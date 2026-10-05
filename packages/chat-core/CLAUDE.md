# chat-core package

`@ai-med/chat-core`: the grounded-conversation engine. Two applications run on it, the clinical simulator (`app: "simulation"`) and document chat (`app: "talk"`: papers, decks, course readings, document advisors). The engine answers one chat turn over one document, with optional corpus retrieval, a structured answer and a beyond-scope flag, and records usage. It knows nothing about HTTP, Kobo, grading or which database it runs on.

## What it exports

`@ai-med/chat-core` (`src/index.ts`):

- **The pipeline** (`src/chat/`). `runChatTurn(req, deps)` (`pipeline.ts`) validates the request, assembles the prompt (`prompt.ts`, `grounding.ts`), completes with the response_format ladder (`completion.ts`) and the retrieval loop (`retrieval.ts`), logs usage (`usage.ts`, which also holds `estimateCost`) and parses the answer (`answer.ts`). `loadChatProjectConfig` (`config.ts`) reads a project's chat settings; `resolveDocumentKey` (`request.ts`) takes `documentKey` or its alias `vignetteKey`; `language.ts` matches a session language to the corpus language.
- **Readings search** (`readings.ts`): `openReadingsIndex`, `searchReadings`, `formatSearchResults` and the `search_readings` tool, over the SQLite index shape defined once in `tools/lib/readings_schema.py`. `searchReadings` takes `docIds` to search only those documents, applied inside both rankers. A project with `"retrievalScope": "document"` searches only the turn's own document (its key as the index's document id), set by the pipeline and never by the model; `"searchFirst": true` makes the first completion of a turn call the tool (`tool_choice: 'required'` on hop 0 only). Both default off.
- **The OpenAI clients** (`openai-clients.ts`): `openaiClients()`, `clientForPaymentSource()`, `DirectKeyMissingError`. This is the only file in any package or in `tools/` that may call `new OpenAI(` (`openai-clients.test.ts`).
- **The gateway contract** (`gateway.ts`): the env names `HARVARD_GATEWAY_URL` and `OPENAI_API_KEY`, the default host, and the embedding model. `tools/lib/openai_gateway.py` holds the same values for the Python corpus builders; `gateway-contract.test.ts` fails when the two drift and pins the Python side's request headers.
- **Project flags** (`project-config.ts`): `resolveProjectFlags`, which resolves a `project.json` to its `app` and the flags `/api/config` emits (talk implies the four advisor flags), and `talkContradictions`, `followHostContradictions` and `rememberConversationContradictions`, which `tools/validate-projects.ts` uses. `rememberConversation` (`{days}` or null) is the talk page's alone: the engine ignores it, since the page sends the whole history with every turn whether or not it was restored from the browser.
- **Following a host page** (`chat/follow-host.ts`): the prompt and history of a `followHost` turn; see below.
- **Grounding** (`chat/grounding.ts`): `corpusGroundingFile` and `loadCorpusGrounding`, the one grounding file of a turn: the current document's grounding set's file when the project lists that set in `groundingSets`, else `groundingFile`, else the legacy locations. See "Grounding" below.
- **Document sets** (`document-set.ts`, also the browser-safe subpath `@ai-med/chat-core/document-set`): `documentSet(key)`, the part of a key before the first `--`, else the key. The one definition: the talk page keys a remembered thread by it and the pipeline picks a grounding set by it. `project-config.ts` holds `groundingSets`, `groundingSetFile`, `groundingSetFiles` and `groundingSetsContradictions`, which the validator, the content push and the server's private store use.
- **Content files** (`content-files.ts`): `resolveProjectContentFile(rel, {repoRoot, privateRoot})`, where a project content path is on disk, the checkout first and the private store (the API's `PRIVATE_CONTENT_ROOT`) second. The API's tab and file routes and the grounding sets use it; there is no second copy.
- **Talk hooks**: `talkHooks()` and `datePreamble` (`chat/hooks.ts`).

`@ai-med/chat-core/talk-url` (`src/talk-url.ts`): DOI normalization and the `talkPublicUrl` fill. It is browser-safe and the frontend imports it on its own, so it must never import a Node module.

`@ai-med/chat-core/test-support/fixture-index`: `buildFixtureIndex()`, a BM25-only readings index in the real schema, for this package's tests and the API's.

## Following a host page (`followHost`)

A talk project that sets `"followHost": true` (with `"embedOrigins"`, the origins allowed to drive it) is embedded in a page that says which document is current, a slide deck for instance, and the reader keeps one conversation going while the document changes. The page side is in `packages/frontend-chat/CLAUDE.md`; this is the server side, and **the contract a followHost project's system prompt is written against**.

**History.** The server holds no conversation: the page sends the whole history with every turn (`messages`), as every page always has. A followHost page tags each question with `documentKey`, the document current when it was asked, and the request's `documentKey` is the current question's. That is the only history path; the qa_log is a write-only record, one row per turn under the turn's own key.

**Prompt shape.** One system message, in this order, so that what does not change from turn to turn comes first and the provider's prompt cache can apply to it:

1. the project's system prompt;
2. the app's preamble blocks (the date);
3. the corpus grounding, if any: **one** file, chosen by the current document (see "Grounding" below);
4. the JSON instruction (`STRUCTURED_INSTRUCTION`; talk implies `enableFollowups`);
5. the language directive (`SPEAK ONLY IN <language>`), if the page sent one;
6. a section headed exactly `## Current document: <title> (<key>)`, then that document's content;
7. if an earlier question in the conversation was asked on a different document, a section headed exactly `## Earlier document: <title> (<key>)`, then the content of the **most recent** such document, one only. It is loaded server-side by key through `ChatStore.getDocument`, like any document; a key the project does not hold gives no section. Nothing about it is taken from the page but the key.

Then the history as chat messages, role and content only (anything else a page sends, a client-side `system` message included, is dropped): each question prefixed `[On: <title>] `, answers as they were. The last question is the current turn's and is always prefixed with the current document, whatever its tag says. A tag naming a key the server does not know (not the current or earlier document, not titled in `project.json`) gets no prefix, so no page-supplied text reaches the prompt as a title.

A title is the vignette's `title` in `project.json` (`cases.vignettes[].title`), else the key itself. The history is capped at `historyTokens` estimated tokens (characters / 4; default 24,000, `DEFAULT_HISTORY_TOKENS`, sized for gpt-4o-mini's 128k context next to a 12k-token document pair): whole turns are dropped, oldest first, and the current question is always kept. The earlier document is found from the whole history, not only the turns the cap kept. The log keeps every turn.

Compared with a project that does not follow a host (`assemblePrompt`: system prompt, preamble, document, grounding, JSON instruction, language), the document moves after the stable parts and gains its heading. Every other project's prompt is unchanged: `pipeline.ts` takes this path only when `config.followHost` is set, and ignores `documentKey` tags otherwise.

Tests: `src/chat/follow-host.test.ts` (the parts), `src/chat/pipeline.test.ts` (the branch), and `packages/api/src/follow-host.test.ts`, a characterization through the real server on an invented fixture project (switch, earlier-document section, an unknown key, the history cap), with its snapshot in `packages/api/test-fixtures/follow-host/snapshots.json`.

## Grounding

A turn's corpus grounding is one file, resolved by `corpusGroundingFile(repoRoot, config, {documentKey, privateRoot})`:

1. if the project lists the current document's set in `groundingSets` (project.json; the set is `documentSet(documentKey)`, the part of the key before the first `--`), the file `projects/<slug>/grounding/<set>.md`, looked up in the checkout and then in the private store (`ChatDeps.privateContentRoot`);
2. else, and also when a listed set's file is in neither place (logged as a warning), `groundingFile`;
3. else the legacy locations, `content/legal/grounding.md` then `content/readings/grounding.md`.

It goes where the corpus grounding always went: item 3 of a followHost prompt above, and after the document in every other project's prompt. **One grounding per turn, chosen by the current document alone.** In a followHost turn the earlier document shares the current document's grounding when it is of the same set; when it is of another set it is sent under its `## Earlier document` heading with no grounding of its own, and that set's file is not read. A project that follows a host across sets should therefore keep in each set's file what a reader needs to read that set's documents, and write its documents so that the earlier one stands on its content alone. A project that lists no sets grounds exactly as before.

Tests: `src/chat/grounding.test.ts` (the order of resolution, the store, the fallback), `src/chat/pipeline.test.ts` (the turn's document picks the set; the earlier-document rule) and `packages/api/src/grounding-sets.test.ts`, a characterization through the real server on an invented fixture project with a private store (a set in the checkout, a set only in the store, a document outside the sets, an earlier document of the same set and of another, and the store's upload guard), with its snapshot in `packages/api/test-fixtures/grounding-sets/snapshots.json`.

## Ports: what an app hands the pipeline

`ChatDeps` is everything `runChatTurn` touches outside itself:

- `store: ChatStore`: the system prompt, a document by key, languages, and the three ledgers (`token_usage`, `qa_log`, `session_log`). The API implements it as `engineStore` (`packages/api/src/db/engine-store.ts`).
- `hooks: AppHooks`: what differs between the apps. The prompt preamble, the case template a response carries, and an optional first-turn hook. `talkHooks()` lives here; `simulationHooks()` is simulator code and lives in the API (`packages/api/src/sim/hooks.ts`).
- `client`: the completion client for this request, chosen by the caller (the API picks it by the project's `payment_source`). The pipeline never builds or fetches a client.
- `openIndex`, `now`, `repoRoot`, `config`.
- `privateContentRoot` (optional): the private store a grounding set's file may be in when the checkout lacks it. The API passes `PRIVATE_CONTENT_ROOT` (`packages/api/src/repo-root.ts`); omitted, only the checkout is read.

## What may not be imported

`src/boundaries.test.ts` enforces these:

- nothing under `src/` or `test-support/` imports from `packages/api` (by relative path or as `@ai-med/api`), `express` or `pg`. The engine sits below the apps; the API owns the routes and the database connection;
- every package chat-core imports is declared in its own `package.json`. The API's bundle leaves non-workspace packages external, so a dependency that is only found hoisted would fail at runtime;
- nothing under `src/chat/` calls `openaiClients()` or `clientForPaymentSource()`, builds a client, or imports `openai-clients`.

## Build

There is no build step. The package exports TypeScript source: tsx (dev, tests), Vite (frontend) and the API's esbuild bundle (`packages/api/build.mjs`, which inlines every `@ai-med/*` import and leaves every other package external) all read `src/*.ts`.

## Tests

`npm -w @ai-med/chat-core test` runs `src/*.test.ts` and `src/chat/*.test.ts`; the root `npm test` runs it after the API's. `npm -w @ai-med/chat-core run type-check` type-checks the package and its test support (CI runs it). The pipeline's end-to-end behavior is pinned by the API's chat characterization (`packages/api/src/chat-characterization.test.ts`), which runs the real server.
