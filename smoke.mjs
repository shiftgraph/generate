#!/usr/bin/env node
// Pre-publish smoke test: pack the package, install the tarball into a clean
// directory, and run it the way a stranger would.
//
// WHY THIS EXISTS. Two of the first three publishes were broken, and both would
// have been caught here in about a minute:
//
//   0.1.0  npm silently stripped the `bin` entry, so `npx @shiftgraph/generate`
//          did nothing at all. npm reported it under a line that reads like
//          housekeeping: "errors corrected".
//   0.1.1  the tool ran, but emitted a field typed so it could never hold a
//          value.
//
// Neither failed a unit test. Both were found by a human reading output, which
// is not a process. The difference between "publish and hope" and this is that
// this cannot ship a package that does nothing.
//
// It deliberately tests the TARBALL rather than the working directory, because
// every failure above lived in the gap between them: what `files`, `bin` and
// npm's own normalisation actually produce.
//
//   node packages/generate/smoke.mjs
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
// npm on Windows is a .cmd shim, and Node refuses to exec one without a shell
// (the CVE-2024-27980 mitigation), so npm goes through `execSync` which shells.
// node itself is invoked directly, because passing its arguments through a
// shell is exactly what the DEP0190 warning objects to. Paths are quoted
// because this repository lives under a directory with a space in its name,
// which is how the first version of this failed.
const npm = (args, cwd) =>
  execSync(`npm ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`, { cwd, encoding: 'utf8', stdio: 'pipe' });
const node = (args, cwd, input) => execFileSync(process.execPath, args, { cwd, encoding: 'utf8', stdio: 'pipe', input });

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${String(err.message).split('\n')[0].slice(0, 160)}`);
  }
};

console.log('\nPre-publish smoke test: packing, installing and running as a stranger would.\n');

const dir = mkdtempSync(path.join(tmpdir(), 'sg-smoke-'));
try {
  // 1. Pack exactly what would be published.
  const tarball = npm(['pack', '--pack-destination', dir], PKG_DIR).trim().split('\n').pop().trim();
  const tarPath = path.join(dir, tarball);
  check('the package packs', () => {
    if (!existsSync(tarPath)) throw new Error(`no tarball at ${tarPath}`);
  });

  // 2. Install the tarball into a clean project.
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'smoke', version: '1.0.0', private: true }));
  npm(['install', tarPath], dir);

  // 3. The bin shim must exist. This is the 0.1.0 failure.
  const binDir = path.join(dir, 'node_modules', '.bin');
  check('a bin shim is created (npx would work)', () => {
    const shims = existsSync(binDir) ? readdirSync(binDir) : [];
    if (!shims.length) throw new Error('node_modules/.bin is empty: npm stripped the bin entry');
  });

  // 4. It must actually run and produce a file. This is the whole product.
  const installed = path.join(dir, 'node_modules', '@shiftgraph', 'generate', 'cli.js');
  check('it runs against a live URL and writes a file', () => {
    node([installed, 'https://api.github.com/repos/octocat/Hello-World', '--samples', '1'], dir);
    const written = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    if (!written.length) throw new Error('no .ts file written: the tool printed and left nothing behind');
    const src = readFileSync(path.join(dir, written[0]), 'utf8');
    if (!src.includes('export interface')) throw new Error('output has no interface');
    if (!src.includes('Regenerate:')) throw new Error('output has no provenance header');
    if (src.length < 500) throw new Error(`output suspiciously short (${src.length} bytes)`);
  });

  // 5. Honesty checks: the limits a reader is entitled to see must be present.
  check('the honest-limits notes survive into the output', () => {
    const written = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    const src = readFileSync(path.join(dir, written[0]), 'utf8');
    if (!src.includes('prefer theirs')) throw new Error('missing the official-SDK limit');
    if (!src.includes('ONE resource')) throw new Error('missing the resource-conditioning warning');
  });

  // 6. `--stdout` must still pipe, or we have made the tool rude.
  check('--stdout still prints instead of writing', () => {
    // Pipe real JSON in: the first version of this test sent nothing and failed
    // because stdin was empty, which is a broken test rather than a finding.
    const out = node([installed, '--stdin', '--name', 'Probe', '--stdout'], dir, '{\"a\":1,\"b\":{\"c\":true}}');
    if (!out.includes('export interface Probe')) throw new Error('stdout mode produced nothing usable');
  });

  // 7. Zero dependencies: a stranger installs this on a plane.
  check('the package has no third-party dependencies', () => {
    const meta = JSON.parse(readFileSync(path.join(dir, 'node_modules', '@shiftgraph', 'generate', 'package.json'), 'utf8'));
    const deps = Object.keys(meta.dependencies || {});
    if (deps.length) throw new Error(`has dependencies: ${deps.join(', ')}`);
  });
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows file locks */ }
}

console.log('');
if (failures) {
  console.error(`SMOKE TEST FAILED (${failures}). Do not publish.\n`);
  process.exitCode = 1;
} else {
  console.log('All checks passed. Safe to publish.\n');
}
