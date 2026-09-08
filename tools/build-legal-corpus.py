#!/usr/bin/env python3
"""Build the haivn_eip legal-corpus index -- the statute tier of the EIP advisor.

The advisor's always-on grounding carries the EIP text plus a legal *index*:
instrument numbers, titles and scope, but not a word of the statutes themselves.
That is why it could name 96/2023/NĐ-CP and still not say what Điều 40 requires.
This script turns the full text the repository already carries into a retrieval
index the running API can search, so a statute-level question is answered from
the statute rather than declined or, worse, answered from model memory.

    python3 tools/build-legal-corpus.py                  # hybrid (BM25 + vectors)
    python3 tools/build-legal-corpus.py --no-embeddings  # FTS5-only index
    python3 tools/build-legal-corpus.py --query "Điều 40"  # search an existing index

Inputs, all plain JSON/Markdown already in the repository:

    projects/haivn_eip/content/legal/registry.json   -- ids, numbers, titles, status
    projects/haivn_eip/content/legal/text/<id>.md    -- full text (21 of 26 docs)
    projects/haivn_eip/content/legal/maps/<id>.json  -- section key -> label + PDF page

Output: projects/haivn_eip/content/legal/legal-corpus.db, committed to the repo
and declared as `readingsIndex` in projects/haivn_eip/project.json. Unlike the
PPOL index -- a derived copy of copyrighted PDFs, and gitignored for it -- these
are Vietnamese government legal instruments published in the official gazette,
and the repository already ships their full text and their PDFs. There is
nothing here to withhold, and committing the index is what lets Railway serve it
without an upload step after every redeploy.

MIRROR NOTE. This script is deliberately publishable, and ships to
bbdaniels/ai-med-core with the rest of tools/. The four excluded Python tools
each carry something that must not leave the repo -- Google Doc ids that are
bearer capabilities, a spoofed User-Agent and forged Referer, an instructor's
private corpus paths. This one carries none of those, and holds no secret of its
own: its only network call is the embeddings endpoint this deployment is already
configured for, the key comes from the repo-root .env at runtime, and no secret
is written to, or read from, a tracked file. It also does not import
fetch-legal-docs.py, whose registry helpers would have been convenient.

It is not, however, self-contained, and this note used to claim it was. It
imports four helpers from tools/lib/ -- filelock, transcriptions,
openai_gateway, section_order -- all four of which the mirror publishes; and
`jump_maps()` below loads tools/build-jump-maps.py by path, which the mirror
does NOT publish, because that file imports fetch-legal-docs.py and would carry
the spoofed headers out with it. That load is unreachable in the mirror rather
than absent from it: this script reads project-relative paths the mirror does
not carry, so it exits on the missing registry with a clear message long before
any heading is parsed. Two consequences worth stating plainly. The published
copy is there to be read, not run -- the only project it indexes ships with
neither its content nor its map builder. And if the registry check is ever
relaxed, the mirror's copy stops failing on missing content and starts failing
on a missing module, which is a worse error for a stranger to land on.

SCHEMA. The tables here are not this script's to design. packages/api/src/
readings.ts queries a fixed shape, built until now only by tools/build-ppol-
corpus.py, and a second producer of the same shape is exactly the kind of
divergence that goes silent. So SCHEMA below is byte-identical to the one in
build-ppol-corpus.py, and the column meanings are mapped onto legal metadata
rather than invented:

    author_short  the instrument number, "96/2023/NĐ-CP" -- readings.ts renders
                  it as the CITE AS line, which is precisely how the model
                  should cite a statute
    year          the issue year
    title         English title, then the Vietnamese one
    venue         type, issuing agency, validity status, and the language of the
                  indexed text -- rendered next to the title in every passage
    section       the citable location and NOTHING else, "Chương II ... >
                  Điều 5. ...". It carried "(part k of n)" until round 10, which
                  is a fact about our chunker and not about the instrument, and
                  readings.ts writes this field into the `Location:` line the
                  advisor is told to repeat verbatim. Material attached to an
                  instrument rather than enacted in an article says so instead
                  of borrowing the nearest article's number -- see "where the
                  articles stop" below
    page_start /  the PDF pages this chunk's OWN lines are printed on, read off
    page_end      `pageBreaks` in maps/<id>.json and floored at its section's
                  page, so an answer can be turned into a chip that opens the
                  Legal Library at the right page -- see `page_range`
    weeks         "[]" -- a course-schedule concept with no legal analogue.
                  Empty is what keeps readings.ts from printing an "assigned"
                  clause it cannot mean here.
    notice        (on chunks) the staleness note the registry attaches to a
                  passage through `supersededPassages`, as a JSON object of
                  language code to text, set on every chunk that states a
                  restriction in the superseded vocabulary. readings.ts selects
                  the answer language's copy and prints it once per search.
                  NULL on every other chunk, and on every chunk of the PPOL
                  index, whose builder never sets it.
"""

from __future__ import annotations

import argparse
import bisect
import json
import os
import re
import sqlite3
import sys
import time
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import filelock                             # noqa: E402
from lib import transcriptions                       # noqa: E402
from lib import openai_gateway as gateway            # noqa: E402
from lib.openai_gateway import api_post, load_env, pack, unpack  # noqa: E402,F401
from lib.section_order import monotone_assignment    # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
LEGAL_DIR = REPO_ROOT / "projects" / "haivn_eip" / "content" / "legal"
REGISTRY = LEGAL_DIR / "registry.json"
DB_PATH = LEGAL_DIR / "legal-corpus.db"
# Where the build happens; `DB_PATH` is only ever written by a rename. Same
# directory, because a rename is only atomic within one filesystem.
BUILD_PATH = LEGAL_DIR / "legal-corpus.db.build"

# The query embedding is issued by packages/api/src/server.ts with the model id
# hardcoded there. A different model here would produce vectors of a different
# dimension and a silently useless dense ranking, so these two constants are
# pinned to that call, not chosen.
EMBED_MODEL = "text-embedding-3-small"
EMBED_DIM = 1536
EMBED_BATCH = 64

# A Điều is the unit a lawyer cites, so it is the unit we chunk on. Splitting is
# a fallback for the long ones, and the target is generous because a half-quoted
# article is worse than a long passage.
TARGET_TOKENS = 700
OVERLAP_TOKENS = 100
MIN_SPLIT_TOKENS = 120
# A ceiling no chunk may pass, whatever its shape. Some appendices are one
# reconstructed Markdown table with no blank line in it -- a single "paragraph"
# of 22,000 tokens, which paragraph-level splitting cannot touch and which would
# arrive at the model as a 67 KB tool result.
HARD_MAX_TOKENS = 1200

# Rough but stable: the ratio matters only for chunk sizing, never for billing.
# Vietnamese runs shorter per token than English under cl100k; 3 is closer than
# the 4 the English corpus uses.
CHARS_PER_TOKEN = 3

MAX_SECTION_LABEL = 140


def est_tokens(text: str) -> int:
    return max(1, len(text) // CHARS_PER_TOKEN)


# ── headings ─────────────────────────────────────────────────────────────
#
# Vietnamese legal instruments head an article "Điều 40." -- number, then a
# period. The period is load-bearing: "Điều 28 của Luật" and "Điều 12 Nghị định
# này" are mid-sentence cross-references, and the extractor's paragraph
# unwrapping can leave either at the start of a line. Telling those apart is
# `build-jump-maps.parse_heading_parts`, and this file does not do it a second
# time -- see the note under `jump_maps()`.

# Keys in maps/<id>.json are slugs of the same headings: dieu-5, chuong-2,
# muc-1, phu-luc-3.
KEY_RE = re.compile(r"^(dieu|chuong|muc|phu-luc|phan)-([0-9a-z]+)$")

# The heading GRAMMAR and the heading LABEL both live in
# `tools/build-jump-maps.py`, and are borrowed rather than copied. The maps that
# file writes are this builder's authority on which sections exist and what they
# are called, so a second reading of the same line is a divergence waiting to
# happen -- and it happened twice.
#
# The LABEL first: `nd-188-2025-nd-cp`'s publisher transcription prints
# `Chương I` and `QUY ĐỊNH CHUNG` as two paragraphs, the map joined them into one
# label, this file did not, every one of the twelve chapter labels failed to
# match, and 132 chunks lost their `Chương ... > Điều ...` location.
#
# Then the GRAMMAR, which was left behind as a local `classify()` when the label
# was fixed. The two regex sets disagreed on 77 lines of this corpus. Two of
# them cost a map section outright -- `tt-30`'s `Điểu 5.` and `tt-43`'s
# `Điêu 6.`, publisher typos that `heading_form` normalises and a literal
# `^Điều` pattern does not. Three were worse because nothing reported them:
# `luat-15` spells three of its `Mục` headings in decomposed (NFD) Unicode,
# which a composed `^Mục` pattern cannot match at all, so `Điều 48` was filed
# under the chapter instead of under `Mục 1 GIẤY PHÉP HOẠT ĐỘNG KHÁM BỆNH,
# CHỮA BỆNH` and no unmatched count went up. One grammar, in one file.
#
# The KEY's spelling is borrowed for the same reason: a marker's key is compared
# against the map's keys, so `jump_maps.section_key` writes both sides. `KEY_RE`
# below is this file's READER of that shape and the only local statement of it.
_JUMP_MAPS = None


def jump_maps():
    """`tools/build-jump-maps.py` as a module, loaded on first use (a hyphen is
    not a legal module name, so it cannot simply be imported)."""
    global _JUMP_MAPS
    if _JUMP_MAPS is None:
        import importlib.util  # noqa: PLC0415 - only this one function needs it

        spec = importlib.util.spec_from_file_location(
            "build_jump_maps", Path(__file__).with_name("build-jump-maps.py"))
        if spec is None or spec.loader is None:
            sys.exit("error: cannot load tools/build-jump-maps.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _JUMP_MAPS = mod
    return _JUMP_MAPS


# The vocabulary `parse_heading_parts` is asked about here. The order is the
# order it tries the kinds in, and `dieu` leads because it is the overwhelming
# majority of every document's headings.
LABEL_KINDS = ("dieu", "phu-luc", "chuong", "muc", "phan")

ANNEX_KIND = "annex"
CONTAINER_KINDS = {"chuong", "muc", "phan"}
BOUNDARY_KINDS = {"dieu", "phu-luc", ANNEX_KIND}
# What ends the run of chapters: an appendix is attached to the instrument, not
# filed under whichever Chương or Mục happened to come last.
APPENDIX_KINDS = {"phu-luc", ANNEX_KIND}


# ── where the articles stop ──────────────────────────────────────────────
#
# A Vietnamese instrument's numbered articles end at its signature block, and
# what follows is a different kind of thing: a promulgated plan, a technical
# guideline, a tariff schedule, a set of forms. That material belongs to no
# Điều at all. Nothing above notices, because a segment simply runs to the next
# heading and the last one runs to the end of the file -- so the whole tail
# inherited the last article's label and the last article's PDF page, and the
# prompt instructs the model to cite exactly that. 35/2016/TT-BYT is the plain
# case: its technical-services payment schedule was labelled "Điều 8. Tổ chức
# thực hiện", an eight-line ministry-coordination clause a quarter of the way
# into the document, at that clause's page.
#
# The signature block is the reliable terminator: every one of these documents
# closes with a "Nơi nhận:" distribution list and a signing title. Attachment
# headings are the second signal, for the documents whose extraction lost the
# signature block or put the attachment first.

GAZETTE_BREAK = "<!-- gazette part break -->"

CLOSING_RE = re.compile(
    r"^(?:N[oơ]i\s+nh[aâậ]n)\s*:"                     # distribution list
    r"|^(?:KT|TL|TM|TUQ)\.\s"                         # "KT. BỘ TRƯỞNG" etc.
    r"|^(?:BỘ\s+TRƯỞNG|THỨ\s+TRƯỞNG|CHỦ\s+TỊCH\s+QUỐC\s+HỘI|THỦ\s+TƯỚNG)\b"
    r"|^XÁC\s+THỰC\s+VĂN\s+BẢN\s+HỢP\s+NHẤT\b"
)

# Headings an attachment introduces itself with. Applied only inside the tail,
# never to the operative text, so a loose match here cannot split an article.
ANNEX_HEADING_RE = re.compile(
    r"^(?:PHỤ\s+LỤC|Phụ\s+lục|PHU\s+LUC|Phu\s+luc"
    r"|MẪU\s+SỐ|Mẫu\s+số|BIỂU\s+MẪU|Biểu\s+mẫu"
    r"|DANH\s+MỤC|Danh\s+mục|DANH\s+SÁCH|Danh\s+sách"
    r"|KẾ\s+HOẠCH|HƯỚNG\s+DẪN|QUY\s+TRÌNH|QUY\s+CHẾ|QUY\s+ĐỊNH|CHƯƠNG\s+TRÌNH)\b"
)

# Two honest labels, in place of one false citation. Both name themselves as
# outside the articles, in Vietnamese for the text and in English for the model,
# so a passage from here cannot be read as "Điều N says".
ANNEX_SIGNATURE_LABEL = "Phần ký ban hành (signature block, not part of any Điều)"
ANNEX_PREFIX = "Tài liệu ban hành kèm theo (attached material, not part of any Điều)"
MAX_ANNEX_HEADING = 90
# Below this the tail is a signature and nothing else: separating it would churn
# every document's last chunk to fix a label nobody would misread.
ANNEX_MIN_TOKENS = 300


@dataclass
class Marker:
    """A heading found in the text: where it is, what it is, what page it is on."""
    line: int
    kind: str                    # dieu | phu-luc | chuong | muc | phan
    key: str                     # map key when matched, else a synthesized one
    label: str
    page: int = 0                # 1-based PDF page, 0 when unmapped
    mapped: bool = False


@dataclass
class Chunk:
    section: str
    page: int                    # 1-based PDF page the chunk STARTS on, 0 when unknown
    text: str
    part: int = 1
    parts: int = 1
    page_end: int = 0            # the page it ENDS on; equals `page` where unmeasured


@dataclass
class DocResult:
    doc_id: str
    chunks: list[Chunk] = field(default_factory=list)
    language: str = "vi"
    mapped_sections: int = 0
    text_sections: int = 0        # headings the map does not carry, read from the text
    unmatched_sections: int = 0
    duplicates: int = 0
    orphan_transcriptions: int = 0
    source: str = "map"          # map | heuristic


def norm(s: str) -> str:
    """Casefold + collapse whitespace + drop punctuation, for prefix matching.

    Map labels come from the PDF's own line boxes and the Markdown from the same
    PDF's unwrapped paragraphs, so they agree on the words and disagree on the
    spacing and on a trailing colon often enough to matter.
    """
    s = unicodedata.normalize("NFC", s)
    s = re.sub(r"\s+", " ", s).strip().casefold()
    return s.strip(" .:;,-")


# Markdown furniture, and the opening quotation mark an amending law puts in
# front of the article it is substituting ("Điều 7. ... " inside 51/2024/QH15).
LEAD_CHARS = "#>*_ \t“”‘’\"'"
# An emphasis run anywhere in a line. `_` only where it is not inside a word,
# so an identifier is left alone.
EMPHASIS_MARKS = re.compile(r"\*+|(?<![0-9A-Za-zÀ-ỹ])_+(?![0-9A-Za-zÀ-ỹ])")


def strip_front_matter(text: str) -> str:
    """Drop the provenance header tools/fetch-legal-docs.py writes above the text.

    Two shapes exist in content/legal/text: a government-PDF extraction that ends
    its header with a horizontal rule, and a working copy from a legal-reference
    site that ends its header with a `Source:` line. Both are metadata the
    registry already holds, and indexing them would put the same boilerplate
    sentence into 21 documents' first chunk.
    """
    return split_front_matter(text)[0]


def split_front_matter(text: str) -> tuple[str, int]:
    """`strip_front_matter`, plus how many lines it took off the top.

    The offset is what lets a line of the stripped body be named in the file as
    it is on disk, which is the coordinate `maps/<id>.json`'s `pageBreaks` are
    written in. One function so the two answers cannot drift: a header shape
    added to one and not the other would put every page break in that document
    a few lines out, silently."""
    lines = text.splitlines()
    for i, line in enumerate(lines[:24]):
        if line.strip() == "---":
            return "\n".join(lines[i + 1:]), i + 1
    for i, line in enumerate(lines[:24]):
        if line.strip().lower().startswith(("source:", "official source:")):
            return "\n".join(lines[i + 1:]), i + 1
    if lines and lines[0].startswith("# "):
        return "\n".join(lines[1:]), 1
    return text, 0


# A figure the fetcher saved beside the text, written into it as a Markdown
# image at a repo-relative path. The path is plumbing: it means nothing to a
# reader and the advisor is instructed to quote its chunks, so leaving it in
# invites a file path into an answer. The alt text -- the only part that says
# anything -- is kept in its place, on the same line, so the line numbers the
# section map matches against do not move.
FIGURE_IMAGE = re.compile(r"!\[([^\]]*)\]\(((?:projects/)[^)\s]*)\)")


def strip_figure_paths(text: str) -> str:
    return FIGURE_IMAGE.sub(lambda m: f"[{m.group(1)}]" if m.group(1) else "", text)


def figure_stems(lines: list[str]) -> dict[int, list[str]]:
    """`{line index: [fig-01, ...]}` for the figures embedded in the text.

    Read BEFORE `strip_figure_paths` runs, because the stem is in the path it
    removes -- and read by line, because the stem is how a transcription finds
    the section its figure sits in. `strip_figure_paths` is a same-line
    substitution, so these indices stay valid against the stripped body."""
    out: dict[int, list[str]] = {}
    for i, line in enumerate(lines):
        stems = [Path(m.group(2)).stem for m in FIGURE_IMAGE.finditer(line)]
        if stems:
            out[i] = stems
    return out


def vietnamese(text: str) -> bool:
    """Density of Vietnamese-only diacritics. The texts are Vietnamese originals;
    this exists so a future English translation is labelled honestly rather than
    inheriting a hardcoded 'vi'."""
    sample = text[:20000]
    if not sample:
        return True
    hits = sum(1 for ch in sample if ch in "ăâđêôơưĂÂĐÊÔƠƯ")
    return hits / max(1, len(sample)) > 0.005


# ── locating the sections ────────────────────────────────────────────────


def heading_candidates(lines: list[str]) -> list[tuple[int, str, str, str, bool]]:
    """Every line that reads as a heading: (line index, kind, number, label,
    annexed).

    Both the grammar and the label are `build-jump-maps.py`'s, so a line reads
    here exactly as it reads in the map this text is matched against -- down to
    the bare marker whose title is printed on the line under it (`Chương I` /
    `QUY ĐỊNH CHUNG`, which is how the aggregator editions set a chapter).

    The number keeps its lettered variant (`48b`), which the map keys never
    carry: an amending law's inserted article is not the article it was inserted
    after, and pass 2 matches these numbers against the keys by string.

    `annexed` is `jump_maps.annexed_scanner` -- the heading is a section of a
    document this instrument CARRIES rather than one of its own: a `Phụ lục`
    whose own issuing clause names an annexed document, or a `Chương`/`Mục`/
    `Điều` printed after the appendices begin. It is the map builder's
    discriminator, called rather than reimplemented, and it is a FLAG rather
    than a filter because the two callers below want opposite answers:
    `markers_from_map` must not anchor one of this instrument's keys on a
    carried document's section, while `markers_from_headings` -- the fallback
    for a document with no map -- is chunking the text as it stands, where that
    section is a real section.
    """
    jm = jump_maps()
    annexed = jm.annexed_scanner(LABEL_KINDS)
    out: list[tuple[int, str, str, str, bool]] = []
    for i, raw in enumerate(lines):
        line = raw.lstrip(LEAD_CHARS).strip()
        # A line the source wrote as a list item is a contents entry, not the
        # section it names -- see `jump_maps.list_bullet` for why this builder
        # refuses one and the map builder does not.
        if not line or jm.list_bullet(raw):
            continue
        hit = jm.parse_heading_parts(line, LABEL_KINDS)
        if hit:
            kind, number, suffix, title = hit
            out.append((i, kind, f"{number}{suffix}",
                        jm.heading_label(lines, i, line, title, LABEL_KINDS),
                        annexed(lines, i, kind)))
    return out


def markers_from_map(lines: list[str], sections: list[dict]) -> tuple[list[Marker], int]:
    """Locate each curated section in the text.

    The map is the authority on which sections it carries, what they are called
    and what page they start on; the text is the authority on where they begin
    -- and on which sections EXIST, which is not the same thing and used to be
    treated as if it were. Matching runs in three passes: first the labels,
    which are near-verbatim (both sides come out of the same PDF), then -- only
    inside the window between two already-fixed neighbours -- the heading's own
    number, which is what the key encodes, and finally the headings whose key
    the map does not carry at all, which open a marker of their own with no
    page. Number matching alone is far too weak to be trusted globally: the
    string "Điều 5." occurs in most of these documents more than once.

    Pass 1 assigns globally rather than with a forward cursor
    (`lib.section_order.monotone_assignment`), because a label can match several
    lines and one misleading recurrence must lose only itself. The map's own
    section order is what the assignment runs against, and since round 9 that
    order is guaranteed monotone by `build-jump-maps.py`, which runs the same
    function over the pages before it writes the file -- so a section this pass
    cannot place is one this TEXT does not support, not one the map ordered
    wrongly. Lines are STRICTLY increasing: two sections cannot begin on the
    same line, which is the one place this differs from the map builder's call.
    """
    parsed: list[tuple[str, str, str, str, int]] = []   # key, kind, number, label, page
    unparsed = 0
    for sec in sections:
        km = KEY_RE.match(sec.get("key", ""))
        if not km:
            unparsed += 1
            continue
        label = re.sub(r"\s+", " ", sec.get("label", "") or "").strip()
        parsed.append((sec["key"], km.group(1), km.group(2), label,
                       int(sec.get("page") or 0)))

    cands = heading_candidates(lines)

    # Pass 1 -- label matches only.
    strong: dict[int, list[int]] = {}
    for i, (_, kind, _, label, _) in enumerate(parsed):
        prefix = norm(label)[:20]
        if not prefix:
            continue
        strong[i] = [ln for ln, k, _, text, annexed in cands
                     if k == kind and not annexed and norm(text).startswith(prefix)]
    assigned = monotone_assignment(strong, len(parsed), strict=True)

    # Pass 2 -- fill the gaps by number, bounded by the anchors on either side.
    for i, (_, kind, number, _, _) in enumerate(parsed):
        if i in assigned:
            continue
        lo = max((assigned[j] for j in range(i) if j in assigned), default=-1)
        hi = min((assigned[j] for j in range(i + 1, len(parsed)) if j in assigned),
                 default=len(lines))
        # An annexed document's sub-appendix is refused here for the same
        # reason the map refuses to key it: `tt-40-2025-tt-byt`'s model
        # framework agreement prints `PHỤ LỤC 2` and `PHỤ LỤC 3` of its own,
        # and filling a gap by number alone is exactly how the circular's own
        # Phụ lục III would be anchored on one of them -- the map bug, one tool
        # later, with nothing said.
        hit = next((ln for ln, k, num, _, annexed in cands
                    if k == kind and num == number and not annexed and lo < ln < hi), None)
        if hit is not None:
            assigned[i] = hit

    markers = [
        Marker(line=assigned[i], kind=parsed[i][1], key=parsed[i][0],
               label=parsed[i][3] or lines[assigned[i]].strip(),
               page=parsed[i][4], mapped=True)
        for i in sorted(assigned, key=lambda i: assigned[i])
    ]

    # Pass 3 -- A HEADING THE MAP DOES NOT CARRY IS STILL A HEADING, and
    # opening no marker for it does not leave it unlabelled: it leaves it
    # labelled as the section ABOVE it, at that section's page, in the
    # `Location:` the advisor is told to repeat verbatim. That is the same
    # false citation `annex_markers` exists to stop at the signature block, one
    # boundary earlier, so it gets the same answer -- a marker read out of the
    # text, with no page of its own.
    #
    # Two ways the map comes to be missing a section this text has. A section
    # the map DROPPED: `luat-15-2023-qh15`'s `Chương XII` and
    # `tt-05-2024-tt-byt`'s `Phụ lục II` were both dropped as `nomatch` until
    # the sliding anchor learned to step over a garbled numeral, and while they
    # were, five of luat-15's chunks cited Chương XI and the whole of tt-05's
    # Phụ lục II cited `PHỤ LỤC I ... p. 27`. And a section the key space
    # cannot hold: `Điều 48a` and `Điều 48b` are new articles an amending law
    # inserts, `Phần` is a kind the maps deliberately do not carry, and neither
    # is ever going to appear in a map file.
    #
    # The test is the KEY: a key the map carries has already been placed by the
    # two passes above, and a second line reading as that key is the recurrence
    # they exist to reject (`Điều 17.` inside an appendix form). A key the map
    # does not carry at all has nothing to collide with.
    #
    # THE ONE EXCEPTION IS A CONTAINER WHOSE NUMBERING RESTARTS, and it is the
    # third way a map comes to be missing a section. The map key space is flat
    # `<kind>-<number>`, so `luat-15-2023-qh15`, which restarts `Mục 1` under
    # six of its twelve chapters, has one `muc-1` and five sections with nowhere
    # to live. Chương IV's `Mục 1 GIẤY PHÉP HOẠT ĐỘNG ...` is one of those five,
    # and every article under it -- Điều 48 first -- was filed under `Chương IV`
    # instead. THE TITLE is what separates a restart from a recurrence: the map
    # says which section that key names, and a `Mục 1` printed under a
    # different title is a different section. A marker here is local to this
    # builder (nothing downstream reads `Marker.key`), so this fixes the
    # `Location:` without touching the key space at all.
    #
    # QUALIFYING THE MAP'S KEYS BY PARENT (`chuong-4/muc-1`) IS STILL OPEN, and
    # the reason it was not done here is scope, not impossibility. Do not repeat
    # the reason this comment used to give -- that `doc-refs.ts` builds a key
    # out of a chat citation reading only "Mục 1", so a qualified key would
    # leave those citations unresolvable. It does not: `doc-refs.ts` keys
    # ARTICLES only (`DEFAULT_LEGAL_SECTION_WORDS` is Điều / Article / Art.,
    # `LEGAL_SECTION_PREFIX` is `dieu`, and no project overrides either), for
    # the reason its own comment gives -- an answer writes `Chương I` where the
    # map writes `chuong-1`, and guessing between them sends a reader to the
    # wrong page. The real consumer of a `muc-` key is the Legal Library's jump
    # list (`jumpableSections` / `sectionPageIndex` in `legal-map.ts`), which
    # therefore still offers one `Mục 1` per document. That is the map's limit,
    # and lifting it is a change to `KEY_RE` here and to `legal-map.ts` --
    # not to this pass.
    keyed = {key: norm(label) for key, _kind, _num, label, _page in parsed}
    taken = set(assigned.values())
    unmapped: list[Marker] = []
    section_key = jump_maps().section_key
    for ln, kind, number, label, annexed in cands:
        if annexed or ln in taken:
            continue
        key = section_key(kind, number)
        if key in keyed:
            mapped_label = keyed[key]
            if kind not in CONTAINER_KINDS or not label or not mapped_label:
                continue
            if norm(label).startswith(mapped_label[:20]):
                continue                     # the same section, seen twice
        unmapped.append(Marker(line=ln, kind=kind, key=key, label=label, page=0))
    return (sorted(markers + unmapped, key=lambda m: m.line),
            len(parsed) - len(assigned) + unparsed)


def markers_from_headings(lines: list[str]) -> list[Marker]:
    """Fallback for a document with text but no section map.

    Accepts a Điều only where the numbering can be read as a sequence: the next
    number, a lettered variant of the current one (Điều 48b), or a restart at 1
    -- which is what happens when a Quyết định promulgates a Quy chế that
    numbers its own articles from scratch.
    """
    markers: list[Marker] = []
    last = 0
    section_key = jump_maps().section_key
    for i, kind, number, line, _annexed in heading_candidates(lines):
        if kind == "dieu":
            digits = int(re.match(r"\d+", number).group(0))
            letter = number[len(str(digits)):]
            ok = digits == last + 1 or (digits == last and letter) or digits == 1
            if not ok:
                continue
            last = digits
        label = line[:MAX_SECTION_LABEL]
        markers.append(Marker(line=i, kind=kind, key=section_key(kind, number), label=label))
    return markers


def clean_line(raw: str) -> str:
    """One line with its Markdown furniture taken off.

    Emphasis goes from anywhere in the line, not just its front. This line
    becomes a chunk's `section`, `readings.ts` writes that verbatim into the
    `Location:` the advisor reads an article number off, and the advisor is
    instructed to answer with no markdown in it -- so a `**` that survives here
    is a marker the model is handed and told not to write. A heading whose text
    is bold end to end loses the markers to `LEAD_CHARS` on the left and kept
    them on the right; an attachment title with a bold name and an italic
    parenthetical after it kept them in the middle.
    """
    return re.sub(r"\s+", " ", EMPHASIS_MARKS.sub("", raw.lstrip(LEAD_CHARS))).strip()


def annex_heading(line: str) -> bool:
    """An attachment heading, and not a cross-reference the unwrapper broke.

    "(thực hiện theo Phụ lục 1)" wrapped onto its own line reads as a heading to
    the regex and is a fragment. The unmatched closing parenthesis it leaves
    behind is what tells the two apart.
    """
    return bool(ANNEX_HEADING_RE.match(line)) and line.count(")") <= line.count("(")


def annex_markers(lines: list[str], markers: list[Marker]) -> list[Marker]:
    """Markers for the attached material that follows the last article.

    The region at issue starts after the document's last Điều and ends at the
    next heading of any kind -- usually a Phụ lục, which already labels itself
    honestly, and often the end of the file. Only that region can attribute
    attached material to an article, so only that region is touched: a tail that
    already starts at a Phụ lục or a Chương is left exactly as it was.

    Everything these markers cover is given page 0. The section map located
    articles, never the attachments, so the page is genuinely unknown, and 0 is
    the value the header composer and the chip system already read as "no page".
    """
    dieu = [i for i, mk in enumerate(markers) if mk.kind == "dieu"]
    if not dieu:
        return []
    start = markers[dieu[-1]].line + 1
    end = markers[dieu[-1] + 1].line if dieu[-1] + 1 < len(markers) else len(lines)

    boundary = None
    for i in range(start, end):
        line = clean_line(lines[i])
        if not line:
            continue
        if (line.startswith(GAZETTE_BREAK) or CLOSING_RE.match(line)
                or annex_heading(line)):
            boundary = i
            break
    if boundary is None:
        return []
    if est_tokens("\n".join(lines[boundary:end])) < ANNEX_MIN_TOKENS:
        return []

    def annex_label(line: str) -> str:
        return f"{ANNEX_PREFIX} > {line[:MAX_ANNEX_HEADING]}"

    head = clean_line(lines[boundary])
    out = [Marker(line=boundary, kind=ANNEX_KIND, key="annex-0",
                  label=annex_label(head) if annex_heading(head)
                  else ANNEX_SIGNATURE_LABEL)]
    for i in range(boundary + 1, end):
        line = clean_line(lines[i])
        if line and annex_heading(line):
            out.append(Marker(line=i, kind=ANNEX_KIND, key=f"annex-{len(out)}",
                              label=annex_label(line)))
    return out


# ── chunking ─────────────────────────────────────────────────────────────


def split_long(body: str, target: int, overlap: int) -> list[str]:
    """Split one over-long section on paragraph boundaries, with a little overlap.

    Paragraph granularity keeps a numbered khoản whole, which is the smallest
    unit anyone quotes.
    """
    if est_tokens(body) <= target:
        return [body]
    paras = [p for p in re.split(r"\n\s*\n", body) if p.strip()]
    parts: list[str] = []
    buf: list[str] = []
    buf_tokens = 0
    for para in paras:
        t = est_tokens(para)
        if buf and buf_tokens + t > target:
            parts.append("\n\n".join(buf))
            tail: list[str] = []
            tail_tokens = 0
            for prev in reversed(buf):
                if tail_tokens >= overlap:
                    break
                tail.insert(0, prev)
                tail_tokens += est_tokens(prev)
            buf = tail
            buf_tokens = tail_tokens
        buf.append(para)
        buf_tokens += t
    if buf:
        merged = "\n\n".join(buf)
        # A trailing sliver is overlap and nothing else; fold it back.
        if parts and est_tokens(merged) < MIN_SPLIT_TOKENS:
            parts[-1] = parts[-1] + "\n\n" + merged
        else:
            parts.append(merged)

    # Ceiling pass: a part still over HARD_MAX_TOKENS is a single unbroken block
    # (a table), so break it on line boundaries rather than let it through.
    capped: list[str] = []
    for part in parts or [body]:
        if est_tokens(part) <= HARD_MAX_TOKENS:
            capped.append(part)
            continue
        rows, size = [], 0
        for line in part.splitlines():
            t = est_tokens(line)
            if rows and size + t > target:
                capped.append("\n".join(rows))
                rows, size = [], 0
            rows.append(line)
            size += t
        if rows:
            capped.append("\n".join(rows))
    return capped or [body]


# ── what a figure SAYS ───────────────────────────────────────────────────
#
# A figure in these instruments is often where the operative content is:
# 1868/QĐ-BYT lays its HBV marker-interpretation table (Bảng 2) out as a picture
# and draws six of its testing algorithms as flow charts. Nothing extracts that,
# so it is transcribed by hand into `content/legal/transcriptions/<id>.md`,
# named from the registry as `figureTranscriptions` (see lib/transcriptions.py).
#
# Round 6 got it into the index by splicing it into the DISPLAYED text, and
# HAIVN's reviewers reported on 2026-09-04 that a transcription printed under
# the figure duplicates what they are already looking at. The coupling was the
# defect: the reader's text file was load-bearing for the search index. So the
# transcription is read here, from the sidecar, and indexed as chunks of the
# section its figure sits in -- through the SAME `emit` as every other chunk, so
# it is split, sized, page-stamped, headed and deduped identically. There is no
# second chunking path, and the text file is now only the text.
#
# A transcription whose figure is not in the text is still indexed, against the
# document with no section of its own, because losing an algorithm from the
# index is the failure this whole mechanism exists to prevent. `--format`
# reports the mismatch on the curated side, which is where it can be fixed.
def transcription_section(parent: str, stem: str,
                          entry: tuple[str, str]) -> str:
    """The citable location for a figure's transcription.

    The figure's own caption is the label -- `Bảng 2: Phiên giải ...` is what a
    reader would cite -- hung under the section the figure appears in. An
    appendix algorithm's caption IS its section's heading (the `Phụ lục` line is
    the only name it has), and `Phụ lục 1. ... > Phụ lục 1. ...` is a location
    that reads as two places; where they are the same, one of them is enough."""
    caption = entry[0] or stem
    if not parent or norm(parent.rsplit(" > ", 1)[-1]) == norm(caption):
        return parent or caption
    return f"{parent} > {caption}"


# ── what page a CHUNK is on ──────────────────────────────────────────────
#
# Until round 10 a chunk was stamped with its SECTION's page, so
# `tt-40-2025-tt-byt`'s Phụ lục III spans PDF pages 172-301 and all 199 of its
# chunks cited 172, and `page_start` and `page_end` were the same number on all
# 2,209 chunks in the index. Never impossible -- a chunk is at or after the page
# it names -- but the longer the section the further its last chunk is from the
# page it claims, and there was no page evidence in this pipeline for a line in
# the middle of one.
#
# There is now: `build-jump-maps.py` measures where each PDF page opens in the
# canonical text and writes it into `maps/<id>.json` as `pageBreaks`, in the
# coordinates of the file on disk. This is the reader of that measurement.
#
# The section's own page stays the FLOOR. It is the curated number, confirmed by
# an exact n-gram against exactly one page, and clamping to it keeps a section's
# first chunk on the page the map confirmed for it.
#
# THREE WAYS THIS UNDERSTATES A PAGE, and all three err in the direction a jump
# target may -- the reader lands earlier in the PDF and reads forward:
#
#   - a page the measurement could not place is not claimed, so the lines it
#     covers read as the last page that WAS placed. Where several consecutive
#     pages are unplaced -- `vbhn-15-2024-byt` places 17 of 75, `tt-05-2024-tt-
#     byt` 35 of 70 -- that is not the section's page either, but a specific
#     earlier page, and it can be a long way back;
#   - a break is anchored at the first window of the page that is unique, which
#     may be a line or two below the page's true first line;
#   - `locate` cannot find a chunk's own lines at all (about 100 chunks, most of
#     them later parts of a segment `split_long` overlapped), and the chunk then
#     keeps its section's page at both ends -- the behavior every chunk had
#     before round 10. That is where the widest understatements are: four of
#     `tt-40-2025-tt-byt`'s Phụ lục III chunks sit ~125 pages into a 130-page
#     appendix and cite its first page.
#
# IT MUST NOT OVERSTATE, and that is not this file's doing: `page_breaks` bounds
# every break by the sections the map confirmed either side of it, so a break
# cannot land above a section confirmed below it and a chunk cannot be pushed
# past the page its own section was confirmed on. That property is checked in
# the map builder, not patched up here with a ceiling -- see `page_range`.


def page_lookup(breaks: list[dict] | None, offset: int):
    """`line index in the stripped body -> PDF page`, or None where unknown.

    `offset` is the front matter `split_front_matter` removed, since the breaks
    are numbered against the file as it is on disk."""
    pairs = sorted((int(b["line"]), int(b["page"])) for b in (breaks or [])
                   if b.get("line") and b.get("page"))
    if not pairs:
        return lambda _index: None
    starts = [line for line, _page in pairs]
    pages = [page for _line, page in pairs]

    def at(index: int) -> int | None:
        position = bisect.bisect_right(starts, offset + index + 1) - 1
        return pages[position] if position >= 0 else None

    return at


def chunk_document(doc_id: str, text: str, sections: list[dict] | None,
                   transcripts: dict[str, tuple[str, str]] | None = None,
                   breaks: list[dict] | None = None) -> DocResult:
    stripped, offset = split_front_matter(text)
    figures = figure_stems(stripped.splitlines())
    transcripts = dict(transcripts or {})
    body = strip_figure_paths(stripped)
    lines = body.splitlines()
    page_at = page_lookup(breaks, offset)
    result = DocResult(doc_id=doc_id, language="vi" if vietnamese(body) else "en")

    if sections:
        markers, unmatched = markers_from_map(lines, sections)
        result.unmatched_sections = unmatched
        result.mapped_sections = sum(1 for m in markers if m.mapped)
        result.text_sections = len(markers) - result.mapped_sections
        result.source = "map"
        # A map that matched nothing is no map. The test is the MAPPED markers:
        # pass 3 reads headings out of the text, and counting those would let a
        # map that placed not one of its sections look like a working one.
        if not result.mapped_sections:
            markers = markers_from_headings(lines)
            result.text_sections = 0
            result.source = "heuristic (map matched nothing)"
    else:
        markers = markers_from_headings(lines)
        result.source = "heuristic (no map)"

    markers.sort(key=lambda m: m.line)
    # Attached material belongs to no article, and without these markers it is
    # attributed to the last one. See annex_markers.
    markers = sorted(markers + annex_markers(lines, markers), key=lambda m: m.line)

    # Preamble: everything before the first heading. For a legal instrument this
    # is the title block and the "Căn cứ" recitals -- the authority the document
    # is issued under, which is a real answer to a real question.
    bounds = [m.line for m in markers]
    segments: list[tuple[Marker | None, str, list[str], tuple[int, int]]] = []

    def stems_in(start: int, end: int) -> list[str]:
        return [s for i in range(start, end) for s in figures.get(i, ())]

    first = bounds[0] if bounds else len(lines)
    preamble = "\n".join(lines[:first]).strip()
    if preamble:
        segments.append((None, preamble, stems_in(0, first), (0, first)))
    for idx, marker in enumerate(markers):
        end = markers[idx + 1].line if idx + 1 < len(markers) else len(lines)
        segments.append((marker, "\n".join(lines[marker.line:end]).strip(),
                         stems_in(marker.line, end), (marker.line, end)))

    def locate(part: str, span: tuple[int, int] | None,
               cursor: int) -> tuple[int, int] | None:
        """The lines of `lines` a chunk's text came from, [first, last].

        A chunk is a run of the segment's own paragraphs, joined back together,
        so its lines are the segment's lines verbatim -- which is why they can
        simply be walked. The walk starts at the PREVIOUS chunk's first line,
        not its last, because `split_long` overlaps a paragraph or two between
        neighbouring parts. Where a line cannot be found the search stops and
        the span ends where it got to: an early end costs page precision and
        cannot invent a page the text does not reach.
        """
        if span is None:
            return None
        low, high = span
        wanted = [ln.strip() for ln in part.splitlines() if ln.strip()]
        if not wanted:
            return None
        start = next((i for i in range(max(low, cursor), high)
                      if lines[i].strip() == wanted[0]), None)
        if start is None:
            return None
        last = at = start
        for text in wanted[1:]:
            at = next((i for i in range(at + 1, high)
                       if lines[i].strip() == text), None)
            if at is None:
                break
            last = at
        return start, last

    def page_range(page: int, span: tuple[int, int] | None) -> tuple[int, int]:
        """What this chunk may claim about its pages.

        `page` is its section's, and it is the FLOOR: it was confirmed against
        exactly one page of the PDF, and a chunk of that section is at or after
        it. A page the measurement could not place is not claimed at all -- the
        lines it covers read as the last page that WAS placed, which is early --
        so the floor is what keeps a section's own first chunk on the page the
        map confirmed for it.

        The floor clamps one end only, which is safe just as long as the
        measurement itself cannot run ahead of the map. That is a property of
        `page_breaks` in `build-jump-maps.py`, not of this function: it bounds
        every break by the confirmed sections either side of it, so a break can
        no longer land above a section the map confirmed below it. It could
        before -- the first version chose among up to eight candidate positions
        and `monotone_assignment` takes the earliest one the order rule allows,
        which put `nd-96-2023-nd-cp` page 68 forty lines above the `Điều 34` the
        map confirmed on page 67 and made 22 chunks claim a page LATER than the
        page their text is printed on. Do not add a ceiling here to paper over a
        recurrence of that; the measurement is where it has to be right."""
        if span is None:
            return page, page
        start = page_at(span[0])
        end = page_at(span[1])
        start = page if start is None else max(start, page)
        end = start if end is None else max(end, start)
        return start, end

    # Containers (Chương / Mục / Phần) are context, not citations: their heading
    # rides along with the next article rather than becoming a chunk of its own.
    pending_text: list[str] = []
    pending_figs: list[str] = []
    pending_span: tuple[int, int] | None = None
    parent: str = ""
    page_carry = 0

    def emit(section: str, page: int, body_text: str,
             figs: list[str] | None = None,
             span: tuple[int, int] | None = None) -> None:
        body_text = body_text.strip()
        if body_text:
            parts = split_long(body_text, TARGET_TOKENS, OVERLAP_TOKENS)
            cursor = span[0] if span else 0
            for i, part in enumerate(parts):
                at = locate(part, span, cursor)
                if at:
                    cursor = at[0]
                start, end = page_range(page, at)
                result.chunks.append(Chunk(section=section, page=start, text=part,
                                           part=i + 1, parts=len(parts),
                                           page_end=end))
        # A figure standing in this section: its transcription is indexed here,
        # under the figure's own caption, and through this same call so it is
        # split, sized and page-stamped exactly like the prose around it. Popped
        # rather than read, so what is left over at the end is the orphans.
        #
        # A transcription is the CURATOR's text, not the document's, so it has
        # no lines in this file to measure: it takes its figure's section page
        # at both ends, which is what `span=None` says.
        for stem in figs or ():
            entry = transcripts.pop(stem, None)
            if entry:
                emit(transcription_section(section, stem, entry), page, entry[1])

    def drain(page: int) -> None:
        """Flush whatever has accumulated under a container heading.

        A Chương/Mục heading and nothing else is context for the next article and
        rides along with it. A Chương/Mục carrying substantive text of its own --
        which happens in the procurement Thông tư, where a Mục runs for pages
        before its first Điều -- is content, and gluing it onto the next article
        would both mislabel it and make one 22,000-token chunk out of it.

        `page` is the page of the material being flushed -- the page carried by
        the marker that OPENED this accumulation, not the one that closes it.
        Every caller is on the closing marker, so every caller has to drain
        BEFORE it advances `page_carry`; draining after was a wrong page claim
        shipping in this corpus (see the loop below).
        """
        nonlocal pending_text, pending_figs, pending_span
        blob = "\n\n".join(pending_text).strip()
        figs, span = pending_figs, pending_span
        pending_text, pending_figs, pending_span = [], [], None
        if blob and est_tokens(blob) > MIN_SPLIT_TOKENS:
            emit(parent or "Unnumbered provisions", page, blob, figs, span)
        elif blob:
            pending_text, pending_figs, pending_span = [blob], figs, span

    def widen(span: tuple[int, int] | None,
              add: tuple[int, int]) -> tuple[int, int]:
        return add if span is None else (span[0], max(span[1], add[1]))

    for marker, seg, figs, span in segments:
        if marker is None:
            if seg:
                emit("Preamble (title block and recitals)",
                     1 if sections else 0, seg, figs, span)
            continue
        # THE DRAIN COMES FIRST, AND `page_carry` ADVANCES AFTER IT. What has
        # accumulated is the text between the PREVIOUS marker and this one, so
        # it is on the previous marker's page; stamping it with the page of the
        # marker that closes it is a page claim the document does not support.
        # Not theoretical: `tt-40-2025-tt-byt`'s Mục 5 block -- text running
        # from PDF page 92 to page 171 -- carried the page of the appendix that
        # follows it, so 124 chunks cited page 172, a page none of their text
        # is printed on, and 110 more cited 92 for text beginning on 46.
        if marker.kind in CONTAINER_KINDS:
            drain(page_carry)
            page_carry = marker.page or page_carry
            parent = marker.label
            pending_figs.extend(figs)
            if seg:
                pending_text.append(seg)
                pending_span = widen(pending_span, span)
            continue
        if marker.kind not in BOUNDARY_KINDS:
            pending_text.append(seg)
            pending_figs.extend(figs)
            pending_span = widen(pending_span, span)
            continue

        drain(page_carry)
        page_carry = marker.page or page_carry
        full = ("\n\n".join(pending_text + [seg])).strip() if pending_text else seg
        figs = pending_figs + figs
        span = widen(pending_span, span)
        pending_text, pending_figs, pending_span = [], [], None
        if marker.kind in APPENDIX_KINDS:
            # An appendix is attached to the instrument, not filed inside its
            # last chapter: `Chương V ĐIỀU KHOẢN THI HÀNH > Phụ lục I` and
            # `Mục 5 ... > PHỤ LỤC III` are `Location:` lines the source does
            # not support, and the advisor is told to cite that field verbatim.
            # So the container is dropped at an appendix boundary -- for the
            # located `phu-luc` as well as for the synthesised `annex`, which
            # is where this rule was already right and stayed for one kind
            # only.
            parent = ""
        if marker.kind == ANNEX_KIND:
            # Attached material belongs to no article, so the article's page
            # must not carry into it. It is no longer left with nothing: the
            # page BREAKS cover the attachment like any other part of the file,
            # so `page_range` gives these chunks the pages their own lines are
            # printed on. Zero here means "inherit nothing", not "unknown".
            page_carry = 0
        section = f"{parent} > {marker.label}" if parent else marker.label
        emit(section, page_carry, full, figs, span)

    drain(page_carry)
    if pending_text or pending_figs:          # a sliver drain declined to emit
        emit(parent or "Closing provisions", page_carry,
             "\n\n".join(pending_text), pending_figs, pending_span)

    # Whatever `emit` never popped: a transcription curated for a figure that is
    # not in this text. It is still indexed -- an algorithm missing from the
    # index is the failure this mechanism exists to prevent -- but with no
    # section borrowed from a figure it does not sit in, and no page.
    for stem in sorted(transcripts):
        entry = transcripts[stem]
        result.orphan_transcriptions += 1
        emit(transcription_section("", stem, entry), 0, entry[1])

    # Some source texts carry the whole instrument twice -- qd-1868-2020.md and
    # qd-4026-2010.md are scrapes of legal-reference sites that print a preview
    # copy above the full text. Dropping an exact repeat is safe (identical text
    # cannot be a different provision) and keeps one article from occupying two
    # of the six slots a search returns. It is a guard, not a fix: the duplication
    # is upstream, in tools/fetch-legal-docs.py's output for those two documents.
    seen: set[str] = set()
    deduped: list[Chunk] = []
    for chunk in result.chunks:
        fingerprint = norm(chunk.text)
        if fingerprint in seen:
            result.duplicates += 1
            continue
        seen.add(fingerprint)
        deduped.append(chunk)
    result.chunks = deduped
    return result


# ── OpenAI-compatible endpoint ───────────────────────────────────────────


def embed_batch(env: dict[str, str], texts: list[str]) -> list[list[float]]:
    return gateway.embed_batch(env, texts, EMBED_MODEL)


# ── database ─────────────────────────────────────────────────────────────
#
# Byte-identical to the SCHEMA in tools/build-ppol-corpus.py, because
# packages/api/src/readings.ts reads both indexes with one implementation and a
# second, subtly different shape is how that divergence would start.

SCHEMA = """
PRAGMA journal_mode = WAL;

CREATE TABLE documents (
  id            TEXT PRIMARY KEY,
  authors       TEXT NOT NULL,
  author_short  TEXT NOT NULL,
  year          INTEGER,
  title         TEXT NOT NULL,
  venue         TEXT,
  gloss         TEXT,
  weeks         TEXT NOT NULL,   -- JSON array of {date, topic, term, reference}
  page_offset   INTEGER NOT NULL DEFAULT 0,
  n_chunks      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE chunks (
  id          INTEGER PRIMARY KEY,
  doc_id      TEXT NOT NULL REFERENCES documents(id),
  ordinal     INTEGER NOT NULL,
  section     TEXT,
  page_start  INTEGER NOT NULL,
  page_end    INTEGER NOT NULL,
  header      TEXT NOT NULL,     -- contextual prefix, indexed alongside the body
  text        TEXT NOT NULL,
  tokens      INTEGER NOT NULL,
  notice      TEXT               -- passage-level staleness note; NULL for most chunks
);
CREATE INDEX idx_chunks_doc ON chunks(doc_id);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  header, text, content='chunks', content_rowid='id', tokenize='porter unicode61'
);

CREATE TABLE embeddings (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id),
  vec      BLOB NOT NULL
);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

LANGUAGE_NAMES = {"vi": "Vietnamese", "en": "English"}


def pick(value, lang: str = "en") -> str:
    if isinstance(value, dict):
        return (value.get(lang) or value.get("en") or value.get("vi") or "").strip()
    return (value or "").strip() if isinstance(value, str) else ""


# ── passage-level staleness ──────────────────────────────────────────────
#
# `status` describes a whole instrument, it is curated per document, and it is
# the ONLY thing here that speaks to whether an instrument is in force: Decision
# 4531/QĐ-BYT is recorded `in-force`, and Circular 35/2016/TT-BYT is recorded
# `unknown` because nobody has read a repeal statement for it either way. What
# is NOT current in either is the facility
# classification their text uses -- hạng I/II/III and tuyến, replaced from
# 01/01/2025 by cấp ban đầu / cấp cơ bản / cấp chuyên sâu. A retrieved chunk
# used to arrive at the model reading "Validity: In force" with nothing to say
# its rule had been converted, and the model restated a 2021 restriction as
# today's rule however the system prompt was worded. The signal belongs on the
# passage, so the registry carries `supersededPassages` and every chunk of a
# document that opts in carries a notice into the tool result.
#
# THREE TIERS, weakest first, and the tiering is what keeps the annotation
# honest rather than merely loud. Each is true of exactly the chunks it is
# stamped on, and a chunk carries the STRONGEST one that applies to it, never
# several:
#
#   document    -- every chunk of an opted-in instrument. Says only what is true
#                  of any chunk of it: the instrument predates the 2025
#                  reclassification, so any hạng or tuyến it names anywhere is
#                  the old scheme, and an answer about which facilities may
#                  provide or be paid for a service must name the current
#                  framework. It asserts nothing about THIS passage's content,
#                  which is what lets it reach every chunk.
#   passage     -- a chunk whose own text uses the superseded vocabulary.
#   restriction -- a chunk that states a restriction or condition in it.
#
# The document tier exists because coverage was the binding constraint, not
# wording. Before it, 43 of 2,209 chunks carried a notice (31 in qd-4531-2021,
# 12 in tt-35-2016-tt-byt), so a six-passage Vietnamese search on qd-4531 could
# return no stamped chunk at all and the correction never reached the model:
# measured 2026-09-07, 8 of 9 answers that retrieved a notice named the current
# framework and 0 of 3 that did not. Stamping the PASSAGE notice everywhere was
# tried first and reverted, correctly -- its first sentence says the passage
# describes facilities in the old scheme, which is false of most chunks. The fix
# is a weaker sentence, not a wider stamp.
#
# The shared paragraphs are written ONCE in the registry's `passageNotices`
# topic block (`documentNotice`, `notice`, `restrictionNotice`) rather than
# copied per document; a document contributes only the closing sentence that is
# true of its own text.
#
# NO TIER ASSERTS THAT AN INSTRUMENT IS IN FORCE, and `statusCaveat` -- appended
# to every tier here, so the sentence exists once rather than in each of the
# three texts -- is what says so out loud: the notice corrects the facility
# classification, and the instrument's own validity is the curated `status`
# field, which already reaches the model as the `Validity:` line in the header
# and the status term in the document's `venue`. `documentNotice` and `notice`
# both used to end "The instrument as a whole is still in force", which was a
# guess the registry itself refuses to make: `tt-35-2016-tt-byt` is recorded
# `unknown`, and widening the stamp to every chunk put that guess on all 83 of
# them, contradicting the `Status not verified` printed beside the same passage
# in the same tool result -- with the system prompt telling the model the notice
# outranks the passage it covers. A shared topic block describes a topic; only
# the document's own record describes the document.
#
# The notice is stored on the chunk and NOT written into the header, the FTS row
# or the embedding input. It is an editorial annotation, not text of the
# instrument: indexing it would make old-scheme passages retrievable on the new
# scheme's vocabulary, which is the opposite of what this is for.

# Weakest first. The 1-based position in this tuple is the RANK stored on the
# chunk, and it is the only ordering `readings.ts` is given: that file renders
# the highest rank present in a result set and knows none of these names. So
# "which notice is stronger" is decided here, once, and a fourth tier is a line
# in this tuple rather than a second ordering to keep in sync.
NOTICE_TIERS = ("document", "passage", "restriction")


def passage_notices(registry: dict, doc: dict) -> list[tuple[dict, list[dict[str, str]]]]:
    """Compile a document's `supersededPassages` into (topic, texts-by-tier).

    The topic -- terms, superseding instruments, evidence, the three shared
    notice bodies and the `statusCaveat` appended to all of them -- is defined
    ONCE in the registry's `passageNotices` block. A
    document contributes only the closing sentence that is true of its own text.
    Writing the shared paragraphs out per document is how two annotations of one
    fact drift apart the first time the framework wording is corrected, so they
    are written once there and composed per language here at build time.

    The returned list is indexed by `NOTICE_TIERS`: [document, passage,
    restriction]. What each says, and why each is true of what it is stamped on,
    is in the section comment above.
    """
    topics = registry.get("passageNotices") or {}
    compiled: list[tuple[dict, list[dict[str, str]]]] = []
    for entry in doc.get("supersededPassages") or []:
        topic = topics.get(entry.get("topic"))
        if not topic:
            print(f"    warning: unknown passage-notice topic "
                  f"{entry.get('topic')!r}; skipped")
            continue
        texts: list[dict[str, str]] = [{} for _ in NOTICE_TIERS]
        for lang in ("en", "vi"):
            body = pick(topic.get("notice"), lang)
            document = pick(topic.get("documentNotice"), lang)
            # Appended to every tier, and written once in the topic block: the
            # notice corrects the classification and says nothing about whether
            # the instrument is in force, which is the document's own curated
            # `status`. See the section comment.
            caveat = pick(topic.get("statusCaveat"), lang)
            if document:
                texts[0][lang] = " ".join(x for x in (document, caveat) if x)
            if not body:
                continue
            texts[1][lang] = " ".join(x for x in (body, caveat) if x)
            texts[2][lang] = " ".join(x for x in (
                body,
                pick(topic.get("restrictionNotice"), lang),
                pick(entry.get("closing"), lang),
                caveat,
            ) if x)
        if not any(texts):
            print(f"    warning: passage-notice topic {entry.get('topic')!r} "
                  f"defines no notice text at any tier; skipped")
            continue
        if not texts[1]:
            print(f"    warning: passage-notice topic {entry.get('topic')!r} "
                  f"defines no `notice` text; chunks using the classification "
                  f"vocabulary fall back to the strongest tier that has one")
        if not texts[0]:
            print(f"    warning: passage-notice topic {entry.get('topic')!r} "
                  f"defines no `documentNotice`; only chunks using the "
                  f"classification vocabulary will be annotated")
        if not pick(topic.get("statusCaveat")):
            print(f"    warning: passage-notice topic {entry.get('topic')!r} "
                  f"defines no `statusCaveat`; the notice will not tell the "
                  f"model that it speaks to the classification only and not to "
                  f"the instrument's validity")
        compiled.append((topic, texts))
    return compiled


def states_restriction(topic: dict, text: str) -> bool:
    """Whether this chunk states a restriction in the superseded vocabulary.

    A classification term alone is not enough for the restriction tier and must
    not become enough. On qd-4531-2021, matching "tuyến tỉnh" anywhere put a
    payment-restriction sentence on 31 chunks -- a safe-delivery-package
    distribution list, a blood-donation outreach plan, the national reference
    laboratory -- none of which contains one. Requiring a restriction term
    within `proximityChars` leaves exactly the two chunks that do, and all
    twelve of tt-35-2016-tt-byt's grade-expressed payment conditions.
    """
    hay = text.casefold()
    window = int(topic.get("proximityChars") or 200)
    cls_pos = [m.start() for t in (topic.get("classificationTerms") or [])
               for m in re.finditer(re.escape(t.casefold()), hay)]
    res_pos = [m.start() for t in (topic.get("restrictionTerms") or [])
               for m in re.finditer(re.escape(t.casefold()), hay)]
    return any(abs(a - b) <= window for a in cls_pos for b in res_pos)


def uses_classification(topic: dict, text: str) -> bool:
    hay = text.casefold()
    return any(t.casefold() in hay
               for t in (topic.get("classificationTerms") or []))


def notice_tier(topic: dict, text: str) -> int:
    """This chunk's tier under this topic, as an index into `NOTICE_TIERS`.

    The one implementation of tier selection. It used to be inlined in
    `notice_for` and then recomputed a second time in `build` to count the
    restriction chunks for the run report, which is two answers to one question
    and one edit away from disagreeing.
    """
    if not uses_classification(topic, text):
        return 0
    return 2 if states_restriction(topic, text) else 1


def notice_for(notices, text: str) -> tuple[str, str] | None:
    """This chunk's notice as `(tier name, JSON)`, or None if none applies.

    Per topic the strongest applicable tier wins, so a chunk carries one notice
    per topic rather than a stack of them. Where a document declares several
    topics their texts are joined, and the chunk's rank is the strongest among
    them.

    Both languages are stored; `readings.ts` selects the one the answer is being
    written in, so a bilingual advisor does not pay for the other copy on every
    search. `rank` is 1-based so that a stored notice never reads as rank 0, and
    it is the whole ordering contract with that file: it renders the highest
    rank in a result set and never looks at `tier`, which is there for the run
    report and for anyone reading the database.
    """
    # A tier's existence is independent of the others': a chunk takes the
    # strongest tier at or below its own that the topic actually defines, so a
    # topic written with only `documentNotice` still annotates every chunk.
    ranked = []
    for topic, texts in notices:
        r = notice_tier(topic, text)
        while r >= 0 and not texts[r]:
            r -= 1
        if r >= 0:
            ranked.append((r, texts))
    if not ranked:
        return None
    top = max(r for r, _ in ranked)
    merged: dict[str, str] = {}
    for lang in ("en", "vi"):
        parts = [texts[r][lang] for r, texts in ranked
                 if r == top and texts[r].get(lang)]
        if parts:
            merged[lang] = "\n\n".join(parts)
    if not merged:
        return None
    return NOTICE_TIERS[top], json.dumps(
        {"tier": NOTICE_TIERS[top], "rank": top + 1, "text": merged},
        ensure_ascii=False)


def build(args: argparse.Namespace) -> int:
    if not REGISTRY.exists():
        print(f"error: registry not found at {REGISTRY}", file=sys.stderr)
        print("       This tool builds one project's index and needs that project's "
              "content, which the public mirror does not carry.", file=sys.stderr)
        return 2
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    env = load_env()

    # The index is built beside the tracked file and moved onto it at the very
    # end, in one rename. A build takes minutes -- the embedding pass alone is
    # 2,000 chunks over the network -- and writing in place means an interrupted
    # run leaves a HALF-BUILT database under the tracked name, which is exactly
    # what shipped once: 2,051 chunks, 448 embeddings, an empty `meta`, and
    # `readings.ts` reading `embedded_chunks` as 0 and silently serving the
    # advisor BM25-only. Nothing about that file looks broken. A rename either
    # happens or does not, so the tracked index is always a complete build, and
    # the `-wal`/`-shm` an interrupted run strands are stranded beside the temp
    # name (gitignored) rather than beside the database.
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    # Two builds at once destroy each other, silently and expensively. Both
    # write the same BUILD_PATH, so the second one's first act is to unlink the
    # first one's file; the first then keeps inserting into an unlinked inode
    # until SQLite notices the file has moved and turns the connection
    # read-only, and the run dies at the meta INSERT with "attempt to write a
    # readonly database" AFTER paying for every embedding. What it leaves in the
    # tree is an index whose embeddings table is a fraction of its chunks and
    # whose meta table is empty -- which readings.ts reads as a valid BM25-only
    # index and serves, so retrieval quietly loses its dense half with nothing
    # in the log to say so. Observed twice on 2026-09-02. So a build takes an
    # exclusive lock and a second one refuses to start. The lock itself is
    # `lib/filelock.py`, shared with the registry write in fetch-legal-docs.py,
    # which had the same defect for the same reason -- one implementation, so a
    # fix to the stale-holder handling reaches both.
    # The RESOURCE, not a lock path: `filelock` derives `<BUILD_PATH>.lock`.
    try:
        filelock.acquire(BUILD_PATH)
    except filelock.LockBusy as busy:
        print(f"error: another build of this index is running ({busy}). "
              f"Wait for it to finish rather than racing it.", file=sys.stderr)
        return 2

    for stale in (BUILD_PATH, BUILD_PATH.with_name(BUILD_PATH.name + "-wal"),
                  BUILD_PATH.with_name(BUILD_PATH.name + "-shm"),
                  DB_PATH.with_name(DB_PATH.name + "-wal"),
                  DB_PATH.with_name(DB_PATH.name + "-shm")):
        if stale.exists():
            stale.unlink()

    conn = sqlite3.connect(BUILD_PATH)
    conn.executescript(SCHEMA)

    indexed: list[tuple[str, str, int, int, int, str]] = []
    skipped: dict[str, str] = {}
    # Per-document notice counts by tier, for the run report. Coverage is what
    # this annotation is for and a total hides it: 43 stamped chunks and 194
    # stamped chunks read the same as "annotated" if the tiers are added up.
    annotated_tiers: list[tuple[str, str, int, dict[str, int]]] = []
    # Explicit, monotone chunk ids assigned in registry order then text order:
    # a rebuild from unchanged inputs reproduces the same id for the same Điều,
    # so a diff of two builds is about content rather than renumbering.
    next_id = 1
    total_tokens = 0

    for doc in registry.get("documents", []):
        doc_id = doc["id"]
        text_rel = doc.get("textFile")
        if not text_rel:
            # textFile: null is the curator saying this document has no full text
            # in the repo (a WHO report, or a PDF we may not redistribute as text).
            # Not a failure, and not something to index around.
            skipped[doc_id] = "no textFile in the registry"
            continue
        text_path = REPO_ROOT / text_rel
        if not text_path.exists():
            skipped[doc_id] = f"text file missing: {text_rel}"
            print(f"  {doc_id}: MISSING {text_rel}")
            continue

        sections = None
        breaks = None
        map_rel = doc.get("mapFile")
        if map_rel and (REPO_ROOT / map_rel).exists():
            page_map = json.loads((REPO_ROOT / map_rel).read_text(encoding="utf-8"))
            sections = page_map.get("sections") or None
            # Where the PDF's pages open in this text. Absent from a map written
            # before round 10, and absent for a document with no canonical text
            # to measure against -- both read as "no measurement", which is the
            # behaviour every chunk had before there was one.
            breaks = page_map.get("pageBreaks") or None

        # The figures' hand-curated transcriptions, read from the sidecar rather
        # than out of the displayed text. See the section comment above
        # `chunk_document`: the reader sees the figure, the index sees what it
        # says, and neither depends on the other.
        transcripts, note = transcriptions.read(doc, REPO_ROOT)
        if note:
            print(f"  {doc_id}: {note}")

        res = chunk_document(doc_id, text_path.read_text(encoding="utf-8"), sections,
                             transcripts, breaks)
        if transcripts:
            print(f"  {doc_id}: indexed {len(transcripts)} figure transcription(s)"
                  + (f", {res.orphan_transcriptions} with no figure in the text"
                     if res.orphan_transcriptions else ""))
        if not res.chunks:
            skipped[doc_id] = "no chunks produced"
            print(f"  {doc_id}: no chunks")
            continue

        number = doc.get("number", doc_id)
        title_en = pick(doc.get("title"), "en")
        title_vi = pick(doc.get("title"), "vi")
        agency_en = pick(doc.get("issuingAgency"), "en")
        agency_vi = pick(doc.get("issuingAgency"), "vi")
        type_en = pick(doc.get("typeLabel"), "en") or doc.get("type", "")
        status = doc.get("status", "unknown")
        status_en = pick((registry.get("statusLabels") or {}).get(status, {}), "en") or status
        scope_en = pick(doc.get("scope"), "en")
        issue_date = doc.get("issueDate") or ""
        effective = doc.get("effectiveDate") or ""
        year = int(issue_date[:4]) if issue_date[:4].isdigit() else None
        lang_name = LANGUAGE_NAMES.get(res.language, res.language)

        title = title_en if not title_vi else f"{title_en} / {title_vi}"
        venue = "; ".join(x for x in [
            type_en, agency_en, status_en, f"text in {lang_name}"] if x)
        authors = agency_vi or agency_en

        conn.execute(
            "INSERT INTO documents (id, authors, author_short, year, title, venue, "
            "gloss, weeks, page_offset, n_chunks) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (doc_id, authors, number, year, title, venue, scope_en, "[]", 0,
             len(res.chunks)),
        )

        dates = ", ".join(x for x in [
            f"issued {issue_date}" if issue_date else "",
            f"effective {effective}" if effective else ""] if x)
        notices = passage_notices(registry, doc)
        by_tier: dict[str, int] = {name: 0 for name in NOTICE_TIERS}
        for ordinal, chunk in enumerate(res.chunks):
            # `section` is the CITABLE location and nothing else goes in it. It
            # used to carry `(part k of n)` when one article was split, which is
            # a fact about our chunker and not about the instrument -- and
            # `readings.ts` writes this field into the `Location:` line the
            # advisor is instructed to repeat verbatim, so `(part 18 of 99)`
            # reached a reader inside a citation, describing a division of the
            # law that does not exist. Nothing read the suffix; the passages in
            # a tool result are already numbered.
            where = chunk.section
            page_bit = (f", PDF pages {chunk.page}-{chunk.page_end}"
                        if chunk.page_end > chunk.page
                        else f", PDF page {chunk.page}" if chunk.page else "")
            # The header is indexed at twice the weight of the body and is the
            # string embedded alongside it, so it carries every handle a question
            # might use: the number, the article, both titles, the agency, the
            # status, and what the instrument is for.
            #
            # It leads with the citation so the exact string a lawyer would write
            # sits at the front of the field BM25 weights at 2.0.
            #
            # Do not expect that to make a bare article number findable, and do
            # not add index-side tricks trying to: measured on this corpus,
            # "Điều 40 của Nghị định 96/2023/NĐ-CP" retrieves the right document
            # and the wrong article, whether the citation leads the header or
            # trails it. The cause is on the query side, in readings.ts's
            # toFtsQuery, which drops every query term of two characters or
            # fewer -- so "40", the only discriminating token in that question,
            # never reaches FTS5 and the dense half is left to separate one
            # article of 96/2023/NĐ-CP from 390 others on a two-character
            # difference, which no embedding does. The fix belongs there (keep
            # short terms that are pure digits), not here. What DOES work, and
            # is the question users actually ask, is retrieval by topic: "điều
            # kiện cấp giấy phép hoạt động" returns Điều 40 with its number and
            # its PDF page attached, which is the citation the answer needs.
            header = (
                f"{number}, {where}{page_bit}. "
                + f"Vietnamese legal instrument {number}"
                + (f" ({year})" if year else "")
                + f" -- {type_en} issued by {agency_en or agency_vi}"
                + (f", {dates}" if dates else "")
                + f". Validity: {status_en}. Text language: {lang_name}. "
                + f"Full title: \"{title_en}\"" + (f" ({title_vi})" if title_vi else "")
                + (f". What this instrument covers: {scope_en}" if scope_en else "")
            )
            # One call decides the tier and composes the stored payload; the
            # count for the run report is read off that answer rather than
            # recomputed from the terms a second time.
            tiered = notice_for(notices, chunk.text)
            notice = None
            if tiered:
                by_tier[tiered[0]] += 1
                notice = tiered[1]
            tokens = est_tokens(header + chunk.text)
            conn.execute(
                "INSERT INTO chunks (id, doc_id, ordinal, section, page_start, "
                "page_end, header, text, tokens, notice) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (next_id, doc_id, ordinal, where, chunk.page,
                 max(chunk.page_end, chunk.page),
                 header, chunk.text, tokens, notice),
            )
            conn.execute("INSERT INTO chunks_fts (rowid, header, text) VALUES (?,?,?)",
                         (next_id, header, chunk.text))
            next_id += 1
            total_tokens += tokens

        indexed.append((doc_id, number, len(res.chunks), res.unmatched_sections,
                        res.duplicates, res.source))
        tier_report = "/".join(f"{by_tier[name]} {name}" for name in NOTICE_TIERS)
        if notices:
            annotated_tiers.append((doc_id, number, len(res.chunks), dict(by_tier)))
        print(f"  {doc_id} ({number}): {len(res.chunks)} chunks "
              f"[{res.source}, {res.unmatched_sections} unmatched, "
              # A heading the map does not carry, opened from the text. Named
              # in the run because it is the one thing here the map cannot be
              # checked against: a number that climbs is a map going thin.
              + (f"{res.text_sections} text-only section"
                 f"{'' if res.text_sections == 1 else 's'}, "
                 if res.text_sections else "")
              + f"{res.duplicates} duplicate, {res.language}"
              + (f", notices {tier_report}" if notices else "") + "]")
        # Every chunk of an opted-in document now carries at least the document
        # notice, so "nothing was annotated" no longer says anything about the
        # terms. What the terms are checked by is the tier they select: a topic
        # whose classificationTerms match nothing in this document's text is a
        # topic pointed at the wrong document or written against the wrong
        # vocabulary, and it looks identical to a working one in the totals.
        if notices and not (by_tier["passage"] + by_tier["restriction"]):
            print(f"    warning: {doc_id} declares supersededPassages but no chunk "
                  f"matched its terms -- check the topic's classificationTerms "
                  f"and restrictionTerms against the text")

    conn.commit()

    # ── embeddings ───────────────────────────────────────────────────────
    embedded = 0
    build_mode = "bm25-only (--no-embeddings)"
    if not args.no_embeddings:
        rows = conn.execute("SELECT id, header, text FROM chunks ORDER BY id").fetchall()
        print(f"\nEmbedding {len(rows)} chunks with {EMBED_MODEL}...")
        try:
            for start in range(0, len(rows), EMBED_BATCH):
                batch = rows[start:start + EMBED_BATCH]
                vectors = embed_batch(env, [f"{h}\n\n{t}" for _, h, t in batch])
                conn.executemany("INSERT INTO embeddings (chunk_id, vec) VALUES (?,?)",
                                 [(row[0], pack(vec)) for row, vec in zip(batch, vectors)])
                conn.commit()
                embedded += len(batch)
                print(f"    {embedded}/{len(rows)}", end="\r", flush=True)
            print()
            build_mode = f"hybrid ({EMBED_MODEL}, {EMBED_DIM}d)"
        except Exception as e:                        # noqa: BLE001
            # A missing vector column costs recall, not correctness: readings.ts
            # degrades to BM25 on its own. Losing the index we just built would
            # cost both.
            print(f"\n  embeddings failed after {embedded} chunks: {e}")
            print("  continuing with an FTS5-only index")
            build_mode = f"bm25-only (embeddings FAILED after {embedded} chunks)"

    for key, value in {
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "corpus": "haivn_eip legal library (Vietnamese legal instruments cited by the EIP)",
        "builder": "tools/build-legal-corpus.py",
        # readings.ts requires exactly these two to switch on hybrid retrieval.
        "embedding_model": EMBED_MODEL if embedded else "",
        "embedding_dim": str(EMBED_DIM) if embedded else "0",
        "embedded_chunks": str(embedded),
        "build_mode": build_mode,
        "target_tokens": str(TARGET_TOKENS),
        "overlap_tokens": str(OVERLAP_TOKENS),
        "documents_indexed": str(len(indexed)),
        "documents_skipped": json.dumps(skipped, ensure_ascii=False),
    }.items():
        conn.execute("INSERT INTO meta (key, value) VALUES (?,?)", (key, value))

    conn.commit()
    # Back to a rollback journal before closing. This index is committed to git
    # and opened read-only on a container whose directory may not be writable;
    # a WAL database wants to create -wal/-shm next to itself even for a reader,
    # and a stray -wal beside a tracked .db is a file nobody meant to commit.
    conn.execute("PRAGMA journal_mode = DELETE")
    conn.execute("VACUUM")
    conn.close()
    for stale in (BUILD_PATH.with_name(BUILD_PATH.name + "-wal"),
                  BUILD_PATH.with_name(BUILD_PATH.name + "-shm")):
        if stale.exists():
            stale.unlink()
    os.replace(BUILD_PATH, DB_PATH)

    print("\n" + "=" * 68)
    print(f"Index:      {DB_PATH.relative_to(REPO_ROOT)} "
          f"({DB_PATH.stat().st_size / 1e6:.2f} MB)")
    print(f"Documents:  {len(indexed)} indexed, {len(skipped)} skipped")
    print(f"Chunks:     {next_id - 1}")
    print(f"Tokens:     ~{total_tokens:,} (chunk text + headers)")
    print(f"Mode:       {build_mode}")
    print("-" * 68)
    print(f"{'document':26} {'number':20} {'chunks':>6}  source")
    for doc_id, number, n, unmatched, dupes, source in indexed:
        print(f"{doc_id:26} {number:20} {n:>6}  {source}"
              + (f" ({unmatched} unmatched)" if unmatched else "")
              + (f" ({dupes} exact duplicates dropped)" if dupes else ""))
    if annotated_tiers:
        print("-" * 68)
        print("Passage notices (chunks by tier, weakest first):")
        print(f"  {'document':26} {'number':20} {'chunks':>6} "
              + " ".join(f"{name:>12}" for name in NOTICE_TIERS))
        for doc_id, number, n, counts in annotated_tiers:
            print(f"  {doc_id:26} {number:20} {n:>6} "
                  + " ".join(f"{counts[name]:>12}" for name in NOTICE_TIERS))
    if skipped:
        print("-" * 68)
        print("Skipped:")
        for doc_id, why in skipped.items():
            print(f"  {doc_id}: {why}")
    print("=" * 68)
    return 0


# ── query (smoke test; the server has its own implementation) ────────────


def query(args: argparse.Namespace) -> int:
    if not DB_PATH.exists():
        print(f"no index at {DB_PATH}", file=sys.stderr)
        return 2
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    terms = [t for t in re.sub(r'[^\w\s-]', " ", args.query, flags=re.UNICODE).split()
             if len(t) > 1]
    fts = " OR ".join(f'"{t}"' for t in terms)
    rows = conn.execute(
        "SELECT c.doc_id, c.section, c.page_start, substr(c.text, 1, 240) AS preview, "
        "       bm25(chunks_fts, 2.0, 1.0) AS score "
        "FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid "
        "WHERE chunks_fts MATCH ? ORDER BY score LIMIT ?",
        (fts, args.k),
    ).fetchall()
    if not rows:
        print("no matches")
        return 1
    for row in rows:
        print(f"\n[{row['score']:.2f}] {row['doc_id']} p.{row['page_start']} "
              f"section={row['section']!r}")
        print("  " + " ".join(row["preview"].split())[:220] + "...")
    conn.close()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--no-embeddings", action="store_true",
                        help="skip the vector column; ship an FTS5-only index")
    parser.add_argument("--query", help="search an existing index and exit")
    parser.add_argument("-k", type=int, default=5, help="results for --query")
    args = parser.parse_args()
    return query(args) if args.query else build(args)


if __name__ == "__main__":
    sys.exit(main())
