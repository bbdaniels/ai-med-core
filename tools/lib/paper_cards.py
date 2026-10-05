"""Paper cards: a short stand-in for a paper's full text.

A card is what a document-scoped talk project grounds a turn in instead of the
whole paper: the paper's metadata block, its abstract, its section headings,
and an instruction to search the paper's text before answering anything
specific. The text itself is then reached through search_readings, scoped to
the one paper.

A card is derived from the full-text vignette, the one derivation of a paper's
text, so cards and full texts can never disagree about the metadata. The
vignette shape it reads is the one tools/build-papers-content.py writes:

    SELECTED PAPER
    Title: ...            (metadata lines)
    Text below: ...       (kept as "Searchable text: ...": the edition the
                          searched passages come from)

    FULL TEXT OF THE SELECTED PAPER
    <text: "# Heading" sections from XML, or "[page N]" pages from a PDF>
"""

from __future__ import annotations

import re

FULL_TEXT_MARKER = "FULL TEXT OF THE SELECTED PAPER"
SEARCH_INSTRUCTION = ("Search the paper's text with search_readings before answering "
                      "any specific question.")
ABSTRACT_MAX_CHARS = 3000

_PAGE = re.compile(r"^\[page (\d+)\]\s*$")
_ABSTRACT = re.compile(r"^\s*(abstract|summary)\b\s*[:.\-–—]?\s*(.*)$", re.I)
# Where an abstract stops in PDF text: the introduction, or the front matter
# journals print after the abstract. A structured abstract's own labels
# (Background, Methods, Findings) do not end it.
_ABSTRACT_END = re.compile(
    r"^\s*(((\d{1,2}|[IVX]{1,5})\.?\s+)?introduction\b|key ?words?\b|jel\b|"
    r"received\b|accepted\b|published\b|article history|©|copyright\b|this is an open access|"
    r"\*?corresponding author|citation:|editor:|author summary|highlights\b|article info\b|"
    r"contents lists available)", re.I)
# Sidebar lines some layouts set inside the abstract column; skipped there.
_ABSTRACT_SKIP = re.compile(r"^\s*(open access|(a1{10}\s*)+)\s*$", re.I)
# The opening text stands in for an abstract no heading marks: the first run
# of long lines (a paragraph set in the page width) of at least this length.
OPENING_MIN_CHARS = 400
OPENING_LINE_CHARS = 45
_KNOWN_SECTIONS = (
    "introduction", "background", "context", "setting", "data", "data and methods",
    "methods", "materials and methods", "methodology", "study design", "results",
    "findings", "discussion", "conclusion", "conclusions", "limitations",
    "policy implications", "implications", "summary", "appendix", "acknowledgments",
    "acknowledgements", "literature review", "framework", "conceptual framework",
    "empirical strategy", "estimation", "robustness", "heterogeneity",
)
_NUMBERED = re.compile(r"^\s*((\d{1,2}(\.\d{1,2}){0,2})\.?|[IVX]{1,5}\.)\s+([A-Z][^.]{2,70})$")


def split_vignette(text: str) -> tuple[list[str], str]:
    """The metadata lines and the text after the marker. A card has no text
    below, so the "Text below:" line becomes "Searchable text:"."""
    head, sep, body = text.partition(FULL_TEXT_MARKER)
    if not sep:
        raise ValueError(f"no '{FULL_TEXT_MARKER}' line: not a paper vignette")
    meta = [re.sub(r"^Text below:", "Searchable text:", l.rstrip())
            for l in head.strip().splitlines() if l.strip()]
    return meta, body.strip("\n")


def _markdown_sections(body: str) -> tuple[str, list[tuple[int, str]]]:
    """Abstract and headings of text built from XML, with # headings."""
    lines = body.splitlines()
    headings: list[tuple[int, str]] = []
    abstract: list[str] = []
    in_abstract = False
    for line in lines:
        m = re.match(r"^(#{1,4})\s+(.*\S)\s*$", line)
        if m:
            depth, title = len(m.group(1)), m.group(2)
            if depth == 1:
                in_abstract = title.lower() == "abstract"
            if in_abstract:
                if depth > 1:
                    abstract.append(f"{title}:")
                continue
            headings.append((depth - 1, title))
        elif in_abstract and line.strip():
            abstract.append(line.strip())
    return _clip(" ".join(abstract)), headings


def _is_heading(line: str, numbered: bool = True) -> bool:
    """A section heading: a known section name, numbered or not, or (when
    `numbered`) any short numbered title."""
    s = line.strip()
    if not s or len(s) > 80 or s.endswith((",", ";")):
        return False
    bare = re.sub(r"^((\d{1,2}(\.\d{1,2}){0,2})\.?|[IVX]{1,5}\.)\s+", "", s).rstrip(":").strip()
    if bare.lower() in _KNOWN_SECTIONS:
        return True
    # A numbered heading: "2.1 Sampling frame", "III. Results". Not a list
    # item that runs on into a sentence, and not a table row of numbers.
    m = _NUMBERED.match(s) if numbered else None
    if m and len(m.group(4).split()) <= 8 and not re.search(r"\d{3,}|\s{2,}", m.group(4)):
        return True
    return False


def _unspace(s: str) -> str:
    """'A B S T R A C T' -> 'ABSTRACT': letter-spaced headings in some journals."""
    return re.sub(r"\b([A-Z]) (?=[A-Z]\b)", r"\1", s) if re.fullmatch(r"([A-Z] )+[A-Z]", s) else s


def _pdf_sections(body: str) -> tuple[str, bool, list[tuple[int, str]]]:
    """Abstract and headings of text extracted from a PDF, with [page N]
    markers. The flag says whether the abstract was marked by a heading (True)
    or is the paper's opening text (False)."""
    page = None
    headings: list[tuple[int, str]] = []
    seen: set[str] = set()
    abstract: list[str] | None = None
    abstract_done = False
    early: list[tuple[int | None, str]] = []     # pages 1-2, for the opening text
    for line in body.splitlines():
        pm = _PAGE.match(line)
        if pm:
            page = int(pm.group(1))
            continue
        s = _unspace(line.strip())
        if page is None or page <= 2:
            early.append((page, s))
        if abstract is not None and not abstract_done:
            if _ABSTRACT_END.match(s) or sum(map(len, abstract)) > ABSTRACT_MAX_CHARS:
                abstract_done = True
            else:
                if s and not _ABSTRACT_SKIP.match(s):
                    abstract.append(s)
                continue
        if abstract is None and (page is None or page <= 3):
            am = _ABSTRACT.match(s)
            if am and len(s) < 2000 and (not am.group(2) or am.group(2)[:1].isupper()):
                abstract = [am.group(2)] if am.group(2) else []
                continue
        # A numbered line before the paper's first named section is front
        # matter (an affiliation "1 Fixture University"), not a heading.
        if _is_heading(s, numbered=bool(headings)):
            key = re.sub(r"\s+", " ", s.lower())
            if key in seen:
                continue
            seen.add(key)
            headings.append((0, f"{s} (page {page})" if page is not None else s))
    text = " ".join(x for x in (abstract or []) if x)
    if text:
        return _clip(text), True, headings
    return _clip(_opening_text(early)), False, headings


def _opening_text(lines: list[tuple[int | None, str]]) -> str:
    """The first run of long lines before the first section heading."""
    run: list[str] = []
    for _, s in lines:
        if _is_heading(s) or _ABSTRACT_END.match(s):
            if sum(map(len, run)) >= OPENING_MIN_CHARS:
                return " ".join(run)
            run = []
            if _is_heading(s) and re.search(r"introduction", s, re.I):
                break
            continue
        if len(s) >= OPENING_LINE_CHARS:
            run.append(s)
        elif sum(map(len, run)) >= OPENING_MIN_CHARS:
            run.append(s)          # the short last line of a paragraph
            return " ".join(run)
        else:
            run = []
    return " ".join(run) if sum(map(len, run)) >= OPENING_MIN_CHARS else ""


def _clip(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    # PDF line ends split words with a hyphen: "provi- ders".
    # A hyphen at a PDF line end may be a compound's ("middle-\nincome") or a
    # broken word's; the text has already lost soft hyphens (pdf_text.clean),
    # so the hyphen is kept and only the space goes. "low- and" is left alone.
    text = re.sub(r"([a-z])- (?!(and|or|to|versus)\b)([a-z])", r"\1-\3", text)
    if len(text) <= ABSTRACT_MAX_CHARS:
        return text
    cut = text[:ABSTRACT_MAX_CHARS]
    return cut[:cut.rfind(" ")] + " ..."


def paper_card(vignette: str) -> str:
    """The card for one full-text vignette."""
    meta, body = split_vignette(vignette)
    if re.search(r"^#{1,4}\s", body, re.M):
        abstract, headings = _markdown_sections(body)
        marked = True
    else:
        abstract, marked, headings = _pdf_sections(body)
    out = list(meta)
    if abstract and marked:
        out += ["", "ABSTRACT", abstract]
    elif abstract:
        out += ["", "OPENING TEXT (no abstract heading was found; this is the paper's first paragraph)", abstract]
    else:
        out += ["", "ABSTRACT",
                "No abstract was found in the extracted text. Search the paper's text for its summary."]
    out += ["", "SECTIONS OF THE PAPER"]
    out += [f"{'  ' * depth}- {h}" for depth, h in headings] or ["No section headings were found in the extracted text."]
    out += ["", "The paper's full text is not included here.", SEARCH_INSTRUCTION, ""]
    return "\n".join(out)
