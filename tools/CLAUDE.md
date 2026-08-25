# Tools Directory

CLI utilities for content management. All run via `npx tsx tools/<script>.ts`.

## push-content.ts

Push all content from a project's `project.json` to a deployment: system prompt, vignettes, Kobo config, languages, case template, and **vignette assignments** (if `projects/<name>/assignments.json` exists).

`push-content.ts` reads `ADMIN_PASSPHRASE` and `DEPLOY_URL` from the environment.
Keep both in the untracked root `.env` (or export them in your shell). **Never write a
passphrase into a tracked file, a command example, a log, or a commit message** -- a
passphrase committed once is compromised for good, and this repo syncs to a public
mirror.

The production passphrase lives in exactly three places: Railway's `ADMIN_PASSPHRASE`
service variable, the `ADMIN_PASSPHRASE_PROD` key in the untracked root `.env`, and the
`ADMIN_PASSPHRASE` GitHub Actions secret. Reference it, never transcribe it.

```bash
# Push to a deployed backend (URL from DEPLOY_URL in .env, or pass --url)
ADMIN_PASSPHRASE="$ADMIN_PASSPHRASE_PROD" npx tsx tools/push-content.ts demo

# Push to local dev
ADMIN_PASSPHRASE=test123 npx tsx tools/push-content.ts demo --local
```

Requires `ADMIN_PASSPHRASE` to match the target deployment's configured value.

### Assignments sync

When `projects/<name>/assignments.json` exists, `push-content.ts` diffs the local rows against the remote DB (via `GET /api/admin/vignette-assignments`) using the `(uid, vignette_key)` pair as the key. It then:

- `DELETE`s remote rows that aren't in the local file
- Bulk `POST`s local rows that aren't in the remote DB
- Prints `Diff vs remote: -N / +M` in both real and `--dry-run` modes so you can preview changes

The file format is a JSON array of `{ "uid": "...", "vignette_key": "..." }` objects. Same `uid` can appear multiple times (e.g., teech participants who get both a text and a voice vignette). Assignment row count in the DB stays in sync with the file on every push to main via the existing CI step in `deploy-pages.yml`.

Projects without an `assignments.json` file skip this step silently — the tool also still supports formless and non-assignment projects unchanged.

## export-conversations.ts

Pull a project's **durable conversation log** down for review. Formless advisors like
`haivn_eip` have no Kobo form, so their conversations live only in the global `qa_log` table
(written by `/api/chat` for projects with `logConversations: true`). This is the read path:
`GET /api/admin/qa-log` behind the same admin auth as every other admin route. Railway's
Postgres has no public URL, so the API is the only way in -- and a container shell would
only ever show you the ephemeral `transcripts/` directory, which is not the store.

```bash
# Last two weeks from a deployment (URL from DEPLOY_URL in .env, or pass --url)
ADMIN_PASSPHRASE="$ADMIN_PASSPHRASE_PROD" \
  npx tsx tools/export-conversations.ts haivn_eip --days 14

# An exact window, and against local dev
ADMIN_PASSPHRASE="$ADMIN_PASSPHRASE_PROD" \
  npx tsx tools/export-conversations.ts haivn_eip --since 2026-08-14 --until 2026-08-25
ADMIN_PASSPHRASE=test123 \
  npx tsx tools/export-conversations.ts haivn_eip --local --days 7
```

Options: `--days <n>` (default 30), `--since YYYY-MM-DD`, `--until YYYY-MM-DD` (inclusive,
UTC; `--since` wins over `--days`), `--url <base>`, `--local`, `--out <dir>` (default
`exports/`). It pages through the endpoint 500 turns at a time, so a long log arrives in
pieces rather than one unbounded response.

Writes two files per run:

- `<project>-conversations-<stamp>.json` -- every row plus range and counts, for analysis
- `<project>-conversations-<stamp>.txt` -- transcript-style, grouped by session, sessions in
  chronological order and turns chronological within each

**Privacy.** These files hold what users actually typed. The consent they saw (each
project's `languages.json`) says conversations are logged so *the project team* can improve
the tool, and asks them not to enter patient-identifiable information. So: `exports/` is
gitignored, the tool prints counts and never conversation content to stdout, and an export
does not belong in the repo, in a shared drive, or in an email. Read it, learn from it,
delete it.

## generate-case.ts

Scaffold and register case variants (demographic variations of base scenarios).

Subcommands:
- `register <template> <profile-id> <project> <file>` -- register a vignette file in project.json
- `scaffold <template>` -- create directory structure for a new case template
- `validate <file>` -- validate a single vignette file
- `validate-project <project>` -- validate all vignettes in a project

## manage-kobo.ts

Kobo form registry management.

Subcommands:
- `list` -- list all registered forms
- `status` -- check deployment status of registered forms
- `register` -- register a new form in `kobo/registry.json`
- `sync-registry` -- sync registry with live Kobo state

## lib/api-client.ts

Shared admin API client used by CLI tools. Handles JWT authentication, content CRUD, and the
conversation-log read (`getQaLog`). One HTTP layer for every tool -- add a method here rather
than a second `fetch` wrapper in a script.

## build-eip-text.py

Rebuilds **every** artifact the `haivn_eip` project derives from the EIP source
Google Doc, from a single parse per language:

- `projects/haivn_eip/content/eip-text.<lang>.md` -- the "EIP Text" reader tab
- `projects/haivn_eip/cases/eip-advisor/content.md` -- the advisor's LLM grounding text
- `projects/haivn_eip/content/eip-<lang>.pdf` -- the "EIP PDF" tab

```bash
python3 tools/build-eip-text.py            # everything, both languages
python3 tools/build-eip-text.py --en-only  # after an English-doc edit
python3 tools/build-eip-text.py --no-pdf   # skip the ~5 MB PDF re-fetches
```

Needs `pandoc` on PATH. **Never hand-edit any of those three outputs** -- the
grounding file used to be maintained by hand while the reader text was
generated, which is two implementations of one job and is how the reader tab and
the model's grounding ended up as separate things to keep in sync. Change the
Google Doc, bump `DOC_IDS` / `EIP_VERSION` at the top of the script if HAIVN cut
a new document rather than revising the old one, and re-run.
