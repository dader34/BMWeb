#!/usr/bin/env python3
"""The wiring extract, and the designator index a clicked schematic resolves through.

A component on a schematic is a link: click X6254 and the tool shows where that connector
lives. Nothing about that is a name match. A location, connector-view or pin-assignment
document declares its component in two structured fields, and the index is built from
those and nothing else:

  the identifier   EBO-EBO-E46_EB6217B is chassis E46, kind E (Einbauort), designator B6217
  the title        an installation location's title IS its designator list, "B6217, X6217"

What a failure here means:

  a designator that stops resolving   clicking the component on a diagram does nothing, and
                                      the wiring pane silently loses half its navigation
  a designator resolving too widely   a click opens some other component's document, which
                                      is worse than opening nothing: it is a wrong answer
                                      presented as a right one
  chassis bleeding across             PIB-PIB-E53_PE46B is an E53 document whose designator
                                      happens to read E46; parsing the identifier positionally
                                      rather than searching it for a chassis string is what
                                      keeps that out of the E46 set

The database-backed check skips when the ISTA files are not on this machine (CI has no BMW data).
"""
import importlib.util
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
TOOL = os.path.join(ROOT, "tools", "ista", "wiring_extract.py")

spec = importlib.util.spec_from_file_location("wiring_extract", TOOL)
W = importlib.util.module_from_spec(spec)
spec.loader.exec_module(W)


def entry(doc_id, identifier, title, kind):
    """@returns one index entry in the shape write_chassis stores"""
    return {"id": doc_id, "identifier": identifier, "title": title, "type": kind}


class TestIdentifierDesignator(unittest.TestCase):
    def test_the_identifier_carries_the_designator(self):
        for ident, want in [
            ("EBO-EBO-E46_EB6217B", "B6217"),
            ("EBO-EBO-E46_EX01054A", "X01054"),
            ("STA-STA-E46_SX782A", "X782"),
            ("PIB-PIB-E46_PR33A", "R33"),
            ("PIB-PIB-E46_PA6000G", "A6000"),
        ]:
            hit = W.DESIGNATOR_IDENT.match(ident)
            self.assertIsNotNone(hit, ident)
            self.assertEqual(hit.group(1), want, ident)

    def test_the_chassis_field_is_positional_not_searched(self):
        # an E53 document whose DESIGNATOR is E46: the chassis comes from the
        # identifier's own chassis field, so this never joins the E46 set
        hit = W.DESIGNATOR_IDENT.match("PIB-PIB-E53_PE46B")
        self.assertIsNotNone(hit)
        self.assertEqual(hit.group(1), "E46")

    def test_a_shape_it_does_not_know_is_not_guessed_at(self):
        for ident in ["", "EBO-EBO-E46", "SOMETHING-ELSE", "EBO-EBO-E46_EXX"]:
            self.assertIsNone(W.DESIGNATOR_IDENT.match(ident), ident)


class TestIndex(unittest.TestCase):
    def test_a_location_indexes_every_designator_its_title_lists(self):
        idx = W.designator_index(
            [entry(1, "EBO-EBO-E46_EB6254F", "B6254, X6254", "location")]
        )
        self.assertEqual(sorted(idx), ["B6254", "X6254"])
        self.assertEqual(idx["X6254"][0]["id"], 1)

    def test_several_documents_can_carry_one_designator(self):
        idx = W.designator_index(
            [
                entry(1, "EBO-EBO-E46_EB6254F", "B6254, X6254", "location"),
                entry(2, "STA-STA-E46_SX6254A", "X6254 Component connector", "connector"),
            ]
        )
        self.assertEqual([d["type"] for d in idx["X6254"]], ["location", "connector"])
        # B6254 is named only by the location, so only that one answers for it
        self.assertEqual([d["id"] for d in idx["B6254"]], [1])

    def test_one_document_is_listed_once_per_designator(self):
        # the identifier and the title both say B6217; that is one document
        idx = W.designator_index(
            [entry(1, "EBO-EBO-E46_EB6217B", "B6217, X6217", "location")]
        )
        self.assertEqual(len(idx["B6217"]), 1)

    def test_diagrams_are_not_indexed(self):
        # a schematic is what a designator is clicked ON, never what it opens
        idx = W.designator_index(
            [entry(1, "SP-SP-E46_X6254", "X6254 wiring diagram", "diagram")]
        )
        self.assertEqual(idx, {})

    def test_prose_in_a_title_does_not_invent_a_designator(self):
        idx = W.designator_index(
            [entry(1, "PIB-PIB-E46_PR33A", "R33 Steering angle sensor", "pinout")]
        )
        self.assertEqual(sorted(idx), ["R33"])


class TestRevisionCollapse(unittest.TestCase):
    """One component, one document per kind, unless they really say different things."""

    def test_identical_revisions_collapse_to_one(self):
        # X6254's installation location ships as revisions A..F with the same
        # text; six identical choices is noise, not a decision
        docs = [
            entry(i, "EBO-EBO-E46_EB6254%s" % r, "B6254, X6254", "location")
            for i, r in enumerate("ABCDEF", start=1)
        ]
        same = ["Installation position", "underside of oil pan"]
        idx = W.designator_index(docs, {str(i): same for i in range(1, 7)})
        self.assertEqual(len(idx["X6254"]), 1)
        self.assertEqual(idx["X6254"][0]["identifier"], "EBO-EBO-E46_EB6254A")

    def test_revisions_that_read_differently_are_all_kept(self):
        # A6000's locations differ by where the box sits in that model year
        docs = [
            entry(1, "EBO-EBO-E46_EA6000A", "A6000, X60001", "location"),
            entry(2, "EBO-EBO-E46_EA6000C", "A6000, X60001", "location"),
        ]
        bodies = {
            "1": ["Installation position", "rear LH side of engine compartment"],
            "2": ["Installation position", "in electronics box in water box left"],
        }
        idx = W.designator_index(docs, bodies)
        self.assertEqual(len(idx["A6000"]), 2)

    def test_a_different_kind_is_never_collapsed_into_another(self):
        # a connector view and a location are different answers even when the
        # rendered text happens to match
        docs = [
            entry(1, "EBO-EBO-E46_EB6254A", "B6254, X6254", "location"),
            entry(2, "STA-STA-E46_SX6254A", "X6254 Component connector", "connector"),
        ]
        idx = W.designator_index(docs, {"1": ["same"], "2": ["same"]})
        self.assertEqual([d["type"] for d in idx["X6254"]], ["location", "connector"])

    def test_no_private_field_reaches_the_shipped_index(self):
        idx = W.designator_index(
            [entry(1, "EBO-EBO-E46_EB6254A", "B6254, X6254", "location")],
            {"1": ["text"]},
        )
        for rows in idx.values():
            for doc in rows:
                self.assertNotIn("_body", doc)


class TestAgainstTheRealExtract(unittest.TestCase):
    """The E46 extract, when it is on this machine."""

    def setUp(self):
        import json

        path = os.path.join(ROOT, "data", "ista", "wiring", "E46", "index.json")
        if not os.path.exists(path):
            self.skipTest("no E46 wiring extract on this machine")
        with open(path, encoding="utf-8") as fh:
            self.index = json.load(fh)
        # the shipped bodies, flat, the way write_chassis hands them over
        self.bodies = {}
        body_dir = os.path.join(os.path.dirname(path), "body")
        for name in sorted(os.listdir(body_dir)):
            with open(os.path.join(body_dir, name), encoding="utf-8") as fh:
                self.bodies.update(json.load(fh))

    def test_the_index_is_rebuilt_from_the_documents_it_ships(self):
        fresh = W.designator_index(self.index["documents"], self.bodies)
        self.assertEqual(fresh, self.index["designators"])

    def test_every_designator_points_at_a_document_that_shipped(self):
        have = {str(d["id"]): d for d in self.index["documents"]}
        for key, rows in self.index["designators"].items():
            for row in rows:
                doc = have.get(str(row["id"]))
                self.assertIsNotNone(doc, f"{key} points at missing {row['id']}")
                self.assertIn(doc["type"], W.DESIGNATOR_TYPES)
                # a body document must name its shard or the pane cannot fetch it
                self.assertTrue(doc.get("shard"), f"no shard on {doc['id']}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
