import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export function sha256(input) {
  return createHash('sha256').update(String(input)).digest('hex');
}

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

export function hashObject(value) {
  return sha256(canonicalize(value));
}

export function safeParseJson(text, context = 'json') {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: `${context}: ${error.message}` };
  }
}

export async function statSafe(filePath) {
  try { return await fs.stat(filePath); } catch { return null; }
}

export async function collectInputFiles(inputs) {
  const out = [];
  for (const input of inputs) {
    const abs = path.resolve(input);
    const st = await statSafe(abs);
    if (!st) throw new Error(`Input not found: ${input}`);
    if (st.isDirectory()) {
      const children = await fs.readdir(abs);
      const nested = await collectInputFiles(children.map(c => path.join(abs, c)));
      out.push(...nested);
    } else if (st.isFile()) {
      out.push(abs);
    }
  }
  return out.sort();
}

export async function readText(filePath) {
  return fs.readFile(filePath, 'utf8');
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(path.resolve(filePath)));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function writeText(filePath, value) {
  await ensureDir(path.dirname(path.resolve(filePath)));
  await fs.writeFile(filePath, value, 'utf8');
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export function percentile(values, p) {
  const nums = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const idx = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1));
  return nums[idx];
}

export function bucketNumber(value, buckets) {
  if (!Number.isFinite(value)) return 'unknown';
  for (const [label, min, max] of buckets) {
    if (value >= min && value < max) return label;
  }
  return 'other';
}

export function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function normalizeDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'number') {
    // Support millis, seconds, and Unix nanos if very large.
    const ms = value > 1e15 ? Math.floor(value / 1e6) : value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'bigint') {
    const ms = Number(value / 1000000n);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function durationMsFromNano(start, end) {
  if (!start || !end) return null;
  try {
    const s = BigInt(start);
    const e = BigInt(end);
    if (e <= s) return null;
    return Number((e - s) / 1000000n);
  } catch {
    return null;
  }
}
