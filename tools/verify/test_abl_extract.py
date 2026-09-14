#!/usr/bin/env python3
"""The ABL test-module recovery, checked on the shapes the compiler really emits.

The fixtures in fixtures/abl/ are decompiled method bodies written by hand in the exact layout
ilspycmd produces for a compiled flow, small enough to commit (the DLLs never are). Each one pins
one property the recovery depends on:

  flatten.cs     control-flow flattening: the step order is the chain of `num = <const>` assignments
  opaque.cs      the `switch (1 == 1)` opaque predicate, where the body ilspy prints under `default:`
                 is the live path and `case true:` is the decoy
  dictswitch.cs  the newer template's measure selection: a string key through a
                 <PrivateImplementationDetails> Dictionary<string,int> into an integer switch
  arith.cs       a dispatch register computed arithmetically instead of assigned a literal
  lostassign.cs  the dispatch register reused as a data temporary: a job reading parked in `num`
                 and copied into the local a later branch tests, which the lift must emit
  deadexit.cs    a step wired into an exit switch whose register never takes that value: provably
                 dead flow authoring, which must be reported as dead and never as a recovery gap

The last one is the reason `complete` is not simply "every step reached": flows ship jump-table arms
no return statement selects, and calling those a failure would make 100 percent recovery unreachable
by definition. The validator has to tell "cannot be reached" apart from "was not followed".

Text rendering is checked against the spe XML schema without a database; the database-backed checks
skip when the ISTA files are not on this machine (CI has no BMW data).
"""
import os
import sys
import unittest
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures", "abl")
sys.path.insert(0, os.path.join(HERE, "..", "ista"))
import abl_extract as A  # noqa: E402


def recover(name):
    return A.extract_module(os.path.join(FIX, name), None)


class TestFlattening(unittest.TestCase):
    """Undoing the control-flow flattening restores the real step order."""

    def setUp(self):
        self.r = recover("flatten.cs")

    def test_step_order_follows_the_dispatch_chain(self):
        self.assertEqual(self.r["step_order"], ["Start", "Erste_01_s", "Zweite_02_s"])

    def test_every_step_is_reached(self):
        self.assertEqual(self.r["unreached_steps"], [])
        self.assertTrue(self.r["complete"])
        self.assertEqual(self.r["findings"], [])

    def test_exits_are_the_graph_edges(self):
        self.assertEqual(self.r["steps"]["Start"]["exits"], ["Erste_01_s"])
        self.assertEqual(self.r["steps"]["Erste_01_s"]["exits"], ["Zweite_02_s"])
        self.assertEqual(self.r["steps"]["Zweite_02_s"]["exits"], [])

    def test_statements_survive_the_flattening(self):
        assigns = [n for n in self.r["steps"]["Start"]["nodes"] if n["type"] == "assign"]
        self.assertEqual([(n["lhs"], n["rhs"]) for n in assigns], [("SG_gruppe_v", '"D_MOTOR"')])


class TestOpaquePredicate(unittest.TestCase):
    """`switch (1 == 1)`: the IL jumps to what ilspy prints as `default:`.

    Reading it as C# (`case true:` wins) inverts the whole step, so this is the one place where
    following the decompiler's own output is wrong.
    """

    def setUp(self):
        self.r = recover("opaque.cs")

    def test_the_default_body_is_the_live_path(self):
        self.assertIn("Lebend_01_s", self.r["step_order"])
        assigns = [n for n in self.r["steps"]["Start"]["nodes"] if n["type"] == "assign"]
        self.assertEqual([n["rhs"] for n in assigns], ['"DDE control unit"'])

    def test_the_decoy_arm_is_dead_not_a_gap(self):
        self.assertEqual(self.r["unreached_steps"], ["Tot_99_s"])
        reasons = {f["step"]: f["reason"] for f in self.r["findings"]}
        self.assertEqual(reasons, {"Tot_99_s": "call-site-unreached"})
        self.assertIn("Tot_99_s", self.r["dead_steps"])
        self.assertTrue(self.r["complete"], "a provably dead arm does not make a module incomplete")


class TestDictionarySwitch(unittest.TestCase):
    """The newer template selects the measure step by a string key through a compiler dictionary.

    The lookup must be resolved back to a switch on the key itself, with the original strings as
    case labels: the engine routes a selected fault location to its measure step by that string.
    """

    def setUp(self):
        self.r = recover("dictswitch.cs")
        self.sw = next(n for n in self.r["steps"]["Verzweigung_02_s"]["nodes"]
                       if n["type"] == "switch")

    def test_every_measure_step_is_reached(self):
        self.assertEqual(self.r["unreached_steps"], [])
        self.assertTrue(self.r["complete"])
        for step in ("MN_Leitung_10_s", "MN_Sensor_11_s", "WAW_Tausch_12_s"):
            self.assertIn(step, self.r["step_order"])

    def test_the_switch_subject_is_the_string_key(self):
        self.assertEqual(self.sw["expr"], "f_SELEKT_ORT_NR_HEX")

    def test_the_case_labels_are_the_original_strings(self):
        labels = {k for k in self.sw["cases"] if k != "default"}
        self.assertEqual(labels, {'"4550"', '"4551"', '"4552"'})

    def test_each_key_reaches_a_distinct_step(self):
        targets = {k: v for k, v in self.sw["cases"].items() if k != "default"}
        self.assertEqual(len(set(targets.values())), 3)


class TestArithmeticRegister(unittest.TestCase):
    """A dispatch register computed from a variable, not assigned a literal.

    The walker cannot know the value, so it must fork on every arm and record the expression rather
    than give up with an unknown-dispatch error.
    """

    def setUp(self):
        self.r = recover("arith.cs")

    def test_both_arms_are_reached(self):
        self.assertEqual(self.r["unreached_steps"], [])
        self.assertTrue(self.r["complete"])
        self.assertIn("Ohne_Fehler_04_s", self.r["step_order"])
        self.assertIn("Mit_Fehler_05_s", self.r["step_order"])

    def test_the_computed_expression_is_kept(self):
        sw = next(n for n in self.r["steps"]["Auswertung_03_s"]["nodes"] if n["type"] == "switch")
        self.assertEqual(sw["expr"], "Status_Fehlerspeicher_v + 1")
        self.assertEqual({k for k in sw["cases"] if k != "default"}, {"1", "2"})

    def test_no_error_node_is_produced(self):
        errors = [n for st in self.r["steps"].values()
                  for n in st.get("nodes", []) if n["type"] == "error"]
        self.assertEqual(errors, [])


class TestReusedDispatchRegister(unittest.TestCase):
    """The compiler reuses its own dispatch register `num` as an ordinary data temporary.

    After a job read the flattener parks the result in `num` and the flow copies it out
    (`num3 = num`) before testing it. `num` being the register the flattening is followed through
    does not make its value a constant at that point, and the copy is the only thing that carries
    the reading into the register the next branch tests. Losing it leaves the tell-tale shape: a
    `branch` whose two arms are the same node -- the test survived, the assignment on the taken
    arm did not -- and the register stays pinned at the literal it last held.
    """

    def setUp(self):
        self.r = recover("lostassign.cs")
        self.nodes = self.r["steps"]["Fehlerspeicher_Lesen_01_s"]["nodes"]

    def test_the_copy_out_of_the_dispatch_register_is_emitted(self):
        assigns = [n for n in self.nodes if n["type"] == "assign" and n["lhs"] == "num3"]
        self.assertEqual([n["rhs"] for n in assigns],
                         ["0", 'job_result("/Result/Status/SAETZE", int)'])

    def test_no_branch_has_both_arms_on_the_same_node(self):
        same = [n for n in self.nodes if n["type"] == "branch"
                and n["cases"].get("true") == n["cases"].get("false")]
        self.assertEqual(same, [], "a branch whose arms coincide is an assignment the lift dropped")

    def test_the_reading_decides_the_branch(self):
        # the arm that read a record count must test a num3 that is no longer the literal 0
        null_test = next(n for n in self.nodes if n["type"] == "branch" and "!= null" in n["cond"])
        loaded = next(n for n in self.nodes if n["id"] == null_test["cases"]["true"])
        self.assertEqual(loaded["type"], "assign")
        self.assertEqual(loaded["lhs"], "num3")
        after = next(n for n in self.nodes if n["id"] == loaded["next"])
        self.assertEqual(after["cond"], "num3 != 0")
        self.assertNotEqual(after["cases"]["true"], after["cases"]["false"])

    def test_both_outcomes_stay_reachable(self):
        self.assertTrue(self.r["complete"])
        self.assertEqual(self.r["unreached_steps"], [])
        self.assertIn("Mit_Fehler_05_s", self.r["step_order"])
        self.assertIn("Ohne_Fehler_04_s", self.r["step_order"])


class TestDeadExit(unittest.TestCase):
    """A step wired into an exit switch that no return statement selects.

    This is dead authoring in the flow, not a recovery gap, and the distinction is what makes an
    empty failure list meaningful: the validator proves the register never takes that value.
    """

    def setUp(self):
        self.r = recover("deadexit.cs")

    def test_the_unreachable_step_is_reported_with_a_provable_reason(self):
        self.assertEqual(self.r["unreached_steps"], ["Nie_Erreicht_09_s"])
        finding = next(f for f in self.r["findings"] if f["step"] == "Nie_Erreicht_09_s")
        self.assertEqual(finding["reason"], "exit-never-produced")
        self.assertIn("never ==", finding["detail"])

    def test_it_counts_as_dead_not_as_a_gap(self):
        self.assertIn("Nie_Erreicht_09_s", self.r["dead_steps"])
        self.assertTrue(self.r["complete"])

    def test_the_produced_exit_is_still_reached(self):
        self.assertIn("Erreicht_08_s", self.r["step_order"])


class TestValidator(unittest.TestCase):
    """`complete` is the contract the batch gates on."""

    def test_a_pruned_step_would_not_be_complete(self):
        self.assertIn("pruned", A.validate.__doc__)
        self.assertNotIn("pruned", A.DEAD_REASONS,
                         "a pruned step is a recovery gap and must never count as dead")

    def test_dead_reasons_are_all_provable(self):
        for reason in A.DEAD_REASONS:
            self.assertIn(reason, ("never-called", "exit-never-produced", "exit-not-executed",
                                   "caller-unreached", "call-site-unreached"))

    def test_every_recovered_step_has_an_entry_node(self):
        for name in ("flatten.cs", "dictswitch.cs", "arith.cs"):
            r = recover(name)
            for step in r["step_order"]:
                st = r["steps"][step]
                self.assertIn("entry", st, "%s/%s" % (name, step))
                ids = {n["id"] for n in st["nodes"]}
                self.assertIn(st["entry"], ids, "%s/%s entry must be a real node" % (name, step))

    def test_no_edge_dangles(self):
        """Every next/cases target must name a node that exists in the same step."""
        for name in ("flatten.cs", "opaque.cs", "dictswitch.cs", "arith.cs", "deadexit.cs"):
            r = recover(name)
            for step, st in r["steps"].items():
                ids = {n["id"] for n in st.get("nodes", [])}
                for n in st.get("nodes", []):
                    nxt = n.get("next")
                    for t in (nxt if isinstance(nxt, list) else [nxt]):
                        if t is not None:
                            self.assertIn(t, ids, "%s/%s node %s next" % (name, step, n["id"]))
                    for label, t in (n.get("cases") or {}).items():
                        self.assertIn(t, ids, "%s/%s node %s case %s" % (name, step, n["id"], label))

    def test_no_node_is_orphaned(self):
        """Every node listed in a step must be reachable from that step's entry.

        Nodes are emitted in walk order, not link order, so an orphan would mean the walker recorded
        an event it never linked into the graph: work the engine could never run.
        """
        for name in ("flatten.cs", "opaque.cs", "dictswitch.cs", "arith.cs", "deadexit.cs"):
            r = recover(name)
            for step in r["step_order"]:
                st = r["steps"][step]
                nodes = {n["id"]: n for n in st.get("nodes", [])}
                if not nodes:
                    continue
                seen, stack = set(), [st["entry"]]
                while stack:
                    i = stack.pop()
                    if i in seen or i not in nodes:
                        continue
                    seen.add(i)
                    nxt = nodes[i].get("next")
                    for t in (nxt if isinstance(nxt, list) else [nxt]):
                        if t is not None:
                            stack.append(t)
                    stack.extend((nodes[i].get("cases") or {}).values())
                self.assertEqual(set(nodes) - seen, set(), "%s/%s orphaned nodes" % (name, step))

    def test_every_exit_names_a_recovered_step(self):
        for name in ("flatten.cs", "dictswitch.cs", "arith.cs"):
            r = recover(name)
            for step, st in r["steps"].items():
                for ex in st.get("exits", []):
                    self.assertIn(ex, r["steps"], "%s: %s exits to unknown %s" % (name, step, ex))


class TestDecompilationIntegrity(unittest.TestCase):
    """A truncated decompilation still parses, so it must be rejected before it is parsed.

    ilspycmd given several assemblies in one invocation truncates all but the last at a 4 KB
    boundary. The cut file yields a graph that looks recoverable but silently loses every step after
    the cut, which is why the cache is verified rather than trusted.
    """

    def test_a_whole_file_passes(self):
        self.assertTrue(A.cs_complete(os.path.join(FIX, "flatten.cs")))

    def test_a_truncated_file_is_rejected(self):
        import tempfile
        src = open(os.path.join(FIX, "flatten.cs"), encoding="utf-8").read()
        with tempfile.NamedTemporaryFile("w", suffix=".cs", delete=False) as fh:
            fh.write(src[: int(len(src) * 0.6)])
            cut = fh.name
        try:
            self.assertFalse(A.cs_complete(cut))
        finally:
            os.unlink(cut)

    def test_a_truncated_file_would_lose_steps(self):
        """The damage the check prevents, made explicit."""
        import tempfile
        src = open(os.path.join(FIX, "flatten.cs"), encoding="utf-8").read()
        cut_at = src.index("private void Zweite_02_s")
        with tempfile.NamedTemporaryFile("w", suffix=".cs", delete=False) as fh:
            fh.write(src[:cut_at])
            cut = fh.name
        try:
            self.assertFalse(A.cs_complete(cut))
            whole = recover("flatten.cs")
            self.assertIn("Zweite_02_s", whole["steps"])
            partial = A.extract_module(cut, None)
            self.assertNotIn("Zweite_02_s", partial["steps"])
        finally:
            os.unlink(cut)


class TestTextRendering(unittest.TestCase):
    """spe text XML flattened to the plain English the engine shows, without a database."""

    def setUp(self):
        self.t = A.Texts.__new__(A.Texts)   # render() needs no connections
        self.t.std_cache = {}

    def render(self, xml):
        doc = xml.replace("<spe:TEXTITEM ", '<spe:TEXTITEM xmlns:spe="%s" ' % A.NS["spe"], 1)
        return self.t.render(ET.fromstring(doc))

    def test_placeholders_become_braces(self):
        out = self.render('<spe:TEXTITEM ID="1">Boost pressure '
                          '<spe:PARAMETER ID="Plad_v"/> mbar</spe:TEXTITEM>')
        self.assertEqual(out, "Boost pressure {Plad_v} mbar")

    def test_list_entries_become_bullets(self):
        out = self.render('<spe:TEXTITEM ID="1"><spe:LISTENTRY>U_LDF</spe:LISTENTRY>'
                          '<spe:LISTENTRY>A_LDF</spe:LISTENTRY></spe:TEXTITEM>')
        self.assertEqual(out, "- U_LDF\n- A_LDF")

    def test_a_note_is_marked(self):
        out = self.render('<spe:TEXTITEM ID="1"><spe:HINT>Altitude matters</spe:HINT></spe:TEXTITEM>')
        self.assertEqual(out, "Note: Altitude matters")

    def test_text_ids_are_collected_from_a_graph(self):
        ids = set()
        A.collect_text_ids({"nodes": [{"params": {"txtParam": {"text": "12784794379"}}}]}, ids)
        self.assertEqual(ids, {"12784794379"})


class TestIdentifier(unittest.TestCase):
    def test_dll_name_maps_to_the_database_identifier(self):
        self.assertEqual(A.identifier_of("ABL_DIT_B1362_D6LDF"), "ABL-DIT-B1362_D6LDF")
        self.assertEqual(A.identifier_of("ABL_GEN_GISTA_FSLISTE1"), "ABL-GEN-GISTA_FSLISTE1")


class TestDeterminism(unittest.TestCase):
    def test_the_same_input_gives_the_same_output(self):
        import json
        a = json.dumps(recover("dictswitch.cs"), sort_keys=True)
        b = json.dumps(recover("dictswitch.cs"), sort_keys=True)
        self.assertEqual(a, b)


class TestChassisIndex(unittest.TestCase):
    """The per-chassis file the app actually reads.

    The app opens this file by fault code and by module identifier, so the two
    things that can go silently wrong are the key format and the document order.
    Both have: the database stores fault codes in DECIMAL while every screen in
    the app reads HEX, and the document links carry no order of their own.
    """

    def setUp(self):
        import json

        path = os.path.join(HERE, "..", "..", "data", "ista", "abl", "E46.json")
        if not os.path.exists(path):
            self.skipTest("no E46 ABL index on this machine")
        with open(path, encoding="utf-8") as fh:
            self.index = json.load(fh)

    def test_fault_codes_are_keyed_in_hex_not_the_stored_decimal(self):
        # XEP_FAULTCODES.CODE for the misfire fault the app shows as 27C3 is
        # the string "10179". A decimal key finds nothing, for any fault, and
        # the failure is silent: every calculated test plan comes out empty.
        self.assertIn("27C3", self.index["faults"])
        self.assertNotIn("10179", self.index["faults"])
        for key in self.index["faults"]:
            code = key.rpartition(":")[2]
            self.assertTrue(code, f"empty code in key {key!r}")
            int(code, 16)  # raises if a decimal-only or malformed key crept back

    def test_a_fault_is_reachable_by_the_lookup_the_app_performs(self):
        table = self.index["faults"]

        def look(code):
            code = code.upper()
            out = []
            for key in (code, code.lstrip("0") or "0", code.rjust(6, "0")):
                for one in table.get(key, []):
                    if one not in out:
                        out.append(one)
            return out

        self.assertEqual(look("27C3"), ["ABL-DIT-B1214_NGTOENS"])
        self.assertEqual(look("0027C3"), ["ABL-DIT-B1214_NGTOENS"])

    def test_a_variant_qualified_key_agrees_with_the_bare_one(self):
        table = self.index["faults"]
        for key, mods in table.items():
            variant, sep, code = key.rpartition(":")
            if not sep:
                continue
            self.assertTrue(variant, f"{key!r} has an empty variant prefix")
            for one in mods:
                self.assertIn(one, table.get(code, []), f"{key} not under {code}")

    def test_documents_are_in_a_stable_chosen_order(self):
        # the link rows carry no PRIORITY, so the order is the tool's choice;
        # the app opens the FIRST of the class a step asked for, so an order
        # that moves between rebuilds changes which diagram is shown
        for ident, mod in self.index["modules"].items():
            docs = mod.get("documents") or []
            keys = [(d["type"], d["identifier"], d["id"]) for d in docs]
            self.assertEqual(keys, sorted(keys), f"{ident} is not in order")

    def test_a_module_carries_only_what_a_plan_row_needs(self):
        allowed = {"complete", "component", "documents", "priority", "steps", "title"}
        for ident, mod in self.index["modules"].items():
            self.assertTrue(set(mod) <= allowed, f"{ident} has {set(mod) - allowed}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
