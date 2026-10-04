"""Tests for pairing library files with their published articles via versions.json.

Run from the repo root:  python3 -m unittest tools/lib/test_paper_versions.py
"""

import csv
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paper_versions import VERSIONS_FILE, load_versions, pair_versions  # noqa: E402

LIBRARY_TSV = (Path(__file__).resolve().parents[2] / "projects" / "papers" / "content"
               / "library" / "library.tsv")


def row(bibkey, doi="", title="", version="pub"):
    return {"bibkey": bibkey, "doi": doi, "title": title, "version": version}


class PairVersions(unittest.TestCase):
    def test_working_paper_by_doi_case_insensitive(self):
        rows = [row("jde", "10.1016/J.JDEVECO.2026.103795"), row("jdewp", "10.2139/ssrn.6566855", version="wp")]
        papers = [{"doi": "10.1016/j.jdeveco.2026.103795", "versions": [
            {"kind": "working-paper", "doi": "10.3386/w35060"},          # not in the library
            {"kind": "working-paper", "doi": "10.2139/SSRN.6566855"}]}]
        self.assertEqual(pair_versions(rows, papers), {"jdewp": "jde"})

    def test_working_paper_by_title_when_its_doi_misses(self):
        rows = [row("art", "10.1/a"), row("wp", "", "Caseloads and Competence: A Reassessment", "wp")]
        papers = [{"doi": "10.1/a", "versions": [
            {"kind": "working-paper", "doi": "10.9/none", "title": "caseloads and competence -- a reassessment"}]}]
        self.assertEqual(pair_versions(rows, papers), {"wp": "art"})

    def test_accepted_manuscript_shares_the_article_doi(self):
        # The AM row comes first and carries the same DOI: the article is still the proof row
        rows = [row("repkitam", "10.1177/1536867x251398246", version="am"),
                row("repkit", "10.1177/1536867X251398246", version="proof")]
        papers = [{"doi": "10.1177/1536867X251398246", "versions": [
            {"kind": "accepted-manuscript", "label": "Accepted manuscript", "link": False}]}]
        self.assertEqual(pair_versions(rows, papers), {"repkitam": "repkit"})

    def test_duplicate_records_are_not_files(self):
        rows = [row("jhr", "10.3368/jhr.1", "Human Capital and Disasters")]
        papers = [{"doi": "10.3368/jhr.1", "versions": [
            {"kind": "duplicate", "title": "Human Capital and Disasters", "link": False}]}]
        self.assertEqual(pair_versions(rows, papers), {})

    def test_no_pair_without_the_article_in_the_library(self):
        rows = [row("wp", "10.1596/wp", version="wp")]
        papers = [{"doi": "10.1/absent", "versions": [{"kind": "working-paper", "doi": "10.1596/wp"}]}]
        self.assertEqual(pair_versions(rows, papers), {})

    def test_manifest_notes_play_no_part(self):
        rows = [dict(row("a", "10.1/a"), notes=""), dict(row("b", "10.1/b", version="wp"), notes="WP twin of a")]
        self.assertEqual(pair_versions(rows, []), {})


@unittest.skipUnless(VERSIONS_FILE.is_file() and LIBRARY_TSV.is_file(),
                     "site repo or papers library not present")
class LiveLibrary(unittest.TestCase):
    def test_every_library_twin_comes_from_versions_json(self):
        with LIBRARY_TSV.open(newline="") as f:
            primaries = {}
            for r in csv.DictReader(f, delimiter="\t"):
                if r["bibkey"] not in primaries or primaries[r["bibkey"]]["version"] == "xml":
                    primaries[r["bibkey"]] = r
        self.assertEqual(pair_versions(list(primaries.values()), load_versions()), {
            "andrabi2026emergencewp": "andrabi2026emergence",
            "singh2025repkitam": "singh2025repkit",
            "daniels2025caseloads": "daniels2026hrcrisis",
            "croke2026sicknesswp": "croke2026sickness",
        })


if __name__ == "__main__":
    unittest.main()
