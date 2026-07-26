import { hashObject } from './utils.js';
import { templateKey } from './url.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T.*)?$/;
const URL_RE = /^https?:\/\//i;
const NUMERIC_STRING_RE = /^-?\d+(\.\d+)?$/;

export function profileValue(value, options = {}, depth = 0) {
  const maxDepth = options.maxDepth ?? 8;
  if (depth > maxDepth) return { type: 'max-depth' };
  if (value === undefined) return { type: 'missing' };
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    const len = value.length;
    const sampleProfiles = value.slice(0, 10).map(v => profileValue(v, options, depth + 1));
    const elementProfile = mergeProfiles(sampleProfiles);
    return {
      type: 'array',
      length_bucket: lengthBucket(len),
      element: elementProfile,
      sample_count: len
    };
  }
  const t = typeof value;
  if (t === 'string') {
    return { type: 'string', format: classifyString(value), length_bucket: lengthBucket(value.length) };
  }
  if (t === 'number') {
    return { type: Number.isInteger(value) ? 'integer' : 'float', magnitude_bucket: magnitudeBucket(value), sign: value === 0 ? 'zero' : value > 0 ? 'positive' : 'negative' };
  }
  if (t === 'boolean') return { type: 'boolean' };
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    // Keys are contract by default; the ones that are plainly identifiers are
    // redacted first (see templateKey). Several source keys can collapse onto
    // one templated key - which is the entire point for an object keyed by
    // data - so colliding values are merged into a single profile rather than
    // the last one winning. Merging is what makes `{"u_a1b2c3": …, "u_d4e5f6":
    // …}` stop looking like a contract that changes on every request.
    const collapsed = new Map();
    for (const k of keys) {
      const outKey = isSecretKey(k) ? k : templateKey(k);
      const profile = isSecretKey(k)
        ? { type: 'redacted-secret' }
        : profileValue(value[k], options, depth + 1);
      const prior = collapsed.get(outKey);
      collapsed.set(outKey, prior ? mergeProfiles([prior, profile]) : profile);
    }
    const profiled = {};
    for (const k of [...collapsed.keys()].sort()) profiled[k] = collapsed.get(k);
    // MAP DETECTION, within one response and without another syntax rule.
    //
    // `templateKey` deliberately refuses to chase keys that syntax cannot
    // settle, which left `$.analytics.build_error.30d` keyed by Homebrew
    // install variants ("git", "git --HEAD") reporting a removal every time
    // someone stopped installing one way.
    //
    // The signal is not the key on its own, it is the key TOGETHER WITH its
    // siblings: a map's values all share one shape, and at least one of its
    // keys is something no field name could be. `git --HEAD` contains a space,
    // and a contract does not have a field called that. A record like
    // {first_name, last_name} is homogeneous too, which is exactly why
    // homogeneity alone is not enough and both conditions must hold.
    const names = Object.keys(profiled);
    if (names.length >= 2) {
      const shapes = names.map(n => JSON.stringify(structuralProfile(profiled[n])));
      const homogeneous = shapes.every(s => s === shapes[0]);
      // A purely numeric key is the deliberately-undecided case ({"200": n,
      // "404": n} is a status histogram, which is contract vocabulary), so it
      // does not count as evidence of a map. Caught by the record guards on the
      // first run, which is what the guards are for.
      const unfieldlike = names.some(
        n => !/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(n) && !/^\d+$/.test(n),
      );
      if (homogeneous && unfieldlike) {
        return { type: 'object', keys: { '{key}': profiled[names[0]] }, key_count: keys.length, depth, map: true };
      }
    }
    // key_count stays the count of keys the response actually carried, not the
    // collapsed count: how many entries a map holds is contract-relevant, and
    // reporting the post-collapse number would understate every such object.
    return { type: 'object', keys: profiled, key_count: keys.length, depth };
  }
  return { type: t };
}

// Structural projection: the CONTRACT only (types, keys, nullability, unions),
// invariant to value-derived buckets (string length, numeric magnitude, array
// length, string format). Shape IDENTITY for grouping and drift must use this, so
// changing DATA (a different price, a longer string, one more array item) never
// looks like a changing CONTRACT. This is the fix for the value-variance false
// positives found on live public APIs (adviceslip text, docker pull counts, coinbase
// rates), where the hash moved but there was no structural difference.
export function structuralProfile(p) {
  if (!p || typeof p !== 'object') return p;
  switch (p.type) {
    case 'object': {
      const keys = {};
      for (const k of Object.keys(p.keys || {}).sort()) {
        const sp = structuralProfile(p.keys[k]);
        // Optionality IS contract, so it survives the structural projection and
        // participates in the hash. A field going from always-present to
        // sometimes-absent is a real weakening: every consumer that assumed it
        // was there now has a latent crash. Dropping the flag here would buy a
        // quiet diff by blinding the instrument to that entire class.
        keys[k] = p.keys[k]?.optional ? { ...sp, optional: true } : sp;
      }
      return { type: 'object', keys };
    }
    case 'array':
      return { type: 'array', element: structuralProfile(p.element) };
    case 'union':
      // Union membership is data-driven (which sample shapes we happened to observe),
      // so it drops null/empty/degenerate wildcard variants and collapses a single
      // real variant to that type. `rates.HUF` being int in one sample and float in
      // another, or `group_id` being null in some incidents and a string in others,
      // is DATA, not a changing contract.
      return normalizeUnion(p.variants || []);
    // integer and float are the same CONTRACT (a JSON number); whether a rate lands
    // on a whole number is value churn, per Design Law 6.
    case 'integer':
    case 'float':
      return { type: 'number' };
    default:
      // string drops format/length; null/boolean/missing/redacted-secret/
      // unknown-empty-array/max-depth keep only their type tag.
      return { type: p.type };
  }
}

// The variant tags that carry no contract information in a union: presence/nullness,
// an empty/unknown array element, a too-deep leaf, or a degenerate nested union.
const WILDCARD_VARIANT = new Set(['null', 'missing', 'unknown-empty-array', 'max-depth', 'union', 'any', 'unknown']);
function normalizeUnion(variants) {
  const real = [...new Set(variants.map(v => (v === 'integer' || v === 'float') ? 'number' : v))]
    .filter(v => !WILDCARD_VARIANT.has(v))
    .sort();
  if (real.length === 0) return { type: 'unknown' }; // wholly presence/wildcard -> wildcard
  if (real.length === 1) return { type: real[0] };   // one real shape -> that shape
  return { type: 'union', variants: real };          // genuine polymorphism (rare)
}

export function shapeHash(profile) {
  return `sha256:${hashObject(structuralProfile(profile))}`;
}

export function profileWithHash(value, options = {}) {
  const profile = profileValue(value, options);
  return { profile, shape_hash: shapeHash(profile) };
}

export function classifyString(value) {
  const s = String(value);
  if (UUID_RE.test(s)) return 'uuid';
  if (EMAIL_RE.test(s)) return 'email-like';
  if (URL_RE.test(s)) return 'url-like';
  if (ISO_DATE_RE.test(s)) return 'iso-date-like';
  if (NUMERIC_STRING_RE.test(s)) return 'numeric-string';
  if (s.length > 80) return 'long-opaque';
  return 'opaque';
}

function lengthBucket(n) {
  if (n === 0) return '0';
  if (n === 1) return '1';
  if (n <= 4) return '2-4';
  if (n <= 10) return '5-10';
  if (n <= 64) return '11-64';
  if (n <= 256) return '65-256';
  return '257+';
}

function magnitudeBucket(n) {
  const v = Math.abs(n);
  if (v === 0) return '0';
  if (v < 1) return '<1';
  if (v < 10) return '1-9';
  if (v < 100) return '10-99';
  if (v < 1000) return '100-999';
  if (v < 1000000) return '1k-1m';
  return '1m+';
}

function isSecretKey(key) {
  return /authorization|cookie|token|secret|password|api[-_]?key|session/i.test(key);
}

/**
 * Merge sibling profiles into one.
 *
 * A WILDCARD IS ABSORBED, NEVER UNIONED, and that is the whole correction here.
 * `WILDCARD_TYPES` below already declares that an empty array, a null and an
 * absent leaf carry no contract information, and `diffProfiles` already honours
 * it. This function did not: any disagreement in type produced
 * `{type:'union', variants:[...]}`, a node with no `keys` at all, so merging one
 * populated sibling with one empty one DISCARDED the populated sibling's entire
 * structure.
 *
 * Observed live on 2026-07-26. `ll.thespacedevs.com /launch/upcoming` returns
 * two launches; one had `mission.agencies: [{...26 fields}]` and the other had
 * `mission.agencies: []`. The merged element became
 * `union[object, unknown-empty-array]`, all twenty-six field profiles vanished,
 * and the next comparison reported twenty-six fields removed as a high-severity
 * contract change. The API had not moved. The second launch simply had no
 * agency attached.
 *
 * Two rules were in the file and they disagreed with each other, so the one
 * that ran silently won. The merge now treats a wildcard the way the diff
 * always has: real structure survives contact with an absent sibling.
 *
 * This also closes a nullable-field case nobody had traced. A field that is
 * sometimes null and sometimes a value produced `union[integer, null]`, which is
 * neither type, so a later sample with a non-null value read as a type change.
 * `null` is a wildcard under the same rule, and a nullable field is now what it
 * always was: the type it carries when it carries one.
 */
function mergeProfiles(profiles) {
  if (!profiles.length) return { type: 'unknown-empty-array' };
  const informative = profiles.filter(p => p && !isWildcard(p.type));
  // Nothing informative: keep the old behaviour, since the disagreement is then
  // between wildcards and there is no structure to preserve either way.
  if (!informative.length) {
    const wildTypes = [...new Set(profiles.map(p => p.type))].sort();
    return wildTypes.length > 1 ? { type: 'union', variants: wildTypes } : profiles[0];
  }
  const types = [...new Set(informative.map(p => p.type))].sort();
  if (types.length > 1) return { type: 'union', variants: types };
  const type = types[0];
  if (type === 'object') {
    const allKeys = new Set();
    for (const p of informative) for (const k of Object.keys(p.keys || {})) allKeys.add(k);
    const keys = {};
    for (const k of [...allKeys].sort()) {
      const childProfiles = informative.map(p => p.keys?.[k]).filter(Boolean);
      const merged = mergeProfiles(childProfiles);
      // PRESENCE. Absence is proof; presence is only evidence.
      //
      // A key missing from even one sibling is DEFINITIVELY optional, at any
      // sample size, because we have watched the interface omit it. A key
      // present in every sibling might be required or might be coincidence, and
      // no sample size settles that, so it claims nothing.
      //
      // The asymmetry is what keeps this safe. Marking optional needs positive
      // evidence of an absence, so a single-sample object marks nothing and a
      // genuine field removal still fires. A rule that inferred "required" from
      // presence would have to guess, and guessing from one sample is the
      // defect this file already carries two warnings about.
      keys[k] = childProfiles.length < informative.length ? { ...merged, optional: true } : merged;
    }
    return { type: 'object', keys };
  }
  if (type === 'array') return { type: 'array', element: mergeProfiles(informative.map(p => p.element).filter(Boolean)) };
  return informative[0];
}

export function diffProfiles(before, after, basePath = '$') {
  const diffs = [];
  if (!before && after) return [{ type: 'added', path: basePath, after }];
  if (before && !after) return [{ type: 'removed', path: basePath, before }];
  if (!before && !after) return diffs;
  if (before.type !== after.type) {
    diffs.push({ type: 'type_changed', path: basePath, before: before.type, after: after.type });
    return diffs;
  }
  if (before.type === 'object') {
    const bk = before.keys || {};
    const ak = after.keys || {};
    const keys = [...new Set([...Object.keys(bk), ...Object.keys(ak)])].sort();
    for (const k of keys) {
      if (!(k in bk)) diffs.push({ type: 'field_added', path: `${basePath}.${k}`, after: ak[k]?.type });
      else if (!(k in ak)) diffs.push({ type: 'field_removed', path: `${basePath}.${k}`, before: bk[k]?.type });
      else diffs.push(...diffProfiles(bk[k], ak[k], `${basePath}.${k}`));
    }
  } else if (before.type === 'array') {
    diffs.push(...diffProfiles(before.element, after.element, `${basePath}[]`));
  } else if (JSON.stringify(before) !== JSON.stringify(after)) {
    // Keep primitive-profile changes concise; type already matches.
    if (before.format !== after.format) diffs.push({ type: 'format_changed', path: basePath, before: before.format, after: after.format });
  }
  return diffs;
}

// Types that carry no contract information: an empty array, a null, or an
// absent/unknown/too-deep leaf. Refining one of these later (or vice versa) is a
// DATA refinement, not a contract change, so it must never count as drift.
const WILDCARD_TYPES = new Set(['unknown-empty-array', 'any', 'unknown', 'max-depth', 'null', 'missing']);
function isWildcard(t) { return WILDCARD_TYPES.has(t); }
// A field whose PRESENCE toggles but which carries no contract information when present:
// an array (a provider signals "no items" as [] OR by omitting the key entirely -
// status-page `incidents`/`scheduled_maintenances`, GitHub-style empty collections) or a
// wildcard leaf. Same emptiness-by-omission volatility already tolerated for an empty-array
// element (WILDCARD_TYPES). A toggling SCALAR or OBJECT field is a real contract change and
// is still reported; only array/wildcard presence toggles are suppressed. This keeps the
// published honesty claim ("empty-vs-populated arrays never reach a drift event") true even
// when the provider drops the key rather than sending []. Note: structuralDiff is shared
// with spec-vs-reality, which will likewise not flag a purely additive undocumented array
// field - consistent with the engine's "additions are non-breaking" stance.
function isEmptinessVolatile(p) { return Boolean(p) && (p.type === 'array' || isWildcard(p.type)); }

// Breaking-aware, wildcard-tolerant structural diff. Both sides are first projected to
// the structural contract (integer/float -> number, unions normalized), so value churn
// and presence/nullness never register. Field additions are additive (non-breaking);
// field removals and concrete type changes are breaking. Differences that touch a
// wildcard leaf, or that involve a union (its membership is data-driven, not the
// contract), are suppressed. This is the decision function for cross-capture drift:
// no structural diff means no drift, regardless of the hash.
/**
 * SERIES MEMORY. Carry optionality forward when a baseline rolls.
 *
 * Presence within one response only sees what one response contains, so an
 * object observed once tells you nothing about which of its fields are
 * conditional. `status-openai` proved it: one incident on Monday without
 * `monitoring_at`, one incident on Tuesday with it, n=1 both days. Nothing
 * inside either response could reveal that the field is state-conditioned, so
 * the field appeared, then vanished when the incident resolved, and each
 * transition read as a contract change forever.
 *
 * The evidence exists, it is just spread across time rather than across
 * siblings, and the baseline is where time is kept.
 *
 * The rule is the same asymmetry as within-response presence: **having seen a
 * field absent is proof it is optional.** A key in one profile and not the
 * other has been observed both ways, so the rolled baseline keeps it and marks
 * it optional. A key present in both keeps whatever optionality either side
 * had.
 *
 * A vanished key is RETAINED rather than dropped, which is the part worth
 * pausing on. Dropping it would mean the field reappearing later reads as new,
 * and the pair oscillates forever. Keeping it costs one honest report of the
 * removal, once, on the day it happened, and silence after. Reporting a
 * genuine removal every single day is not vigilance; it is the same event
 * counted repeatedly, which is precisely what the ledger's rate arithmetic must
 * never be fed.
 */
export function carryOptionality(prior, next) {
  if (!prior || !next || typeof prior !== 'object' || typeof next !== 'object') return next;
  if (prior.type !== next.type) return next;
  if (next.type === 'object') {
    const pk = prior.keys || {};
    const nk = next.keys || {};
    const keys = {};
    for (const k of [...new Set([...Object.keys(pk), ...Object.keys(nk)])].sort()) {
      const inPrior = k in pk;
      const inNext = k in nk;
      if (inPrior && inNext) {
        const merged = carryOptionality(pk[k], nk[k]);
        keys[k] = pk[k]?.optional || nk[k]?.optional ? { ...merged, optional: true } : merged;
      } else if (inNext) {
        keys[k] = { ...nk[k], optional: true };   // appeared: observed both ways
      } else {
        keys[k] = { ...pk[k], optional: true };   // vanished: observed both ways, retained
      }
    }
    return { ...next, keys };
  }
  if (next.type === 'array') return { ...next, element: carryOptionality(prior.element, next.element) };
  return next;
}

export function structuralDiff(before, after, basePath = '$') {
  return diffNormalized(structuralProfile(before), structuralProfile(after), basePath);
}
function diffNormalized(before, after, basePath) {
  const diffs = [];
  if (!before || !after) return diffs;
  const bt = before.type, at = after.type;
  if (isWildcard(bt) || isWildcard(at)) return diffs;
  // a union on either side = "which sample shapes we happened to observe" (nullness,
  // polymorphic content). That is data, not a changing contract; suppress it.
  if (bt === 'union' || at === 'union') return diffs;
  if (bt !== at) { diffs.push({ type: 'type_changed', path: basePath, before: bt, after: at, breaking: true }); return diffs; }
  if (bt === 'object') {
    const bk = before.keys || {}, ak = after.keys || {};
    // A map on one side and a record on the other is US changing our mind, not
    // the interface changing. Map detection needs at least two entries plus a
    // key no field name could be, so a map that shrinks to one entry stops
    // looking like a map and every collapsed key reads as added-and-removed.
    // That is a disagreement between two of our own readings of one shape, and
    // reporting it as drift would be the instrument narrating its own
    // uncertainty as the provider's change.
    if (('{key}' in bk) !== ('{key}' in ak)) return diffs;
    for (const k of [...new Set([...Object.keys(bk), ...Object.keys(ak)])].sort()) {
      if (!(k in bk)) { if (isEmptinessVolatile(ak[k])) continue; diffs.push({ type: 'field_added', path: `${basePath}.${k}`, after: ak[k]?.type, breaking: false }); }
      else if (!(k in ak)) {
        if (isEmptinessVolatile(bk[k])) continue;
        // Already known optional: we watched the interface omit it before, so
        // omitting it again is the contract behaving as observed, not changing.
        // This is what stops a rotating list of results from reporting every
        // conditionally-present field as removed on every sweep.
        if (bk[k]?.optional) continue;
        diffs.push({ type: 'field_removed', path: `${basePath}.${k}`, before: bk[k]?.type, breaking: true });
      }
      else diffs.push(...diffNormalized(bk[k], ak[k], `${basePath}.${k}`));
    }
  } else if (bt === 'array') {
    diffs.push(...diffNormalized(before.element, after.element, `${basePath}[]`));
  }
  return diffs;
}

export function hasStructuralDiff(before, after) { return structuralDiff(before, after).length > 0; }
export function hasBreakingDiff(before, after) { return structuralDiff(before, after).some(d => d.breaking); }

export function summarizeDiff(before, after, limit = 12) {
  const diffs = structuralDiff(before, after).slice(0, limit);
  if (!diffs.length) return 'No structural diff after redaction.';
  return diffs.map(d => {
    if (d.type === 'field_added') return `added ${d.path} (${d.after})`;
    if (d.type === 'field_removed') return `removed ${d.path} (${d.before})`;
    if (d.type === 'type_changed') return `${d.path} changed ${d.before} -> ${d.after}`;
    return `${d.type} at ${d.path}`;
  }).join('; ');
}
