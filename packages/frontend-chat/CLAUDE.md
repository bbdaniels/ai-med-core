# Frontend Chat Package

React SPA with split-panel layout: AI chat (left) + assessment form (right). Includes admin dashboard at `/admin`.

## Key Files

- `src/App.tsx` -- Main flow: consent → chat + form → transition → next case → end screen
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

```typescript
interface LanguageUISection {
  welcome: { title, subtitle, instructionsLead, howItWorks, bullets, getStarted, languageLabel }
  chat: { headerTitle, scenarioDescription, inputPlaceholder, send, loadingForm, thanksTitle, nextCase, patientMode, diagnosis, submitForm, submittingForm, formTitle, noticeLine?, noticeDetails? }
  feedback?: { loading, loadingDetail, explored, opportunities, complete, error, continue }
}
```

**Translation Function** (`App.tsx:209-215`):
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
- Selected language code stored in localStorage (`lang_code`); initial value resolves `?lang=` URL param → saved → browser locale → `en` (`src/lang-boot.ts`), validated against the project's languages by the auto-correct effect
- Language selector on welcome screen (only shown if >1 language available)
- `skipWelcome` projects (haivn_eip) have no welcome page: `src/ChatNoticeBar.tsx` renders a slim line under the chat input (current language flag + short consent notice) whose popover carries the language switcher and the full `consentParagraphs` — rendered only when the project supplies real consent text
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

The right panel is a tab container. App.tsx resolves tabs from two sources:
1. `/api/tabs` (new pattern) — tab structure from `project.json`, content from filesystem. Object-keyed i18n values resolved via `resolveI18n(val, lang)` helper.
2. `langs.tabs` (legacy pattern, CBS) — tabs embedded in languages.json, string labels only.

Tab types:
- `content` — renders `<ContentPanel>` with sections (heading, content, image), markdown-rendered per section
- `form` — renders `<NativeKoboForm>` (Enketo)
- `suggestions` — renders `<SuggestedQuestions>` with clickable question buttons that auto-send on click
- `document` — renders `<DocumentPanel>` with a single markdown file as formatted HTML (headings, tables, bold, lists)
- `pdf` — embeds the PDF returned as `{pdfUrl}` by `/api/tabs` in an iframe

`/api/tabs` is re-fetched whenever `selectedLanguageCode` changes, because a tab's `contentFile` may be declared per language (see `projects/CLAUDE.md`). The "select the first tab" effect is therefore keyed on the joined list of tab **ids** rather than the tabs array identity: a language switch (same ids, new content) leaves the reader where they were, while a vignette switch (different ids) still pulls a newly-visible tab forward, which is what TEECH's `showForVignetteKeys` Physical Exams tab relies on.

### DocumentPanel find bar

`<DocumentPanel content lang />` renders the markdown and layers an in-panel search over it: sticky field, `n/total` counter, prev/next buttons, Enter / Shift+Enter to step, Escape to clear. Matches are wrapped by walking **text nodes** (never string-replacing the HTML, which would corrupt tags), and the body is re-rendered from the memoized HTML on each new query, which is what clears the previous highlights. Input is debounced 150 ms because these documents run to ~100 KB. UI strings live in a small `UI` map in the component (en/vi, falling back to en).

Headings carry `scroll-margin-top` so a contents link doesn't land underneath the sticky find bar.

`DocumentPanel` also accepts an optional `scrollTarget={{anchor, nonce}}` prop: when the nonce changes it scrolls that heading anchor into view (via `requestAnimationFrame`, so the tab has become visible first). This is how a document reference clicked in the chat drives the scroll. The anchor ids are the same `{#...}`-derived ids the in-panel contents list uses.

### Document references in chat answers (`docRefs`)

`src/doc-refs.ts` recognizes numbered document references in an assistant answer — "Section 4.1", "Appendix 7.1", and the Vietnamese "Mục 4.1" / "Phần 4.1" / "Phụ lục 7.1" — and turns them into links that switch the right panel to the project's `document` tab and scroll the passage in (`handleDocRefClick` in `App.tsx` → `docScrollTarget` → `DocumentPanel`'s `scrollTarget`).

- **Gated + generic.** Active only when `/api/config` returns a `docRefs` config (from `project.json`); otherwise assistant messages render exactly as `{message.content}`, byte-identical. The trigger words and their anchor prefix are config (`{tabId, patterns:[{prefix, words}]}`), and the number→anchor transform (`4.1` → `sec-4-1`) is the anchor convention the document markdown is expected to carry.
- **Validated against the real document.** `App.tsx` derives the valid-anchor set from the loaded document tab's markdown (`extractAnchorIds`) and passes it to `buildDocRefMatcher`. A reference that doesn't resolve to an anchor present in the document (a model-invented section, or one that doesn't exist) is left as ordinary text — never a dead link. Numbered anchors are identical across the English and Vietnamese editions, so a Vietnamese answer scrolls the Vietnamese document to the same anchor.
- **No markdown in chat.** Only this narrow affordance is introduced; the rest of the message stays plain text. Segments are rendered as plain strings and React `<a>` nodes (never `innerHTML`), and the href is a validated anchor id, so the model's text can't inject markup.

## Formless Mode

When `/api/config` returns `formless: true`, App.tsx skips auto-adding a form tab. The project's declared tabs (from `/api/tabs`) are shown as-is. Used by Q&A chatbots that have no Kobo form.

## Inline Follow-up Suggestions

When `/api/chat` returns a non-empty `followups` array (only when the project has `enableFollowups: true` in `project.json`), the frontend renders 2-3 clickable chips above the input textbox. Clicking a chip calls `handleQuestionClick(text)` → `handleSendMessage(text)` → auto-sends to chat. Follow-ups are cleared at the start of the next user turn.

CSS: `.followups-bar` + `.followup-chip` in `style.css`.

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
npm run dev      # Vite dev server (:5173), proxies /api to :3001
npm run build    # Vite production build
```

`VITE_BASE_PATH` sets the base URL for GitHub Pages per-project subdirectories.
