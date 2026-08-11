# AI-MED Core Platform

AI medical training platform: students chat with AI playing pre-written clinical scenarios ("vignettes"), then complete assessment forms via KoboToolbox. Multi-project capable.

## Architecture

Monorepo with npm workspaces:
- `packages/api/` -- Express REST API, LLM integration, database, Kobo proxy
- `packages/frontend-chat/` -- React SPA (Vite), split-panel chat + form
- `packages/shared/` -- shared TypeScript types
- `projects/` -- where per-project configs go (vignettes, prompts, forms, languages)
- `tools/` -- CLI utilities (push content, generate cases, manage Kobo)
- `eval/` -- evaluation pipeline (fetch, grade, dashboard)
- `kobo/` -- form templates and build scripts
- `cases/` -- base case templates for vignette generation

ESM throughout. TypeScript strict mode. Node 22.x (see `engines` in `package.json`).

## Multi-Project System

Each project lives in `projects/<name>/` with `project.json` as single source of truth (vignettes, system prompt, Kobo form, languages, table prefix).

- **Dev**: `VITE_PROJECT=<name> npm run dev` selects project
- **Build**: Build per-project frontends with different `VITE_PROJECT`, `VITE_BASE_PATH`, `VITE_API_BASE_URL`
- **Routing**: Frontend sends `X-Project: <slug>` header on all API calls. Backend uses `AsyncLocalStorage` to set per-request table prefix (`{prefix}_admin_content`, etc.)

## Dev Setup

```bash
npm install
npm run dev          # Vite :3000 + Express :3001 (concurrently)
```

**IMPORTANT**: Always use `npm run dev` to start BOTH servers. Running only the API causes 404s because the frontend won't be running. Verify both are up:
- Frontend: `http://localhost:3000`
- API: `http://localhost:3001`
- Vite proxies `/api/*` requests from :3000 → :3001

Required `.env` (see `env.example`):
```
OPENAI_API_KEY=...
KOBO_API_TOKEN=...
ADMIN_PASSPHRASE=...
JWT_SECRET=...
DATABASE_URL=sqlite://./local-dev.db
PORT=3001
```

## Deployment

- **Backend + DB**: Any Node.js host with PostgreSQL (Railway, Render, Fly.io, etc.)
- **Frontend**: Any static host (GitHub Pages, Netlify, Vercel, etc.)

Push project content to a deployed backend:
```bash
ADMIN_PASSPHRASE="..." npx tsx tools/push-content.ts --project <name> --url https://your-api-host.example.com
```

## Kobo Integration

Forms managed via KoboToolbox. Two API surfaces:
- **kf** (`kf.kobotoolbox.org`) -- form metadata, XForm XML, v2 REST API
- **kc** (`kc.kobotoolbox.org`) -- submissions via v1 OpenRosa API

Backend proxies both: `/api/enketo-xform` (15-min cache) and `/api/enketo-submit` (rewrites XML to fix kf/kc ID mismatch + injects `formhub/uuid`).

### Transcript Storage Architecture

**Flow: Chat → Filesystem + Kobo**
1. Frontend generates 32-char random token at session start
2. Token prefilled into Kobo form hidden field:
   - Newer forms: `transcriptToken` (dedicated field)
   - Older forms: `chat_transcript` (stores token, later replaced with full transcript)
3. During chat: `POST /api/transcripts/:token` saves to `transcripts/<timestamp>_<token>.txt`
4. After form submit: `POST /api/kobo-transcript` bulk-updates Kobo submission (replaces token → full transcript)
   - Backend searches for submission using `transcriptToken` first, falls back to `chat_transcript`
   - Updates `chat_transcript` field with full transcript (regardless of which field contained the token)
5. **Result**: `chat_transcript` field contains complete conversation, not just token

**CRITICAL**: `/api/kobo-transcript` must complete before grading can work. It searches Kobo for the token, then uses `PATCH /api/v2/assets/{formUid}/data/bulk/` to replace the placeholder with full content.

See [packages/api/CLAUDE.md](packages/api/CLAUDE.md#transcript-storage-architecture) for implementation details.

## Grading & Feedback System

**Two-Tier Architecture:**
1. **Real-time student feedback** (`POST /api/grade-session`):
   - Powered by `gpt-4o-mini` for fast, focused feedback (2-4 strengths, 3-5 growth areas)
   - Enabled per-project via `project.json` `enableFeedback: true`
   - Frontend calls after all forms submitted, displays carousel of feedback cards
   - Grades against scoring rubric (4Ms) + assessment checklist (clinical competencies)
   - **Hallucination guard**: Returns empty strengths if no evidence found in transcript

2. **Batch evaluation for instructors**:
   - Use a more capable model for comprehensive analysis
   - Can be run via cron (GitHub Actions) or manually
   - Outputs detailed rubric scores + checklist results

**Key Project Files:**
- `projects/{slug}/cases/{template}/scoring_rubric.json` -- 4Ms framework (Person-centered, Mobility, Medications, Mind, Matters Most)
- `projects/{slug}/cases/{template}/assessment_checklist.json` -- Clinical competency items (diagnoses, workup, safety, referrals)

**Grading Flow:**
1. Fetch submissions from Kobo by transcript token
2. Load rubrics and checklists for each case template
3. Grade each transcript: `gradeScoringRubric()` + `gradeChecklist()`
4. Synthesize focused feedback: extract strengths with exact quotes, suggest growth areas
5. Return synthesized feedback with opening statement context

See [packages/api/CLAUDE.md](packages/api/CLAUDE.md#grading--feedback-architecture) for implementation details.

## Language Localization

**Multi-language support** via `projects/{slug}/languages.json`:

```json
{
  "languages": [
    { "code": "en", "name": "English" },
    { "code": "fr", "name": "Français" }
  ],
  "ui": {
    "en": { "welcome": {...}, "chat": {...}, "feedback": {...} },
    "fr": { "welcome": {...}, "chat": {...}, "feedback": {...} }
  }
}
```

**Translation System:**
- Frontend uses `t(section, key)` helper to fetch localized strings
- Supported sections: `welcome`, `chat`, `feedback`
- Fallback chain: selected language → English → hardcoded default
- Language persisted in localStorage, passed to backend for LLM prompts

**LLM Language Instructions:**
- All grading prompts include explicit language directives when `language !== 'en'`
- System message: *"CRITICAL: ALL text in your response MUST be written in the language with ISO 639-1 code: {language}"*
- Synthesis prompt includes repeated language reminders before response format
- Fallback messages also constructed in English (template-based, not LLM-generated)

**Key Implementation:**
- [App.tsx](packages/frontend-chat/src/App.tsx): `LanguageUISection` interface, `t()` function
- [grading.ts](packages/api/src/grading.ts): Language instructions in all prompts
- [GradingScreen.tsx](packages/frontend-chat/src/components/GradingScreen.tsx): Translations prop for all UI text
- [NativeKoboForm.tsx](packages/frontend-chat/src/components/NativeKoboForm.tsx): `loadingLabel` prop

See [packages/frontend-chat/CLAUDE.md](packages/frontend-chat/CLAUDE.md#language-localization) for frontend translation details.

## Testing

No automated unit tests. Manual E2E via Playwright scripts.

**Grading Validation:**
- Real-time grading tested manually via frontend `<GradingScreen>` component
- Batch evaluation outputs to `eval/output/`
- Hallucination prevention validated: empty transcripts return zero strengths (guard active)
