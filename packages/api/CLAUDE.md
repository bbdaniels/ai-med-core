# API Package

Express REST API serving the AI-MED platform. Handles LLM chat, database, admin panel, and Kobo form proxying.

## Key File

`src/server.ts` -- monolith containing all routes, middleware, and database initialization. ~1200 lines.

## Database

- **Dev**: SQLite via `better-sqlite3` (path from `DATABASE_URL=sqlite://./local-dev.db`)
- **Prod**: PostgreSQL via `pg` (standard connection string)
- **Multi-tenancy**: `X-Project` header triggers `runWithProject()` which sets table prefix in `AsyncLocalStorage`. All queries use `getTablePrefix()` to scope tables (e.g., `demo_admin_content`, `cbs_admin_content`).
- **Schema**: Single `admin_content` table with `content_type` discriminator (`system_prompt`, `vignette`, `kobo_form_url`, `kobo_form_uid`, `languages`, `case_template`). Separate `vignette_assignments` table for user-to-vignette mapping.

## API Endpoints

### Public
- `POST /api/chat` -- AI chat (GPT-4o-mini). Rate limited: 1 req/sec burst, 100/15min. Returns `{message, followups[], beyondScope, usage, caseTemplate}`. When project has `enableFollowups: true`, uses JSON mode and returns 2-3 contextual follow-up questions plus the beyond-scope flag.
- `GET /api/config` -- Returns koboFormUrl, koboFormUid, languages, tablePrefix, enableFeedback, enableVoice, formless, enableFollowups, docRefs (the document-reference linking config, or null; see frontend `doc-refs.ts`)
- `GET /api/tabs` -- Returns `{tabs: [{id, type, order, pinned, content}]}` for the active project. Reads `tabs` array from project.json and resolves each `contentFile` from the filesystem. Returns empty array if project omits `tabs` (frontend then falls back to legacy `langs.tabs`).
- `GET /api/vignettes` -- Vignette keys (filtered by `?uid=` if assignments exist)
- `GET /api/enketo-xform` -- Proxy XForm XML from Kobo (15-min cache)
- `POST /api/enketo-submit` -- Proxy submission to Kobo v1 with XML rewriting
- `POST /api/transcripts/:token` -- Write transcript to the container filesystem. **Dev-only and ephemeral**: no Railway volume is mounted, so a redeploy wipes it, and its only frontend caller is `?wip`-gated. Not a store -- see Transcript Storage Architecture below.
- `GET /t/:token` -- Serve transcript by token (text/plain), from that same ephemeral directory
- `POST /api/kobo-transcript` -- **CRITICAL**: Write full transcript to Kobo submission (replaces token)
- `POST /api/grade-session` -- Grade multiple submissions by token (real-time feedback)

### Admin (JWT in HTTP-only cookie)
- `POST /api/admin/login` -- Authenticate with `ADMIN_PASSPHRASE` (5 attempts/15min)
- `GET/POST /api/admin/content` -- Get/save all content
- `POST/DELETE /api/admin/vignette` -- Manage vignettes
- `POST /api/admin/vignette-assignments` -- Assign vignettes to users
- `GET /api/admin/qa-log` -- Read back the durable conversation log for the active project. Params: `days` (relative, default 30) **or** `since=YYYY-MM-DD` (plus optional `until=YYYY-MM-DD`, inclusive of that whole day, UTC); `limit` (default 500, cap 2000) and `offset` for pagination. Returns `{project, days, since, until, limit, offset, total, returned, hasMore, rows[]}` with rows oldest-first. CLI wrapper: `tools/export-conversations.ts`.

## Inline Follow-up Suggestions (enableFollowups)

When a project's `project.json` has `"enableFollowups": true`, `/api/chat`:
1. Appends a JSON-format instruction to the system prompt: return `{"answer": "...", "followups": ["q1", "q2", "q3"], "beyondScope": false}`
2. Sets `response_format: {type: 'json_object'}` on the OpenAI call
3. Parses the returned JSON, splits into `message` (the answer) + `followups` array (capped at 3) + `beyondScope` boolean
4. On JSON parse failure, falls back to returning the raw content with empty `followups` and `beyondScope: false`

The frontend renders these as clickable chips above the input; click → auto-send. The `enableFollowups` flag is read per-request from `projects/<slug>/project.json` on the filesystem — no DB storage, no push-content.ts step needed.

### beyondScope (per-answer disclosure)

`beyondScope` rides the same structured channel rather than an in-band marker in the prose, so the model cannot leak the signal into the answer text and a missing field degrades to `false` instead of a stray token on screen. It is `true` when the answer states anything the project's reference content does not itself cover — a declined or out-of-scope question, a partially covered one, or general framing added around the reference content. The strict `json_schema` lists it in `required`, so the model must emit it; the `json_object` and no-`response_format` fallbacks parse it when present. The frontend shows a localized marker on flagged answers (`chat.beyondScopeNotice`) alongside a standing disclaimer (`chat.groundingNote`); a project that ships neither string sees no change.

## Tabs Architecture

Tab structure lives in `project.json`'s `tabs` array; tab content lives in separate files (JSON or Markdown) pointed to by each tab's `contentFile`. `/api/tabs` reads project.json at request time, resolves each tab's file from the filesystem (path-traversal-guarded against REPO_ROOT), and returns the merged structure inline.

**File type handling:**
- `.json` files — parsed and returned as the tab's `content` object. Label resolution: `tab.label` (from project.json) wins over `content.label`.
- `.md` files — loaded as raw text, wrapped in `{markdown: "..."}` as the tab's content. Label must come from `tab.label` in project.json.
- `.pdf` files — not read; returned as `{pdfUrl: "/api/project-content/<path>"}` for the frontend to embed.

**Per-language content:** `contentFile` may be a string or an object keyed by language code (`{en: "...", vi: "..."}`). `GET /api/tabs?lang=<code>` picks the variant, falling back selected → `en` → any. `lang` is validated against `/^[a-z]{2}$/` before use, so it can't be steered into the object as an arbitrary key; the path-traversal guard against `REPO_ROOT` applies to the resolved path exactly as before. Omitting `lang` yields English.

This deliberately bypasses the database — tab content is treated as code-adjacent configuration, authored in source files, served fresh on each request. No admin UI for editing, no migration concerns, no DB content_type to add. Legacy projects (CBS) that embed tabs in `languages.json` still work: the frontend falls back to `langs.tabs` when `/api/tabs` returns empty.

## Transcript Storage Architecture

Two durable stores, plus one that is not durable and must not be mistaken for one.

### `qa_log` -- the conversation store for formless projects

Formless advisors (`formless: true`, e.g. `haivn_eip`) have no Kobo form, so the Kobo flow
below never runs for them. Their conversations live in `qa_log`: a **global** table (not
project-prefixed) with a `project` column, one row per chat turn.

```
id | project | session_token | vignette_key | language | question | answer | created_at
```

- **Write**: `POST /api/chat` calls `logQaTurn()` (`database.ts`) when the project sets
  `logConversations: true` in `project.json`. Fire-and-forget: the promise is caught and
  warned, so a logging failure can never break a reply. `session_token` is the same
  transcript token the frontend generates, which is what lets turns be regrouped into
  conversations; it is `NULL` when a turn arrives without one.
- **Read**: `getQaLog()` (`database.ts`) behind `GET /api/admin/qa-log`. Both the SQLite and
  Postgres branches normalize `created_at` to the same ISO-8601 UTC string, so a client sees
  one format regardless of backend. Ordered `(created_at, id)` ascending for stable
  pagination and chronological export.
- **Export**: `tools/export-conversations.ts` pages through the endpoint and writes a JSON
  plus a session-grouped text rendering to the gitignored `exports/`.
- **Privacy**: users consent to the *project team* reading these turns to improve the tool
  (see each project's `languages.json` consent text) and are asked not to enter
  patient-identifiable data. Admin auth is the boundary; do not widen it, do not print
  conversation content to stdout, do not commit an export.

### `transcripts/` -- ephemeral, dev-only, not a store

`POST /api/transcripts/:token` writes `transcripts/<ISO-timestamp>_<token>.txt` on the API
container's local filesystem. Railway mounts **no volume** there, so every redeploy destroys
the directory, and the only frontend caller is `?wip`-gated so real sessions never reach it.
Useful for eyeballing a transcript during local development; worthless as a record.

### Kobo -- the canonical store for form-based projects

**Flow: Frontend → Kobo**

1. **During Chat**: the token is prefilled into the Enketo form's hidden fields
   - Token: 16+ char random hex (generated client-side)
   - With `?wip` on, also POSTed to `/api/transcripts/:token` (see above)

2. **After Form Submit**: Frontend calls `POST /api/kobo-transcript`
   - Searches for Kobo submission by token in `transcriptToken` field (newer forms) or `chat_transcript` field (older forms)
   - Uses **bulk PATCH** to write full transcript into `chat_transcript` field
   - CRITICAL: Must happen AFTER Enketo submit, uses token as lookup key
   - Endpoint: `PATCH /api/v2/assets/{formUid}/data/bulk/` with `{payload: {submission_ids: [...], data: {chat_transcript: <full_transcript>}}}`
   - Backward compatibility: Supports both field naming conventions

3. **Result**: Kobo submissions have complete transcripts in `chat_transcript` field (not just tokens)

## Grading & Feedback Architecture

**Two-Tier System:**
1. **Real-time feedback** (student-facing): `gpt-4o-mini` via `POST /api/grade-session`
2. **Batch evaluation** (instructor-facing): `claude-opus-4` via GitHub Actions cron

### Real-Time Grading Flow (`/api/grade-session`)

```typescript
// Input: { tokens: string[], language: string }
// Output: { synthesized: { [token]: { strengths: [], growthAreas: [], openingStatement: string } } }
```

**Steps:**
1. Fetch submissions from Kobo by token (searches `transcriptToken` or `chat_transcript` field)
2. Extract `chat_transcript` (full transcript), `vignette_id`, `case_template` from each submission
3. Load scoring rubrics and assessment checklists from `projects/{slug}/cases/{template}/`
4. **Grade** each submission:
   - `gradeScoringRubric()` → scores 4Ms rubric items, returns enriched results with evidence
   - `gradeChecklist()` → binary yes/no for assessment items (diagnoses, workup, safety)
5. **Synthesize** focused feedback (2-4 strengths, 3-5 growth areas):
   - Extract opening statement (first `Assistant:` message from transcript)
   - `synthesizeFeedback()` → LLM condenses rubric scores into learner-friendly narratives
   - **Hallucination Guard**: If `scoredItems.length === 0`, return empty strengths (bypass LLM)
   - Strict prompt: "ONLY include items with EXACT QUOTES from evidence"

**Key Files:**
- `src/grading.ts` → `gradeSession()`, `gradeScoringRubric()`, `gradeChecklist()`, `synthesizeFeedback()`
- `projects/{slug}/cases/{template}/scoring_rubric.json` → 4Ms rubric (Person-centered, Mobility, Medications, Mind, Matters Most)
- `projects/{slug}/cases/{template}/assessment_checklist.json` → Clinical competency checklist (diagnoses, workup, referrals, safety)

**Hallucination Prevention:**
- Guard at synthesis entry: `if (scoredItems.length === 0) return { strengths: [] }`
- Prompt includes: "If evidence list is empty, return empty strengths array: {\"strengths\": []}"
- Only cite exact quotes from `evidence` field in rubric scores

**Language Support:**
- `language` parameter passed to all grading functions (ISO 639-1 code, e.g., "fr", "es")
- When `language !== 'en'`, prompts include explicit directives:
  - System message: *"CRITICAL: ALL text in your response MUST be written in the language with ISO 639-1 code: {language}. This is non-negotiable. Every single word must be in this language, not in English."*
  - Rubric prompt: *"CRITICAL: You MUST write ALL text (including overall_notes) in the language..."*
  - Checklist prompt: *"CRITICAL: You MUST write ALL text (including evidence quotes) in the language..."*
  - Synthesis prompt: *"🌍 CRITICAL REQUIREMENT: You MUST provide ALL feedback text in the language..."* + reminder before response format
- Fallback messages (when LLM fails) constructed from templates:
  - Questions: `"Next time, try asking: \"${question}\""`
  - Criteria: `"Next time, consider: ${criterion.toLowerCase()}"`
  - These templates are in English but can be localized by updating the fallback logic in `synthesizeFeedback()`

## Kobo Submission Gotchas

The kf and kc APIs have mismatched identifiers:
- kf serves XForms with `id="ai_med_diagnosis"` (XForm title)
- kc registers forms with `id_string=<asset_uid>`
- Solution: `rewriteSubmissionXml()` replaces the `id` attribute and injects `<formhub><uuid>...</uuid></formhub>`

Other gotchas:
- kc v1 `/api/v1/submissions` returns OpenRosa XML (not JSON) on 201
- kf v2 `/api/v2/assets/{uid}/data/` does NOT accept POST submissions
- Individual PATCH on `/data/{id}/` returns 405 -- always use bulk endpoint

## Build

```bash
npm run build    # esbuild → dist/server.js (ESM, external packages)
npm run dev      # tsx watch
npm start        # NODE_ENV=production node dist/server.js
```

When `SERVE_FRONTEND=true`, serves the built frontend from `packages/frontend-chat/dist/`.
