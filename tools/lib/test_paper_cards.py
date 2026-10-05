"""Tests for paper cards (paper_cards.paper_card).

Run from the repo root:  python3 -m unittest tools/lib/test_paper_cards.py
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from paper_cards import SEARCH_INSTRUCTION, paper_card  # noqa: E402

META = """SELECTED PAPER
Title: A fixture study of clinic attendance
Authors: Ada Example, Bo Fixture
Venue: Journal of Fixtures, 2026
DOI: https://doi.org/10.0000/fixture.1
License: CC BY (open access)
PDF shown to the reader: yes: the reader can open it in the PDF tab beside the chat
Text below: the published version of record, extracted from the PDF; each page starts with a [page N] marker.

FULL TEXT OF THE SELECTED PAPER
"""

PDF_TEXT = META + """[page 1]
A fixture study of clinic attendance
Ada Example1, Bo Fixture2
1 Fixture University
A B S T R A C T
Background: We randomized 120 clinics to a reminder program.
Results: Attendance rose by a third in treated clinics, and low- and middle-
income districts gained most.
Keywords: attendance; reminders
Introduction
Clinic attendance is low in many places. We study why.
[page 2]
2. Data and methods
We sampled 120 clinics from the national registry.
2.1 Sampling frame
The registry lists 4,512 clinics.
[page 3]
Results
Attendance rose from 30 to 40 visits per week.
Discussion
Reminders are cheap.
"""

XML_TEXT = META.replace(
    "Text below: the published version of record, extracted from the PDF; each page starts with a [page N] marker.",
    "Text below: PubMed Central full-text XML of the published article; sections are marked with # headings, and there are no page numbers.",
) + """# Abstract

## Background

Attendance is low.

## Findings

Reminders raised attendance by a third.

# Introduction

Clinic attendance is low in many places.

# Methods

## Setting

Twelve districts.

# Results

Attendance rose.
"""

UNMARKED_TEXT = META + """[page 1]
A fixture study of clinic attendance
Ada Example and Bo Fixture
This paper studies clinic attendance in twelve districts over two years of
observation. We randomized one hundred and twenty clinics to a reminder program
and compared attendance in treated and control clinics, using registry data on
every visit. Attendance rose by a third in treated clinics, and the effect was
largest in the districts with the lowest baseline attendance, which suggests
reminders work where attendance is most fragile and least where it is already
high.
JEL Codes: I10
Introduction
Clinic attendance is low.
"""


class PdfCard(unittest.TestCase):
    def setUp(self):
        self.card = paper_card(PDF_TEXT)

    def test_metadata_block_is_kept_and_the_edition_line_renamed(self):
        self.assertTrue(self.card.startswith("SELECTED PAPER\nTitle: A fixture study of clinic attendance\n"))
        self.assertIn("DOI: https://doi.org/10.0000/fixture.1", self.card)
        self.assertIn("Searchable text: the published version of record", self.card)
        self.assertNotIn("Text below:", self.card)

    def test_abstract_from_a_letter_spaced_heading_through_its_labels(self):
        self.assertIn("ABSTRACT\nBackground: We randomized 120 clinics to a reminder program. "
                      "Results: Attendance rose by a third in treated clinics, and low- and "
                      "middle-income districts gained most.\n", self.card)
        self.assertNotIn("Keywords", self.card)

    def test_section_headings_with_pages(self):
        sections = self.card.split("SECTIONS OF THE PAPER\n")[1].split("\n\n")[0]
        self.assertEqual(sections.splitlines(), [
            "- Introduction (page 1)",
            "- 2. Data and methods (page 2)",
            "- 2.1 Sampling frame (page 2)",
            "- Results (page 3)",
            "- Discussion (page 3)",
        ])

    def test_no_body_text_and_the_search_line_last(self):
        self.assertNotIn("4,512", self.card)
        self.assertNotIn("30 to 40", self.card)
        self.assertEqual(self.card.rstrip("\n").splitlines()[-1], SEARCH_INSTRUCTION)
        self.assertEqual(SEARCH_INSTRUCTION,
                         "Search the paper's text with search_readings before answering any specific question.")


class XmlCard(unittest.TestCase):
    def test_structured_abstract_and_nested_headings(self):
        card = paper_card(XML_TEXT)
        self.assertIn("ABSTRACT\nBackground: Attendance is low. Findings: Reminders raised attendance by a third.\n", card)
        sections = card.split("SECTIONS OF THE PAPER\n")[1].split("\n\n")[0]
        self.assertEqual(sections.splitlines(), ["- Introduction", "- Methods", "  - Setting", "- Results"])
        self.assertNotIn("Twelve districts", card)


class UnmarkedAbstract(unittest.TestCase):
    def test_the_opening_paragraph_stands_in_and_says_so(self):
        card = paper_card(UNMARKED_TEXT)
        self.assertIn("OPENING TEXT (no abstract heading was found", card)
        self.assertIn("This paper studies clinic attendance", card)
        self.assertNotIn("JEL", card)

    def test_not_a_vignette(self):
        with self.assertRaises(ValueError):
            paper_card("Just some text.")


if __name__ == "__main__":
    unittest.main()
