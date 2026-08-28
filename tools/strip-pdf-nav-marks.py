#!/usr/bin/env python3
"""Strip Google Docs' dead per-page navigation chip out of an exported PDF.

WHAT THIS REMOVES, and why it is safe to remove. A Google Doc that carries a
document outline exports to PDF with a small "table of contents" chip stamped
into the top-left corner of every body page: a 225x225 px raster of the Material
Symbols `toc` glyph (four bars with four square bullets), drawn at ~27.75 pt
square, with a link annotation over it. That link is an internal jump to a NAMED
DESTINATION -- and the exporter never writes that destination into the file. It
is undefined in the exported PDF by construction, so the chip is inert in every
viewer that has ever opened it: nothing to click, nothing to jump to, just an
icon squatting in the margin of all 41 pages. It is the exporter's bug, not the
document's content, and the document's owner cannot switch it off.

WHAT THIS DOES NOT TOUCH. The contents-page links in the same document DO work:
they are named destinations the exporter *did* define, resolving to a page and a
y-offset. Those are real content. So is a one-off broken link inside the body
text (the Vietnamese EIP has one, a contents row pointing at a heading that was
deleted upstream) -- that is the document owner's to fix, not ours. The
difference is not "is the destination defined" alone; it is the whole signature
below. Anything that fails any part of it is left alone.

THE SIGNATURE. All four must hold before a single byte moves:

  1. one image XObject is drawn on at least half the pages;
  2. every one of its placements is at the *same* rectangle, to the point;
  3. a link annotation sits over that same rectangle on those same pages; and
  4. that link's target is a named destination the file never defines.

A real illustration fails (2) -- it appears once, at its own place. A working
contents link fails (4). A single dead body link fails (1) and (3): one page,
and its rectangle is a line of text, not the chip's. Only the exporter's chip
satisfies all four.

THE EDIT. Per page: delete the link annotation, then delete from the content
stream the `q ... /Xn Do ... Q` group that paints the chip -- located by walking
the operator tokens, not by matching on text, so a string containing "q" cannot
be mistaken for the operator. If what remains of the enclosing group is a clip
that now paints nothing, that goes too. The chip's XObject is then dropped from
the page resources, which lets the raster itself be garbage-collected on save.
Nothing else is rewritten: no other annotation, destination, outline entry, or
drawing operator is read or written.

IDEMPOTENT BY CONSTRUCTION. A stripped file has no image satisfying the
signature, so a second run finds nothing and does not write -- the file is left
byte-identical, not merely equivalent.

Requirements: PyMuPDF >= 1.23 (`pip install 'pymupdf>=1.23'`).

Usage:
    python3 tools/strip-pdf-nav-marks.py FILE.pdf [FILE.pdf ...]
    python3 tools/strip-pdf-nav-marks.py --dry-run FILE.pdf   # report only
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

# Placements are compared at this tolerance, in points. The exporter emits the
# identical rectangle on every page, so this is slack against float round-trips
# through the content stream, not a fuzzy match.
RECT_EPS = 0.05

# The chip is small. A guard against ever matching a real repeated graphic -- a
# letterhead logo, a watermark -- which would be larger than this.
MAX_MARK_PT = 60.0

# It has to be on at least this share of pages to be the exporter's per-page
# furniture rather than content that happens to recur.
MIN_PAGE_SHARE = 0.5

# Operators that only set up a clip. A group left holding nothing but these
# paints nothing, so it can go once the chip inside it has gone.
_CLIP_OPS = {"re", "W", "W*", "n"}
_DELIMS = " \t\r\n\f\0()<>[]{}/%"


def require_pymupdf():
    """The one non-stdlib dependency, checked once and reported as itself."""
    try:
        import pymupdf  # noqa: F401
    except ImportError:
        try:
            import fitz as pymupdf  # noqa: F401
        except ImportError:
            sys.exit("error: PyMuPDF is required.  pip install 'pymupdf>=1.23'")
    return pymupdf


# --------------------------------------------------------------------------
# Content-stream tokenising
#
# Enough of a PDF content-stream lexer to tell an operator from the inside of a
# string. `(q)` is text; `q` is save-state. Matching on raw bytes cannot tell
# them apart, and the EIP pages are 100+ KB of exactly such text.

def tokens(buf: str) -> list[tuple[str, int, int]]:
    """Every non-string token as (text, start, end). Strings and comments are
    consumed and dropped, so nothing inside them can be read as an operator."""
    out: list[tuple[str, int, int]] = []
    i, n = 0, len(buf)
    while i < n:
        c = buf[i]
        if c in " \t\r\n\f\0":
            i += 1
        elif c == "%":                                    # comment to end of line
            while i < n and buf[i] not in "\r\n":
                i += 1
        elif c == "(":                                    # literal string
            depth, i = 1, i + 1
            while i < n and depth:
                if buf[i] == "\\":
                    i += 2
                    continue
                depth += (buf[i] == "(") - (buf[i] == ")")
                i += 1
        elif c == "<" and i + 1 < n and buf[i + 1] != "<":  # hex string
            j = buf.find(">", i)
            i = n if j < 0 else j + 1
        elif c == "<" or c == ">":                         # dict open/close
            out.append((buf[i:i + 2], i, i + 2))
            i += 2
        elif c in "[]{}":
            out.append((c, i, i + 1))
            i += 1
        else:                                              # name, number, operator
            j = i + 1 if c == "/" else i
            while j < n and buf[j] not in _DELIMS:
                j += 1
            j = max(j, i + 1)
            out.append((buf[i:j], i, j))
            i = j
    return out


def group_open(toks: list[tuple[str, int, int]], idx: int) -> int | None:
    """Index of the `q` opening the innermost group that contains token idx."""
    depth = 0
    for j in range(idx - 1, -1, -1):
        t = toks[j][0]
        if t == "Q":
            depth += 1
        elif t == "q":
            if depth == 0:
                return j
            depth -= 1
    return None


def group_close(toks: list[tuple[str, int, int]], idx: int) -> int | None:
    """Index of the `Q` closing the innermost group that contains token idx."""
    depth = 0
    for j in range(idx + 1, len(toks)):
        t = toks[j][0]
        if t == "q":
            depth += 1
        elif t == "Q":
            if depth == 0:
                return j
            depth -= 1
    return None


def balanced(toks: list[tuple[str, int, int]], lo: int, hi: int) -> bool:
    """Does toks[lo:hi+1] open and close every graphics-state group it touches?

    A span that does not is one whose removal would leave a stray `q` or `Q`
    behind, and a stray `Q` pops the state stack a level too far -- silently
    re-drawing everything after it under whatever matrix happened to be
    underneath. That is not a hypothetical: it is the bug this function exists
    to make impossible. On six pages of the English EIP the chip is followed by
    a figure, and an off-by-one on the closing `Q` moved the figure down the
    page and flipped it upside down while every other check still passed."""
    net, low = depth_profile(toks, lo, hi)
    return net == 0 and low >= 0


def depth_profile(toks: list[tuple[str, int, int]], lo: int, hi: int) -> tuple[int, int]:
    """(net change, lowest point) of the graphics-state depth over toks[lo:hi+1]."""
    depth = low = 0
    for j in range(lo, hi + 1):
        t = toks[j][0]
        if t == "q":
            depth += 1
        elif t == "Q":
            depth -= 1
            low = min(low, depth)
    return depth, low


def _is_number(tok: str) -> bool:
    try:
        float(tok)
        return True
    except ValueError:
        return False


def remove_xobject_paint(buf: str, name: str) -> tuple[str, int]:
    """Delete every `q ... /<name> Do ... Q` group from a content stream.

    Returns the new stream and how many groups went. Deletions run back to front
    so earlier offsets stay valid."""
    toks = tokens(buf)
    before = Counter(toks[i][0] for i in range(len(toks) - 1) if toks[i + 1][0] == "Do")
    before_depth = depth_profile(toks, 0, len(toks) - 1)
    spans: list[tuple[int, int]] = []
    for i in range(len(toks) - 1):
        if toks[i][0] != name or toks[i + 1][0] != "Do":
            continue
        oi, ci = group_open(toks, i), group_close(toks, i)
        if oi is None or ci is None or not balanced(toks, oi, ci):
            continue                        # refuse to guess at a shape we do not know
        start, end = toks[oi][1], toks[ci][2]

        # If the group this one sits in is left holding only a clip, it paints
        # nothing and goes too. Its closing `Q` is found forward from the INNER
        # group's `Q`, never from its own `q` -- searching forward from the `q`
        # stops at the inner `Q` and hands back a span that ends one level too
        # early. See `balanced()` for what that cost.
        ooi = group_open(toks, oi)
        oci = group_close(toks, ci)
        if ooi is not None and oci is not None:
            rest = [toks[j][0] for j in range(ooi + 1, oi)] + \
                   [toks[j][0] for j in range(ci + 1, oci)]
            if rest and all(t in _CLIP_OPS or _is_number(t) for t in rest) \
                    and balanced(toks, ooi, oci):
                start, end = toks[ooi][1], toks[oci][2]

        spans.append((start, end))

    for start, end in sorted(spans, reverse=True):
        # Take the trailing newline with it so the stream does not accumulate
        # blank lines across runs.
        while end < len(buf) and buf[end] in "\r\n":
            end += 1
        buf = buf[:start] + buf[end:]

    # Post-conditions, checked rather than assumed: the stream still balances,
    # and no other XObject lost a paint. Either failing means the edit was wrong,
    # and a wrong edit must stop the run, not ship.
    after_toks = tokens(buf)
    if depth_profile(after_toks, 0, len(after_toks) - 1) != before_depth:
        raise ValueError(f"removing {name} changed the graphics-state balance "
                         f"{before_depth} -> "
                         f"{depth_profile(after_toks, 0, len(after_toks) - 1)}")
    after = Counter(after_toks[i][0] for i in range(len(after_toks) - 1)
                    if after_toks[i + 1][0] == "Do")
    if {k: v for k, v in before.items() if k != name} != \
            {k: v for k, v in after.items() if k != name}:
        raise ValueError(f"removing {name} disturbed another XObject's paint")
    return buf, len(spans)


# --------------------------------------------------------------------------
# Finding the mark

def find_nav_mark(doc) -> dict | None:
    """The image XObject that satisfies the whole signature, or None."""
    fitz = require_pymupdf()

    placements: dict[int, set[tuple[float, ...]]] = defaultdict(set)
    pages: dict[int, set[int]] = defaultdict(set)
    for pno in range(doc.page_count):
        for im in doc[pno].get_image_info(xrefs=True):
            xref = im.get("xref")
            if not xref:
                continue
            placements[xref].add(tuple(round(v, 2) for v in im["bbox"]))
            pages[xref].add(pno)

    defined = set(doc.resolve_names())
    floor = max(2, int(doc.page_count * MIN_PAGE_SHARE))

    for xref, boxes in placements.items():
        if len(boxes) != 1:                       # (2) one rectangle, always
            continue
        if len(pages[xref]) < floor:              # (1) most of the pages
            continue
        bbox = fitz.Rect(next(iter(boxes)))
        if bbox.width > MAX_MARK_PT or bbox.height > MAX_MARK_PT:
            continue

        # (3) and (4): a link over that same rectangle, on those same pages,
        # pointing at a destination the file never defines.
        link_rects: Counter = Counter()
        link_pages: set[int] = set()
        dests: set[str] = set()
        for pno in sorted(pages[xref]):
            for li in doc[pno].get_links():
                name = li.get("nameddest") or li.get("name")
                if not name or name in defined:
                    continue
                if li["kind"] not in (fitz.LINK_GOTO, fitz.LINK_NAMED):
                    continue
                if not fitz.Rect(li["from"]).contains(bbox):
                    continue
                link_rects[tuple(round(v, 2) for v in li["from"])] += 1
                link_pages.add(pno)
                dests.add(name)
        if len(link_rects) != 1 or len(dests) != 1 or link_pages != pages[xref]:
            continue

        return {
            "xref": xref,
            "bbox": bbox,
            "pages": sorted(pages[xref]),
            "link_rect": fitz.Rect(next(iter(link_rects))),
            "dest": next(iter(dests)),
        }
    return None


# --------------------------------------------------------------------------

def strip(path: Path, dry_run: bool = False, quiet: bool = False) -> int:
    """Strip the nav chip from `path` in place. Returns pages changed."""
    fitz = require_pymupdf()
    say = (lambda *a: None) if quiet else print

    doc = fitz.open(path)
    try:
        mark = find_nav_mark(doc)
        if mark is None:
            say(f"  {path.name}: no dead navigation mark (nothing to do)")
            return 0

        say(f"  {path.name}: mark = image xref {mark['xref']} at "
            f"{tuple(round(v, 2) for v in mark['bbox'])} on {len(mark['pages'])}/"
            f"{doc.page_count} pages, link -> undefined dest '{mark['dest']}'")
        if dry_run:
            return len(mark["pages"])

        changed = 0
        for pno in mark["pages"]:
            page = doc[pno]

            # The resource name this page calls the chip by. Read per page: the
            # exporter is consistent, but the name is a page-local label and
            # nothing guarantees it.
            kind, val = doc.xref_get_key(page.xref, "Resources/XObject")
            if kind != "dict":
                say(f"    ! page {pno}: no XObject resources; skipped")
                continue
            names = {m.group(1): int(m.group(2)) for m in
                     re.finditer(r"/([^\s/<>\[\]()]+)\s+(\d+)\s+0\s+R", val)}
            name = next((n for n, x in names.items() if x == mark["xref"]), None)
            if name is None:
                say(f"    ! page {pno}: mark not in page resources; skipped")
                continue

            conts = page.get_contents()
            removed = 0
            for xref in conts:
                buf = doc.xref_stream(xref).decode("latin-1")
                new, n = remove_xobject_paint(buf, "/" + name)
                if n:
                    doc.update_stream(xref, new.encode("latin-1"))
                    removed += n
            if not removed:
                say(f"    ! page {pno}: paint operator not found; annotation kept")
                continue

            for li in page.get_links():
                if li["kind"] not in (fitz.LINK_GOTO, fitz.LINK_NAMED):
                    continue
                if (li.get("nameddest") or li.get("name")) != mark["dest"]:
                    continue
                r = fitz.Rect(li["from"])
                if max(abs(r.x0 - mark["link_rect"].x0), abs(r.y0 - mark["link_rect"].y0),
                       abs(r.x1 - mark["link_rect"].x1), abs(r.y1 - mark["link_rect"].y1)) > RECT_EPS:
                    continue
                page.delete_link(li)

            # Drop the now-unused resource entry so the raster can be collected.
            if len(names) == 1:
                doc.xref_set_key(page.xref, "Resources/XObject", "null")
            else:
                doc.xref_set_key(page.xref, f"Resources/XObject/{name}", "null")
            changed += 1

        before = path.stat().st_size
        tmp = path.with_suffix(path.suffix + ".stripped")
        doc.save(tmp, garbage=3, deflate=True)
        doc.close()
        tmp.replace(path)
        say(f"    stripped {changed} pages; {before:,} -> {path.stat().st_size:,} bytes")
        return changed
    finally:
        if not doc.is_closed:
            doc.close()


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdfs", nargs="+", type=Path)
    ap.add_argument("--dry-run", action="store_true", help="report, change nothing")
    args = ap.parse_args()
    for p in args.pdfs:
        strip(p, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
