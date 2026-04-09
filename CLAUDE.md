# Arbiter Organ (#190)

## Identity

- **Organ:** Arbiter (Bill of Rights Guardian)
- **Number:** 190
- **Profile:** Probabilistic
- **Artifact:** md (no database — vault markdown)
- **DIO Node:** BOR
- **Ports:** 4021 (AOS) / 3921 (SAAS)
- **Binding:** 127.0.0.1

## Dependencies

| Organ | AOS Port | Purpose |
|---|---|---|
| Spine | 4000 | Message bus (WebSocket + HTTP) |
| Graph | 4020 | BoR hash storage, URN minting |

## Key Modules

- `@coretex/organ-boot` — boot factory, Spine client, health/introspect, live loop
- `llm-client` (from organ-shared-lib) — clause matching agent (Haiku)
- `lib/bor-loader.js` — BoR document reader, parser, SHA-256 hash
- `lib/graph-adapter.js` — Graph organ hash registration and verification

## Architecture

Arbiter answers one question: "Is this action permitted under the Bill of Rights?"

Three determinations: IN_SCOPE, OUT_OF_SCOPE, AMBIGUOUS.
Ambiguity is blocking — escalates to human principal via HOM.
Only Nomos and the Human Principal may query Arbiter.

BoR document: `00-Registry/constitutional-policy/bill-of-rights.md`
Test fixture: `test/fixtures/test-bor.md`

## Running

```bash
npm install                # Install dependencies
npm test                   # Run tests
ARBITER_PORT=4021 npm start # Start organ (requires Spine + Graph)
```

## Zero Cross-Contamination Rules

- Never reference `ai-kb.db` or `AI-Datastore/`
- Never reference `AOS-software-dev/` paths
- Never use ports 3800-3851 (monolith range)
- Never import from monolith packages

## Conventions

- ES modules (import/export)
- Node.js built-in test runner (`node --test`)
- Structured JSON logging to stdout
- Express 5 path patterns (from organ-shared-lib)

## Completed Relays

- Relay 1 (a8j-1): Project scaffold + BoR document structure + hash verification
- Relay 2 (a8j-2): Scope query API — access control, determination store, HTTP routes (scope, bor, human)
- Relay 3 (a8j-3): Determination logic — LLM clause matching agent (Haiku), response parsing, fail-safe AMBIGUOUS
- Relay 4 (a8j-4): Amendment proposal drafting — ambiguity tracker, amendment routes, Senate BOR_CONFLICT handler
- Relay 5 (a8j-5): Spine integration — createOrgan() wiring, directed message handlers, LaunchAgent
- Relay 6 (a8j-6): CV tests — 6 categories, 7 Vigil registry entries, entity registration, migration checklist
