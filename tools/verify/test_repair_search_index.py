#!/usr/bin/env python3
"""The repair manual's body-text index: every string in a body, lowercased,
picture ids left out, one gzipped map per chassis that repairBodyIndex reads."""
import gzip
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "ista"))
import repair_search_index as X  # noqa: E402

BODY = {
    "sections": [
        {
            "steps": [
                {
                    "pics": [2000003982111],
                    "text": ["Remove both  exhaust manifolds."],
                    "hints": [{"title": "Installation:", "text": ["Replace nuts."]}],
                }
            ]
        }
    ]
}


class TestIndex(unittest.TestCase):
    def test_body_text(self):
        t = X.body_text(BODY)
        self.assertEqual(t, "remove both exhaust manifolds. installation: replace nuts.")
        self.assertNotIn("2000003982111", t, "picture ids are not words")

    def test_chassis_round_trip(self):
        with tempfile.TemporaryDirectory() as d:
            folder = os.path.join(d, "E46")
            os.makedirs(os.path.join(folder, "body"))
            with open(os.path.join(folder, "body", "00.json"), "w", encoding="utf-8") as fh:
                json.dump({"1": BODY, "2": {"sections": []}}, fh)
            index = X.build_chassis(folder)
            self.assertEqual(list(index), ["1"], "an empty body is not indexed")
            X.write_index(folder, index)
            back = json.load(gzip.open(os.path.join(folder, "search-index.json.gz"), "rt"))
            self.assertIn("exhaust manifolds", back["1"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
