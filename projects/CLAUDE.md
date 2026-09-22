# Projects Directory

Each subdirectory is a self-contained project deployment. `project.json` is the single source of truth.

## Project Structure

```
projects/<name>/
├── project.json          # Project definition (required)
├── system-prompt.md      # AI behavior instructions
├── languages.json        # i18n strings (pushed to DB)
├── assignments.json      # Optional: uid → vignette assignments (auto-synced by push-content.ts)
├── forms/
│   └── <template>.json   # Kobo form JSON template (omit for formless projects)
├── cases/
│   └── <template>/       # Vignette files (.md)
├── content/              # Optional: tab content files (suggestions, etc.)
│   └── <tab-id>.json     # Self-contained tab content with i18n
└── eval/                 # Evaluation data (auto-generated)
```

## assignments.json (optional)

JSON array of `{uid, vignette_key}` rows mapping participants to vignettes. When a participant visits `ai-med.live/<project>/?values=d[uid]=<their-uid>`, the backend filters vignettes to just the ones assigned to that uid. Multiple rows per uid are allowed — the user cycles through them in order.

`push-content.ts` treats the file as source of truth: on every CI push, it diffs local vs remote by `(uid, vignette_key)` pair and applies deletes/bulk-adds to keep the DB in sync. Projects without an `assignments.json` serve all vignettes to all users (no filtering). See `tools/CLAUDE.md` for full sync semantics.

## project.json Schema

```json
{
  "name": "demo",
  "displayName": "Demo Project",
  "frontend": "chat",
  "cases": {
    "systemPrompt": "projects/demo/system-prompt.md",
    "vignettes": [
      {
        "key": "scene_1",           // Unique key (UUID or readable name)
        "template": "fall_elderly", // Case template name
        "title": "Display title",
        "file": "projects/demo/cases/fall_elderly/scene_1.md",
        "profileId": "profile-name" // Avatar/demographic profile
      }
    ]
  },
  "kobo": {                         // Optional — omit for formless projects
    "template": "projects/demo/forms/diagnosis.json",
    "formUid": "aFAKEuid00000000000000000",
    "formUrl": "https://ee.kobotoolbox.org/single/..."
  },
  "tabs": [                         // Optional — per-project tab structure
    {
      "id": "questions",
      "type": "suggestions",        // "content" | "form" | "suggestions" | "document"
      "order": 0,
      "pinned": true,
      "contentFile": "projects/demo/content/suggested-questions.json"
    },
    {
      "id": "eip-doc",
      "type": "document",           // renders a .md file as formatted markdown
      "order": 1,
      "pinned": true,
      "label": { "en": "Full Document", "vi": "Tài liệu đầy đủ" },
      "contentFile": "projects/demo/content/doc.md",
      "showForVignetteKeys": [      // Optional — tab only visible when selected vignette is in this list
        "vignette-key-1",
        "vignette-key-2"
      ]
    }
  ],
  // Declaring one id TWICE — once "pdf", once "document" — makes those two
  // entries one tab with a Text/PDF switcher (see "Two editions, one tab" below).
  "languages": ["en", "th"],
  "enableFeedback": false,          // Real-time grading/feedback
  "enableVoice": false,             // TTS for assistant messages
  "formless": false,                // Skip the Kobo form tab entirely (Q&A chatbots)
  "enableFollowups": false,         // Inline AI-suggested follow-up questions above chat input
  "talkManifest": "projects/papers/manifest.json", // Optional — public paper list + public_chat kill switch (see below)
  "docRefs": {                      // Optional — linkify document references in chat answers
    "tabId": "eip-doc",             // id of the tab the links point into (its `document` edition)
    "patterns": [                   // surface words -> anchor prefix (the {#sec-…}/{#app-…} ids in the document)
      { "prefix": "sec", "words": ["Section", "Mục", "Phần"] },
      { "prefix": "app", "words": ["Appendix", "Phụ lục"] }
    ]
  },
  "deployment": {
    "tablePrefix": "demo"
  }
}
```

### docRefs — clickable document references in chat answers (optional)

When a project sets `docRefs`, the frontend recognizes numbered references in an
assistant answer ("Section 4.1", "Appendix 7.1", and the Vietnamese "Mục 4.1" /
"Phần 4.1" / "Phụ lục 7.1") and renders them as links that switch the right panel
to the named `document` tab and scroll that passage in. The valid-anchor set is
derived at runtime from the loaded document markdown (the `{#sec-…}`/`{#app-…}`
ids carried by the document itself, identical across languages), so a
reference the model invented — or one to a section that does not exist — stays
plain text; a link is only ever created for an anchor that is actually in the
document. Chat stays plain text otherwise (no markdown rendering). Absent
`docRefs`, the feature is off and answers render byte-identically. Generic: any
document-advisor project with a `document` tab whose headings carry `{#prefix-N}`
anchors can adopt it by declaring its own `tabId` + word/prefix `patterns`.
`projects/haivn_eip/` is the canonical example.

## Validation

`projects/project-schema.json` declares every field a `project.json` may carry (`additionalProperties: false`), and `npm run validate:projects` (`tools/validate-projects.ts`) checks every project against it plus the things a schema cannot express: slug equals directory name, `languages.json` present, every referenced file exists, vignette keys unique. It runs first in `npm run build` and in `deploy-pages.yml`, so a new field must be added to the schema in the same commit that first uses it, or the build fails.

## Formless Projects

Projects with `"formless": true` are pure Q&A chatbots with no Kobo form (e.g. document advisors). For these projects:
- Omit the `kobo` block entirely
- Omit `cases/<template>/scoring_rubric.json` + `assessment_checklist.json` (no grading)
- Set `enableFeedback: false`
- The frontend skips the auto-added form tab; define `tabs` in project.json to give users something to interact with (e.g. a `suggestions` tab)

Reference: `projects/haivn_eip/` is the canonical formless example (EIP Q&A advisor; slug `haivn_eip`, served at `/haivn-eip/`, formerly `stitch`).

### talkManifest — externally embedded advisors and the public-chat kill switch

A formless advisor that other websites link into (e.g. a "Talk to this paper" button beside each publication) declares `"talkManifest": "projects/<slug>/manifest.json"`. The file lists what the external site may offer:

```json
{ "papers": [ { "doi": "10.xxxx/yyy", "title": "...", "vignette": "<vignette key>" } ] }
```

It is served without auth, to any origin, at `GET /api/talk-manifest/<slug>`. Declaring it also puts the project behind the per-project `public_chat` setting, which defaults to **off** and is flipped from the global admin page (`landing/admin.html`, "Public chat") or `PUT /api/admin/public-chat {"enabled": true}`, with no redeploy:

- **On**: the manifest route returns the file (`Cache-Control: public, max-age=300`, so an external page may keep showing buttons for up to five minutes after switching off), and chat works normally.
- **Off**: the manifest route returns `{"papers": []}` (`no-store`), so the external site renders no buttons, and `/api/chat`, `/api/tts`, `/api/realtime/session` and `/api/grade-session` answer 503 `{code: "public_chat_disabled"}`, so bookmarked chat links stop working at once. The frontend shows that error text as the assistant reply.

Unknown slugs and projects without `talkManifest` get 404 from the manifest route; projects without `talkManifest` are untouched by the switch. A malformed manifest file is logged and served as `{"papers": []}`, never a 500.

## Private content (files kept out of git)

Some of what a project serves must not be committed: the `papers` project's vignettes are each paper's full text and its PDF tabs point at the paper PDFs, and several are publisher-copyright. Such files are **gitignored, and the `.gitignore` is the only declaration**: `tools/lib/private-files.ts` asks `git check-ignore`, and every tool uses that one answer.

- `npm run validate:projects` accepts a referenced file that is absent when it is gitignored (a CI checkout lacks it by design) and still fails on any other missing file.
- `tools/push-content.ts` pushes private files when the checkout has them and skips them, leaving the deployed copies in place, when it does not. CI's push therefore keeps everything else current, and the author delivers the private files by running the same push from his own checkout after rebuilding them.
- Private **vignettes** go to the database like any other vignette.
- Private **tab files** (PDFs) go to the deployment's private store, `PRIVATE_CONTENT_ROOT` on the mounted volume (Railway: `web-volume` at `/data`, e.g. `PRIVATE_CONTENT_ROOT=/data/private-content`), at the same repo-relative path they have in a checkout. The API resolves every content path through one function, checkout first and store second, so `project.json` names one path that works in dev and in production. The push uploads only changed files (by SHA-256) and removes stored files `project.json` no longer names. The upload route accepts only paths the project's own tabs name, so a closed-access paper with no PDF tab can never reach the store.
- A PDF tab whose file is in neither place is left out of `/api/tabs` (logged), so a reader never sees a dead viewer.

```bash
python3 tools/build-papers-content.py --sync     # rebuild the paper texts and project.json
ADMIN_PASSPHRASE="$ADMIN_PASSPHRASE_PROD" npx tsx tools/push-content.ts papers --url https://api.ai-med.live
```

The reading index (`readingsIndex`) is private too, but it still has its own upload route and variable (`READINGS_INDEX_<SLUG>`, `tools/upload-readings-index.sh`); folding it into the private store is an open cleanup.

## Tabs: Structure vs. Content

Tab structure (id, type, order, pinned, label) lives in `project.json`. Tab content lives in a separate file pointed to by `contentFile`. This keeps `languages.json` focused on UI strings.

### Tab types

- **`content`** — sectioned markdown cards (heading + content + optional image) rendered via `ContentPanel`. Best for per-scene guides, instructions, reference material organized as distinct sections. CBS-style.
- **`form`** — Kobo assessment form rendered via `NativeKoboForm` (Enketo). Auto-added by the frontend unless `formless: true`.
- **`suggestions`** — grouped clickable question buttons that auto-send to chat on click. Content file is JSON with `{label, intro, sections: [{heading, questions[]}]}`.
- **`document`** — single markdown file rendered as formatted HTML (headings, tables, bold, lists, links). Content file is raw `.md`. Good for embedding reference documents. Ships with a sticky find bar (match counter, prev/next, Enter / Shift+Enter, Escape to clear) and scrolls in-panel to `{#anchor}` heading ids, so a generated contents list at the top of the file works as navigation.

### Two editions, one tab (`pdf` + `document` sharing an id)

A reference document that ships both a PDF and an extracted text is one document,
not two, and a project says so by **declaring the same tab id twice** — once as
`pdf`, once as `document`, each with its own `contentFile`:

```json
{ "id": "eip-doc", "type": "pdf",      "order": 1, "label": {"en": "EIP", "vi": "EIP"},
  "contentFile": { "en": ".../eip-en.pdf", "vi": ".../eip-vi.pdf" } },
{ "id": "eip-doc", "type": "document", "order": 2,
  "contentFile": { "en": ".../eip-text.en.md", "vi": ".../eip-text.vi.md" } }
```

The frontend folds them into one tab carrying a Text/PDF switcher — the same
segmented control the Legal Library uses. **Declaration order decides the default
view**, so the PDF is declared first: it is the document as published, and the
text is our extraction of it. The label and any `showForVignetteKeys` come from
the first entry; the second needs neither.

The shared id is the point. Everything that addresses a tab — `docRefs.tabId`,
the PDF page jumps, the active-tab reselect — keeps working on one stable id
instead of having to know which edition a citation was aimed at. A citation with
a known page opens the PDF view at that page; its "Text" affordance opens the
text view at the anchor; an unmapped anchor falls back to the text view.

`/api/tabs` passes both entries through untouched — the merge is entirely
frontend-side. An id repeated in any other combination (same type twice, or a
type other than `pdf`/`document`) is a config error: the extra entry is dropped
with a console warning rather than rendered behind the same tab button.

### Per-language content files

A tab's `contentFile` may be a single path **or** an object keyed by language code:

```json
"contentFile": {
  "en": "projects/haivn_eip/content/eip-en.pdf",
  "vi": "projects/haivn_eip/content/eip-vi.pdf"
}
```

`/api/tabs?lang=<code>` resolves it (selected language → `en` → whichever single variant exists). The frontend re-fetches `/api/tabs` whenever the language selector changes, so both the tab's content and its label follow the language. Plain-string `contentFile` values keep working unchanged.

Note that the "select the first tab" effect is keyed on the **set** of tab ids, not on tab content — switching language leaves the reader on the tab they were reading, while switching vignette (which changes the set) still brings a newly-revealed tab forward.

A document tab can serve the same source both as a PDF and as sectioned markdown, in more than one language. Where that sectioned text is generated from an upstream source document rather than hand-written, keep the generator in the project and re-run it rather than hand-editing the output, so the `{#sec-…}` anchors stay in step with the source.

### Tab content file formats

JSON files (for `content`, `suggestions`) are loaded via `/api/tabs` and parsed as-is. They should embed their own i18n with object-keyed values:
```json
{
  "label": { "en": "Suggested Questions", "vi": "Câu hỏi gợi ý" },
  "intro": { "en": "Click any...", "vi": "Nhấn vào..." },
  "sections": [
    { "heading": { "en": "...", "vi": "..." },
      "questions": [{ "en": "...", "vi": "..." }] }
  ]
}
```

Markdown files (for `document`) are loaded as raw text and wrapped in `{markdown: "..."}` by the backend. Document tabs should declare their `label` in the tab config (`project.json`), since `.md` files have no structured metadata.

### Label resolution

`/api/tabs` resolves each tab's label as: `tab.label` (from `project.json`) → fallback to `content.label` (from the JSON content file). Document tabs must set `tab.label` since their `.md` contentFile has no label field — except the second entry of a merged pair, which takes the label of the first.

### Per-vignette tab visibility

Tabs can be restricted to specific vignettes with `showForVignetteKeys: [keys...]` in the tab definition. Omit the field to show the tab on all vignettes (default). When set, the frontend hides the tab unless `selectedVignetteKey` is in the list. The `activeTabId` effect reselects the first visible tab on vignette switch, so newly-appearing tabs automatically come into focus. Backend passes the field through `/api/tabs` verbatim.

Use case: TEECH shows a `physical-exams` suggestions tab only on the second (demographic-variant) case of a paired assignment, while the base case has just the form tab.

Legacy projects (e.g. CBS) still embed `tabs` inside `languages.json` — this is supported for backward compatibility but new projects should use the `project.json` + `content/` pattern.

## Inline Follow-up Suggestions

When `"enableFollowups": true`, the backend switches `/api/chat` to JSON mode and the model returns `{answer, followups[], beyondScope}`. The frontend renders 2-3 clickable chips above the input box. Clicking a chip auto-sends it as the next user message.

Best for: open-ended Q&A tools where users explore a topic by drilling into related questions. Not well-suited to structured clinical simulations.

## Beyond-Scope Disclosure

The same JSON channel carries `beyondScope`: the model sets it true when the answer says anything the project's reference content does not itself cover (declined, out of scope, partially covered, or general framing added around the content). The frontend renders a quiet marker under that answer, using `chat.beyondScopeNotice` from `languages.json`, plus a standing line under the input from `chat.groundingNote`. Both are opt-in by translation: a project that supplies neither string shows neither element, so this costs nothing to projects that do not want it. A project that wants the per-answer marker should also spell out in its `system-prompt.md` what counts as beyond its own scope (see `projects/haivn_eip/system-prompt.md`, COVERAGE RULE).

## Vignette Keys

- **UUIDs** (e.g., `dc2e742371344813b4719eae1999af2a`) -- for generated demographic variants
- **Readable names** (e.g., `scene_1`) -- for scene-based projects like CBS

## Case Templates

Shared base templates live in `cases/` at repo root. Project-specific instances are under `projects/<name>/cases/<template>/`. Templates include rubrics (`*_rubric.json`, `*_checklist.json`) for evaluation.

## Adding Languages to a Project

Three things need translations when adding a language:

1. **UI strings** (`languages.json`): `welcome` section (title, subtitle, instructions, bullets, consentParagraphs, button labels) and `chat` section (header, scenario description, placeholders, end screen). App.tsx reads `consentParagraphs` from languages.json, falling back to `DEFAULT_CONSENT_PARAGRAPHS`, which is a bracketed placeholder and not approved text for any study. Every project supplies its own.

2. **Kobo form labels** (`forms/<template>.json`): Use object-valued `label` fields with `"Language (code)"` keys (e.g., `"English (en)"`, `"Français (fr)"`). `build_form.py` auto-detects multi-language labels and outputs `label::Language (code)` columns in the XLSForm.

3. **`project.json` languages array**: List all language codes. Controls the language picker in the frontend.

### Workflow
```bash
# 1. Edit languages.json and forms/<template>.json with translations
# 2. Update project.json languages array
# 3. Build the XLSForm
python3 kobo/build_form.py projects/<name>/forms/<template>.json
# 4. Deploy to Kobo (replace existing form, preserving submissions)
#    Use KoboToolbox MCP: replace_form(form_uid, file_path)
# 5. Push content to production
ADMIN_PASSPHRASE="..." npx tsx tools/push-content.ts <name> --url <deployment-url>
```

### JSON Gotcha
Chinese smart quotes (`\u201c` / `\u201d`) look identical to JSON string delimiters. Always use `\u201c` and `\u201d` escape sequences in JSON files containing Chinese text with quotation marks.

## Pushing Content

Content from `project.json` is pushed to the deployment database:
```bash
ADMIN_PASSPHRASE="..." npx tsx tools/push-content.ts <name> --url <deployment-url>
```

See also: `CREATING-A-PROJECT.md` at repo root for step-by-step project creation guide.
