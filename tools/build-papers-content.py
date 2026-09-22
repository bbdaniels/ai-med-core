#!/usr/bin/env python3
"""Build the papers advisor's content from its library manifest.

    python3 tools/build-papers-content.py                # build from the library
    python3 tools/build-papers-content.py --sync         # mirror the CV folder first
    python3 tools/build-papers-content.py --refresh-authors

The single input is projects/papers/content/library/library.tsv, one row per
file in the library folder beside it (the PDFs and PMC XML of Ben Daniels'
publications, with a license and a servable flag per work). That folder mirrors
~/Documents/Career/_CV/pdfs/, the canonical copy that also feeds his personal web
page, where the same manifest is called _manifest.txt; --sync copies anything
new or changed from there before building.

Everything the project serves about a paper is derived here, and nowhere else:

  cases/paper/<bibkey>.md     the paper's full text, the vignette the chat is
                              grounded in. GITIGNORED: for closed-access papers
                              it is copyrighted text. tools/push-content.ts
                              pushes it to the deployment database from a
                              checkout that has it, and skips it in CI.
  project.json                cases.vignettes (one per paper with text) and
                              tabs (the suggestions tab, plus one PDF tab per
                              servable paper, shown only on that paper).
                              Every other field is left as written.
  manifest.json               the public list behind the "Talk to this paper"
                              buttons, served at /api/talk-manifest/papers.
  content/readings/grounding.md
                              a catalog of every paper in the library, appended
                              to the system prompt so the advisor can name and
                              link the author's other work.
  readings-manifest.json      the build sheet for the search_readings index,
                              in the schema tools/build-readings-corpus.py
                              reads (one schema for every reading index): one
                              document per paper with a PDF, with its DOI.
                              Build the index from it with
                                python3 tools/build-readings-corpus.py \
                                  --manifest projects/papers/readings-manifest.json \
                                  --out projects/papers/content/readings/readings.db
  content/library/authors.json
                              author lists by bibkey, from Crossref (or the PMC
                              XML, or the CV's .bib), cached so a rebuild needs
                              no network. Public bibliographic metadata.

Which rows become vignettes:
  * one per bibkey; a bibkey's first non-XML row carries its metadata;
  * a working-paper or preprint twin of a published article in the library
    (notes say "WP twin of <bibkey>") is not a vignette of its own;
  * the text comes from the PMC XML when there is one (the published text,
    with real section structure), otherwise from the PDF;
  * a work with neither has no vignette and is reported, not faked.

A PDF tab is added only when the row is servable=yes AND the PDF is present;
the publisher-copyright papers are summarized by the advisor, never shown.

Idempotent: re-running with an unchanged library rewrites identical files.
"""

from __future__ import annotations

import argparse
import csv
import filecmp
import json
import os
import re
import shutil
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import pdf_text  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
PROJECT = REPO_ROOT / "projects" / "papers"
LIBRARY = PROJECT / "content" / "library"
MANIFEST_TSV = LIBRARY / "library.tsv"
AUTHORS_CACHE = LIBRARY / "authors.json"
OCR_CACHE = LIBRARY / "text" / "ocr-cache"      # gitignored with library/text/
CASES_DIR = PROJECT / "cases" / "paper"
PROJECT_JSON = PROJECT / "project.json"
TALK_MANIFEST = PROJECT / "manifest.json"
GROUNDING = PROJECT / "content" / "readings" / "grounding.md"
READINGS_MANIFEST = PROJECT / "readings-manifest.json"

CV_PDFS = Path.home() / "Documents" / "Career" / "_CV" / "pdfs"
CV_BIB = Path.home() / "Documents" / "Career" / "_CV" / "daniels-publications.bib"

REL = lambda p: p.relative_to(REPO_ROOT).as_posix()  # noqa: E731

# Vignette text goes into the system prompt on every turn. gpt-4o-mini's window
# is 128K tokens; a 231-page handbook would not fit, and a short paper is about
# 40K characters. Past this the text stops at a page boundary and says so.
MAX_TEXT_CHARS = 180_000

VERSION_LABEL = {
    "pub": "the published version of record",
    "pub-inpress": "the publisher's in-press version (final pagination not yet set)",
    "pp": "the preprint",
    "am": "an author manuscript, not the typeset published version",
    "wp": "the working paper",
    "proof": "the journal's galley proof, effectively identical to the published version",
}
PDF_TAB_LABEL = {
    "pub": "PDF",
    "pub-inpress": "PDF (in press)",
    "pp": "PDF (preprint)",
    "am": "PDF (author manuscript)",
    "wp": "PDF (working paper)",
    "proof": "PDF (proof)",
}
LICENSE_LABEL = {
    "cc-by": "CC BY (open access)",
    "cc-by-nc": "CC BY-NC (open access, non-commercial)",
    "cc-by-3.0-igo": "CC BY 3.0 IGO (open access)",
    "closed": "publisher copyright (closed access)",
    "bronze": "free to read on the publisher's site, no reuse license",
    "wb-noncommercial": "World Bank copyright, noncommercial reproduction with attribution",
    "unknown": "not stated",
}


# ── library ──────────────────────────────────────────────────────────────


def read_library() -> list[dict]:
    with MANIFEST_TSV.open(newline="") as f:
        return list(csv.DictReader(f, delimiter="\t"))


def sync_from_cv(src: Path) -> None:
    """Mirror new or changed files from the canonical CV folder into the library."""
    if not src.is_dir():
        sys.exit(f"error: {src} does not exist")
    copied = 0
    pairs = [(src / "_manifest.txt", MANIFEST_TSV)]
    pairs += [(p, LIBRARY / p.name) for p in sorted(src.iterdir())
              if p.suffix in (".pdf", ".xml")]
    for s, d in pairs:
        if not s.exists():
            continue
        if d.exists() and filecmp.cmp(s, d, shallow=False):
            continue
        shutil.copy2(s, d)
        copied += 1
        print(f"  synced {d.name}")
    print(f"Sync: {copied} file(s) copied from {src}")


def vignette_key(bibkey: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", bibkey)


def select_papers(rows: list[dict]) -> tuple[list[dict], list[tuple[str, str]]]:
    """One record per bibkey, in manifest order, with its text source resolved."""
    by_key: dict[str, list[dict]] = {}
    for r in rows:
        by_key.setdefault(r["bibkey"], []).append(r)
    papers, skipped = [], []
    for bibkey, group in by_key.items():
        primary = next((r for r in group if r["version"] != "xml"), group[0])
        twin = re.search(r"WP twin of (\w+)", primary.get("notes", ""))
        xml = LIBRARY / f"{bibkey}.xml"
        pdf = LIBRARY / f"{bibkey}.pdf"
        has_pdf = primary["version"] not in ("missing", "xml") and pdf.exists()
        paper = {
            "bibkey": bibkey,
            "key": vignette_key(bibkey),
            "doi": primary["doi"].strip() or None,
            "title": primary["title"].strip(),
            "year": int(primary["year"]) if primary["year"].strip().isdigit() else None,
            "venue": primary["venue"].strip(),
            "version": primary["version"],
            "license": primary["license"],
            "pdf": pdf if has_pdf else None,
            "xml": xml if xml.exists() else None,
            "twin_of": twin.group(1) if twin and twin.group(1) in by_key else None,
        }
        paper["servable"] = primary["servable"] == "yes" and has_pdf
        paper["has_text"] = bool(paper["xml"] or paper["pdf"])
        if paper["twin_of"]:
            skipped.append((bibkey, f"working-paper/preprint twin of {paper['twin_of']}"))
        elif not paper["has_text"]:
            skipped.append((bibkey, "no PDF or XML in the library"))
        papers.append(paper)
    return papers, skipped


# ── authors ──────────────────────────────────────────────────────────────


def _crossref_authors(doi: str) -> list[str] | None:
    url = "https://api.crossref.org/works/" + urllib.request.quote(doi, safe="/")
    req = urllib.request.Request(url, headers={"User-Agent": "ai-med build-papers-content"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            msg = json.load(r)["message"]
    except (urllib.error.URLError, TimeoutError, KeyError, ValueError):
        return None
    out = []
    for a in msg.get("author", []):
        name = " ".join(x for x in (a.get("given"), a.get("family")) if x) or a.get("name")
        if name:
            out.append(name)
    return out or None


def _xml_authors(xml: Path) -> list[str] | None:
    root = ET.parse(xml).getroot()
    out = []
    for c in root.iterfind(".//article-meta/contrib-group/contrib[@contrib-type='author']"):
        given = (c.findtext("name/given-names") or "").strip()
        family = (c.findtext("name/surname") or "").strip()
        collab = "".join(c.findtext("collab") or "").strip()
        name = " ".join(x for x in (given, family) if x) or collab
        if name:
            out.append(name)
    return out or None


def _bib_authors(bibkey: str) -> list[str] | None:
    if not CV_BIB.exists():
        return None
    m = re.search(r"@\w+\{" + re.escape(bibkey) + r",(.*?)\n\}", CV_BIB.read_text(), re.S)
    a = m and re.search(r"author\s*=\s*\{(.*?)\},?\n", m.group(1), re.S)
    if not a:
        return None
    names = [n.strip() for n in re.split(r"\s+and\s+", a.group(1))]
    out = []
    for n in names:
        if n == "others":
            out.append("et al.")
        elif "," in n:
            fam, giv = [x.strip() for x in n.split(",", 1)]
            out.append(f"{giv} {fam}")
        else:
            out.append(n)
    return out


def load_authors(papers: list[dict], refresh: bool) -> dict[str, list[str]]:
    cache = {}
    if AUTHORS_CACHE.exists() and not refresh:
        cache = json.loads(AUTHORS_CACHE.read_text())
    for p in papers:
        if cache.get(p["bibkey"]):
            continue
        authors = ((p["doi"] and _crossref_authors(p["doi"]))
                   or (p["xml"] and _xml_authors(p["xml"]))
                   or _bib_authors(p["bibkey"]))
        if authors:
            cache[p["bibkey"]] = authors
            print(f"  authors: {p['bibkey']} ({len(authors)})")
    AUTHORS_CACHE.write_text(json.dumps(dict(sorted(cache.items())), indent=1,
                                        ensure_ascii=False) + "\n")
    return cache


def author_line(names: list[str] | None) -> str:
    if not names:
        return "not recorded"
    return ", ".join(names[:12]) + (f", and {len(names) - 12} more" if len(names) > 12 else "")


# ── text: PMC XML ────────────────────────────────────────────────────────


def _itertext(el) -> str:
    return re.sub(r"\s+", " ", "".join(el.itertext())).strip()


def _table_text(tw) -> str:
    parts = []
    label = _itertext(tw.find("label")) if tw.find("label") is not None else ""
    cap = _itertext(tw.find("caption")) if tw.find("caption") is not None else ""
    parts.append(" ".join(x for x in (label, cap) if x))
    for tr in tw.iter("tr"):
        cells = [_itertext(c) for c in tr if c.tag in ("td", "th")]
        if any(cells):
            parts.append(" | ".join(cells))
    for fn in tw.iterfind("table-wrap-foot"):
        parts.append(_itertext(fn))
    return "\n".join(p for p in parts if p)


def _section_text(sec, depth: int, out: list[str]) -> None:
    title = sec.find("title")
    if title is not None and _itertext(title):
        out.append("\n" + "#" * min(depth, 4) + " " + _itertext(title))
    for child in sec:
        if child.tag == "sec":
            _section_text(child, depth + 1, out)
        elif child.tag == "p":
            # a paragraph may nest a table or figure; render those separately
            for tw in child.iter("table-wrap"):
                out.append(_table_text(tw))
            for tw in list(child.iter("table-wrap")) + list(child.iter("fig")):
                tw.clear()
            out.append(_itertext(child))
        elif child.tag in ("list", "disp-quote", "boxed-text"):
            out.append(_itertext(child))
        elif child.tag == "table-wrap":
            out.append(_table_text(child))
        elif child.tag == "fig":
            cap = child.find("caption")
            label = _itertext(child.find("label")) if child.find("label") is not None else "Figure"
            if cap is not None:
                out.append(f"[{label}] {_itertext(cap)}")


def xml_text(xml: Path) -> str:
    root = ET.parse(xml).getroot()
    art = root.find(".//article") if root.tag != "article" else root
    out: list[str] = []
    abstract = art.find(".//article-meta/abstract")
    if abstract is not None:
        out.append("# Abstract")
        if abstract.find("sec") is not None:
            for s in abstract.iterfind("sec"):
                _section_text(s, 2, out)
        else:
            out.append(_itertext(abstract))
    body = art.find("body")
    if body is not None:
        loose = [c for c in body if c.tag != "sec"]
        if loose:
            wrapper = ET.Element("sec")
            wrapper.extend(loose)
            _section_text(wrapper, 1, out)
        for s in body.iterfind("sec"):
            _section_text(s, 1, out)
    back = art.find("back")
    if back is not None:                       # appendices, not references
        for app in back.iter("app"):
            _section_text(app, 1, out)
    for fl in art.iterfind(".//floats-group"):
        for tw in fl.iter("table-wrap"):
            out.append(_table_text(tw))
    return re.sub(r"\n{3,}", "\n\n", "\n\n".join(x for x in out if x.strip()))


# ── text: PDF ────────────────────────────────────────────────────────────

_REFS = re.compile(r"^\s*(\d+\.?\s*)?(References|REFERENCES|Bibliography|BIBLIOGRAPHY|"
                   r"Literature Cited|Works Cited|Reference list)\s*$")
_APPX = re.compile(r"^\s*(Appendix|APPENDIX|Online Appendix|Supplementary|SUPPLEMENTARY|"
                   r"Appendices|APPENDICES)\b")


def _norm(line: str) -> str:
    return re.sub(r"\d+", "#", re.sub(r"\s+", " ", line.strip().lower()))


def pdf_text_pages(pdf: Path) -> list[tuple[int, str]]:
    pages = pdf_text.extract_pages(pdf, None, False, OCR_CACHE)
    texts = [(p.number, pdf_text.clean(p.text)) for p in pages]
    n = len(texts)
    # Running headers and footers: short lines that recur on many pages.
    counts: dict[str, int] = {}
    for _, t in texts:
        for line in set(_norm(l) for l in t.splitlines() if l.strip()):
            counts[line] = counts.get(line, 0) + 1
    threshold = max(3, int(0.4 * n))
    running = {k for k, c in counts.items() if c >= threshold and len(k) < 160}
    out = []
    for num, t in texts:
        keep = [l for l in t.splitlines()
                if _norm(l) not in running and not re.fullmatch(r"\s*#?\s*", _norm(l))]
        out.append((num, "\n".join(keep).strip()))
    return out


_NOTES = re.compile(r"^\s*(Notes|NOTES|Endnotes)\s*$")
_CITATION = re.compile(r"\b(19|20)\d{2}\b\s*[;.(:]")


def _is_refs_heading(lines: list[str], j: int) -> bool:
    """A reference-list heading. Some journals (Health Affairs Scholar) title
    the numbered reference list "Notes"; that counts only when citations follow."""
    if _REFS.match(lines[j]):
        return True
    return bool(_NOTES.match(lines[j])) and any(
        _CITATION.search(l) for l in lines[j + 1:j + 7])


def drop_references(pages: list[tuple[int, str]]) -> list[tuple[int, str]]:
    """Cut the reference list: from its heading, past the 40% mark, to the next
    appendix heading or the end. Left untouched when no heading is found."""
    n = len(pages)
    for i in range(n - 1, int(0.4 * n) - 1, -1):
        lines = pages[i][1].splitlines()
        hit = next((j for j in range(len(lines)) if _is_refs_heading(lines, j)), None)
        if hit is None:
            continue
        out = pages[:i] + [(pages[i][0], "\n".join(lines[:hit]))]
        resume = None
        for k in range(i, n):
            ls = pages[k][1].splitlines()
            start = hit + 1 if k == i else 0
            m = next((j for j in range(start, len(ls)) if _APPX.match(ls[j])), None)
            if m is not None:
                resume = (k, m)
                break
        if resume:
            k, m = resume
            out.append((pages[k][0], "\n".join(pages[k][1].splitlines()[m:])))
            out += pages[k + 1:]
        return [p for p in out if p[1].strip()]
    return pages


def pdf_full_text(pdf: Path) -> str:
    pages = drop_references(pdf_text_pages(pdf))
    parts, total = [], 0
    for num, t in pages:
        block = f"[page {num}]\n{t}"
        if total + len(block) > MAX_TEXT_CHARS:
            parts.append(f"[The text stops here, at page {num}, because the document is "
                         "too long to include whole. Say so if asked about later pages.]")
            break
        parts.append(block)
        total += len(block)
    return "\n\n".join(parts)


# ── outputs ──────────────────────────────────────────────────────────────


def vignette_markdown(p: dict, authors: list[str] | None) -> str:
    doi_url = f"https://doi.org/{p['doi']}" if p["doi"] else "none"
    if p["xml"]:
        source = ("PubMed Central full-text XML of the published article; "
                  "sections are marked with # headings, and there are no page numbers.")
        body = xml_text(p["xml"])
    else:
        source = (f"{VERSION_LABEL.get(p['version'], p['version'])}, extracted from the PDF; "
                  "each page starts with a [page N] marker.")
        body = pdf_full_text(p["pdf"])
    # The PDF can be a different edition from the text below (chaudhry2024longcovid:
    # published text from PMC XML, but only the submitted manuscript as a PDF), so
    # say which edition the reader is looking at whenever it is not the published one.
    pdf_edition = ("" if p["version"] == "pub" else
                   f" (the PDF is {VERSION_LABEL.get(p['version'], p['version'])})")
    shown = (f"yes: the reader can open it in the PDF tab beside the chat{pdf_edition}"
             if p["servable"] else
             "no: this paper is not openly licensed here, so summarize and explain it "
             "but do not reproduce it; send the reader to the publisher page "
             f"{doi_url}")
    meta = [
        "SELECTED PAPER",
        f"Title: {p['title']}",
        f"Authors: {author_line(authors)}",
        f"Venue: {p['venue']}" + (f", {p['year']}" if p["year"] else ""),
        f"DOI: {doi_url}",
        f"License: {LICENSE_LABEL.get(p['license'], p['license'])}",
        f"PDF shown to the reader: {shown}",
        f"Text below: {source}",
        "",
        "FULL TEXT OF THE SELECTED PAPER",
        "",
    ]
    return "\n".join(meta) + body.strip() + "\n"


def write_if_changed(path: Path, text: str) -> bool:
    if path.exists() and path.read_text() == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return True


def update_project_json(papers: list[dict]) -> None:
    project = json.loads(PROJECT_JSON.read_text())
    project["cases"]["vignettes"] = [
        {"key": p["key"], "template": "paper", "title": p["title"],
         "file": REL(CASES_DIR / f"{p['bibkey']}.md")}
        for p in papers
    ]
    tabs = [t for t in project.get("tabs", []) if t.get("type") != "pdf"]
    order = max((t.get("order", 0) for t in tabs), default=-1) + 1
    for p in papers:
        if not p["servable"]:
            continue
        tabs.append({
            "id": "pdf-" + re.sub(r"[^a-z0-9]+", "-", p["bibkey"].lower()),
            "type": "pdf",
            "order": order,
            "pinned": True,
            "label": {"en": PDF_TAB_LABEL.get(p["version"], "PDF")},
            "contentFile": REL(p["pdf"]),
            "showForVignetteKeys": [p["key"]],
        })
    project["tabs"] = tabs
    write_if_changed(PROJECT_JSON, json.dumps(project, indent=2, ensure_ascii=False) + "\n")


def talk_manifest(papers: list[dict]) -> str:
    rows = [{"doi": p["doi"], "title": p["title"], "vignette": p["key"],
             "year": p["year"], "venue": p["venue"], "servable": p["servable"]}
            for p in papers]
    return json.dumps({"papers": rows}, indent=2, ensure_ascii=False) + "\n"


def author_short(names: list[str] | None) -> str:
    """'Daniels', 'Daniels and Das', 'Daniels et al.' from 'Given Family' names."""
    fams = [n.split()[-1] for n in (names or []) if n.split() and n != "et al."]
    if not fams:
        return "Anonymous"
    if len(fams) == 1:
        return fams[0]
    if len(fams) == 2:
        return f"{fams[0]} and {fams[1]}"
    return f"{fams[0]} et al."


def readings_manifest(papers: list[dict], authors: dict[str, list[str]]) -> str:
    """The search index's build sheet: every talkable paper that has a PDF.

    PDF only, because the index cites pages and a PMC XML text has none; a
    paper with only XML (salomon2022southafrica) is reachable through its
    vignette but not through search_readings. Closed papers are included: the
    index is backend text, exactly like their vignettes, and is never served.
    """
    docs = []
    for p in papers:
        if not p["pdf"]:
            continue
        doc = {
            "id": p["bibkey"],
            "authors": author_line(authors.get(p["bibkey"])),
            "authorShort": author_short(authors.get(p["bibkey"])),
            "year": p["year"],
            "title": p["title"],
            "venue": p["venue"],
            "kind": "pdf",
            "file": p["pdf"].name,
        }
        if p["doi"]:
            doc["doi"] = p["doi"]
        docs.append(doc)
    manifest = {
        "$comment": [
            "GENERATED by tools/build-papers-content.py from content/library/library.tsv.",
            "Do not hand-edit. Bibliographic metadata only; the PDFs it names are",
            "gitignored, and so is the index built from it.",
        ],
        "course": "Talk to this paper: the author's publications",
        "corpusRoot": REL(LIBRARY),
        "glossContext": "an academic paper by the economist Benjamin Daniels",
        "documents": docs,
    }
    return json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"


def grounding(all_papers: list[dict], talkable: set[str],
              authors: dict[str, list[str]]) -> str:
    titles = {p["bibkey"]: p["title"] for p in all_papers}
    lines = [
        "THE AUTHOR'S PAPERS IN THIS COLLECTION",
        "",
        "Every work of Benjamin Daniels' in the library, newest first. Use it to name "
        "and link his other work. It is a catalog only: what a paper says comes from "
        "the selected paper's text above or from search_readings, never from this list.",
        "",
    ]
    for p in all_papers:
        bits = [f"{p['title']} ({p['year'] or 'n.d.'}). {p['venue']}.",
                f"Authors: {author_line(authors.get(p['bibkey']))}."]
        bits.append(f"DOI link: https://doi.org/{p['doi']}." if p["doi"] else "No DOI.")
        if p["twin_of"]:
            bits.append("Working-paper or preprint version of \""
                        f"{titles[p['twin_of']]}\"; discuss the published article.")
        elif p["key"] in talkable:
            bits.append("Open access; the reader can talk to it and open its PDF here."
                        if p["servable"] else
                        "Closed access; the reader can talk to it here, but it is not shown.")
        else:
            bits.append("Its text is not in this collection; point to the DOI link only.")
        lines.append("- " + " ".join(bits))
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sync", nargs="?", const=str(CV_PDFS), metavar="DIR",
                    help=f"mirror PDFs, XML and _manifest.txt from DIR first (default {CV_PDFS})")
    ap.add_argument("--refresh-authors", action="store_true",
                    help="re-fetch every author list instead of using authors.json")
    args = ap.parse_args()

    if args.sync:
        sync_from_cv(Path(args.sync).expanduser())

    papers, skipped = select_papers(read_library())
    authors = load_authors(papers, args.refresh_authors)
    talkable = [p for p in papers if p["has_text"] and not p["twin_of"]]

    CASES_DIR.mkdir(parents=True, exist_ok=True)
    wanted = set()
    for p in talkable:
        path = CASES_DIR / f"{p['bibkey']}.md"
        wanted.add(path.name)
        changed = write_if_changed(path, vignette_markdown(p, authors.get(p["bibkey"])))
        src = "xml" if p["xml"] else "pdf"
        print(f"  {'wrote' if changed else 'same '} {path.name:34s} {src} "
              f"{path.stat().st_size // 1000:>4d} KB  {'pdf-tab' if p['servable'] else 'no-tab'}")
    for stale in CASES_DIR.glob("*.md"):
        if stale.name != "README.md" and stale.name not in wanted:
            stale.unlink()
            print(f"  removed stale {stale.name}")

    update_project_json(talkable)
    write_if_changed(TALK_MANIFEST, talk_manifest(talkable))
    write_if_changed(GROUNDING, grounding(papers, {p["key"] for p in talkable}, authors))
    write_if_changed(READINGS_MANIFEST, readings_manifest(talkable, authors))

    print(f"\n{len(talkable)} vignettes, {sum(p['servable'] for p in talkable)} with a PDF tab.")
    for bibkey, why in skipped:
        print(f"  no vignette: {bibkey} ({why})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
