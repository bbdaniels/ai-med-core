"""Which library file is another version of which published paper.

The pairing lives in one file, versions.json in Ben's site repo
(~/Projects/bbdaniels.github.io/publications/versions.json). The same file
pairs versions on his web page (orcid-display's applyVersions) and in his CV
(~/Documents/Career/_CV/fetch-publications.py). This module applies that file
to the papers library with the same matching rule those two use:

  * a paper or version is found by DOI, compared case-insensitively;
  * failing that, by title, lowercased with everything outside a-z0-9 removed.

Two refinements the ORCID readers do not need, because a library holds files
rather than ORCID records:

  * an "accepted-manuscript" version has no DOI or title of its own (it shares
    the article's DOI and is never on ORCID, so the web page and the CV skip
    it). It is the library row carrying the paper's DOI whose version is "am";
  * "duplicate" versions are stale ORCID records, not files, and are skipped.

The library manifest keeps per-file facts only (path, version, license,
servable). It says nothing about pairing.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

VERSIONS_FILE = (Path.home() / "Projects" / "bbdaniels.github.io"
                 / "publications" / "versions.json")

# The library's version code for a versions.json kind with no DOI of its own.
SHARED_DOI_KIND = {"accepted-manuscript": "am"}


def norm_doi(doi: str | None) -> str:
    d = (doi or "").strip().lower()
    return re.sub(r"^https?://(dx\.)?doi\.org/", "", d)


def norm_title(title: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (title or "").lower())


def load_versions(path: Path = VERSIONS_FILE) -> list[dict]:
    with path.open() as f:
        return json.load(f)["papers"]


def _find(ref: dict, rows: list[dict]) -> dict | None:
    """The row that is `ref`: by DOI, else by title (the shared rule)."""
    doi = norm_doi(ref.get("doi"))
    if doi:
        hit = next((r for r in rows if norm_doi(r.get("doi")) == doi), None)
        if hit:
            return hit
    title = norm_title(ref.get("title"))
    if not title:
        return None
    return next((r for r in rows if norm_title(r.get("title")) == title), None)


def pair_versions(rows: list[dict], papers: list[dict]) -> dict[str, str]:
    """{bibkey of a version: bibkey of its published article}.

    `rows` is one row per bibkey (bibkey, doi, title, version); `papers` is
    versions.json's list. A pair is made only when both the article and the
    version are in the library.
    """
    out: dict[str, str] = {}
    for paper in papers:
        claimed = []
        for v in paper.get("versions", []):
            kind = v.get("kind")
            if kind == "duplicate":
                continue
            if kind in SHARED_DOI_KIND and not (v.get("doi") or v.get("title")):
                doi = norm_doi(paper.get("doi"))
                hit = next((r for r in rows if doi and norm_doi(r.get("doi")) == doi
                            and r.get("version") == SHARED_DOI_KIND[kind]), None)
            else:
                hit = _find(v, rows)
            if hit:
                claimed.append(hit)
        if not claimed:
            continue
        taken = {r["bibkey"] for r in claimed}
        article = _find(paper, [r for r in rows if r["bibkey"] not in taken])
        if article:
            for r in claimed:
                out[r["bibkey"]] = article["bibkey"]
    return out
