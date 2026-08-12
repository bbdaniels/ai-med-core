# AI-MED Core

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.21895858.svg)](https://doi.org/10.5281/zenodo.21895858)

Open-source platform for AI-powered medical training simulations. Students chat with an AI playing pre-written clinical scenarios ("vignettes"), then complete structured assessment forms via KoboToolbox.

This repo contains the **platform code only**. Clinical content (vignettes, rubrics, forms) lives in separate project directories that you create and manage independently.

## Features

- **Multi-project architecture** -- run multiple independent training programs from one deployment
- **AI patient simulation** -- LLM-powered conversations following structured clinical vignettes
- **KoboToolbox integration** -- structured assessment forms with automatic transcript attachment
- **Multi-language support** -- full i18n for UI, forms, and AI-generated feedback
- **Real-time grading** -- instant student feedback on clinical competencies
- **Batch evaluation** -- instructor-facing analytics pipeline with grading dashboard
- **Admin dashboard** -- manage vignettes, assignments, and translations

## Architecture

Monorepo with npm workspaces:

| Directory | Description |
|-----------|-------------|
| `packages/api/` | Express REST API, LLM integration, database, Kobo proxy |
| `packages/frontend-chat/` | React SPA (Vite), split-panel chat + assessment form |
| `packages/shared/` | Shared TypeScript types |
| `tools/` | CLI utilities (push content, generate cases, manage Kobo) |
| `eval/` | Evaluation pipeline (fetch transcripts, grade, dashboard) |
| `kobo/` | Form templates and XLSForm build scripts |
| `cases/` | Base case templates for generating vignettes |
| `projects/` | Where your project configs go (see below) |

ESM throughout. TypeScript strict mode. Node 22.x (see `engines` in `package.json`).

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Create .env from template
cp env.example .env
# Fill in: OPENAI_API_KEY, KOBO_API_TOKEN, ADMIN_PASSPHRASE, JWT_SECRET

# 3. Start dev servers against the bundled demo project
#    (frontend :3000 + API :3001)
npm run dev
```

`npm run dev` runs the synthetic `projects/demo/` project that ships with this
repo, so the platform boots with no clinical content of your own. The demo case is
invented for smoke-testing and is not clinical guidance.

To run your own project instead, create `projects/<name>/` and select it:

```bash
VITE_PROJECT=your_project npm run dev
```

See [`CREATING-A-PROJECT.md`](CREATING-A-PROJECT.md) for the full guide.

## Creating a Project

Each project lives in `projects/<name>/` with a `project.json` as the single source of truth. A project defines:

- **Vignettes** -- clinical scenarios the AI patient follows
- **System prompt** -- instructions for AI behavior
- **Kobo form** -- structured assessment students complete
- **Scoring rubrics** -- grading criteria for feedback
- **Languages** -- UI translations and form localizations

See [`CREATING-A-PROJECT.md`](CREATING-A-PROJECT.md) for step-by-step instructions and [`projects/CLAUDE.md`](projects/CLAUDE.md) for the full schema reference.

## Deployment

The platform is designed for:
- **Backend**: Any Node.js host (Railway, Render, Fly.io, etc.) with PostgreSQL
- **Frontend**: Static hosting (GitHub Pages, Netlify, Vercel, etc.)

```bash
# Push project content to your deployed backend
ADMIN_PASSPHRASE="..." npx tsx tools/push-content.ts \
  --project your_project --url https://your-api-host.example.com
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key for chat + grading |
| `KOBO_API_TOKEN` | Yes | KoboToolbox API token |
| `ADMIN_PASSPHRASE` | Yes | Passphrase for admin endpoints |
| `JWT_SECRET` | Yes | Secret for JWT signing |
| `DATABASE_URL` | Yes | PostgreSQL connection string (or `sqlite://` for dev) |
| `PORT` | No | API server port (default: 3001) |

## LLM Billing Sources

The platform supports two ways of paying for model calls, selectable per project
through the `payment_source` admin setting:

- **`direct`** -- calls go straight to the OpenAI API and bill the key in
  `OPENAI_API_KEY`. This is the default and the only path most deployments need.
- **`harvard`** -- chat and grading calls are routed through a Harvard HUIT API
  gateway that redeems institutional credits, by setting `OPENAI_BASE_URL` to the
  gateway. The API records the credit balance the gateway returns and exposes it at
  `GET /api/harvard-balance` and in the admin dashboard.

The gateway is optional and institution-specific. It proxies standard
chat-completions models only: text-to-speech and the Realtime API always use a
direct key (`OPENAI_TTS_KEY` / `OPENAI_REALTIME_KEY`), because the gateway's
credit-redemption proxy rejects those models. Leave `OPENAI_BASE_URL` unset and the
whole gateway path stays dormant. Any OpenAI-compatible gateway can be substituted
by pointing `OPENAI_BASE_URL` at it, though the credit-balance fields are specific
to the Harvard gateway's response format.

## Cite this

Daniels, Benjamin B. *AI-MED Core: digital standardized patient research platform*. Zenodo. `https://doi.org/10.5281/zenodo.21895858`

That DOI is the concept DOI, so it always resolves to the most recent release; each release also gets its own version DOI on the Zenodo record. [`CITATION.cff`](CITATION.cff) carries the same metadata in machine-readable form, which is what GitHub's "Cite this repository" button reads.

## Attribution

AI-MED Core descends from content developed in a fork of
[`kobotoolbox/medicalbot`](https://github.com/kobotoolbox/medicalbot), a proof of
concept by Tino Kreutzer, distributed under the MIT License. The platform has since
been rewritten, but that lineage is acknowledged here.

## License

MIT. See [LICENSE](LICENSE).
