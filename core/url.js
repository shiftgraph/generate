// url.js
// Host normalization and CONSERVATIVE path templating. Templating only collapses segments that
// are unambiguously identifiers (numeric ids, uuids, dates, long high-entropy tokens). It never
// collapses distinct human-meaningful route segments. Discrimination between genuinely different
// operations is done in operation.js (by kind + graphql op), not by aggressive templating, which
// is what previously merged unlike requests into one bucket.
import { sha256 } from './utils.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NUM_RE = /^\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION_RE = /^v\d+(?:\.\d+)?$/i;
const HEX_RE = /^[0-9a-f]{16,}$/i;
const BASE64ISH_RE = /^[A-Za-z0-9_-]{24,}$/;

/**
 * An email address, which no rule here caught until now.
 *
 * `/customers/alice@example.com` templated to itself and went out on the wire
 * and into storage verbatim. None of the rules above can reach it: the wordy
 * guard excludes `@` and `.`, and the opaque-token rule requires twenty-four
 * characters of `[A-Za-z0-9_-]`, which an address is not. The SDK's own
 * docstring names that exact string as an identifier it strips, so the promise
 * was published before the code kept it.
 *
 * This is the sharpest of the identifier shapes, because it is directly
 * personal rather than merely unique, and it is the one shape that can never be
 * contract vocabulary: no API has a field or route segment literally named like
 * an address.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Prefixed opaque identifiers (Stripe `cus_A1b2C3d4`, Clerk `user_2abc123XYZ`).
 *
 * The suffix must carry ENTROPY: a digit or an uppercase letter. Without that
 * requirement this matched ordinary snake_case route words whose prefix happened
 * to be six letters or fewer, which silently destroyed operation identity. It
 * collapsed `search_repositories`, `list_commits`, `fork_repository`,
 * `create_branch` and `list_directory` into one `{token}` bucket while leaving
 * `create_issue` and `read_file` alone, so whether a route survived depended on
 * nothing but the length of its second word.
 *
 * Found by pointing the observatory at MCP tool contracts, where the tool name
 * IS the operation identity: eleven distinct GitHub tools merged into a single
 * operation, which would have made per-tool drift undetectable and mixed eleven
 * unrelated contracts into one population. The same flaw applies to any REST API
 * with snake_case path segments.
 *
 * A real opaque id is high-entropy by construction. A route word is not.
 */
const PREFIXED_ID_RE = /^[a-z]{1,6}_(?=[A-Za-z0-9]{6,}$)[A-Za-z0-9]*[0-9A-Z][A-Za-z0-9]*$/;

/**
 * A readable multi-word route segment: lowercase alphabetic words joined by
 * underscores or hyphens, and nothing else. `create_pull_request_review`,
 * `toggle-simulated-logging`, `list_directory_with_sizes`.
 *
 * These are names, never identifiers, and this rule outranks every id
 * heuristic below it. Without it the length-based token rule swallowed any such
 * name past 24 characters, so `get_pull_request_reviews` (24) collapsed while
 * `get_pull_request_files` (22) survived: identity decided by character count.
 *
 * Digits disqualify a segment from this rule, so `user_12345` and `order_9f2a1b`
 * still template correctly. An identifier that is purely lowercase words with no
 * digits is indistinguishable from a route name by inspection, and treating it
 * as a name is the safer error: over-templating merges unlike operations into
 * one population and silently destroys the evidence, while under-templating only
 * splits one operation into a few thin ones that are still individually honest.
 */
const WORDY_SEGMENT_RE = /^[a-z]+([_-][a-z]+)+$/;

/**
 * A name followed by a number is an identifier at any length: `user_12345`,
 * `order-42`, `invoice_7`. The entropy rule above requires six characters, so
 * short numeric ids slipped through and split one operation into one bucket per
 * id. A single word ending in digits (`oauth2`, `s3`, `base64`) has no separator
 * and is correctly untouched.
 */
const NUMERIC_SUFFIX_RE = /^[a-z]+[_-]\d+$/;

/**
 * Redact an OBJECT KEY that is an identifier rather than contract vocabulary.
 *
 * Keys are structural by default and must stay that way: in `{name, email, id}`
 * the key set IS the contract, and collapsing it would destroy the thing being
 * profiled. The assumption inverts for an object keyed by data. In
 * `{"alice@example.com": {...}}` or `{"user_a3f9": {...}}` the keys are the
 * payload, and they were being stored verbatim in the shape profile, carried
 * into every drift event's `field_path`, and from there into the corpus
 * signature hash and its published headline. The corpus is the surface other
 * tenants can see, which makes a data-key the widest-reaching value we hold.
 *
 * THE RULE IS DELIBERATELY NARROWER THAN PATH TEMPLATING, and the asymmetry is
 * the point. Only shapes that can never be a field name are redacted: an
 * address, a uuid, a date, a long hash, a long opaque token, a prefixed or
 * numeric id. Every one of those is a value wearing a key's clothes.
 *
 * TWO PATH RULES ARE DELIBERATELY ABSENT, and the reason is the whole lesson of
 * this file. The first draft reused the length-based opaque-token rule and the
 * name-then-digits rule, and the observatory caught it destroying real contract
 * vocabulary on the very first comparison:
 *
 *   astronomicalTwilightBegin          -> {token}   (25 chars, so the 24+ rule ate it)
 *   market_cap_change_24h_in_currency  -> {token}   (same rule, underscores count)
 *   address_1, address_2, psr-4        -> {token}   (name-then-digits)
 *
 * Those are field names, not identifiers. A route segment is rarely long and
 * rarely ends in a digit; a field name is routinely both. Reusing a rule across
 * two populations because it was written for a similar-looking shape is exactly
 * the defect the warning above this function describes, and it was reproduced
 * here within an hour of writing that warning down.
 *
 * So only shapes that cannot be a field name survive as rules: an address, a
 * uuid, a date, a long hash, and a prefixed id whose suffix carries entropy.
 *
 * WHAT IS DELIBERATELY LEFT ALONE, each because syntax genuinely cannot decide:
 *   - bare integers: `{"200": n, "404": n}` is a status histogram, and this
 *     repository's own run summaries are shaped that way
 *   - name-then-digits: `user_12345` is an id and `address_1` is a field, and
 *     they are the same string shape. There is no threshold that separates
 *     them, and inventing one is how this went wrong the first time
 *   - wordy keys: `{"bitcoin": ...}` is a real word in key position
 *
 * All three need the observational signal rather than a guess: across
 * observations a map's keys churn while its sibling value shapes hold
 * identical, and a record's keys are stable. That is the product's own thesis
 * turned on itself, and it is recorded in REAL_AUDIT_BACKLOG Issue 4 rather
 * than approximated here.
 */
export function templateKey(key) {
  const k = String(key);
  if (EMAIL_RE.test(k)) return '{email}';
  if (UUID_RE.test(k)) return '{uuid}';
  if (DATE_RE.test(k)) return '{date}';
  if (WORDY_SEGMENT_RE.test(k)) return k;   // `user_id`, `created_at`: a field name
  if (PREFIXED_ID_RE.test(k)) return '{token}';
  if (HEX_RE.test(k)) return '{hex}';
  return k;
}

export function normalizeHost(host, mode = 'display') {
  if (!host) return { display: 'unknown-host', hash: sha256('unknown-host') };
  const cleaned = String(host).trim().toLowerCase().replace(/:\d+$/, '');
  return { display: mode === 'strict' ? `host:${sha256(cleaned).slice(0, 12)}` : cleaned, hash: sha256(cleaned) };
}

export function inferPathTemplate(pathname = '/') {
  let path = String(pathname || '/').split('?')[0].split('#')[0];
  if (!path.startsWith('/')) path = `/${path}`;
  const parts = path.split('/').filter(Boolean).map(segment => {
    const clean = decodeURIComponentSafe(segment);
    if (VERSION_RE.test(clean)) return clean;         // keep v1, v2.0 literal
    if (EMAIL_RE.test(clean)) return '{email}';       // personal, and never contract vocabulary: outranks the name guard
    if (WORDY_SEGMENT_RE.test(clean)) return clean;   // a name, not an id: outranks every heuristic below
    if (UUID_RE.test(clean)) return '{uuid}';
    if (DATE_RE.test(clean)) return '{date}';
    if (NUM_RE.test(clean)) return '{int}';
    if (PREFIXED_ID_RE.test(clean)) return '{token}'; // prefixed opaque id (Stripe/Clerk style: cus_, pi_, user_)
    if (NUMERIC_SUFFIX_RE.test(clean)) return '{token}'; // `user_12345`, `order-42`: a name followed by a number is an id
    if (HEX_RE.test(clean)) return '{hex}';
    if (BASE64ISH_RE.test(clean)) return '{token}';   // long opaque id, not a route word
    return clean;
  });
  return parts.length ? `/${parts.join('/')}` : '/';
}

function decodeURIComponentSafe(segment) {
  try { return decodeURIComponent(segment); } catch { return segment; }
}

export function parseHttpTarget({ url, host, path, route, method, redactionMode = 'balanced' }) {
  let parsed = null;
  const target = url || path || '';
  if (url) { try { parsed = new URL(url); } catch { parsed = null; } }
  const hostname = parsed?.hostname || host || inferHostFromUrlLike(target) || 'unknown-host';
  const displayHost = normalizeHost(hostname, redactionMode === 'strict' ? 'strict' : 'display');
  const rawPath = route || parsed?.pathname || pathFromUrlLike(target) || '/';
  const pathTemplate = route && route.includes('{') ? route : inferPathTemplate(rawPath);
  return {
    transport: 'http',
    direction: 'outbound',
    method: method ? String(method).toUpperCase() : 'UNKNOWN',
    hostDisplay: displayHost.display,
    hostHash: displayHost.hash,
    pathTemplate,
    pathRaw: rawPath,
    queryKeys: collectQueryKeys(parsed, target)
  };
}

function collectQueryKeys(parsed, target) {
  try {
    const search = parsed?.search || (String(target).includes('?') ? `?${String(target).split('?')[1]}` : '');
    if (!search) return [];
    return [...new URLSearchParams(search).keys()].sort();
  } catch { return []; }
}

function inferHostFromUrlLike(value) {
  const m = String(value || '').match(/^https?:\/\/([^/]+)/i);
  return m ? m[1].replace(/:\d+$/, '') : null;
}

function pathFromUrlLike(value) {
  const s = String(value || '');
  const m = s.match(/^https?:\/\/[^/]+([^?#]*)/i);
  if (m) return m[1] || '/';
  return s.startsWith('/') ? s.split('?')[0] : null;
}
