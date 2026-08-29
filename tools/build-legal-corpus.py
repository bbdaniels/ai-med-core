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
private corpus paths. This one carries none of those: it imports nothing but the
standard library (in particular NOT fetch-legal-docs.py, whose registry helpers
would have been convenient and would have dragged an excluded module into the
mirror), it reads project-relative paths that the mirror does not publish and
degrades to a clear error when they are absent, and its only network call is the
embeddings endpoint this deployment is already configured for. The key comes
from the repo-root .env at runtime; no secret is written to, or read from, a
tracked file.

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
    section       the citable location, "Chương II ... > Điều 5. ..." (with
                  "(part k of n)" appended when one Điều is split). Material
                  attached to an instrument rather than enacted in an article
                  says so instead of borrowing the nearest article's number --
                  see "where the articles stop" below
    page_start /  the PDF page from maps/<id>.json, so an answer can be turned
    page_end      into a chip that opens the Legal Library at the right page
    weeks         "[]" -- a course-schedule concept with no legal analogue.
                  Empty is what keeps readings.ts from printing an "assigned"
                  clause it cannot mean here.
"""

from __future__ import annotations

import argparse
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
from lib import openai_gateway as gateway            # noqa: E402
from lib.openai_gateway import api_post, load_env, pack, unpack  # noqa: E402,F401

REPO_ROOT = Path(__file__).resolve().parent.parent
LEGAL_DIR = REPO_ROOT / "projects" / "haivn_eip" / "content" / "legal"
REGISTRY = LEGAL_DIR / "registry.json"
DB_PATH = LEGAL_DIR / "legal-corpus.db"

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
# unwrapping can leave either at the start of a line. Requiring the period, and
# then requiring the numbering to make sense, is what separates a heading from a
# citation.

DIEU_RE = re.compile(r"^Điều\s+(\d+)\s*([a-zA-ZđĐ]?)\s*\.")
PHU_LUC_RE = re.compile(r"^(?:PHỤ\s+LỤC|Phụ\s+lục|PHU\s+LUC|Phu\s+luc)\s+([IVXLC]+|\d+)\b")
CHUONG_RE = re.compile(r"^(?:CHƯƠNG|Chương)\s+([IVXLC]+|\d+)\b")
MUC_RE = re.compile(r"^(?:MỤC|Mục)\s+(\d+)\b")
PHAN_RE = re.compile(r"^(?:PHẦN|Phần)\s+([IVXLC]+|\d+)\b")

# Keys in maps/<id>.json are slugs of the same headings: dieu-5, chuong-2,
# muc-1, phu-luc-3.
KEY_RE = re.compile(r"^(dieu|chuong|muc|phu-luc|phan)-([0-9a-z]+)$")

ANNEX_KIND = "annex"
CONTAINER_KINDS = {"chuong", "muc", "phan"}
BOUNDARY_KINDS = {"dieu", "phu-luc", ANNEX_KIND}


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
    page: int
    text: str
    part: int = 1
    parts: int = 1


@dataclass
class DocResult:
    doc_id: str
    chunks: list[Chunk] = field(default_factory=list)
    language: str = "vi"
    mapped_sections: int = 0
    unmatched_sections: int = 0
    duplicates: int = 0
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


def classify(line: str) -> tuple[str, str] | None:
    """(kind, number) when this line is a heading, else None."""
    m = DIEU_RE.match(line)
    if m:
        return "dieu", (m.group(1) + m.group(2).lower())
    for kind, rx in (("phu-luc", PHU_LUC_RE), ("chuong", CHUONG_RE),
                     ("muc", MUC_RE), ("phan", PHAN_RE)):
        m = rx.match(line)
        if m:
            return kind, m.group(1).lower()
    return None


def strip_front_matter(text: str) -> str:
    """Drop the provenance header tools/fetch-legal-docs.py writes above the text.

    Two shapes exist in content/legal/text: a government-PDF extraction that ends
    its header with a horizontal rule, and a working copy from a legal-reference
    site that ends its header with a `Source:` line. Both are metadata the
    registry already holds, and indexing them would put the same boilerplate
    sentence into 21 documents' first chunk.
    """
    lines = text.splitlines()
    for i, line in enumerate(lines[:24]):
        if line.strip() == "---":
            return "\n".join(lines[i + 1:])
    for i, line in enumerate(lines[:24]):
        if line.strip().lower().startswith(("source:", "official source:")):
            return "\n".join(lines[i + 1:])
    return "\n".join(lines[1:]) if lines and lines[0].startswith("# ") else text


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


def heading_candidates(lines: list[str]) -> list[tuple[int, str, str, str]]:
    """Every line that reads as a heading: (line index, kind, number, clean text)."""
    out: list[tuple[int, str, str, str]] = []
    for i, raw in enumerate(lines):
        line = raw.lstrip(LEAD_CHARS).strip()
        if not line:
            continue
        found = classify(line)
        if found:
            out.append((i, found[0], found[1], line))
    return out


def align(sections: list[tuple[str, str, str]],
          options: dict[int, list[int]]) -> dict[int, int]:
    """Assign map sections to heading lines, in order, matching as many as possible.

    Naive forward-only matching was the first implementation and it was wrong in
    a way that hid: one bad match -- 96/2023/NĐ-CP's "Điều 17." recurring inside
    an appendix form -- dragged the cursor 9,000 lines forward and silently cost
    every one of the 131 articles after it. So the assignment is chosen globally
    instead: a longest-increasing-subsequence over each section's candidate
    lines, which is the largest set of matches that can all be true at once. A
    single misleading recurrence now loses at most itself.

    `sections` is the ordered list of (key, kind, number); `options[i]` the
    sorted candidate line indexes for section i. Returns {section index -> line}.
    """
    # dp[k] = (last line used, section index, previous k's chain id) for the
    # cheapest way to match k sections; chains are reconstructed from `back`.
    dp: list[int] = [-1]                     # dp[0]: nothing matched yet
    chain: list[int] = [-1]                  # index into `back` for dp[k]
    back: list[tuple[int, int, int]] = []    # (line, section index, parent chain id)
    for i, _ in enumerate(sections):
        for k in range(len(dp) - 1, -1, -1):
            lines_ = options.get(i, ())
            nxt = next((ln for ln in lines_ if ln > dp[k]), None)
            if nxt is None:
                continue
            if k + 1 == len(dp):
                dp.append(nxt)
                back.append((nxt, i, chain[k]))
                chain.append(len(back) - 1)
            elif nxt < dp[k + 1]:
                dp[k + 1] = nxt
                back.append((nxt, i, chain[k]))
                chain[k + 1] = len(back) - 1
    assigned: dict[int, int] = {}
    node = chain[len(dp) - 1]
    while node >= 0:
        line, sec_i, parent = back[node]
        assigned[sec_i] = line
        node = parent
    return assigned


def markers_from_map(lines: list[str], sections: list[dict]) -> tuple[list[Marker], int]:
    """Locate each curated section in the text.

    The map is the authority on which sections exist, what they are called and
    what page they start on; the text is the authority on where they begin.
    Matching runs in two passes: first the labels, which are near-verbatim (both
    sides come out of the same PDF), then -- only inside the window between two
    already-fixed neighbours -- the heading's own number, which is what the key
    encodes. Number matching alone is far too weak to be trusted globally: the
    string "Điều 5." occurs in most of these documents more than once.
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
        strong[i] = [ln for ln, k, _, text in cands
                     if k == kind and norm(text).startswith(prefix)]
    assigned = align([(p[0], p[1], p[2]) for p in parsed], strong)

    # Pass 2 -- fill the gaps by number, bounded by the anchors on either side.
    for i, (_, kind, number, _, _) in enumerate(parsed):
        if i in assigned:
            continue
        lo = max((assigned[j] for j in range(i) if j in assigned), default=-1)
        hi = min((assigned[j] for j in range(i + 1, len(parsed)) if j in assigned),
                 default=len(lines))
        hit = next((ln for ln, k, num, _ in cands
                    if k == kind and num == number and lo < ln < hi), None)
        if hit is not None:
            assigned[i] = hit

    markers = [
        Marker(line=assigned[i], kind=parsed[i][1], key=parsed[i][0],
               label=parsed[i][3] or lines[assigned[i]].strip(),
               page=parsed[i][4], mapped=True)
        for i in sorted(assigned, key=lambda i: assigned[i])
    ]
    return markers, len(parsed) - len(assigned) + unparsed


def markers_from_headings(lines: list[str]) -> list[Marker]:
    """Fallback for a document with text but no section map.

    Accepts a Điều only where the numbering can be read as a sequence: the next
    number, a lettered variant of the current one (Điều 48b), or a restart at 1
    -- which is what happens when a Quyết định promulgates a Quy chế that
    numbers its own articles from scratch.
    """
    markers: list[Marker] = []
    last = 0
    for i, kind, number, line in heading_candidates(lines):
        if kind == "dieu":
            digits = int(re.match(r"\d+", number).group(0))
            letter = number[len(str(digits)):]
            ok = digits == last + 1 or (digits == last and letter) or digits == 1
            if not ok:
                continue
            last = digits
        label = line[:MAX_SECTION_LABEL]
        markers.append(Marker(line=i, kind=kind, key=f"{kind}-{number}", label=label))
    return markers


def clean_line(raw: str) -> str:
    return re.sub(r"\s+", " ", raw.lstrip(LEAD_CHARS)).strip()


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


def chunk_document(doc_id: str, text: str, sections: list[dict] | None) -> DocResult:
    body = strip_front_matter(text)
    lines = body.splitlines()
    result = DocResult(doc_id=doc_id, language="vi" if vietnamese(body) else "en")

    if sections:
        markers, unmatched = markers_from_map(lines, sections)
        result.unmatched_sections = unmatched
        result.mapped_sections = len(markers)
        result.source = "map"
        if not markers:                      # a map that matched nothing is no map
            markers = markers_from_headings(lines)
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
    segments: list[tuple[Marker | None, str]] = []
    first = bounds[0] if bounds else len(lines)
    preamble = "\n".join(lines[:first]).strip()
    if preamble:
        segments.append((None, preamble))
    for idx, marker in enumerate(markers):
        end = markers[idx + 1].line if idx + 1 < len(markers) else len(lines)
        segments.append((marker, "\n".join(lines[marker.line:end]).strip()))

    # Containers (Chương / Mục / Phần) are context, not citations: their heading
    # rides along with the next article rather than becoming a chunk of its own.
    pending_text: list[str] = []
    parent: str = ""
    page_carry = 0

    def emit(section: str, page: int, body_text: str) -> None:
        body_text = body_text.strip()
        if not body_text:
            return
        parts = split_long(body_text, TARGET_TOKENS, OVERLAP_TOKENS)
        for i, part in enumerate(parts):
            result.chunks.append(Chunk(section=section, page=page, text=part,
                                       part=i + 1, parts=len(parts)))

    def drain(page: int) -> None:
        """Flush whatever has accumulated under a container heading.

        A Chương/Mục heading and nothing else is context for the next article and
        rides along with it. A Chương/Mục carrying substantive text of its own --
        which happens in the procurement Thông tư, where a Mục runs for pages
        before its first Điều -- is content, and gluing it onto the next article
        would both mislabel it and make one 22,000-token chunk out of it.
        """
        nonlocal pending_text
        blob = "\n\n".join(pending_text).strip()
        pending_text = []
        if blob and est_tokens(blob) > MIN_SPLIT_TOKENS:
            emit(parent or "Unnumbered provisions", page, blob)
        elif blob:
            pending_text = [blob]

    for marker, seg in segments:
        if marker is None:
            if seg:
                emit("Preamble (title block and recitals)", 1 if sections else 0, seg)
            continue
        if marker.page:
            page_carry = marker.page
        if marker.kind in CONTAINER_KINDS:
            drain(page_carry)
            parent = marker.label
            if seg:
                pending_text.append(seg)
            continue
        if marker.kind not in BOUNDARY_KINDS:
            pending_text.append(seg)
            continue

        drain(page_carry)
        full = ("\n\n".join(pending_text + [seg])).strip() if pending_text else seg
        pending_text = []
        if marker.kind == ANNEX_KIND:
            # Attached material sits on pages the map never located, and under
            # no Chương. Carrying either forward would be the same false
            # precision in a different field.
            page_carry = 0
            parent = ""
        section = f"{parent} > {marker.label}" if parent else marker.label
        emit(section, page_carry, full)

    drain(page_carry)
    if pending_text:                          # a sliver drain declined to emit
        emit(parent or "Closing provisions", page_carry, "\n\n".join(pending_text))

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
  tokens      INTEGER NOT NULL
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


def build(args: argparse.Namespace) -> int:
    if not REGISTRY.exists():
        print(f"error: registry not found at {REGISTRY}", file=sys.stderr)
        print("       This tool builds one project's index and needs that project's "
              "content, which the public mirror does not carry.", file=sys.stderr)
        return 2
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    env = load_env()

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    for stale in (DB_PATH, DB_PATH.with_name(DB_PATH.name + "-wal"),
                  DB_PATH.with_name(DB_PATH.name + "-shm")):
        if stale.exists():
            stale.unlink()

    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)

    indexed: list[tuple[str, str, int, int, int, str]] = []
    skipped: dict[str, str] = {}
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
        map_rel = doc.get("mapFile")
        if map_rel and (REPO_ROOT / map_rel).exists():
            sections = json.loads((REPO_ROOT / map_rel).read_text(encoding="utf-8")
                                  ).get("sections") or None

        res = chunk_document(doc_id, text_path.read_text(encoding="utf-8"), sections)
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
        for ordinal, chunk in enumerate(res.chunks):
            where = chunk.section
            if chunk.parts > 1:
                where = f"{where} (part {chunk.part} of {chunk.parts})"
            page_bit = f", PDF page {chunk.page}" if chunk.page else ""
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
            tokens = est_tokens(header + chunk.text)
            conn.execute(
                "INSERT INTO chunks (id, doc_id, ordinal, section, page_start, "
                "page_end, header, text, tokens) VALUES (?,?,?,?,?,?,?,?,?)",
                (next_id, doc_id, ordinal, where, chunk.page, chunk.page,
                 header, chunk.text, tokens),
            )
            conn.execute("INSERT INTO chunks_fts (rowid, header, text) VALUES (?,?,?)",
                         (next_id, header, chunk.text))
            next_id += 1
            total_tokens += tokens

        indexed.append((doc_id, number, len(res.chunks), res.unmatched_sections,
                        res.duplicates, res.source))
        print(f"  {doc_id} ({number}): {len(res.chunks)} chunks "
              f"[{res.source}, {res.unmatched_sections} unmatched, "
              f"{res.duplicates} duplicate, {res.language}]")

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
    for stale in (DB_PATH.with_name(DB_PATH.name + "-wal"),
                  DB_PATH.with_name(DB_PATH.name + "-shm")):
        if stale.exists():
            stale.unlink()

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
