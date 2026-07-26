// Generate TypeScript and Zod from an OBSERVED contract.
//
// The difference from every spec generator is one sentence: a specification
// describes the union of every response an interface can produce, so a type
// generated from it marks nearly everything optional, and optional-everything
// types push the work back to the developer at every call site. GitHub's own
// maintained OpenAPI promises 105 fields on its flagship endpoint and the live
// response returns 84. Narrowness is the entire value of a type, and only
// observation produces it.
//
// Optionality here is EARNED rather than assumed. A field is optional only when
// the instrument has watched the interface omit it, either across siblings in
// one response or across observations over time. A field never seen absent is
// emitted as required, because that is what was observed. That is the opposite
// default from a spec generator and it is the whole product.

const RESERVED = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const quoteKey = (k) => (RESERVED.test(k) ? k : JSON.stringify(k));
const indent = (n) => '  '.repeat(n);

/**
 * A profile node to a TypeScript type expression.
 * `depth` only controls indentation of nested object literals.
 */
export function toTypeScript(node, depth = 1) {
  if (!node || typeof node !== 'object') return 'unknown';
  switch (node.type) {
    case 'object': {
      const keys = Object.keys(node.keys || {});
      if (!keys.length) return 'Record<string, unknown>';
      // A map collapses to an index signature: its keys are data, so naming
      // them in a type would be naming one day's values.
      if (keys.length === 1 && keys[0] === '{key}') {
        return `Record<string, ${toTypeScript(node.keys['{key}'], depth)}>`;
      }
      const lines = keys.sort().map((k) => {
        const child = node.keys[k];
        const opt = child?.optional ? '?' : '';
        return `${indent(depth)}${quoteKey(k)}${opt}: ${toTypeScript(child, depth + 1)};`;
      });
      return `{\n${lines.join('\n')}\n${indent(depth - 1)}}`;
    }
    case 'array':
      return `Array<${toTypeScript(node.element, depth)}>`;
    case 'union': {
      const vs = (node.variants || []).map((v) => scalarToTs(v));
      return vs.length ? vs.join(' | ') : 'unknown';
    }
    default:
      return scalarToTs(node.type);
  }
}

function scalarToTs(t) {
  switch (t) {
    case 'string': return 'string';
    case 'number': case 'integer': case 'float': return 'number';
    case 'boolean': return 'boolean';
    case 'null': return 'null';
    case 'redacted-secret': return 'string';
    // A wildcard carries no contract information, so it is `unknown` rather
    // than `any`: the caller is forced to narrow it, which is the honest
    // consequence of us not knowing.
    default: return 'unknown';
  }
}

/** A profile node to a Zod schema expression. */
export function toZod(node, depth = 1) {
  if (!node || typeof node !== 'object') return 'z.unknown()';
  switch (node.type) {
    case 'object': {
      const keys = Object.keys(node.keys || {});
      if (!keys.length) return 'z.record(z.unknown())';
      if (keys.length === 1 && keys[0] === '{key}') {
        return `z.record(${toZod(node.keys['{key}'], depth)})`;
      }
      const lines = keys.sort().map((k) => {
        const child = node.keys[k];
        const inner = toZod(child, depth + 1);
        return `${indent(depth)}${quoteKey(k)}: ${child?.optional ? `${inner}.optional()` : inner},`;
      });
      return `z.object({\n${lines.join('\n')}\n${indent(depth - 1)}})`;
    }
    case 'array':
      return `z.array(${toZod(node.element, depth)})`;
    case 'union': {
      const vs = (node.variants || []).map((v) => scalarToZod(v));
      return vs.length > 1 ? `z.union([${vs.join(', ')}])` : vs[0] || 'z.unknown()';
    }
    default:
      return scalarToZod(node.type);
  }
}

function scalarToZod(t) {
  switch (t) {
    case 'string': return 'z.string()';
    case 'number': case 'integer': case 'float': return 'z.number()';
    case 'boolean': return 'z.boolean()';
    case 'null': return 'z.null()';
    case 'redacted-secret': return 'z.string()';
    default: return 'z.unknown()';
  }
}

/**
 * Fields observed ONLY as null, which are the one place this generator can be
 * confidently wrong.
 *
 * `mirror_url` is null on every repository that is not a mirror, so three
 * observations of a normal repo type it as literally `null`. That type forbids
 * ever assigning a string, and it breaks the first time someone points it at a
 * mirror. GitHub's own specification says `string | null`.
 *
 * The profiler already knows better: `null` is in WILDCARD_TYPES, which the
 * engine defines as carrying no contract information. The generator emitted it
 * as a fact anyway, which is two rules in one system disagreeing.
 *
 * We do not invent the missing half. Observation cannot tell you what type a
 * value would be if you had ever seen one, and guessing `string` would be the
 * documentation-over-observation mistake this tool exists to avoid. So the type
 * stays honest and the header names every such field, because a reader who
 * knows which fields are under-observed can widen them, and one who does not
 * will trust a type that is quietly wrong.
 */
export function nullOnlyFields(node, path = '$', out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'object') {
    for (const k of Object.keys(node.keys || {})) {
      const child = node.keys[k];
      if (child?.type === 'null') out.push(`${path}.${k}`);
      else nullOnlyFields(child, `${path}.${k}`, out);
    }
  } else if (node.type === 'array') {
    nullOnlyFields(node.element, `${path}[]`, out);
  }
  return out;
}

/** Count fields and how many of them are optional, for the provenance header. */
export function countFields(node, acc = { total: 0, optional: 0 }) {
  if (!node || typeof node !== 'object') return acc;
  if (node.type === 'object') {
    for (const k of Object.keys(node.keys || {})) {
      acc.total++;
      if (node.keys[k]?.optional) acc.optional++;
      countFields(node.keys[k], acc);
    }
  } else if (node.type === 'array') {
    countFields(node.element, acc);
  }
  return acc;
}

const pascal = (s) =>
  String(s)
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('') || 'Response';

/**
 * The full generated file.
 *
 * THE HEADER IS THE INTERFACE, and it is a build requirement rather than
 * decoration (Doc 20 §3). This file is committed to the customer's repository,
 * so every engineer who pulls has it and every engineer who opens it meets us.
 * It has to say where the types came from, how much evidence is behind them,
 * and exactly how to regenerate — otherwise it is an unexplained artifact and
 * the first person to question it deletes it.
 */
export function generateModule({ name, profile, source, observations, observedFrom, observedTo, command, notes = [] }) {
  const typeName = pascal(name);
  const counts = countFields(profile);
  const nullOnly = nullOnlyFields(profile);
  if (nullOnly.length) {
    const shown = nullOnly.slice(0, 8).join(', ');
    const rest = nullOnly.length > 8 ? ', and ' + (nullOnly.length - 8) + ' more' : '';
    const one = nullOnly.length === 1;
    notes = notes.concat([
      (one ? '1 field was' : nullOnly.length + ' fields were') +
        ' observed ONLY as null, so ' + (one ? 'it is' : 'they are') +
        ' typed `null` and cannot hold a value. That is what was seen, not necessarily the contract: ' +
        'widen to `T | null` if you know the type. ' + shown + rest,
    ]);
  }
  const header = [
    '// Generated by ShiftGraph from OBSERVED responses. Do not edit by hand.',
    '//',
    `// source        : ${source}`,
    `// observations  : ${observations}`,
    `// observed      : ${observedFrom}${observedTo && observedTo !== observedFrom ? ` to ${observedTo}` : ''}`,
    `// fields        : ${counts.total} (${counts.optional} optional)`,
    '//',
    '// Optionality here is earned, not assumed: a field is marked optional only',
    '// where this interface was actually watched omitting it. A field never seen',
    '// absent is required, because that is what was observed. A type generated',
    '// from a specification would mark nearly all of these optional, which is',
    '// why one of those is useful at a call site and the other is not.',
    '//',
    ...notes.map((n) => `// NOTE: ${n}`),
    ...(notes.length ? ['//'] : []),
    `// Regenerate: ${command}`,
    '',
  ].join('\n');

  const ts = `export interface ${typeName} ${toTypeScript(profile, 1)}\n`;
  const zod = `\nimport { z } from "zod";\n\nexport const ${typeName}Schema = ${toZod(profile, 1)};\n`;
  return header + ts + zod;
}

/**
 * A field-level diff between two profiles, for the regeneration message.
 *
 * Doc 20 §3 makes this a build requirement, not a nicety: regeneration lands in
 * a pull request, and the PR diff is the closest thing we have to Vercel's
 * preview-deployment mechanism — the place where colleagues already read each
 * other's work. **The requirement is that it be legible to a reviewer who has
 * never heard of us**, so it reports fields and evidence, never a regenerated
 * blob.
 */
export function describeRegeneration(before, after, basePath = '$') {
  const out = [];
  const walk = (b, a, p) => {
    if (!b || !a) return;
    if (b.type === 'object' && a.type === 'object') {
      const bk = b.keys || {}, ak = a.keys || {};
      for (const k of [...new Set([...Object.keys(bk), ...Object.keys(ak)])].sort()) {
        const path = `${p}.${k}`;
        if (!(k in bk)) out.push({ change: 'added', path, detail: `now returns ${describeType(ak[k])}` });
        else if (!(k in ak)) out.push({ change: 'removed', path, detail: `no longer returned` });
        else {
          if (!bk[k]?.optional && ak[k]?.optional) out.push({ change: 'now optional', path, detail: 'observed absent, so the type is widened' });
          if (bk[k]?.optional && !ak[k]?.optional) out.push({ change: 'now required', path, detail: 'present in every observation since' });
          walk(bk[k], ak[k], path);
        }
      }
    } else if (b.type === 'array' && a.type === 'array') {
      walk(b.element, a.element, `${p}[]`);
    } else if (b.type !== a.type) {
      out.push({ change: 'type changed', path: p, detail: `${describeType(b)} to ${describeType(a)}` });
    }
  };
  walk(before, after, basePath);
  return out;
}

function describeType(n) {
  if (!n) return 'nothing';
  if (n.type === 'object') return 'an object';
  if (n.type === 'array') return 'a list';
  if (n.type === 'union') return (n.variants || []).join(' or ');
  return n.type;
}
