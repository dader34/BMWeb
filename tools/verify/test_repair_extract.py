#!/usr/bin/env python3
"""The repair extractor's pieces, on fixtures rather than the 15 GB store.

Three things have to hold or the section ships something wrong:

  the DOCUMENT MODEL   both schema generations read into the same shape, and
                       a torque nested inside an instruction is read as
                       torque data AND removed from the instruction's prose,
                       so a figure is never printed twice in two formats
  the GROUP TREE       "67-1" and "67" are one group, not two, and a group
                       is named from ISTA's OWN objects, falling back to the
                       document vote only where no object exists
  the PICTURE MAPPING  every naming style resolves to its segment name, and
                       ISTA's own icons resolve to nothing on purpose

The validity grammar has its own checks here too, because it is now shared
with the workshop extract and a change that widened one would silently
widen the other.
"""
import os
import sqlite3
import struct
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "ista"))
sys.path.insert(0, os.path.join(HERE, ".."))

import repair_extract as R
import validity_rules as V


# a document of the OLD generation: flat, no namespaces, PROCESSTITLE
OLD_DOC = """<?xml version="1.0" encoding="UTF-8"?>
<REPAIRMANUALDOCUMENT CHARSET="UTF-8" LANGUAGE="en-GB" TYPE="PROCESS">
  <PROCESSTITLE>
    <MAINGROUPNUMBER>41</MAINGROUPNUMBER>
    <SUBGROUPNUMBER>11</SUBGROUPNUMBER>
    <JOBNUMBER>043</JOBNUMBER>
    <PROCESSDESC>Replacing engine support front section on left</PROCESSDESC>
  </PROCESSTITLE>
  <PROCESS>
    <OPERATINGSTEP>
      <ILLUSTRATION GRAPHICSIZE="SMALL">
        <GRAPHIC SRC="GRCI0000-HINWEIS.png" LINKID="G1"/>
      </ILLUSTRATION>
      <HINT TYPE="PRELIMINARIES">
        <TITLE>Necessary preliminary work:</TITLE>
        <LIST TYPE="BULLET">
          <LISTENTRY><PARAGRAPH>Remove the wheel.</PARAGRAPH></LISTENTRY>
        </LIST>
      </HINT>
    </OPERATINGSTEP>
    <OPERATINGSTEP>
      <ILLUSTRATION><GRAPHIC SRC="GRRA4110-42.png" LINKID="G2"/></ILLUSTRATION>
      <PARAGRAPH>Release screws (1).</PARAGRAPH>
      <PARAGRAPH>Remove bracket <HOTSPOT LINKID="H1">(2)</HOTSPOT>.</PARAGRAPH>
    </OPERATINGSTEP>
  </PROCESS>
</REPAIRMANUALDOCUMENT>
"""

# the NEW generation: namespaced, split into phases, torque inline on the
# instruction that tightens the fastener
NEW_DOC = """<?xml version="1.0" encoding="UTF-8"?>
<rep:REPAIRMANUALDOCUMENT_MOD
    xmlns:tf="http://bmw.com/2013/TextFragment_1.0"
    xmlns:hint="http://bmw.com/2013/Hint_Mod_1.0"
    xmlns:tigh="http://bmw.com/2013/Tightening_Mod_1.0"
    xmlns:proc="http://bmw.com/2013/Process_Mod_1.1"
    xmlns:rep="http://bmw.com/2013/RepairManualDocument_Mod_1.0"
    IDENT="REP-REP-P-2720010-1" AWNUMBER="2720010" LANGUAGE="en-GB">
  <rep:TITLE>Removing and installing plug adapter</rep:TITLE>
  <rep:HINTS>
    <hint:INCLUDE_DANGER LINKID="HIN-GEF-P-6125">
      <hint:DANGER LANGUAGE="en-GB">
        <hint:GRAPHIC SRC="GRA-SYM-GRCI0000-10-DANGER.png" LINKID="X"/>
        <hint:SIGNALWORD>DANGER</hint:SIGNALWORD>
        <hint:TYPE_OF_DANGER>
          <tf:SIMPLE_TEXTFRAGMENT>High-voltage system.</tf:SIMPLE_TEXTFRAGMENT>
        </hint:TYPE_OF_DANGER>
        <hint:CONSEQUENCES>
          <tf:SIMPLE_TEXTFRAGMENT>Danger to life.</tf:SIMPLE_TEXTFRAGMENT>
        </hint:CONSEQUENCES>
      </hint:DANGER>
    </hint:INCLUDE_DANGER>
  </rep:HINTS>
  <rep:PREPROCESSES>
    <proc:INCLUDE_PROCESS LINKID="REP-TAT-P-5175-01">
      <proc:PROCESS LANGUAGE="en-GB" VALIDITYINFO="Marke=&quot;BMW PKW&quot;">
        <proc:TITLE>Remove the underbody panelling</proc:TITLE>
        <proc:STEPS>
          <proc:OPERATINGSTEP>
            <proc:GRAPHIC SRC="GRA-PIX-GRRB-51-040-86.png" LINKID="A"/>
            <proc:INSTRUCTION>
              <tf:TEXTFRAGMENT>
                <tf:PARAGRAPH>Release all bolts (arrows).</tf:PARAGRAPH>
              </tf:TEXTFRAGMENT>
            </proc:INSTRUCTION>
          </proc:OPERATINGSTEP>
        </proc:STEPS>
      </proc:PROCESS>
    </proc:INCLUDE_PROCESS>
  </rep:PREPROCESSES>
  <rep:KEYPROCESS>
    <proc:INCLUDE_PROCESS LINKID="REP-TAT-P-2720-02">
      <proc:PROCESS LANGUAGE="en-GB">
        <proc:TITLE>Installing the plug adapter</proc:TITLE>
        <proc:STEPS>
          <proc:OPERATINGSTEP>
            <proc:GRAPHIC SRC="GRA-PIX-GRRB-27-001-96.png" LINKID="B"/>
            <proc:INSTRUCTION>
              <tf:TEXTFRAGMENT>
                <tf:PARAGRAPH>Tighten down screw
                  <tf:IMAGENUMBER>1</tf:IMAGENUMBER>.</tf:PARAGRAPH>
              </tf:TEXTFRAGMENT>
              <proc:ADDITIONALDATA>
                <tigh:INCLUDE_TIGHTENING LINKID="AZD-DAT-P-2400">
                  <tigh:TIGHTENING LANGUAGE="en-GB">
                    <tigh:CONNECTION>Plug adapter to transmission</tigh:CONNECTION>
                    <tigh:SCREW>
                      <tigh:DIMENSION>M8</tigh:DIMENSION>
                      <tigh:TIGHTENING_DATA>
                        <tigh:PROPERTY>
                          <tigh:NUMERICVALUE>
                            <tigh:VALUE>10</tigh:VALUE>
                            <tigh:UNIT>Nm</tigh:UNIT>
                          </tigh:NUMERICVALUE>
                        </tigh:PROPERTY>
                      </tigh:TIGHTENING_DATA>
                    </tigh:SCREW>
                  </tigh:TIGHTENING>
                </tigh:INCLUDE_TIGHTENING>
              </proc:ADDITIONALDATA>
            </proc:INSTRUCTION>
          </proc:OPERATINGSTEP>
        </proc:STEPS>
      </proc:PROCESS>
    </proc:INCLUDE_PROCESS>
  </rep:KEYPROCESS>
</rep:REPAIRMANUALDOCUMENT_MOD>
"""


class TestOldGeneration(unittest.TestCase):
    """The flat schema: group numbers, steps, hints, pictures."""

    def setUp(self):
        """Parse the old-generation fixture once."""
        self.body = R.parse_body(OLD_DOC)

    def test_titles_and_numbers(self):
        """PROCESSTITLE gives the group, subgroup, job and description."""
        self.assertEqual(self.body["mainGroup"], "41")
        self.assertEqual(self.body["subGroup"], "11")
        self.assertEqual(self.body["job"], "043")
        self.assertIn("engine support", self.body["title"])

    def test_steps(self):
        """Two steps, the second carrying its picture and both paragraphs."""
        steps = self.body["sections"][0]["steps"]
        self.assertEqual(len(steps), 2)
        self.assertEqual(
            steps[1]["text"],
            ["Release screws (1).", "Remove bracket (2)."],
        )

    def test_hint_folds_to_a_kind(self):
        """PRELIMINARIES is the 'before' kind, with its list text kept."""
        hint = self.body["sections"][0]["steps"][0]["hints"][0]
        self.assertEqual(hint["kind"], "before")
        self.assertEqual(hint["title"], "Necessary preliminary work:")
        self.assertIn("Remove the wheel.", hint["text"])

    def test_icon_is_not_a_picture(self):
        """The GRCI0000 note icon is dropped; the real illustration is not."""
        steps = self.body["sections"][0]["steps"]
        self.assertNotIn("pics", steps[0])
        self.assertEqual(len(steps[1]["pics"]), 1)


class TestNewGeneration(unittest.TestCase):
    """The namespaced schema: phases, torques, document-level hints."""

    def setUp(self):
        """Parse the new-generation fixture once."""
        self.body = R.parse_body(NEW_DOC)

    def test_numbers_come_from_the_aw_number(self):
        """No PROCESSTITLE: 2720010 is group 27, subgroup 20, job 010."""
        self.assertEqual(self.body["aw"], "2720010")
        self.assertEqual(self.body["mainGroup"], "27")
        self.assertEqual(self.body["subGroup"], "20")
        self.assertEqual(self.body["job"], "010")

    def test_phases(self):
        """PREPROCESSES is labelled; KEYPROCESS carries no phase label."""
        secs = self.body["sections"]
        self.assertEqual(len(secs), 2)
        self.assertEqual(secs[0]["phase"], "Preliminary work")
        self.assertNotIn("phase", secs[1])
        self.assertEqual(secs[1]["title"], "Installing the plug adapter")

    def test_document_hint(self):
        """A DANGER folds to the danger kind with both its parts."""
        hint = self.body["hints"][0]
        self.assertEqual(hint["kind"], "danger")
        self.assertEqual(
            hint["text"], ["High-voltage system.", "Danger to life."]
        )

    def test_torque_is_structured(self):
        """The figure is read as data, with its unit."""
        step = self.body["sections"][1]["steps"][0]
        torque = step["torques"][0]
        self.assertEqual(torque["connection"], "Plug adapter to transmission")
        screw = torque["screws"][0]
        self.assertEqual(screw["thread"], "M8")
        self.assertEqual(screw["values"], [{"value": "10", "unit": "Nm"}])

    def test_torque_is_not_also_prose(self):
        """THE bug this guards: the figure must appear once, not twice.

        The torque table is a CHILD of the instruction that tightens the
        screw, so a naive itertext() over the instruction would print
        "Tighten down screw 1. Plug adapter to transmission M8 10 Nm".
        """
        step = self.body["sections"][1]["steps"][0]
        self.assertEqual(step["text"], ["Tighten down screw 1."])
        for line in step["text"]:
            self.assertNotIn("Nm", line)
            self.assertNotIn("M8", line)


class TestGroupNumbers(unittest.TestCase):
    """Group numbers as the source authored them, normalised."""

    def test_plain(self):
        """A bare number keeps its value, zero-padded to two digits."""
        self.assertEqual(R.group_number("11"), "11")
        self.assertEqual(R.group_number("7"), "07")

    def test_noisy(self):
        """The leading digits are the group; the rest is authoring noise."""
        self.assertEqual(R.group_number("67-1"), "67")
        self.assertEqual(R.group_number("13 32"), "13")
        self.assertEqual(R.group_number("65 Airbagsteuergeraet"), "65")

    def test_no_digits(self):
        """Anything with no leading digit files under 00."""
        self.assertEqual(R.group_number(""), "00")
        self.assertEqual(R.group_number(None), "00")
        self.assertEqual(R.group_number("General"), "00")


class TestGroupNames(unittest.TestCase):
    """Group names come from ISTA's own objects, not from document text."""

    def setUp(self):
        """A DiagDocDb stub holding the two name classes."""
        self.con = sqlite3.connect(":memory:")
        self.con.execute(
            "CREATE TABLE XEP_DIAGNOSISOBJECTS "
            "(NODECLASS INT, HG_NUMMER TEXT, HGUG_NUMMER TEXT, TITLE_ENGB TEXT)"
        )
        self.con.executemany(
            "INSERT INTO XEP_DIAGNOSISOBJECTS VALUES (?,?,?,?)",
            [
                # main groups: NODECLASS 5235202, the number in HG_NUMMER
                (5235202, "16", None, "Fuel supply"),
                (5235202, "17", None, "Cooling"),
                (5235202, "21", None, "Clutch"),
                (5235202, "9", None, "Padded to two digits"),
                (5235202, "18", None, ""),
                # subgroups: NODECLASS 5236354, all four digits in HGUG_NUMMER
                (5236354, None, "2100", "Clutch, check"),
                (5236354, None, "2153", "autom. clutch operation"),
                (5236354, None, "21", "too short to be a subgroup"),
                (5236354, None, None, "no number at all"),
                # another class entirely: must not be read as a group name
                (4862722, "16", "1600", "Some diagnostic object"),
            ],
        )

    def test_main_groups(self):
        """The objects' names, keyed the way group_number pads them."""
        main, _ = R.group_names_from_objects(self.con)
        self.assertEqual(main["16"], "Fuel supply")
        self.assertEqual(main["17"], "Cooling")
        self.assertEqual(main["09"], "Padded to two digits")
        # an empty title is not a name
        self.assertNotIn("18", main)

    def test_subgroups(self):
        """HGUG_NUMMER carries group and subgroup together, as ISTA prints it."""
        _, sub = R.group_names_from_objects(self.con)
        self.assertEqual(sub["2100"], "Clutch, check")
        self.assertEqual(sub["2153"], "autom. clutch operation")
        # a number that is not four digits is not a subgroup key
        self.assertNotIn("21", sub)
        self.assertEqual(len(sub), 2)

    def test_other_classes_are_ignored(self):
        """Only the two naming classes are read, not every diagnosis object."""
        main, sub = R.group_names_from_objects(self.con)
        self.assertNotIn("1600", sub)
        self.assertNotEqual(main.get("16"), "Some diagnostic object")

    def test_objects_beat_the_document_vote(self):
        """THE FIX: the object's name wins where both have one.

        The documents mostly say "Radiator" for group 17; ISTA's tree says
        "Cooling", and the tree is what a reader is comparing against.
        """
        main, sub, stats = R.merge_group_names(self.con, None)
        self.assertEqual(main["17"], "Cooling")
        self.assertEqual(sub["2100"], "Clutch, check")
        self.assertEqual(stats["objMain"], 4)
        self.assertEqual(stats["objSub"], 2)

    def test_a_group_with_no_object_keeps_its_voted_name(self):
        """The vote is a fallback, not a rival: a bare number is worse."""
        voted_main = {"99": "Voted only"}
        real = R.group_names_from_index
        try:
            R.group_names_from_index = lambda _p: (voted_main, {"9999": "Voted sub"})
            main, sub, stats = R.merge_group_names(self.con, "ignored")
        finally:
            R.group_names_from_index = real
        self.assertEqual(main["99"], "Voted only")
        self.assertEqual(sub["9999"], "Voted sub")
        # and the object still wins where it has one
        self.assertEqual(main["17"], "Cooling")
        self.assertEqual(stats["votedOnlyMain"], 1)
        self.assertEqual(stats["votedOnlySub"], 1)


class TestPictureNames(unittest.TestCase):
    """A GRAPHIC SRC to the name the segment table holds."""

    def test_old_style(self):
        """"GRRA4110-42.png" is segment "RA4110-42" (verified against the db)."""
        self.assertIn("RA4110-42", R.pic_name("GRRA4110-42.png"))

    def test_new_style(self):
        """A GRA-PIX- prefix is not part of the segment name."""
        self.assertIn(
            "GRRB-27-001-96", R.pic_name("GRA-PIX-GRRB-27-001-96.png")
        )

    def test_egr_style(self):
        """An EGR-EGR- prefix comes off the same way."""
        self.assertIn("GRSW3613-00", R.pic_name("EGR-EGR-GRSW3613-00.png"))

    def test_leading_dashes(self):
        """Some SRCs are authored with stray leading dashes."""
        self.assertIn("RA4110-42", R.pic_name("--GRRA4110-42.png"))

    def test_icons_resolve_to_nothing(self):
        """ISTA's own note/warning icons are never shipped.

        The icon test beats every other rule, including the leading-dash
        one: "--GRCI0000-INFO.png" is still an icon.
        """
        self.assertEqual(R.pic_name("GRA-SYM-GRCI0000-10-NOTICE.png"), [])
        self.assertEqual(R.pic_name("GRCI0000-HINWEIS.png"), [])
        self.assertEqual(R.pic_name("--GRCI0000-INFO.png"), [])

    def test_resolution_prefers_an_exact_match(self):
        """The first candidate that the segment table has wins."""
        segments = {"GRRB-27-001-96": 42}
        self.assertEqual(
            R.resolve_pic(R.pic_name("GRA-PIX-GRRB-27-001-96.png"), segments), 42
        )
        self.assertIsNone(R.resolve_pic(R.pic_name("GRNOPE-1.png"), segments))


class TestHintKinds(unittest.TestCase):
    """Both generations' hint vocabularies fold to one set of kinds."""

    def test_known(self):
        """The kinds the corpus actually uses."""
        self.assertEqual(R.hint_kind("PRELIMINARIES"), "before")
        self.assertEqual(R.hint_kind("ATTENTION"), "caution")
        self.assertEqual(R.hint_kind("DANGER"), "danger")
        self.assertEqual(R.hint_kind("install"), "install")

    def test_unknown_is_a_note(self):
        """An unrecognised kind still shows its text, unstyled."""
        self.assertEqual(R.hint_kind("SOMETHING-NEW"), "note")
        self.assertEqual(R.hint_kind(None), "note")


class TestValidityGrammar(unittest.TestCase):
    """The rule grammar, now shared with the workshop extract."""

    @staticmethod
    def eq(root, val):
        """One EQ node's bytes."""
        return bytes([V.OP_EQ]) + struct.pack("<qq", root, val)

    def test_eq(self):
        """A bare EQ decodes to the pair it names."""
        tree, unsure = V.decode_rule(self.eq(7, 9))
        self.assertFalse(unsure)
        self.assertEqual(tree, {"op": "eq", "root": 7, "val": 9})

    def test_and_or_not(self):
        """The three combinators nest and consume exactly their operands."""
        blob = (
            bytes([V.OP_AND])
            + struct.pack("<i", 2)
            + self.eq(1, 2)
            + bytes([V.OP_NOT])
            + self.eq(3, 4)
        )
        tree, unsure = V.decode_rule(blob)
        self.assertFalse(unsure)
        self.assertEqual(tree["op"], "and")
        self.assertEqual(tree["kids"][1], {"op": "not", "kids": [
            {"op": "eq", "root": 3, "val": 4}]})

    def test_soft_keeps_its_operand(self):
        """An undecoded qualifier keeps what it qualifies, marked soft."""
        tree, unsure = V.decode_rule(bytes([0x03]) + self.eq(1, 2))
        self.assertFalse(unsure)
        self.assertEqual(
            tree, {"op": "soft", "kids": [{"op": "eq", "root": 1, "val": 2}]}
        )

    def test_literal_consumes_eight_bytes(self):
        """0x09/0x0e/0x0f are an int64 with no operand."""
        blob = (
            bytes([V.OP_AND])
            + struct.pack("<i", 2)
            + self.eq(1, 2)
            + bytes([0x0F])
            + struct.pack("<q", -1)
        )
        tree, unsure = V.decode_rule(blob)
        self.assertFalse(unsure)
        self.assertEqual(tree["kids"][1], {"op": "lit"})

    def test_trailing_bytes_are_unsure(self):
        """A tree built from part of a blob is not trusted."""
        tree, unsure = V.decode_rule(self.eq(1, 2) + b"\x00\x00")
        self.assertTrue(unsure)
        self.assertIsNone(tree)

    def test_unknown_opcode_is_unsure(self):
        """An opcode outside the grammar flags the document, not a guess."""
        tree, unsure = V.decode_rule(bytes([0x7F, 0, 0, 0]))
        self.assertTrue(unsure)
        self.assertIsNone(tree)

    def test_no_rule_is_not_unsure(self):
        """No rule means "applies to everything", a real answer."""
        tree, unsure = V.decode_rule(None)
        self.assertFalse(unsure)
        self.assertIsNone(tree)

    def test_applies(self):
        """Evaluation, including the widening directions."""
        self.assertTrue(V.rule_applies(None, set()))
        self.assertTrue(V.rule_applies({"op": "eq", "root": 1, "val": 9}, {9}))
        self.assertFalse(V.rule_applies({"op": "eq", "root": 1, "val": 9}, {8}))
        # soft passes through to its operand
        soft = {"op": "soft", "kids": [{"op": "eq", "root": 1, "val": 9}]}
        self.assertTrue(V.rule_applies(soft, {9}))
        self.assertFalse(V.rule_applies(soft, {8}))
        # a node the grammar could not pin down applies rather than excluding
        self.assertTrue(V.rule_applies({"op": "lit"}, set()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
