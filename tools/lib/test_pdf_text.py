"""Tests for the line-end hyphen rules in pdf_text.clean.

Run from the repo root:  python3 -m unittest tools/lib/test_pdf_text.py
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pdf_text import clean  # noqa: E402

SHY = "­"  # soft hyphen


class LineEndHyphens(unittest.TestCase):
    def test_soft_hyphen_at_line_end_joins_the_word(self):
        # Elsevier sets every line-break hyphen as U+00AD. Dropping only the
        # character used to leave "en rolled".
        text = f"Households were en{SHY}\nrolled in the program."
        out = clean(text)
        self.assertIn("enrolled", out)
        self.assertNotIn("en rolled", out)
        self.assertNotIn(SHY, out)

    def test_real_hyphen_at_line_end_keeps_the_compound(self):
        # In a text whose typesetter marks its own breaks with soft hyphens, a
        # hard hyphen at a line end belongs to a compound. It used to be joined
        # away, giving "providerpatient".
        text = (f"We study the provider-\npatient relationship in pri{SHY}\n"
                "mary care.")
        out = clean(text)
        self.assertIn("provider-patient", out)
        self.assertNotIn("providerpatient", out)
        self.assertIn("primary", out)

    def test_soft_hyphen_before_a_non_continuation_stays_visible(self):
        # A two-column page can interleave another line after the break; keep
        # a visible hyphen rather than gluing unrelated text together.
        text = f"the inter{SHY}\n1 Footnote text."
        self.assertIn("inter-\n1 Footnote", clean(text))

    def test_plain_hyphen_break_without_soft_hyphens_still_joins(self):
        # A PDF with no soft hyphens marks breaks with ordinary hyphens; the
        # long-standing de-hyphenation rule still applies there.
        self.assertIn("treatment", clean("the treat-\nment arm"))


if __name__ == "__main__":
    unittest.main()
