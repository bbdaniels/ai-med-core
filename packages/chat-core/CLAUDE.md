# chat-core package

`@ai-med/chat-core`: the grounded-conversation engine. Two applications run on it, the clinical simulator (`app: "simulation"`) and document chat (`app: "talk"`: papers, decks, course readings, document advisors). The engine answers one chat turn over one document, with optional corpus retrieval, a structured answer and a beyond-scope flag, and records usage. It knows nothing about HTTP, Kobo, grading or which database it runs on.

## What it exports

`@ai-med/chat-core` (`src/index.ts`):

- **The pipeline** (`src/chat/`). `runChatTurn(req, deps)` (`pipeline.ts`) validates the request, assembles the prompt (`prompt.ts`, `grounding.ts`), completes with the response_format ladder (`completion.ts`) and the retrieval loop (`retrieval.ts`), logs usage (`usage.ts`, which also holds `estimateCost`) and parses the answer (`answer.ts`). `loadChatProjectConfig` (`config.ts`) reads a project's chat settings; `resolveDocumentKey` (`request.ts`) takes `documentKey` or its alias `vignetteKey`; `language.ts` matches a session language to the corpus language.
- **Readings search** (`readings.ts`): `openReadingsIndex`, `searchReadings`, `formatSearchResults` and the `search_readings` tool, over the SQLite index shape defined once in `tools/lib/readings_schema.py`.
- **The OpenAI clients** (`openai-clients.ts`): `openaiClients()`, `clientForPaymentSource()`, `DirectKeyMissingError`. This is the only file in any package or in `tools/` that may call `new OpenAI(` (`openai-clients.test.ts`).
- **The gateway contract** (`gateway.ts`): the env names `HARVARD_GATEWAY_URL` and `OPENAI_API_KEY`, the default host, and the embedding model. `tools/lib/openai_gateway.py` holds the same values for the Python corpus builders; `gateway-contract.test.ts` fails when the two drift and pins the Python side's request headers.
- **Project flags** (`project-config.ts`): `resolveProjectFlags`, which resolves a `project.json` to its `app` and the flags `/api/config` emits (talk implies the four advisor flags), and `talkContradictions`, which `tools/validate-projects.ts` uses.
- **Talk hooks**: `talkHooks()` and `datePreamble` (`chat/hooks.ts`).

`@ai-med/chat-core/talk-url` (`src/talk-url.ts`): DOI normalization and the `talkPublicUrl` fill. It is browser-safe and the frontend imports it on its own, so it must never import a Node module.

`@ai-med/chat-core/test-support/fixture-index`: `buildFixtureIndex()`, a BM25-only readings index in the real schema, for this package's tests and the API's.

## Ports: what an app hands the pipeline

`ChatDeps` is everything `runChatTurn` touches outside itself:

- `store: ChatStore`: the system prompt, a document by key, languages, and the three ledgers (`token_usage`, `qa_log`, `session_log`). The API implements it as `engineStore` (`packages/api/src/db/engine-store.ts`).
- `hooks: AppHooks`: what differs between the apps. The prompt preamble, the case template a response carries, and an optional first-turn hook. `talkHooks()` lives here; `simulationHooks()` is simulator code and lives in the API (`packages/api/src/sim/hooks.ts`).
- `client`: the completion client for this request, chosen by the caller (the API picks it by the project's `payment_source`). The pipeline never builds or fetches a client.
- `openIndex`, `now`, `repoRoot`, `config`.

## What may not be imported

`src/boundaries.test.ts` enforces these:

- nothing under `src/` or `test-support/` imports from `packages/api` (by relative path or as `@ai-med/api`), `express` or `pg`. The engine sits below the apps; the API owns the routes and the database connection;
- every package chat-core imports is declared in its own `package.json`. The API's bundle leaves non-workspace packages external, so a dependency that is only found hoisted would fail at runtime;
- nothing under `src/chat/` calls `openaiClients()` or `clientForPaymentSource()`, builds a client, or imports `openai-clients`.

## Build

There is no build step. The package exports TypeScript source: tsx (dev, tests), Vite (frontend) and the API's esbuild bundle (`packages/api/build.mjs`, which inlines every `@ai-med/*` import and leaves every other package external) all read `src/*.ts`.

## Tests

`npm -w @ai-med/chat-core test` runs `src/*.test.ts` and `src/chat/*.test.ts`; the root `npm test` runs it after the API's. `npm -w @ai-med/chat-core run type-check` type-checks the package and its test support (CI runs it). The pipeline's end-to-end behavior is pinned by the API's chat characterization (`packages/api/src/chat-characterization.test.ts`), which runs the real server.
