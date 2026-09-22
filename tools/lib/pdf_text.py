"""PDF text extraction shared by the corpus and content builders.

One extractor for every tool that turns a PDF into text: build-readings-corpus.py
(the PPOL reading index) and build-papers-content.py (the papers advisor's
vignette text). Two copies of this used to be the plan; a fix to one (a
de-hyphenation rule, an OCR threshold) would then silently miss the other.

    pages = extract_pages(pdf, None, force_ocr=False, cache_dir=some_dir)
    text = clean(pages[0].text)
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Page:
    number: int          # 1-based page in the source PDF; 0 = unpaginated source
    text: str
    headings: list[str] = field(default_factory=list)


def page_headings(page) -> list[str]:
    """Lines set noticeably larger than the page's body text, in reading order.

    A heuristic, and it is allowed to miss: a chunk with no detected section
    still carries its document, year, and page, which is enough to cite.
    """
    try:
        d = page.get_text("dict")
    except Exception:
        return []
    sizes: list[float] = []
    lines: list[tuple[float, str]] = []
    for block in d.get("blocks", []):
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            if not spans:
                continue
            text = "".join(s.get("text", "") for s in spans).strip()
            if not text:
                continue
            size = max(float(s.get("size", 0)) for s in spans)
            sizes.append(size)
            lines.append((size, text))
    if not sizes:
        return []
    sizes.sort()
    body = sizes[len(sizes) // 2]
    out = []
    for size, text in lines:
        if size < body * 1.18:
            continue
        if not (3 <= len(text) <= 90):
            continue
        if text.count(" ") > 12:
            continue
        out.append(re.sub(r"\s+", " ", text))
    return out[:4]


def ocr_page(page) -> str:
    """OCR one page through the tesseract CLI (no pytesseract dependency)."""
    import tempfile

    pix = page.get_pixmap(dpi=300)
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        pix.save(tmp_path)
        proc = subprocess.run(
            ["tesseract", tmp_path, "-", "--psm", "1", "-l", "eng"],
            capture_output=True, text=True,
        )
        return proc.stdout if proc.returncode == 0 else ""
    finally:
        os.unlink(tmp_path)


def _ocr_cache_path(pdf_path: Path, cache_dir: Path) -> Path:
    """One cache file per source PDF, keyed by its path and modification time.

    OCR is by far the slowest part of a build (211 pages, about five minutes),
    and a build is re-run whenever the syllabus changes -- which changes the week
    map, not the page images. Without this, every metadata correction costs a
    full re-OCR, and the temptation is to skip the rebuild and let the index
    drift from the manifest.
    """
    import hashlib

    key = hashlib.sha256(
        f"{pdf_path.resolve()}:{pdf_path.stat().st_mtime_ns}".encode()).hexdigest()[:16]
    return cache_dir / f"{pdf_path.stem}.{key}.json"


def extract_pages(pdf_path: Path, page_range: tuple[int, int] | None,
                  force_ocr: bool, cache_dir: Path) -> list[Page]:
    """Text of each page, OCR'd through tesseract where the text layer is thin.

    `cache_dir` holds the OCR results, one JSON file per source PDF. Each caller
    passes its own, beside the derived output it builds, so the cache is covered
    by the same .gitignore rule as that output.
    """
    import pymupdf

    cache_path = _ocr_cache_path(pdf_path, cache_dir)
    cache: dict[str, str] = {}
    if cache_path.exists():
        try:
            cache = json.loads(cache_path.read_text())
        except Exception:                             # noqa: BLE001
            cache = {}
    cache_dirty = False

    doc = pymupdf.open(pdf_path)
    first, last = page_range if page_range else (1, doc.page_count)
    first = max(1, first)
    last = min(doc.page_count, last)

    pages: list[Page] = []
    ocr_used = 0
    cached_hits = 0
    for n in range(first, last + 1):
        page = doc[n - 1]
        text = page.get_text()
        headings = page_headings(page)
        if force_ocr or len(text.strip()) < 100:
            key = str(n)
            if key in cache:
                ocr_text = cache[key]
                cached_hits += 1
            else:
                ocr_text = ocr_page(page)
                cache[key] = ocr_text
                cache_dirty = True
            if len(ocr_text.strip()) > len(text.strip()):
                text, headings = ocr_text, []
                ocr_used += 1
        pages.append(Page(number=n, text=text, headings=headings))
    if ocr_used:
        suffix = f" ({cached_hits} from cache)" if cached_hits else ""
        print(f"    OCR: {ocr_used}/{last - first + 1} pages{suffix}")
    if cache_dirty:
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(cache))
    doc.close()
    return pages


# The instructor's PDFs carry a per-page ProQuest/scan watermark naming him.
WATERMARK = re.compile(r"^\s*For Benjamin Daniels\b.*$", re.M)


def clean(text: str) -> str:
    text = WATERMARK.sub("", text)
    text = text.replace("­", "")            # soft hyphen
    text = re.sub(r"-\n(?=[a-z])", "", text)     # de-hyphenate line breaks
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()
