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
- `projects/haivn_eip/content/eip-<lang>.pdf` -- the EIP tab's PDF view
- `projects/haivn_eip/content/eip-map.<lang>.json` -- the text tab's anchors
  resolved to pages of that PDF, built by `build-jump-maps.py` on the same run

```bash
python3 tools/build-eip-text.py             # everything, both languages
python3 tools/build-eip-text.py --en-only   # after an English-doc edit
python3 tools/build-eip-text.py --no-pdf    # skip the ~5 MB PDF re-fetches
python3 tools/build-eip-text.py --maps-only # re-resolve the anchor maps only
```

Needs `pandoc` on PATH, and PyMuPDF for the PDF step (see
`strip-pdf-nav-marks.py` below). **Never hand-edit any of those four outputs** -- the
grounding file used to be maintained by hand while the reader text was
generated, which is two implementations of one job and is how the reader tab and
the model's grounding ended up as separate things to keep in sync. Change the
Google Doc, bump `DOC_IDS` / `EIP_VERSION` at the top of the script if HAIVN cut
a new document rather than revising the old one, and re-run.

The build refuses to write a reader text whose own links dangle: every
`href="#x"` and `](#x)` it emits must resolve to a `{#x}` anchor in the same
file, or the run exits. The document cross-references itself in both syntaxes --
markdown in prose, raw `<a href="#...">` inside tables and list items -- and a
rewriter that only knew the first shipped eight dead links per language.

## strip-pdf-nav-marks.py

Lifts Google Docs' dead navigation chip out of a PDF export. A Doc with an
outline exports with a small "table of contents" icon stamped into the top-left
corner of every body page, linked to a named destination the exporter never
writes into the file -- inert in every viewer, on every page, by construction,
and not something the document's owner can switch off. `build-eip-text.py` runs
this on each PDF it fetches, so a re-ingest cannot quietly put the chip back.

```bash
python3 tools/strip-pdf-nav-marks.py --dry-run FILE.pdf   # report only
python3 tools/strip-pdf-nav-marks.py FILE.pdf [FILE.pdf ...]
```

Needs PyMuPDF (`pip install 'pymupdf>=1.23'`). It is deliberately narrow: it
acts only on an image that is drawn on at least half the pages, always at one
rectangle, under a link to a destination the file never defines. A working
contents link fails that test, and so does a one-off dead link in the body --
the Vietnamese EIP has one, and it is the document owner's to fix, not ours.
Idempotent: a stripped file matches nothing and is not rewritten at all.

**If you extend the content-stream editing, keep `balanced()` in front of every
span you delete.** Removing a `q ... Q` group whose ends do not match leaves a
stray `Q` that pops the graphics state a level too far, and everything drawn
after it is re-drawn under whatever matrix was underneath. That is not
theoretical: an off-by-one on the closing `Q` moved the figure on six English
pages down the page and flipped it upside down, and every other check --
extracted text, link targets, page count, named destinations -- still passed. It
was caught by rendering the page and looking at it. Render and look.

## fetch-legal-docs.py

Sources the Legal Library tab: downloads each registry document's official
government PDF, keeps it at `content/legal/pdf/<id>.pdf`, extracts it to
`content/legal/text/<id>.md`, and regenerates `content/legal/grounding.md` from
`registry.json`. A multi-part gazette document is merged into one PDF in
`sourcePdfs` order; the merge is compared against what is already on disk by
page content, so a re-run that changes nothing rewrites nothing (PyMuPDF stamps
a fresh trailer /ID on every save, which would otherwise drop megabytes of
identical blob into git history).

```bash
python3 tools/fetch-legal-docs.py            # fetch PDFs + rebuild grounding
python3 tools/fetch-legal-docs.py --index    # only rebuild grounding.md
python3 tools/fetch-legal-docs.py --format   # only restructure existing text
python3 tools/fetch-legal-docs.py --format --dry-run
python3 tools/fetch-legal-docs.py --only qd-1740-2026
```

Needs **PyMuPDF >= 1.23** (`pip install 'pymupdf>=1.23'`) and nothing else
beyond the standard library; the floor is where `Page.find_tables()` arrives,
and the script checks for it up front rather than letting a missing install
surface as a per-document `extract-failed`. The pin is a comment at the top of
the script rather than a `tools/requirements.txt`, because no workflow runs this
script and the public-mirror build excludes the file itself -- see the docstring.
`registry.json` is hand-curated with exactly one exception: the script writes
each document's `pdfFile` path (and removes one whose file is no longer on
disk -- a failed download alone never removes it, because one gazette host drops
the connection on most runs). It touches no other field, and only documents the
run actually attempted, so `--only` leaves the rest alone. `grounding.md` and
everything under `content/legal/text/` and `content/legal/pdf/` are generated,
so do not hand-edit them.

Three behaviours worth knowing before you point a registry entry at a new PDF:

- **`textFile: null` is honoured, not ignored.** Every entry carries the field;
  `null` says the document ships as metadata plus its PDF with no full text, and
  is set where the only official copy is a scan whose OCR cannot be trusted for
  what the document is *for* (the drug tables in 20/2022/TT-BYT extract
  "Lamivudin + tenofovir" as "Lami\,「adia + tenofovir"). The run saves the PDF
  and writes no text. To turn full text on, put the path in `textFile` and
  re-run.
- **An existing text file is never overwritten by a degraded extraction.** The
  documents whose text was ingested from an official HTML full text are exactly
  the ones whose signed original turns out to be a scan, so the run that adopts
  the authoritative PDF is the run that would destroy the readable copy. A new
  extraction is refused when it is under 40% of the size already on disk, or
  when its Vietnamese diacritic density falls below half the existing file's --
  real Vietnamese runs 0.19-0.30 across this corpus, a scanner's OCR layer comes
  back at 0.00 while being the same length, so length alone does not catch it.
  Either way the PDF is still saved and the run says which document it spared.
- **A document's `officialUrl` is fetched before its PDFs when both are on the
  same host.** Some government systems (syt.gialai.gov.vn) hand the file over
  only to a client that has opened the record page first, keying the download to
  a session cookie set there and to that page as `Referer`; a cold request gets
  the nine bytes `Wrong URL`. The Referer otherwise defaults to the file's own
  origin.

### The structure pass (`format_structure`)

Extraction gets the words right and the shape wrong. Before the restructuring
pass, not one `Điều` / `Chương` / `Mục` / `Phụ lục` in twenty-one documents was
a Markdown heading, a contents list was twelve bare lines, and an abbreviation
table was 179 lines reading `AFP | Alpha-fetoprotein` -- which is not GFM (no
leading pipe, no separator row), so the reader printed the pipes. `DocumentPanel`
renders with `marked` in GFM mode and the stylesheet already covers h1-h4, lists
and tables; the files simply had no markup for it to render. So the fix is in
the text, not the panel.

`format_structure()` runs on the assembled document at the end of every fetch,
and `--format` applies the same pass to the text files already on disk -- which
is the only route for the eight documents whose text was ingested from an
official HTML full text and so cannot be re-extracted. It is a pure function of
the text, so it is idempotent: a second run writes the same bytes, and a
document that later goes round through `--fetch` comes out the same.

**The invariant is absolute: it changes markup, never words.** Every file it
writes is checked token for token against the file that went in -- all Markdown
syntax stripped, whitespace collapsed, sequence compared -- and a document whose
word stream moved is REFUSED and reported rather than written. The one tolerated
exception is a table this pass reconstructs, where row-major reflow may move a
token but may not add, drop or alter one; such a region is accepted only if it
is multiset-identical, and it is named in the run's output. (The reconstruction
preserves order anyway, so the exception exists to be reported, not used.)

What it does, in order: unwraps lines the source page wrapped mid-sentence,
gathers `- ` runs into lists, turns runs of `left | right` lines into GFM
tables, folds contents blocks into a compact list under their `MỤC LỤC` heading,
promotes headings, and marks `a) b) c)` clause runs as list items. Numbered
clauses (`1.`, `2.`) are deliberately left alone -- `marked` already renders them
as an ordered list, and re-marking them would renumber them. Headings stop at
**h4** because h5 and h6 have no rule in the reader's stylesheet, and the ladder
is computed per document from the kinds it actually uses, anchored at the bottom
so that Mục and Điều keep their distinction and it is the outer pair that shares
a level when a decree nests four deep.

**The original PDF is what says which line is a heading.** On a born-digital
text layer nearly every heading candidate is bold somewhere (nd-96: 225 of 226),
so a candidate the PDF never sets bold is a cross-reference and is dropped; and
a size ladder appears in the guideline-style documents (`qd-1740` sets its title
at 22pt over 14pt body), which is what names their untitled sections. On the
eight scans -- whose only text layer is the canonical one `build-jump-maps.py`
injected, every span one font at flags 0 with the size scaled to fit an OCR box
-- typography says nothing, the whole document's style is distrusted at once
rather than a line at a time, and structure comes from the heading grammar, the
document's own contents entries, and roman-numeral capitalised section lines.
That is the same rule as everywhere else here: OCR locates, it never produces.

The heading grammar is imported from `build-jump-maps.py` rather than copied,
because telling `Điều 5.` from `Điều 5 của Luật` is the whole difficulty and a
second copy would drift from the one the page maps are built with.

**A section cannot open inside a sentence that is still pointing at it**
(`cross_reference()`). The PDF's bold veto only fires where `attach_style`'s
cursor can place the line, and it cannot place a fragment a page wrap pushed to
the start of a line -- so `tt-40`, whose bidding forms cite five of their own
chapters by name, set eleven citations as h2 in the middle of legal sentences.
Three shapes are refused, and in each it is the document's own punctuation
saying so, never a guess about the words:

- the line is a list item (`- Chương V. Phạm vi cung cấp.` is one line of the
  contents list printed above it -- the source wrote that bullet, not this pass);
- the line above it ends on the words a citation is introduced with -- a
  preposition (`... nêu trong`, `... quy định tại các`) or the citation's own
  hanging stub (`... theo Mẫu số 15`, `... tại Mục 3`);
- the line is a bare marker under a colon (`... nhiễm HBV mạn:` `Phụ lục 1` is
  *see Appendix 1*; a section opening after a colon brings its own title).

**The absence of a full stop is NOT one of those shapes, and must not become
one.** Half this corpus's real titles sit under an all-capitals banner or a bare
page number carrying no punctuation at all; a plain "previous line does not end
in a full stop" rule deletes about a hundred and eighty good headings, `qd-1740`'s
`PHỤ LỤC 4` among them. Both filters are therefore required: the line above must
read as running prose (two words up, and containing a lower-case letter), and it
must break off on citation words. Refusals are counted per document in the run's
output.

A contents entry's page number may be **arabic or a lower-case roman numeral** --
front matter is numbered `v`, `vii` and the contents list is in the front matter.
And a dot-leader run absorbs a contents block this pass folded on an earlier run
(`folded_contents()`), which is what lets an entry printed above the block join
the same list instead of staying a loose paragraph on every future run.

**After any text change, re-run the maps** (`--maps`): the map builder reads
these text files on its canonical side, so a text edit moves what it finds.
Diff the confirmed-section counts before and after and treat a drop as a
regression.

## build-jump-maps.py

Answers one question for both reader surfaces: **which page is this heading
on?** It writes

- `projects/haivn_eip/content/legal/maps/<id>.json` for every registry document
  with a PDF whose structure could be located, shape
  `{"docId", "source": "native"|"ocr", "sections": [{"key": "dieu-5", "label":
  "Điều 5. ...", "page": 7, "confidence": "confirmed"|"structural"}]}`, and a
  `mapFile` path into that document's registry entry (the second and last field
  this repo's tooling writes into the hand-curated registry, after `pdfFile`);
- `projects/haivn_eip/content/eip-map.<lang>.json`, shape
  `{"anchors": {"sec-1-2": 5, "app-2": 24}}`, 1-based pages;
- and a **canonical text layer** into the scanned legal PDFs that have a trusted
  text file, so those scans become searchable and selectable.

```bash
python3 tools/build-jump-maps.py                     # maps + injection + EIP anchors
python3 tools/build-jump-maps.py --only tt-43-2025-tt-byt
python3 tools/build-jump-maps.py --no-inject         # maps only, PDFs untouched
python3 tools/build-jump-maps.py --eip-only          # just the two anchor maps
python3 tools/fetch-legal-docs.py --maps             # same legal pass, from the fetcher
```

**OCR is only ever used to LOCATE text, never to produce it.** That is the rule
the whole tool is shaped around, and it is not a stylistic preference: with
diacritics stripped, tesseract reads this corpus at 98-99% token accuracy, but
with tone marks kept it falls to about 90% on the harder scans -- and `cầu` for
`cấu` is a different word, not a typo. So:

- A page assignment is **confirmed** only by exact match: both sides normalised
  the same way (diacritics stripped, `đ`->`d`, lowercased, punctuation dropped,
  whitespace collapsed), a heading-plus-context n-gram taken from the CANONICAL
  text file, longest first (14 tokens down to 6), and accepted only when exactly
  one page contains it. Ambiguous or absent means the section is **dropped and
  named in the run's output**, never guessed.
- A heading with no canonical text behind it can still be located
  **structurally**, and is labelled `confidence: "structural"`. For a scanned
  document the label is then SYNTHESISED (`Điều 12`) rather than copied out of
  the OCR -- the map is a reader-facing file, and OCR words are never shown to a
  reader as if they were the law. A native document's label is its own text
  layer's line, which is trustworthy.
- A document whose detection is incoherent gets **no map and a logged reason**.
- A heading whose own line carries no title -- `Chương I`, or the `Điều 15.`
  that `format_structure` leaves behind when it hands a 600-character article
  back to the body -- **borrows exactly one following line for its LABEL**, and
  only when that line is the heading's own continuation (the capitalised title
  printed under it, or the sentence the article was split from). A line that is
  itself a heading is the next section, so a contents list's `PHỤ LỤC 1` does
  not swallow `PHỤ LỤC 2`. This is display only: the page is confirmed by the
  same n-gram either way. Markdown, list bullet included, is stripped before a
  line is parsed or labelled.
- `continues_sentence()` -- the punctuation test that rejects a heading-shaped
  fragment of a wrapped sentence -- is asked **only about a line the structure
  pass has not marked**. Where `format_structure` has written a `##`, that mark
  wins: it was made by reading the PDF's own typography, while the punctuation
  test cannot see a paragraph that simply ends without a full stop. Overruling it
  cost `qd-1740` its `PHỤ LỤC 4` (page 39, confirmed) and hid `qd-3310`'s
  `PHỤ LỤC 3` (page 16). This relaxation is only safe because the structure pass
  refuses cross-references itself (see `cross_reference()` above); loosening one
  without the other feeds citations straight into the maps.

Parsing detail worth keeping: headings are parsed in a form that KEEPS
punctuation, because the punctuation is the discriminator -- `Điều 5.` opens an
article, `Điều 5 của Luật Khám bệnh` cites one, and those are the same string
once the full stop is gone. Matching is still done punctuation-free, since OCR's
punctuation is not reliable. Three more guards each come from a real failure:
leading scan noise is tolerated (`- Điều4.`, `l Điều 11.`); roman numerals are
read through the misreads tesseract makes of `I` (`Chương J`, `Chương H`);
contents pages are excluded from matching entirely, because they are the one
page carrying every heading and so are a magnet for a "unique" match (that is
how `PHỤ LỤC 6` landed on page 6 of a guideline whose appendix six starts on page
41); and a kind whose detections collapse under the monotone filter is dropped
as a repeating label rather than shipped (one circular's appendix FORMS are
headed `Mục I`..`Mục IV`, restarting on each of two dozen forms).

### Canonical text-layer injection

For a scan that HAS a canonical text file, OCR word boxes supply the geometry
and the canonical text supplies the strings. The token streams are aligned on
their stripped forms; each fully-aligned OCR line is written back as one
invisible run (PDF render mode 3) at that line's box, in an embedded Noto Sans
(SIL OFL, pinned by SHA-256). A line that does not align completely is skipped
whole -- half a canonical line beside half an OCR line is the mixture this exists
to prevent -- and a pre-Unicode garbage layer is redacted first, or it is what
search would hit.

Lines, not words, is the unit, and that is the one non-obvious part: per-word
injection also renders invisibly and also carries correct diacritics, but the
extracted text then has one word per line and **phrase search silently returns
nothing**.

Invisibility is checked, not asserted: every page is rasterised before and
after, and the injection is discarded whole if any page moved. Idempotency is a
marker in the PDF's metadata naming this tool and the PRE-injection content
digest; the digest is also the OCR cache key, so a second run neither re-OCRs
nor re-injects, and the map it builds is identical. Re-fetching a document with
`fetch-legal-docs.py` restores the government's original (dropping the marker),
and the map pass that same run re-injects it -- which is why the fetcher calls
this tool by default and `--no-maps` is the way to opt out.

First run on a machine provisions itself into `~/.cache/`: the pinned
`tessdata_best` Vietnamese model (SHA-256 checked) plus two symlinks INTO the
tesseract install's own `configs`/`tessconfigs`, without which `TESSDATA_PREFIX`
hides the `tsv` output config and tesseract silently emits plain text with no
word boxes at all. Nothing under `/opt/homebrew` or any other system directory
is modified. Without tesseract installed, the native documents still map and the
scans are reported as skipped.
