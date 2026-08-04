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

/**
 * A flag that takes no value. Naming them is the whole fix.
 *
 * The catch-all branch below treats every unknown `--flag` as taking the next
 * argument, so `--no-fixture` - which takes none - swallowed whatever followed
 * it. Two consequences, both silent and both in the documented usage line
 * `types only: --no-fixture   print instead of writing: --stdout`:
 *
 *   --no-fixture --stdout   set flags['no-fixture'] = '--stdout', so --stdout
 *                           vanished and the tool wrote files while the caller
 *                           asked it to print.
 *   --no-fixture  (last)    set flags['no-fixture'] = undefined, which is
 *                           falsy, so the fixture was written anyway. The
 *                           documented flag did nothing at all.
 */
const BOOLEAN_FLAGS = new Set(['stdin', 'stdout', 'no-fixture']);

function parseArgs(argv) {
  const positional = [];
  const flags = { also: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--also') flags.also.push(argv[++i]);
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) { flags[key] = true; continue; }
      const value = argv[i + 1];
      // A value flag followed by another flag, or by nothing, is a typo the
      // caller wants named rather than absorbed.
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${a} expects a value. Got ${value === undefined ? 'nothing' : value}.`);
      }
      flags[key] = value;
      i++;
    }
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

/**
 * Observe one URL `samples` times and return only the bodies that are contract.
 *
 * A NON-2xx BODY IS NEVER MERGED, AT ANY SAMPLE INDEX.
 *
 * The guard used to read `if (!res.ok && bodies.length === 0)`, so it only
 * covered the FIRST response. From sample two onward a non-2xx with a JSON body
 * went straight into the profile. Reproduced against a server answering 200 then
 * a GitHub-shaped 403: five real fields became seven, `message` and
 * `documentation_url` joined the customer's contract, and - worse - every real
 * field was marked optional, because the error response omitted them. Exit 0, no
 * warning, and the generated header arguing against itself: "a type generated
 * from a specification would mark nearly all of these optional, which is why one
 * of those is useful at a call site and the other is not."
 *
 * This is the observatory's rate-limit incident in the flagship free artefact.
 * That one was fixed at `normalizeObservation`, the single choke point every
 * adapter passes through; this loop is a second reader that never received the
 * rule. Unauthenticated GitHub allows 60 requests an hour and every URL costs
 * `samples` of them, so a rate limit mid-run is the ordinary case rather than
 * the edge - and a rate limit answers 403 with valid JSON, which is exactly the
 * shape that walked through.
 *
 * SKIPPED RATHER THAN FATAL, once at least one good sample exists. Aborting the
 * whole run would throw away responses the caller already spent their rate
 * budget on, precisely when they cannot easily retry. The skips are counted,
 * reported to the caller, and carried into the generated file's own notes,
 * because that file is read later by someone who was not here.
 */
async function observe(url, samples, delayMs) {
  const bodies = [];
  const skipped = [];
  let answeredBy = null;
  for (let i = 0; i < samples; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json, */*' } });
    const text = await res.text();
    // The URL that ANSWERED, which is not the URL asked for when a redirect was
    // followed. `api.github.com/repos/facebook/react` answers 301 to
    // `/repositories/10270250`, and the provenance block claimed the former.
    answeredBy ||= res.url || null;
    if (!res.ok) {
      if (bodies.length === 0 && i === samples - 1) {
        throw new Error(`${url} returned ${res.status}. Types from an error response would describe the error, not the contract.`);
      }
      skipped.push(res.status);
      if (i < samples - 1) await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    try { bodies.push(decodeEmbeddedJson(JSON.parse(text))); } catch {
      throw new Error(`${url} did not return JSON (content-type ${res.headers.get('content-type') || 'unknown'}).`);
    }
    if (i < samples - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  if (bodies.length === 0) {
    throw new Error(`${url} returned ${skipped.join(', ')} on every attempt. Types from an error response would describe the error, not the contract.`);
  }
  return { bodies, skipped, answeredBy };
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
  /** Non-2xx responses that were refused rather than merged. Reported, never silent. */
  const skipped = [];

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
    const resolved = [];
    for (const u of urls) {
      const seen = await observe(u, samples, delayMs);
      bodies.push(...seen.bodies);
      if (seen.skipped.length) skipped.push({ url: u, statuses: seen.skipped });
      // Name the URL that ANSWERED. Every other line in the provenance block is
      // exact; this was the one that could be false, and it was false on every
      // redirect. `res.url` was already in scope.
      resolved.push(seen.answeredBy && seen.answeredBy !== u ? `${u} -> ${seen.answeredBy}` : u);
    }
    name ||= nameFromUrl(url);
    source = resolved.join(', ');
  }

  let profile = structuralProfile(profileValue(bodies[0]));
  for (let i = 1; i < bodies.length; i++) {
    profile = carryOptionality(profile, structuralProfile(profileValue(bodies[i])));
  }

  const notes = [];
  // The refusal travels INTO the file, not just across the terminal. Whoever
  // reads this type later was not here when it ran, and "generated from fewer
  // observations than asked for, because the API was rate-limiting us" is
  // exactly the kind of thing they need in order to trust the optionality.
  for (const s of skipped) {
    notes.push(`${s.statuses.length} of ${samples} responses from ${s.url} returned ${[...new Set(s.statuses)].join('/')} and were REFUSED, not merged. Types from an error response would describe the error, not the contract. Optionality below is therefore based on ${bodies.length} observation${bodies.length === 1 ? '' : 's'}.`);
  }
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
  for (const s of skipped) {
    console.log(`  refused ${s.statuses.length} non-2xx response${s.statuses.length === 1 ? '' : 's'} from ${s.url} (${[...new Set(s.statuses)].join(', ')}) rather than typing the error`);
  }
  if (bodies.length < 3) console.log(`  more observations narrow it further: --samples 5`);
  console.log(`  types only: --no-fixture   print instead of writing: --stdout`);
}

/**
 * The failure path used to be `console.error(err.message)` and nothing else, so
 * a first run from a directory the shell happened to be sitting in produced:
 *
 *   generate: EPERM: operation not permitted, open 'C:\Windows\System32\...'
 *
 * The tool had worked. It fetched, it profiled, it produced a type, and then it
 * could not write to a protected directory. But a raw Node errno reads as "this
 * is broken" rather than "you are in the wrong folder", and it arrives at the
 * single worst moment: the first thirty seconds of the first thing anyone tries,
 * with no account and no prior investment to spend on believing us.
 *
 * A write failure is the ONE error this tool can hit through no fault of the URL
 * it was given, so it is the one worth naming precisely.
 */
const WRITE_FAILURE = {
  EPERM: 'this directory does not allow writes',
  EACCES: 'you do not have permission to write here',
  EROFS: 'this filesystem is read only',
  ENOSPC: 'the disk is full',
};

main().catch((err) => {
  const why = WRITE_FAILURE[err.code];
  if (why) {
    // Recover the directory from the path Node reported, so the message names
    // where it actually tried rather than where we assume it was.
    const dir = err.path ? err.path.replace(/[\\/][^\\/]*$/, '') : process.cwd();
    console.error(`generate: ${why}.`);
    console.error(`  tried to write into ${dir}`);
    console.error(`  cd into your project and run it again, or choose a path with --out`);
    console.error(`  to see the types without writing anything: --stdout`);
  } else {
    console.error(`generate: ${err.message}`);
  }
  process.exitCode = 1;
});
