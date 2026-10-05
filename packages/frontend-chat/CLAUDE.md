# Frontend Chat Package

React SPA with split-panel layout: AI chat (left) + assessment form (right). Includes admin dashboard at `/admin`.

## Two pages, one set of parts

The package builds one of two pages, chosen at build time by `VITE_APP`:

- **Simulator** (`VITE_APP` unset): `src/main.tsx` mounts `src/App.tsx` -- consent → chat + form → transition → next case → grading → end screen, plus the realtime voice page (`?mode=voice`).
- **Talk** (`VITE_APP=talk`): `src/talk-main.tsx` mounts `src/talk/TalkApp.tsx` -- chat about documents (papers, slides, readings, a reference document and its legal library). No welcome page, form, grading or voice, and it imports nothing from Kobo, enketo or grading, so a talk build ships none of that code (CI checks: `test.yml`, "Talk build carries no form code").

`vite.config.ts` (plugin `app-entry`) rewrites `index.html`'s entry script to `/src/talk-main.tsx` when `VITE_APP=talk`, in build and dev; `index.html` stays one file. Any other `VITE_APP` value fails the build, as does `VITE_APP=talk` for a project whose `project.json` does not declare `"app": "talk"`. `deploy-pages.yml` sets `VITE_APP=talk` on the four talk projects' blocks. Both entries serve `/admin` (`src/admin-route.tsx`).

Both pages are composed from the same parts in `src/chat/`, so a fix lands once:

| Part | What it holds |
|---|---|
| `useProjectConfig.ts`, `project-config.ts` | `/api/config`, read by `parseProjectConfig` (checked by `src/project-config.check.ts`) |
| `useAccessGate.ts` | stored token, `#code=` redemption and scrub, `accessReady`, when the gate shows |
| `useLanguages.ts` | languages file, the reader's language, `t()`, starter questions, the tab title |
| `useDeepLink.ts` | `?vignette=` / `?doc=` / `?paper=` through the talk manifest, the picker, `requireKnownVignette` and its refusal, the `talkPublicUrl` redirect, `embeddedInFrame`, the `orcid-display:talk-close` message, posted by the header's Close and by Escape anywhere in a framed page through `src/frame-escape.ts` (one window listener; skips IME composition and an Escape a popover already consumed; checked by `src/frame-escape.check.ts`) |
| `useChatSession.ts` | messages, input, follow-ups, beyond-scope flags, session token, opening turn. A page that speaks its answers (the simulator's TTS) sets `speak` and takes each reply through `beginSpeaking()` / `revealPending()`. A page that remembers the conversation passes `remember` (see "Remembering the conversation" below) |
| `../remember-conversation.ts` | a `rememberConversation` project: the saved thread in localStorage, its window, its key per document set (checked by `src/remember-conversation.check.ts`) |
| `useHostDocument.ts`, `../host-document.ts` | a `followHost` project in a frame: the host page's current document (`host:document`), the `talk:ready` message, the "Now on" dividers, and when sending is blocked (checked by `src/host-document.check.ts`); see "Following a host page" below |
| `useTabs.ts`, `tabs.ts` | `/api/tabs`, `resolveTabs`, merged editions, first-visit mounting (checked by `src/tabs.check.ts`) |
| `useDocRefs.ts`, `AssistantContent.tsx` | document and legal references in answers, page maps, jump requests |
| `TabViews.tsx` | every tab view but the form, the desktop tab panel, the mobile strip |
| `ChatColumn.tsx` | top bar, header, picker, conversation, starters, follow-ups, input; page-specific controls come in through `headerSlot` and `voiceSlot` |
| `Screens.tsx` | access gate, unknown-document refusal, loading screen |

`App.tsx` still carries the talk branches (manifest, picker, refusal) for one release so a rollback of the Pages flag alone restores the old page; they are removed one release later.

To check a page inside a frame (the paper popout, a deck's Ask popover), use `tools/embed-harness.html`; see `tools/CLAUDE.md`.

## Following a host page (`followHost`)

A talk project that sets `"followHost": true` in `project.json` is driven by the page that frames it: a deck's side panel stays open, with the talk page alive in its iframe, while the reader tabs through slides, and the deck tells the page which slide is current. The conversation is one session across them. Only the talk page does this, only inside a frame (a top-level visit behaves as any project), and only for that project; every other project's page is unchanged. The messages and their checks are in `src/host-document.ts`:

- **Ready.** Once the page is mounted and access is settled (the access code entered once, as on any gated project, and the document list loaded), it posts `{type: 'talk:ready'}` to its parent with target origin `'*'`, which is acceptable only because it carries nothing. The host answers with the current document and sends it again on every change.
- **Documents.** The host posts `{type: 'host:document', key: '<key>' | null, title: '<string>'}`. The page obeys it only when the project sets `followHost`, the page is framed, `event.source === window.parent`, and `event.origin` is exactly one of the project's `embedOrigins` (`/api/config`). Anything else is dropped silently. The close message `orcid-display:talk-close` and Escape (`src/frame-escape.ts`) are unchanged.
- **The current document.** The host's latest word, else the document the link names (`?vignette=`), checked against the deployment's document list on every switch (`requireKnownVignette`, applied per switch rather than per link; a link naming none, or one the deployment lacks, waits for the host instead of being refused). The header shows the host's title, else the document's own. A `null` key, or one the deployment does not hold, leaves the conversation in place, shows `chat.noCurrentDocument` above the input (a generic default when the project has none), and disables the send button and the chips until a document is current again; what was typed stays in the box.
- **One thread.** Switching never clears the conversation and never draws a new session token. Each question carries the key and title of the document current when it was asked (`questionOn`); the key goes to `/api/chat` with the history, where the server builds the prompt around it (`packages/chat-core/CLAUDE.md`, "Following a host page"), and the title stays on the page. The thread shows a divider, `chat.nowOn` (default "Now on:") and the title, only before a question asked on a different document from the question before it (`threadWithDividers`), so paging through twenty slides without asking adds nothing, and consecutive switches collapse into one.

To try it, frame the page in `tools/embed-harness.html` served on an origin the project lists; each panel can send `host:document` (see `tools/CLAUDE.md`).

## Remembering the conversation (`rememberConversation`)

A talk project that sets `"rememberConversation": {"days": N}` (1 to 30; `projects/CLAUDE.md`) keeps the conversation in the reader's browser. Only the talk page does this, and only for that project. The storage and its rules are in `src/remember-conversation.ts`:

- **What is saved.** After every answer (`useChatSession`, once the turn has landed and the thread holds a question): the visible messages with their followHost tags (`documentKey`, `documentTitle`) and beyond-scope flags, the session token, and the time of the last turn, as one JSON entry under `talk_thread:<project>:<set>`. The dividers are not stored; `threadWithDividers` draws them again from the tags. The access token is not part of it and stays where it was (`api-base.ts`); the access code is never stored.
- **The set.** The part of the document key before `--`, else the whole key (`documentSet`). A followed page keeps the set of the first document it was on, so a host that moves to another deck does not move the thread with it; any other page follows its open document (`threadSetFor`). Two decks never share a thread.
- **Coming back.** When the conversation opens, a saved thread whose last turn is within the window is shown in place of the opening, and the next question carries on with the whole history (the server holds none). A thread outside the window, or a damaged entry, is removed and the opening shown. On each load the page also removes this project's other expired threads (`sweepExpiredThreads`).
- **The session token** is minted by the page (`randomToken`, 32 hex digits) and only groups the conversation's rows in `qa_log` and `session_log`; the server never verifies it, so it cannot expire or be refused. A restored thread keeps its token (`tokenForEpoch`: the restored token wins the epoch it was restored in). A saved token that is missing or malformed is dropped and the freshly drawn one carries the thread on; the thread is kept either way. The talk page no longer bumps the epoch when the conversation starts (that drew a second token a render later and would have replaced a restored one); it bumps it on a language switch, a paper opened from the picker, and New conversation.
- **New conversation**, a quiet text control under the header's title, shown once the thread has a question and disabled while an answer is pending: it removes the saved thread (`forgetSaved`), clears the conversation (`reset`) and draws a new epoch, so a fresh token and the opening follow, on the current document. On a thread of four questions or more the first press turns it into `chat.newConversationConfirm` (default "Clear this conversation?") for five seconds and a second press clears. Strings: `chat.newConversation` (default "New conversation"), `chat.newConversationConfirm`. No `window.confirm`: a dialog from a cross-origin frame is suppressed by some browsers.
- **When storage fails.** Every read and write is try/caught. A private window, blocked site data or Safari's tracking prevention in a third-party frame (the deck on another site frames this page) can make storage throw or come back empty, and the page then behaves exactly as it did before: the conversation lasts the page's life. A write refused for quota is dropped silently. Browsers that partition third-party storage (Safari, Chrome, Firefox) keep a framed page's thread per top-level site, so a deck opened on the public site and the same deck on the local deck server keep separate threads; Safari may also clear a framed site's storage after seven days without a visit, which is about the window anyway.

## Key Files

- `src/App.tsx` -- The simulator page (see above)
- `src/talk/TalkApp.tsx` -- The talk page (see above)
- `src/components/NativeKoboForm.tsx` -- Enketo-core form rendering with prefill injection
- `src/components/SuggestedQuestions.tsx` -- Clickable topic-outline tab (formless projects)
- `src/components/DocumentPanel.tsx` -- Full-markdown document tab (renders a single .md file)
- `src/components/ContentPanel.tsx` -- Sectioned markdown content tabs (heading + body cards)
- `src/components/enketo-form.css` -- Custom dark-mode styles for enketo forms
- `src/api-base.ts` -- `apiFetch()` wrapper that adds `X-Project` header from `VITE_PROJECT`
- `style.css` -- Global styles, CSS custom properties for light/dark mode

## Enketo Integration

Native browser-side XForm rendering (no Kobo iframe):

1. Backend serves XForm XML via `/api/enketo-xform` (cached)
2. `enketo-transformer/web` transforms XML → HTML + model (browser XSLT, zero native deps)
3. `enketo-core` renders form with skip logic, validation, widgets
4. Prefill values injected into model XML and passed as `instanceStr` to `form.init()`
5. Submission proxied through `/api/enketo-submit`

### Vite Aliases (vite.config.ts)

Enketo-core expects certain module paths. Vite aliases resolve these:
- `enketo/config`, `enketo/widgets`, `enketo/translator`, `enketo/dialog`, `enketo/file-manager`, `enketo/xpath-evaluator-binding`
- Stubs for unused deps: leaflet, maps

### CSS Gotchas

Enketo-core uses these CSS classes for branch/relevance visibility:
- `disabled` -- branch is not relevant (should be hidden)
- `pre-init` -- branch not yet evaluated (should be hidden)
- A branch with just `or-branch` (no `disabled`, no `pre-init`) IS visible

**Do NOT** use `.or-branch { display: none }` -- that hides everything. Instead:
```css
.or-branch.disabled, .or-branch.pre-init { display: none; }
```

Other CSS patterns:
- `.itemset-template` must be `display: none !important` (ghost radio option template)
- Required asterisk: hide `span.required`, inject via `.question:has(> span.required) > .question-label.active::after`
- `.or-required-msg` hidden by default, shown only when `.invalid-required` present on question

`.document-panel` / `.document-panel-body` are defined ONCE, in `style.css` next to
the `.document-search` find-bar rules. Until 2026-09-08 a second, unscoped copy of
the whole set sat ~500 lines further down and won the cascade property by property
(later block, equal specificity), so the rendered panel was the union of two blocks
neither of which described it -- for instance the reading padding came from the
first copy and the 0.9rem body size from the second. The blocks were merged into
the surviving one and verified byte-identical: 21 elements x 37 computed properties,
zero differences. Do not reintroduce a second block; extend the existing one.

### Toggle appearance (iOS-style yes/no pill)

Any `select_one` question with `appearance: "toggle"` renders as a compact row: question label on the left, segmented pill on the right. The selected option is highlighted in `--accent-glow`. Works with any two-option choice list — not just Yes/No. TEECH uses this pattern for both `yes_no_general` toggles and binary demographic pickers (`Man | Woman`, `Black | White`, `70s | 80s`). Implementation lives in `enketo-form.css` under the `.or-appearance-toggle` block.

To use in a form:
1. Wrap the two-option choice list in `choices.<list_name>` as usual.
2. Set the question type to `select_one` with `appearance: "toggle"`.
3. The native radio inputs are visually hidden but kept keyboard-accessible via the wrapping `<label>`, so `:checked` highlighting works without JavaScript.

Structural change to remember: to convert a multi-select checklist into forced-choice toggles, split the `select_multiple` into N individual `select_one` questions (grouped under `begin_group`/`end_group` for the section header). There is no way to render a single `select_multiple` as per-item toggles while keeping the data model clean (no "no" state vs "unanswered" state).

## Transcript & Grading Flow

### Transcript Storage (During Session)

1. **Chat Start**: Frontend generates 32-char random hex token (`crypto.randomUUID().replace(/-/g, '')`)
2. **During Chat**: After each message, `POST /api/transcripts/:token` with formatted transcript
   - Format: `User:\n<message>\n\nAssistant:\n<message>\n\n...`
   - Saved to `transcripts/<timestamp>_<token>.txt` on backend filesystem
3. **Form Prefill**: Token injected into Kobo form hidden field:
   - Newer forms: `transcriptToken` field (dedicated)
   - Older forms: `chat_transcript` field (will be replaced)
4. **Form Submit**: Enketo submits to backend → proxied to Kobo with token as placeholder
5. **Post-Submit**: `POST /api/kobo-transcript` with `{token, transcript}`:
   - Backend searches Kobo for submission by token (checks `transcriptToken` then `chat_transcript`)
   - Bulk PATCH writes full transcript to `chat_transcript` field (replacing token)
   - **CRITICAL**: This must complete before grading can work

### Real-Time Grading Feedback (GradingScreen Component)

**Enabled only if** `project.json` has `enableFeedback: true`

**Flow:**
1. After all forms submitted, frontend transitions to `<GradingScreen />`
2. Component calls `POST /api/grade-session` with all tokens from current session
3. Backend:
   - Fetches submissions from Kobo by token
   - Grades transcripts against scoring rubric + assessment checklist
   - Synthesizes 2-4 strengths + 3-5 growth areas per case (hallucination-guarded)
   - Extracts opening statement (first `Assistant:` message)
4. Frontend renders carousel of feedback cards:
   - Opening statement in speech bubble (patient's first line)
   - Strengths with emoji indicators
   - Growth areas with actionable suggestions
   - Horizontal scroll-snap with peek effect

**Key Files:**
- `src/components/GradingScreen.tsx` → Real-time feedback UI
- `src/App.css` → Carousel, speech bubble, gradient styling
- `src/App.tsx` → Session flow, transition to grading after all cases complete

**Design Notes:**
- Carousel: centered card with side peek (scroll-snap-align: center)
- Gradient style: `linear-gradient(135deg, rgba(147, 197, 253, 0.15), rgba(110, 231, 183, 0.15))`
- User messages use reversed gradient (315deg)
- NO "progress", "counts", or "x of y" language — focus on actionable feedback
- Opening statement reproduces what student saw to provide context

## Language Localization

**Translation System** powered by `languages.json`:

**The API is the only source of translations at runtime.** `useLanguages` (`src/chat/useLanguages.ts`) fetches
`GET /api/languages`, which reads the copy stored in the database -- the same copy
the admin Translations tab uploads and edits. If that fetch fails, `langs` is set
to `null` and every `t()` call degrades to the component's hardcoded default; there
is deliberately no static-file fallback. One used to sit in the catch, fetching
`${BASE_URL}languages.json`, but no build ever published that file (verified
2026-09-08: `ai-med.live/demo/languages.json` and `ai-med.live/haivn-eip/languages.json`
both return 404), so it only delayed the null. Publishing it was rejected rather
than fixed: a build-time copy of `projects/<slug>/languages.json` would diverge
silently from the admin-edited database copy the moment anyone used the
Translations tab, which is exactly the second-source-of-truth problem the DB copy
exists to avoid. The API's matching DB-to-filesystem mirror (it used to write
`languages.json` into `frontend-chat/public` at startup and on every Translations
save) went with it -- the deleted fallback was its only reader.

```typescript
interface LanguageUISection {
  welcome: { title, subtitle, instructionsLead, howItWorks, bullets, getStarted, languageLabel }
  chat: { headerTitle, scenarioDescription, inputPlaceholder, send, loadingForm, thanksTitle, nextCase, patientMode, diagnosis, submitForm, submittingForm, formTitle, noticeLine?, noticeDetails?, groundingNote?, beyondScopeNotice? }
  feedback?: { loading, loadingDetail, explored, opportunities, complete, error, continue }
}
```

**Translation Function** (`src/chat/useLanguages.ts`):
```typescript
function t<S extends 'welcome' | 'chat' | 'feedback', K extends keyof NonNullable<LanguageUISection[S]>>(section: S, key: K): string {
  const code = selectedLanguageCode || 'en';
  const localized = langs?.ui?.[code]?.[section];
  const fallback = langs?.ui?.['en']?.[section];
  const value = (localized?.[key] ?? fallback?.[key]);
  return typeof value === 'string' ? value : '';
}
```

**Usage:**
- `t('welcome', 'title')` → Localized welcome title
- `t('chat', 'loadingForm')` → "Loading form..." or "Chargement du formulaire…"
- `t('feedback', 'explored')` → "Topics you explored well:" or "Sujets que vous avez bien explorés :"

**Language State:**
- Selected language code stored in localStorage (`lang_code`); initial value resolves `?lang=` URL param → saved → browser locale → `en` (`src/lang-boot.ts`); once the project's languages load, the same chain is re-run against that list, so each step counts only if the project offers it and the last resort is the project's first language. Only a validated code is written back to `lang_code`. A language switch before the first question also re-localizes the fixed opening message
- Language selector on welcome screen (only shown if >1 language available)
- `skipWelcome` projects (haivn_eip) have no welcome page, so the two jobs the welcome screen does are split:
  - Both live in `.chat-topbar`, the row above the conversation: switcher on the left, notices on the right. The whole row is gated on `skipWelcome`, so projects that show the welcome screen render nothing there and are byte-identical to before.
  - **Language**: `src/LanguageSwitcher.tsx` renders a real control (flag + language name + caret, opening a listbox) at the top-left, and a second mount inside the fixed `.mobile-tab-strip` on mobile so it stays reachable from the document and library panels. CSS hides the top-bar copy at ≤768px when the project has tabs (`.main-container.has-tabs .chat-topbar .lang-switcher`), so exactly one switcher is ever on screen — the notices beside it are not duplicated and stay visible.
  - **Notice**: `src/ChatNoticeBar.tsx` renders, at the top-right, the standing `chat.groundingNote` disclaimer plus a slim consent line whose popover carries the full `consentParagraphs` (the consent line appears only when the project supplies real consent text; the bar renders nothing when it has neither string). Its popover opens downward and left-ward from that corner. It carried both a language control and, until 2026-08-28, the bottom of the chat column; it now carries neither.
  - At ≤768px the row stacks: switcher on its own line at the left, notices full-width and left-aligned below it, still above the title. Those mobile rules sit next to the desktop rules at the bottom of `style.css`, **not** in the big `@media (max-width: 768px)` block, which is declared earlier in the file and therefore loses every equal-specificity override to it.
  - Both popovers dismiss through the shared `useDismiss(ref, open, onDismiss)` hook in `src/use-dismiss.ts` (outside pointer press + Escape; it calls `preventDefault()` on the Escape it takes, so a framed page's close-on-Escape leaves it alone)
- Language name passed to backend as `language` parameter in `/api/chat` and `/api/grade-session`
- Form reloads when language changes (triggers Enketo re-init with new UI language)

**Components with Translations:**
- `App.tsx` → Welcome screen, chat headers, form labels, transition screens
- `GradingScreen.tsx` → Loading, error, section headers via `translations` prop
- `NativeKoboForm.tsx` → Loading label via `loadingLabel` prop

**Adding New Languages:**
1. Edit `projects/{slug}/languages.json`
2. Add language object to `languages` array: `{ "code": "es", "name": "Español" }`
3. Add UI translations to `ui` object: `"es": { "welcome": {...}, "chat": {...}, "feedback": {...} }`
4. Translate the consent paragraphs in `welcome.consentParagraphs`. This is not optional: a participant offered a language must be able to read the consent in it. Use the project's own IRB-approved text, never another project's (see CREATING-A-PROJECT.md)
5. Push content via `tools/push-content.ts` to update backend

**Fallback Chain:**
1. Selected language (`langs.ui[selectedLanguageCode][section][key]`)
2. English fallback (`langs.ui['en'][section][key]`)
3. Hardcoded default in component (e.g., `t('chat', 'send') || 'Send'`)

## Tab System

The right panel is a tab container. `resolveTabs` (`src/chat/tabs.ts`) takes tabs from two sources:
1. `/api/tabs` (new pattern) — tab structure from `project.json`, content from filesystem. Object-keyed i18n values resolved via `resolveI18n(val, lang)` helper.
2. `langs.tabs` (legacy pattern, CBS) — tabs embedded in languages.json, string labels only.

Tab types:
- `content` — renders `<ContentPanel>` with sections (heading, content, image), markdown-rendered per section
- `form` — renders `<NativeKoboForm>` (Enketo)
- `suggestions` — renders `<SuggestedQuestions>` with clickable question buttons that auto-send on click
- `document` — renders `<DocumentPanel>` with a single markdown file as formatted HTML (headings, tables, bold, lists)
- `pdf` — renders `<PdfJsViewer>` on the `{pdfUrl}` returned by `/api/tabs` (bundled pdf.js, lazy-loaded, with a selectable text layer and its own find bar). The find bar also carries a collapsible outline sidebar built from the document's own bookmarks, a back-to-top control, and a single-slot return that goes back to wherever the last jump started from; back-to-top's threshold and icon are imported from `src/back-to-top.tsx`, shared with `DocumentPanel` so the two editions of one tab offer the same affordance at the same point. The outline's **Contents** toggle sits in that same find bar beside return and back-to-top (one `.pdfjs-find-nav`, only its square width overridden so the word fits), reports `aria-expanded` and `aria-controls` on the sidebar, and closes it to give the pages the full panel width — `recomputeScale` is keyed on the open state, so fit-to-width re-measures. Which way the reader left it is remembered in `localStorage` under `pdf_outline_open` (both accessors try/caught: this app is iframed on Canvas, where Safari can make storage throw). A saved choice outranks the opening width rule (`≥ 640px` opens by default); documents with no bookmarks render no toggle at all. **Inside the sidebar every branch starts collapsed**, at every level, with a drawn chevron per branch that has children (a 24px target, the WCAG 2.2 minimum, since it is the only route to 59 of the EIP's 66 entries; rows wrap and are never truncated). HAIVN read the in-app outline and the same file opened in a new tab as two different outlines while this viewer mounted every node open (2026-09-08). Collapsed is a **chosen constant, not the document's own state**: pdf.js exposes a per-node `count` carrying what the file declares, and the viewer ignores it the way Chrome and Arc do. The EIP PDFs themselves are written with every branch closed since the same day (`build-jump-maps.py`, `set_toc(collapse=1)`; see `tools/CLAUDE.md`), so Firefox, Acrobat and Preview, which honor the flag, now agree too. Which branches the reader has opened is held by the viewer, not by each row, so closing and reopening the sidebar keeps them; a new document starts collapsed again. It is deliberately NOT persisted -- `pdf_outline_open` remembers a single choice about the viewer, while expansion is per document and per branch, and the browser does not remember it either.

**Two editions, one tab.** A project may declare the SAME tab id twice — once `pdf`, once `document` — and `mergeTabViews` (`src/chat/tabs.ts`) folds them into one tab whose `altView` holds the second edition, rendered by `<DualViewTab>` behind a Text/PDF switcher (the Legal Library's `legal-doc-view-*` control, lifted to the top of the tab). Declaration order sets the default view; haivn_eip declares the PDF first, so the EIP tab opens on the PDF. Because both editions answer to one id, `docRefs.tabId`, `pdfScrollTarget.tabId`, `docScrollTarget.tabId` and the active-tab reselect all keep working unchanged — a citation chooses an *edition*, not a tab. `tabMarkdown()` / `tabPdfUrl()` / `tabHasPdf()` read through to whichever view carries the payload, so the doc-reference anchor set is known before the reader has ever opened the text. An id repeated in any other combination is dropped with a console warning. See `projects/CLAUDE.md` for the config shape.

`DualViewTab` also remembers the reader's place in each edition. It does so with a *continuous* scroll listener rather than a read at switch time, and that is load-bearing: React hides the outgoing view in the same commit, and a scroller whose content has just collapsed has had `scrollTop` forced to 0 by the browser before any effect can read it — so reading at switch time saved 0 every time and "back to the PDF" always meant page 1. A `jumpNonce` prop suppresses the restore when a citation arrives with the switch, so the jump is not fought.

`/api/tabs` is re-fetched whenever `selectedLanguageCode` changes, because a tab's `contentFile` may be declared per language (see `projects/CLAUDE.md`). The "select the first tab" effect is therefore keyed on the joined list of tab **ids** rather than the tabs array identity: a language switch (same ids, new content) leaves the reader where they were, while a vignette switch (different ids) still pulls a newly-visible tab forward, which is what TEECH's `showForVignetteKeys` Physical Exams tab relies on.

### DocumentPanel find bar

`<DocumentPanel content lang />` renders the markdown and layers an in-panel search over it: sticky field, `n/total` counter, prev/next buttons, Enter / Shift+Enter to step, Escape to clear. Matches are wrapped by walking **text nodes** (never string-replacing the HTML, which would corrupt tags), and the body is re-rendered from the memoized HTML on each new query, which is what clears the previous highlights. Input is debounced 150 ms because these documents run to ~100 KB. UI strings live in a small `UI` map in the component (en/vi, falling back to en).

Matching goes through `foldQuery`/`foldWithMap` in `src/text-search.ts` — the same fold the PDF find bar uses — so it is diacritic- and case-insensitive: `dieu tri` finds `điều trị`. The fold's index map is what makes that safe: a match is found in the folded form and then painted back onto the ORIGINAL characters, so a `<mark>` still carries the document's own accents, capitalization and spacing. (Before this, the two views of one legal document disagreed — 0 hits in Text against 5 in PDF for the same query.)

Headings carry `scroll-margin-top` so a contents link doesn't land underneath the sticky find bar. Inside a merged tab that clearance is widened by the switcher's height (`--dual-view-switch-height`).

`DocumentPanel` also accepts an optional `scrollTarget={{anchor, nonce}}` prop: when the nonce changes it scrolls that heading anchor into view (via `requestAnimationFrame`, so the tab has become visible first). This is how a document reference clicked in the chat drives the scroll. The anchor ids are the same `{#...}`-derived ids the in-panel contents list uses.

**Figures in a generated document** (`resolveContentImages`). A builder may save a document's figures into the repo beside its text — `tools/fetch-legal-docs.py` does this for the seven testing algorithms in 1868/QĐ-BYT, one of which is that decision's whole Bảng 2 — and it writes them into the markdown as REPO-RELATIVE paths (`projects/haivn_eip/content/legal/figures/...`), which is the only shape that is right in a file with no idea where the API lives. `DocumentPanel` rewrites those to `/api/project-content/<path>`, the same route the text and the PDF come down. The rewrite runs on an **inert document parsed from the sanitized HTML**, not as a string replace and not in an effect after render: `DOMParser` fetches nothing, so no request is ever made for the unresolved path, and a `projects/` prefix cannot be matched inside a text node or a lookalike attribute. Absolute srcs are left alone, and every rewritten image gets `loading="lazy"`. Styling is one rule in `style.css` (`.document-panel-body img`): capped at the column width, never upscaled, on a white card because these are scans of print and a dark theme would otherwise put black diagram lines on black.

### Document references in chat answers (`docRefs`)

`src/doc-refs.ts` recognizes numbered document references in an assistant answer — "Section 4.1", "Appendix 7.1", and the Vietnamese "Mục 4.1" / "Phần 4.1" / "Phụ lục 7.1" — and turns them into links that switch the right panel to the project's `document` tab and scroll the passage in (`openDocRef` in `src/chat/useDocRefs.ts` → `docScrollTarget` → `DocumentPanel`'s `scrollTarget`).

- **Gated + generic.** Active only when `/api/config` returns a `docRefs` config (from `project.json`); otherwise assistant messages render exactly as `{message.content}`, byte-identical. The trigger words and their anchor prefix are config (`{tabId, patterns:[{prefix, words}]}`), and the number→anchor transform (`4.1` → `sec-4-1`) is the anchor convention the document markdown is expected to carry.
- **Validated against the real document.** `useDocRefs` derives the valid-anchor set from the loaded document tab's markdown (`extractAnchorIds`) and passes it to `buildDocRefMatcher`. A reference that doesn't resolve to an anchor present in the document (a model-invented section, or one that doesn't exist) is left as ordinary text — never a dead link. Numbered anchors are identical across the English and Vietnamese editions, so a Vietnamese answer scrolls the Vietnamese document to the same anchor.
- **No markdown in chat.** Only this narrow affordance is introduced; the rest of the message stays plain text. Segments are rendered as plain strings and React `<a>` nodes (never `innerHTML`), and the href is a validated anchor id, so the model's text can't inject markup.

### Legal-instrument citations

The same matcher recognizes citations of a project's **legal library** (a `library` tab), with no new marker syntax — it reads what the model already writes:

| Written in the answer | Resolves to | Rendered as |
|---|---|---|
| `96/2023/NĐ-CP` | the document | plain `doc-ref-link`, opens it in the library (unchanged) |
| `96/2023/NĐ-CP, Điều 40` | document + `dieu-40` | `doc-ref-chip`: opens the library's **PDF view at the mapped page**, with a `Text` button beside it |
| `Điều 40 của Nghị định 96/2023/NĐ-CP` | same | same (reverse order, bridged by ≤ 4 connector words) |
| `Article 40 of Law 15/2023/QH15` | same | same (English article word, same `dieu-40` key) |
| `Điều 40 aligns with Law 15/2023/QH15` | the document only | plain `doc-ref-link` — "aligns" is not a connector, so the article never binds |

- **The number is the anchor.** Only instrument numbers present in the library registry match (`legalNumberToId`), longest-first; an article word is recognized only immediately beside one. `Điều 40` on its own, or an invented instrument number, stays plain text.
- **The reverse-order bridge is a closed vocabulary, not a word budget** (`LEGAL_REF_CONNECTORS` in `doc-refs.ts`). Only possessives/prepositions (`của`, `of`, `trong`, `số`, `the`, `no.`) and the tokens of an instrument-type noun (`Nghị`/`định`, `Thông`/`tư`, `Luật`, `Decree`, `Circular`, `Law`, `Decision`, …) may sit between the article number and the instrument number. An earlier version allowed any four letters-only words, which bound `Điều 40 aligns with Law 15/2023/QH15` to the Law and opened that PDF at a page holding no such article. Any verb or relational phrase now ends the bridge, and the citation falls through to the whole-document link.
- **The page comes from the document's own map.** `useDocRefs` lazily fetches `maps/<id>.json` for a document an answer actually cites an article of (once per document, failures swallowed) and indexes it with `sectionPageIndex` from `src/legal-map.ts` — the *same* filter `LegalLibraryPanel` uses for its section list (`jumpableSections`: confirmed-only where a canonical text is on screen, structural allowed for a PDF-only document). One rule, one module, so a chip can never claim a page the panel beside it refuses to offer.
- **Degradation is the default.** No article named, an article the map does not carry, a document with no map or no PDF, a map still in flight — all fall through to the whole-document link that already existed. There is no state in which a chip goes nowhere. The `Text` button is rendered only where a text edition exists.
- **Plumbing.** `openLegalRef(docId, page?)` (`useDocRefs`) → `legalSelectTarget={docId, page?, nonce}` → `LegalLibraryPanel`, which holds the request in a ref until the document is selected (the view-reset effect would otherwise clear it in the same commit) and then sets `view='pdf'` + `pdfJump`. Chip labels reuse `DOC_REF_UI` (`src/chat/tabs.ts`).

## Formless Mode

When `/api/config` returns `formless: true`, App.tsx skips auto-adding a form tab (the talk page never adds one). The project's declared tabs (from `/api/tabs`) are shown as-is. Used by Q&A chatbots that have no Kobo form.

## Inline Follow-up Suggestions

When `/api/chat` returns a non-empty `followups` array (only when the project has `enableFollowups: true` in `project.json`), the frontend renders 2-3 clickable chips above the input textbox. Clicking a chip calls the page's `handleQuestionClick(text)` → `session.sendMessage(text)` (`useChatSession`) → auto-sends to chat. Follow-ups are cleared at the start of the next user turn.

CSS: `.followups-bar` + `.followup-chip` in `style.css`.

## Beyond-Scope Disclosure

`/api/chat` returns `beyondScope: true` on an answer that says anything the project's reference content does not itself cover (see `packages/api/CLAUDE.md`). The flag is stored on the `Message` — which is also why `pendingAssistantMessage` holds a whole `Message` rather than a bare string, so a voice project's TTS path carries per-message flags to the flushed bubble instead of dropping them.

Rendering is translation-gated, never hardcoded English: the marker under a flagged answer uses `t('chat', 'beyondScopeNotice')` and the standing line in the chat top bar uses `t('chat', 'groundingNote')`. A project whose `languages.json` omits a string renders that element not at all, so nothing changes for other projects. When the model omits the flag it degrades to no marker, and the standing line still discloses the grounding.

CSS: `.beyond-scope-note`, `.chat-standing-note` in `style.css`.

## i18n Helper for Tab Content

Tab labels and content use an object-keyed localization pattern:
```typescript
type TabLabel = string | Record<string, string>  // e.g. {en: "Questions", vi: "Câu hỏi"}

function resolveI18n(val: TabLabel | undefined, lang: string): string {
  if (!val) return ''
  if (typeof val === 'string') return val  // legacy/CBS pattern
  return val[lang] || val['en'] || ''
}
```

Used anywhere tab content may be multilingual. Plain strings pass through unchanged, preserving backward compatibility.

## Multi-Project

`VITE_PROJECT` env var (build-time) determines which project to target. The `apiFetch()` wrapper in `api-base.ts` adds `X-Project: <slug>` header to all API requests.

## Build

```bash
npm run dev                  # Vite dev server (:5173), proxies /api to :3001
npm run build                # Vite production build, simulator page
VITE_APP=talk npm run build  # the talk page
```

`VITE_BASE_PATH` sets the base URL for GitHub Pages per-project subdirectories.
