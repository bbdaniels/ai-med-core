# Evaluation Pipeline

Daily automated evaluation: fetch Kobo submissions, grade with Claude (Opus 5.5, thinking on, the Messages API) against project-specific rubrics, show the results on a dashboard behind the project admin login.

## Pipeline Flow

1. **Fetch**: `scripts/fetch_transcripts.py` downloads submissions from Kobo API
2. **Grade**: `scripts/grade.py` discovers rubrics, groups by data source, makes one Messages API call per rubric (`ANTHROPIC_API_KEY`); each graded file records `harness` and `grader_model` (grades before 2026-10-20 came from the Claude CLI and have no `harness`)
3. **Commit**: GitHub Actions commits results back to repo
4. **Dashboard**: HTML/JS/CSS at `dashboard/`, served by the API behind the project admin login (`packages/api/src/sim/eval.ts`); never on GitHub Pages

Triggered by `.github/workflows/eval.yml` (daily cron + manual dispatch).

## Dynamic Rubric Discovery

The grader auto-finds `*_rubric.json` and `*_checklist.json` files in each project's eval directory. No hardcoded rubric list.

## Source Protocol

Each rubric declares its data source:
- `transcript` -- grade based on chat transcript text
- `field:<name>` -- grade based on a specific Kobo form field
- `survey_time` -- grade based on submission timing metadata

## Key Scripts

- `scripts/fetch_transcripts.py` -- Fetches from Kobo, skips `not_approved` submissions
- `scripts/grade.py` -- Unified grading with dynamic rubric discovery
- `scripts/lib/` -- Shared Python utilities

## Dashboard

`dashboard/` contains a page with dynamic JavaScript that generates tabs and columns from the rubric structure. It holds no data. The API serves it at `/eval/<url-slug>/` on its own origin (`https://api.ai-med.live/eval/demo/`) for a project that has `projects/<slug>/eval/index.json`, with the project named in the page's `ai-med-project` meta tag, and the page reads its data from `GET /api/admin/eval/index.json` and `GET /api/admin/eval/submissions/<file>.json` with `X-Project` set. Those routes take the admin login (the cookie the login sets on the API's origin): a global admin reads every project, a project admin only their own (401 without a login, 403 for another project's token). The project admin page shows an "Evaluation Dashboard" link when `GET /api/admin/eval` reports results.

The results are participant data (full transcripts, the grader's notes and scores). Never publish them to a static site: `deploy-pages.yml` fails its build if any reach `_site/`. Until 2026-10-23 that workflow copied the dashboard and the data to `ai-med.live/<slug>/eval/`, publicly. Tests: `packages/api/src/eval-dashboard.test.ts`.

## Gotchas

- `fetch_transcripts.py` filters out `not_approved` submissions (validation status)
- Rubric files must follow naming convention: `*_rubric.json` or `*_checklist.json`
- Eval workflow loops over all projects defined in the GitHub Actions matrix
