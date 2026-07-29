#!/usr/bin/env node
// Observe a URL, then generate types from what it actually returned.
//
//   npx @shiftgraph/generate https://api.github.com/repos/facebook/react
//   npx @shiftgraph/generate <url> --samples 5 --out repo.ts
//   npx @shiftgraph/generate <url> --also <url2> --also <url3>
//   cat response.json | npx @shiftgraph/generate --stdin --name Thing
//
// Self-contained on purpose. A library that needs a profile you do not have is
// a library nobody can use, so this observes for you: it requests the URL a few
// times, profiles each response, folds them, and writes the types.
import { promises as fs } from 'node:fs';
import { profileValue, structuralProfile, carryOptionality } from './core/shape.js';
import { generateModule, generateFixture, countFields } from './index.js';

const UA = 'shiftgraph-generate/0.1 (+https://www.npmjs.com/package/@shiftgraph/generate)';

function parseArgs(argv) {
  const positional = [];
  const flags = { also: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--also') flags.also.push(argv[++i]);
    else if (a === '--stdin') flags.stdin = true;
    else if (a === '--stdout') flags.stdout = true;
    else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
    else positional.push(a);
  }
  return { positional, flags };
}

const readStdin = async () => {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
};

/**
 * MCP servers overwhelmingly answer with the payload encoded as JSON inside a
 * text block, so the contract that matters sits one level below the envelope.
 * Profiling the envelope alone yields `text: string`, which is honest and
 * useless.
 */
function decodeEmbeddedJson(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.content)) return body;
  let decoded = false;
  const content = body.content.map((b) => {
    if (b?.type !== 'text' || typeof b.text !== 'string') return b;
    const t = b.text.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) return b;
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === 'object') { decoded = true; return { ...b, text_decoded: parsed }; }
    } catch { /* prose */ }
    return b;
  });
  return decoded ? { ...body, content } : body;
}

async function observe(url, samples, delayMs) {
  const bodies = [];
  for (let i = 0; i < samples; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json, */*' } });
    const text = await res.text();
    if (!res.ok && bodies.length === 0) {
      throw new Error(`${url} returned ${res.status}. Types from an error response would describe the error, not the contract.`);
    }
    try { bodies.push(decodeEmbeddedJson(JSON.parse(text))); } catch {
      throw new Error(`${url} did not return JSON (content-type ${res.headers.get('content-type') || 'unknown'}).`);
    }
    if (i < samples - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return bodies;
}

/** A filename someone would not be annoyed to find in their working directory. */
const slug = (s) =>
  String(s)
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60) || 'observed-types';

const nameFromUrl = (u) => {
  try {
    const { hostname, pathname } = new URL(u);
    return `${hostname.replace(/^(www|api)\./, '')}${pathname}`.replace(/[^A-Za-z0-9]+/g, ' ').trim() || 'Response';
  } catch { return 'Response'; }
};

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const samples = Math.max(1, Number(flags.samples ?? 3));
  const delayMs = Number(flags.delay ?? 400);

  let bodies = [];
  let name = flags.name;
  let source;

  if (flags.stdin) {
    const raw = await readStdin();
    if (!raw.trim()) throw new Error('nothing on stdin.');
    bodies = [decodeEmbeddedJson(JSON.parse(raw))];
    name ||= 'Response';
    source = 'stdin';
  } else {
    const url = positional[0];
    if (!url) {
      console.log(`
  Generate TypeScript and Zod from what an API actually returns.

    npx @shiftgraph/generate <url>
    npx @shiftgraph/generate <url> --samples 5 --out types.ts
    npx @shiftgraph/generate <url> --also <url2>     # fold several resources
    cat response.json | npx @shiftgraph/generate --stdin --name Thing

  Optionality is earned: a field is optional only where the interface was
  actually watched omitting it. Specs describe every response an endpoint CAN
  give, so types generated from one mark nearly everything optional. These do
  not, because they describe what came back.
`);
      return;
    }
    const urls = [url, ...flags.also];
    for (const u of urls) bodies.push(...(await observe(u, samples, delayMs)));
    name ||= nameFromUrl(url);
    source = urls.join(', ');
  }

  let profile = structuralProfile(profileValue(bodies[0]));
  for (let i = 1; i < bodies.length; i++) {
    profile = carryOptionality(profile, structuralProfile(profileValue(bodies[i])));
  }

  const notes = [];
  if (bodies.length < 3) {
    notes.push(`only ${bodies.length} observation${bodies.length === 1 ? '' : 's'}: a field that IS conditional may be typed required here. Raise --samples, or fold another resource with --also.`);
  }
  if (!flags.also.length && !flags.stdin) {
    notes.push('observed on ONE resource. The same endpoint can return different fields for different resources (GitHub returns 86 for an org-owned repo and 84 for a user-owned one), so fold several with --also to widen this honestly.');
  }
  notes.push('where a vendor ships official types, prefer theirs. This is strongest where none exist.');

  const today = new Date().toISOString().slice(0, 10);
  const module = generateModule({
    name,
    profile,
    source,
    observations: bodies.length,
    observedFrom: today,
    observedTo: today,
    command: `npx @shiftgraph/generate ${flags.stdin ? '--stdin' : positional[0]}`,
    notes,
  });

  const counts = countFields(profile);

  // DEFAULT TO WRITING THE FILE, not printing it.
  //
  // The header this tool emits says "Do not edit by hand" and carries a
  // regeneration command. Those are instructions for a file in a repository,
  // and printed to a terminal they are nonsense.
  //
  // The adoption mechanism depends on it too. A committed file is one every
  // engineer who pulls the repo has, and regenerating it produces a diff in a
  // pull request, which is where colleagues already read each other's work. A
  // tool that prints and exits leaves nothing behind: a person reads the
  // output, nods, and closes the terminal.
  //
  // So two rules in this codebase disagreed again, the header assuming a file
  // and the behaviour assuming a pipe, and the silent one was winning. Sixth
  // instance of that shape this week.
  //
  // `--stdout` is there because piping is a legitimate thing to want, and a
  // tool that writes files with no way to opt out is its own kind of rude.
  if (flags.stdout) {
    process.stdout.write(module);
    return;
  }
  const outPath = flags.out || `${slug(name)}.ts`;
  await fs.writeFile(outPath, module, 'utf8');
  console.log(`Wrote ${outPath}`);

  // THE FIXTURE IS WRITTEN BY DEFAULT, and that is the whole point of it.
  //
  // A type lands in the repository and is consulted when the code compiles. A
  // fixture lands in the TEST SUITE and is consulted on every run, which is far
  // more often. And a fixture goes stale because time passes rather than
  // because a provider changed anything, so it is felt weekly rather than
  // twice a year. That frequency is the reason this capability exists at all.
  //
  // Behind a flag it would be a feature nobody discovers, and a tool whose best
  // idea is opt-in has not shipped it. `--no-fixture` opts out.
  if (!flags['no-fixture']) {
    const fixturePath = `${outPath.replace(/\.ts$/, '')}.fixture.ts`;
    const typeModule = `./${outPath.split(/[\\/]/).pop().replace(/\.ts$/, '')}`;
    await fs.writeFile(
      fixturePath,
      generateFixture({
        name,
        profile,
        source,
        observations: bodies.length,
        observedFrom: today,
        observedTo: today,
        command: `npx @shiftgraph/generate ${flags.stdin ? '--stdin' : positional[0]}`,
        typeModule,
      }),
      'utf8',
    );
    console.log(`Wrote ${fixturePath}`);
  }

  console.log(`  ${counts.total} fields, ${counts.optional} optional, from ${bodies.length} observation${bodies.length === 1 ? '' : 's'}`);
  if (bodies.length < 3) console.log(`  more observations narrow it further: --samples 5`);
  console.log(`  types only: --no-fixture   print instead of writing: --stdout`);
}

main().catch((err) => {
  console.error(`generate: ${err.message}`);
  process.exitCode = 1;
});
