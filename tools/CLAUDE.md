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
ADMIN_PASSPHRASE="$ADMIN_PASSPHRASE_PROD" npx tsx tools/push-content.ts --project demo

# Push to local dev
ADMIN_PASSPHRASE=test123 npx tsx tools/push-content.ts --project demo --local
```

Requires `ADMIN_PASSPHRASE` to match the target deployment's configured value.

### Assignments sync

When `projects/<name>/assignments.json` exists, `push-content.ts` diffs the local rows against the remote DB (via `GET /api/admin/vignette-assignments`) using the `(uid, vignette_key)` pair as the key. It then:

- `DELETE`s remote rows that aren't in the local file
- Bulk `POST`s local rows that aren't in the remote DB
- Prints `Diff vs remote: -N / +M` in both real and `--dry-run` modes so you can preview changes

The file format is a JSON array of `{ "uid": "...", "vignette_key": "..." }` objects. Same `uid` can appear multiple times (e.g., teech participants who get both a text and a voice vignette). Assignment row count in the DB stays in sync with the file on every push to main via the existing CI step in `deploy-pages.yml`.

Projects without an `assignments.json` file skip this step silently — the tool also still supports formless and non-assignment projects unchanged.

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

Shared admin API client used by CLI tools. Handles JWT authentication and content CRUD operations.
