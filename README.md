# @shiftgraph/generate

**Your types describe what the docs promise. This generates types from what the API actually returned.**

```bash
npx @shiftgraph/generate https://api.github.com/repos/facebook/react
```

No install, no signup, no config. It requests the URL a few times, profiles each response, and writes a `.ts` file containing TypeScript types and a Zod schema — an artifact you commit, not output you read once.

## Why the types differ from a spec generator's

A specification describes the **union of every response an endpoint can produce**. Your code receives exactly one shape, conditioned on your credentials, your plan, and the state of the thing you asked for. So a generator reading a spec marks nearly everything optional, and optional-everything types push the work back to you at every call site.

Measured against GitHub's own maintained OpenAPI on 2026-07-26:

```
spec promises                    105 fields on /repos/{owner}/{repo}
octocat/Hello-World returns       84
facebook/react returns            86
```

**Optionality here is earned.** A field is marked optional only where the interface was actually watched omitting it. A field never seen absent is required, because that is what came back.

## Usage

```bash
# more samples, better evidence for optionality
npx @shiftgraph/generate <url> --samples 5

# fold several resources: each one can only widen the type honestly
npx @shiftgraph/generate https://api.github.com/repos/facebook/react \
  --also https://api.github.com/repos/octocat/Hello-World

# choose the filename
npx @shiftgraph/generate <url> --out src/types/repo.ts

# print instead of writing a file
npx @shiftgraph/generate <url> --stdout

# anything you already have
cat response.json | npx @shiftgraph/generate --stdin --name Widget
```

## Fold across resources, or your types will be too narrow

`facebook/react` is owned by an organisation and returns `organization` and `custom_properties`. `octocat/Hello-World` is owned by a user and returns neither. **Same endpoint, same moment, same credentials, different contract.**

A type generated from `react` alone marks both fields required, which is wrong for any user-owned repo. Fold with `--also` and they come back correctly optional:

```ts
custom_properties?: Record<string, unknown>;
organization?: { ... };
```

Every generated file records which resources it saw, so the required/optional split is auditable rather than merely confident.

## Where this is worse than what you have

Stated first, because you will find out anyway.

- **Where a vendor ships good official types, use theirs.** Stripe's and OpenAI's SDKs carry methods, auth handling and documentation. These carry none of that. This is strongest where no types exist at all: MCP tool responses, internal services, and the long tail.
- **Few observations means under-evidenced optionality.** Below three, the generated header says so.
- **Error responses are refused.** Types from a 4xx would describe the error, not the contract.

## MCP tools

Roughly two thirds of MCP tools declare no `outputSchema` at all, so an agent calling one has a precise specification for the request and **nothing** for the response it has to reason over.

What they actually return, across the tools we have invoked:

```
9 of 12   { content: [ { type, text } ] }
3 of 12   { content: [...], structuredContent: {...} }
```

Where `text` holds JSON it holds it **as a string**, so the payload sits three levels below where a reasonable guess looks. This decodes that and types the payload, not just the envelope. The envelope varies **per tool** rather than per server, so it cannot be learned once and reused.

## The generated header

Every file records the source, the observation count, the date range, the field and optional counts, the limits that apply to that specific file, and the exact regeneration command. This file gets committed to your repository, so it has to explain itself to whoever opens it next.

## Programmatic use

```js
import { generateModule, toTypeScript, toZod, describeRegeneration } from "@shiftgraph/generate";
import { profileValue, structuralProfile, carryOptionality } from "@shiftgraph/generate/core/shape.js";
```

`describeRegeneration(before, after)` returns a field-level list of what changed between two observations, meant to be readable by someone reviewing the regeneration in a pull request.

Zero dependencies. Node 18+. MIT.
