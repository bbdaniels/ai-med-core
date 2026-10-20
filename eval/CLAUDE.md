# Evaluation Pipeline

Daily automated evaluation: fetch Kobo submissions, grade with Claude (Opus 5.5, thinking on, the Messages API) against project-specific rubrics, publish dashboard.

## Pipeline Flow

1. **Fetch**: `scripts/fetch_transcripts.py` downloads submissions from Kobo API
2. **Grade**: `scripts/grade.py` discovers rubrics, groups by data source, makes one Messages API call per rubric (`ANTHROPIC_API_KEY`); each graded file records `harness` and `grader_model` (grades before 2026-10-20 came from the Claude CLI and have no `harness`)
3. **Commit**: GitHub Actions commits results back to repo
4. **Dashboard**: Static HTML/JS at `dashboard/` deployed to GitHub Pages

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

`dashboard/` contains a standalone static page with dynamic JavaScript that generates tabs and columns from the rubric structure. Deployed to `/<project>/eval/` on GitHub Pages.

## Gotchas

- `fetch_transcripts.py` filters out `not_approved` submissions (validation status)
- Rubric files must follow naming convention: `*_rubric.json` or `*_checklist.json`
- Eval workflow loops over all projects defined in the GitHub Actions matrix
