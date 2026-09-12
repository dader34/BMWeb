#!/usr/bin/env python3
"""The tool's control-unit function lists, checked against the source when
the ISTA database is on this machine (CI has no BMW data: those checks skip).
The KOMBI E46 is the pin: eight read groups, two actuator groups, and the
fuel-gauge sweep is STEUERN_ANZEIGE with TANKINHALT;25."""
import gzip
import json
import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "ista"))
import ecu_functions_extract as X  # noqa: E402

DB = os.path.expanduser(
    "~/Development/code/BMWFILES/ista/databases/DiagDocDb.decrypted.sqlite"
)


class TestPure(unittest.TestCase):
    def test_clean_title(self):
        self.assertEqual(X.clean_title("- General"), "General")
        self.assertEqual(X.clean_title("General"), "General")
        self.assertEqual(X.clean_title(None), "")

    def test_config_variants_are_lowercase(self):
        root = os.path.join(os.path.dirname(__file__), "..", "..")
        names = X.config_variants(root)
        self.assertTrue(names, "the chassis configs name modules")
        self.assertTrue(all(n == n.lower() for n in names))
        self.assertIn("kombi46", names)


@unittest.skipUnless(os.path.exists(DB), "ISTA database not on this machine")
class TestKombi46(unittest.TestCase):
    def setUp(self):
        self.con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        (self.vid,) = self.con.execute(
            "SELECT ID FROM XEP_ECUVARFUNCTIONS WHERE lower(NAME)='kombi46'"
        ).fetchone()

    def test_groups_and_leaves(self):
        reads, acts = X.extract_variant(self.con, self.vid)
        self.assertEqual(len(reads), 8)
        self.assertEqual(len(acts), 2)
        titles = {g["title"] for g in reads}
        self.assertIn("Warning and indicating lamps", titles)
        gauge = next(
            it for g in acts for it in g["items"] if it["title"] == "Fuel gauge"
        )
        self.assertEqual(gauge["job"], "STEUERN_ANZEIGE")
        self.assertEqual(gauge["args"], "TANKINHALT;25")
        kl15 = next(
            it for g in reads for it in g["items"] if it["title"] == "Terminal 15"
        )
        self.assertEqual(kl15["job"], "STATUS_IO_LESEN")
        self.assertEqual([r["name"] for r in kl15["results"]], ["STAT_KL15_EIN"])

    def test_writer_round_trips(self):
        reads, acts = X.extract_variant(self.con, self.vid)
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "kombi46.json.gz")
            X.write_json_gz(p, {"variant": "kombi46", "reads": reads, "acts": acts})
            back = json.load(gzip.open(p, "rt", encoding="utf-8"))
        self.assertEqual(len(back["reads"]), 8)


if __name__ == "__main__":
    unittest.main(verbosity=1)
