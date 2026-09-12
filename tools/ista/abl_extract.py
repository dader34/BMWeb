#!/usr/bin/env python3
"""Recover an ISTA test module (ABL_*.dll, a compiled flow) into a JSON step graph.

One DLL (or its ilspy decompilation) in, one JSON out, deterministic. The output shape is
documented in tools/ista/ABL_FORMAT.md and is frozen: fields are only ever added.

Pipeline
  1. decompile the DLL with ilspycmd (cached as cs/<name>.cs)
  2. parse every method of the module class into a statement tree
  3. flatten the tree into a tiny jump-based instruction list
  4. walk it symbolically: the obfuscation is control-flow flattening
     (`while(true) switch(num)`), so tracking the integer state variables
     as known constants and following the chain of assignments recovers the
     real statement order; only genuine data-dependent conditions fork
  5. lift the walked events into typed nodes (message / selection / ecu_job /
     measurement / submodule / assign / branch / switch / goto_step / end)
  6. resolve text ids against the module's text collection in the database

Usage
  abl_extract.py <dll-or-cs> [--out file.json] [--no-db] [--dump-events]
"""
import json
import os
import re
import sqlite3
import subprocess
import sys
import xml.etree.ElementTree as ET
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL_VERSION = "abl_extract 1.0"
ILSPY = os.environ.get("ILSPYCMD", os.path.expanduser("~/.dotnet/tools/ilspycmd"))
DOTNET_ROOT = os.environ.get("DOTNET_ROOT", "/opt/homebrew/Cellar/dotnet/10.0.105/libexec")
BMWFILES = os.environ.get("BMWFILES", os.path.expanduser("~/Development/code/BMWFILES"))
DIAGDOC = os.environ.get("ISTA_DIAGDOC", os.path.join(BMWFILES, "ista/databases/DiagDocDb.decrypted.sqlite"))
XMLVAL_EN = os.environ.get("ISTA_XMLVAL_EN", os.path.join(BMWFILES, "ista/databases/xmlvalueprimitive_ENGB.sqlite"))

DIALOG_KIND = {
    "51915403": "message",            # MessageServiceDlg
    "68904586891": "message",         # Meldung_Neu
    "13628358027": "selection",       # QuestionSelectServiceDlg_20
    "51911691": "selection",          # QuestionSelectServiceDlg
    "51878795": "question",           # QuestionServiceDlg (yes/no)
    "51939083": "ecu_job",            # ECUKOMServiceDlg
    "51892235": "measurement",        # MeasuringServiceDlg (IMIB DMM)
    "51888523": "input",              # EnterServiceDlg (text/number entry)
    "51937067403": "feedback",        # RueckmeldeDialog
    "51919115": "counter",            # ZaehlerServiceDlg
    "51872651": "vehicle_state",      # VehicleStateServiceDlg
    "20000138655401": "multi_selection",
    "51884811": "oscilloscope",
    "57410849547": "value_display",   # Dialog_Messwertanzeige_H
    "55479872651": "value_display",   # Dialog_Messwertanzeige_V
    "20000139577811": "imib_plugin",
    "20000093550613": "curve_display",
    "20000364853784": "curve_display",
    "54870936203": "date_input",
    "52655243": "dtc_display",        # DTC_ANZEIGE_DYN
    "68025234187": "fault_display",   # FKB_Anzeige
    "53531955979": "bar_display", "53536324363": "bar_display",
    "53600486795": "bar_display", "53600523019": "bar_display",
}
COLLECTIVE = {0: "Ok", 1: "Verified", 2: "NotOk", 3: "Unknown", 4: "Repaired", 5: "None"}

# ----------------------------------------------------------------------------
# 1. decompile
# ----------------------------------------------------------------------------

def cs_complete(path):
    """True when a decompilation on disk is whole (ends on a closing brace at column 0).

    A decompilation cut short still parses and still yields a plausible step graph, so a partial
    file must never be trusted. Give ilspycmd exactly one assembly per invocation: several
    assemblies in one invocation truncate all but the last at a 4 KB boundary.
    """
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            src = fh.read()
    except OSError:
        return False
    lines = src.rstrip().splitlines()
    return bool(lines) and lines[-1] == "}"


def decompile(dll, cs_dir):
    os.makedirs(cs_dir, exist_ok=True)
    name = os.path.splitext(os.path.basename(dll))[0]
    cs = os.path.join(cs_dir, name + ".cs")
    if not os.path.exists(cs) or os.path.getsize(cs) == 0 or not cs_complete(cs):
        env = dict(os.environ, DOTNET_ROOT=DOTNET_ROOT)
        tmp = cs + ".part"
        with open(tmp, "w") as fh:
            subprocess.run([ILSPY, dll], stdout=fh, stderr=subprocess.DEVNULL, env=env, check=False)
        if not cs_complete(tmp):
            os.unlink(tmp)
            raise ValueError("decompilation of %s is incomplete" % os.path.basename(dll))
        os.replace(tmp, cs)
    return cs

# ----------------------------------------------------------------------------
# 2. parse C# (ilspy layout: one statement per line, braces on own lines)
# ----------------------------------------------------------------------------

HEADER_RE = re.compile(r"^(if|else if|while|switch|for|foreach|using|lock|do|try|catch|finally|else|fixed|checked|unchecked)\b")
CASE_RE = re.compile(r"^(case\s+(.+?)|default)\s*:$")
LABEL_RE = re.compile(r"^((end_)?IL_[0-9a-fA-F]+)\s*:$")


class Node:
    __slots__ = ("kind", "a", "b", "c")

    def __init__(self, kind, a=None, b=None, c=None):
        self.kind, self.a, self.b, self.c = kind, a, b, c

    def __repr__(self):
        return "Node(%s,%r)" % (self.kind, self.a)


def split_methods(src):
    """Return (classname, fields_text, {method_name: body_lines})."""
    lines = src.split("\n")
    m = re.search(r"public class (\w+) : ISTAModule", src)
    if not m:
        raise ValueError("no ISTAModule subclass")
    cls = m.group(1)
    start = src[: m.start()].count("\n")
    # class body is indented one tab; methods are '\t\tRETTYPE name(...)' followed by '\t\t{'
    meth_re = re.compile(r"^\t\t(?:public|private|protected|internal)?\s*(?:virtual|override|static)?\s*[\w<>\[\],\. ]+?\s+(\w+)\((.*)\)\s*$")
    methods = OrderedDict()
    fields = []
    i = start + 1
    n = len(lines)
    while i < n:
        ln = lines[i]
        if ln.startswith("\t}") and not ln.startswith("\t\t"):
            break  # end of class
        mm = meth_re.match(ln)
        if mm and i + 1 < n and lines[i + 1].rstrip() == "\t\t{":
            name = mm.group(1)
            j = i + 2
            body = []
            while j < n and lines[j].rstrip() != "\t\t}":
                body.append(lines[j])
                j += 1
            key = name
            k = 2
            while key in methods:
                key = "%s#%d" % (name, k)
                k += 1
            methods[key] = (mm.group(2), body)
            i = j + 1
            continue
        if ln.startswith("\t\tpublic ") and ln.rstrip().endswith(";"):
            fields.append(ln.strip())
        i += 1
    return cls, fields, methods


def depth_delta(s):
    """Net brace/paren depth of a line, ignoring the inside of string literals."""
    d = 0
    i = 0
    n = len(s)
    while i < n:
        ch = s[i]
        if ch == '"':
            i += 1
            while i < n and s[i] != '"':
                i += 2 if s[i] == "\\" else 1
        elif ch == "'":
            i += 1
            while i < n and s[i] != "'":
                i += 2 if s[i] == "\\" else 1
        elif ch in "{(":
            d += 1
        elif ch in "})":
            d -= 1
        i += 1
    return d


def parse_block(lines, i, depth_indent):
    """Parse statements until the closing brace of the current block. Returns (nodes, next_index)."""
    nodes = []
    n = len(lines)
    while i < n:
        raw = lines[i]
        s = raw.strip()
        if not s or s.startswith("//"):
            i += 1
            continue
        if s == "}":
            return nodes, i + 1
        if s == "{":
            body, i = parse_block(lines, i + 1, depth_indent)
            nodes.append(Node("block", body))
            continue
        cm = CASE_RE.match(s)
        if cm:
            nodes.append(Node("case", "default" if s.startswith("default") else cm.group(2).strip()))
            i += 1
            continue
        lm = LABEL_RE.match(s)
        if lm:
            nodes.append(Node("label", lm.group(1)))
            i += 1
            continue
        hm = HEADER_RE.match(s)
        if hm and not s.endswith(";"):
            kw = hm.group(1)
            if kw in ("else", "catch", "finally"):
                # attach to previous if/try
                body, i = parse_block(lines, i + 2, depth_indent) if lines[i + 1].strip() == "{" else (None, i + 1)
                if kw == "else":
                    prev = nodes[-1]
                    assert prev.kind == "if", prev
                    prev.c = body
                elif kw == "catch":
                    nodes[-1].b.append(body)
                else:
                    nodes[-1].c = body
                continue
            if kw == "else if":
                cond = s[len("else if"):].strip()
                body, i = parse_block(lines, i + 2, depth_indent)
                prev = nodes[-1]
                assert prev.kind == "if"
                prev.c = [Node("if", cond, body, None)]
                # subsequent else attaches to the inner if: keep a pointer
                nodes.append(Node("_elseif_marker", prev.c[0]))
                continue
            if kw == "do":
                body, i = parse_block(lines, i + 2, depth_indent)
                cond = lines[i].strip()  # while (...);
                i += 1
                nodes.append(Node("do", cond, body))
                continue
            if kw == "try":
                body, i = parse_block(lines, i + 2, depth_indent)
                nodes.append(Node("try", body, [], None))
                continue
            if lines[i + 1].strip() != "{":
                # single-statement body without braces (rare in ilspy output)
                body, i = [Node("stmt", lines[i + 1].strip())], i + 2
            else:
                body, i = parse_block(lines, i + 2, depth_indent)
            if kw == "if":
                nodes.append(Node("if", s[2:].strip(), body, None))
            elif kw == "while":
                nodes.append(Node("while", s[5:].strip(), body))
            elif kw == "switch":
                nodes.append(Node("switch", s[6:].strip(), body))
            else:
                nodes.append(Node("loop", s, body))
            continue
        # plain statement, possibly spanning lines (array initialisers)
        buf = [s]
        depth = depth_delta(s)
        j = i + 1
        while (depth > 0 or not buf[-1].endswith(";")) and j < n:
            t = lines[j].strip()
            if t.startswith("//"):
                j += 1
                continue
            buf.append(t)
            depth += depth_delta(t)
            j += 1
        nodes.append(Node("stmt", " ".join(buf)))
        i = j
    return nodes, i


def fix_elseif(nodes):
    """Remove marker nodes; 'else' after 'else if' was attached to the outer if by parse_block, move it."""
    out = []
    k = 0
    while k < len(nodes):
        nd = nodes[k]
        if nd.kind == "_elseif_marker":
            inner = nd.a
            outer = out[-1]
            # outer.c == [inner]; if a later else was attached to outer.c... parse_block sets prev.c = body
            # for a bare else: that clobbers [inner]. Handle: if outer.c is not [inner], the else body
            # replaced it -> re-nest.
            if outer.c is not None and (len(outer.c) != 1 or outer.c[0] is not inner):
                inner.c = outer.c
                outer.c = [inner]
            k += 1
            continue
        out.append(nd)
        k += 1
    for nd in out:
        for attr in ("a", "b", "c"):
            v = getattr(nd, attr)
            if isinstance(v, list) and v and isinstance(v[0], Node):
                setattr(nd, attr, fix_elseif(v))
            elif isinstance(v, list) and v and isinstance(v[0], list):
                setattr(nd, attr, [fix_elseif(x) if x and isinstance(x[0], Node) else x for x in v])
    return out


def parse_method(body_lines):
    nodes, _ = parse_block(body_lines + ["\t\t}"], 0, 0)
    return fix_elseif(nodes)

# ----------------------------------------------------------------------------
# 3. flatten to instructions
# ----------------------------------------------------------------------------

class Flat:
    def __init__(self):
        self.ins = []          # list of [op, arg]
        self.labels = {}       # name -> index
        self.ctx = []          # stack of ('loop', head, end) / ('switch', cases{val:label}, end)
        self.nlab = 0

    def newlabel(self, hint="L"):
        self.nlab += 1
        return "%s%d" % (hint, self.nlab)

    def label(self, name):
        self.labels[name] = len(self.ins)

    def emit(self, op, arg=None):
        self.ins.append([op, arg])

    def flatten(self, nodes):
        for nd in nodes:
            k = nd.kind
            if k == "stmt":
                self.stmt(nd.a)
            elif k == "label":
                self.label(nd.a)
            elif k == "block":
                self.flatten(nd.a)
            elif k == "if":
                lt, le, lend = self.newlabel("then"), self.newlabel("else"), self.newlabel("endif")
                self.emit("jif", (nd.a, lt, le))
                self.label(lt)
                self.flatten(nd.b)
                self.emit("jmp", lend)
                self.label(le)
                if nd.c:
                    self.flatten(nd.c)
                self.label(lend)
            elif k == "while":
                head, end = self.newlabel("whead"), self.newlabel("wend")
                self.label(head)
                if nd.a not in ("(true)",):
                    self.emit("jif", (nd.a, self.newlabel("wb"), end))
                    self.label(self.ins[-1][1][1])
                self.ctx.append(("loop", head, end))
                self.flatten(nd.b)
                self.ctx.pop()
                self.emit("jmp", head)
                self.label(end)
            elif k == "do":
                head, end = self.newlabel("dhead"), self.newlabel("dend")
                self.label(head)
                self.ctx.append(("loop", head, end))
                self.flatten(nd.b)
                self.ctx.pop()
                cond = nd.a[len("while"):].strip().rstrip(";")
                self.emit("jif", (cond, head, end))
                self.label(end)
            elif k == "loop":
                head, end = self.newlabel("lhead"), self.newlabel("lend")
                self.label(head)
                self.ctx.append(("loop", head, end))
                self.flatten(nd.b)
                self.ctx.pop()
                self.emit("jmp", head)  # foreach/for over enumerators: treated as loop; body forks on unknown
                self.label(end)
            elif k == "try":
                self.flatten(nd.a)
                if nd.c:
                    self.flatten(nd.c)
            elif k == "switch":
                self.switch(nd)
            elif k == "case":
                raise ValueError("stray case")
            else:
                raise ValueError(k)

    def switch(self, nd):
        end = self.newlabel("swend")
        # split body into (labels, nodes) groups
        groups = []
        cur = None
        for x in nd.a if isinstance(nd.a, list) else nd.b:
            if x.kind == "case":
                if cur is None or cur[1]:
                    cur = ([], [])
                    groups.append(cur)
                cur[0].append(x.a)
            else:
                if cur is None:
                    cur = ([], [])
                    groups.append(cur)
                cur[1].append(x)
        cases = {}
        default = None
        glabels = []
        solo_true = None
        for labels, body in groups:
            gl = self.newlabel("case")
            glabels.append(gl)
            if labels == ["true"]:
                solo_true = gl
            for lab in labels:
                if lab == "default":
                    default = default or gl
                elif case_value(lab) not in cases:
                    cases[case_value(lab)] = gl
        # Opaque predicate `switch (1 == 1)`: the IL is `ceq; switch (A, B, A)` and value 1 takes B. ilspy prints
        # the duplicated A target as a group carrying both `case false:` and `case true:` (junk), and B either as a
        # solo `case true:` group or, when B is the fall-through, as `default:`. A `goto case true` inside the junk
        # must reach B as well.
        if solo_true is not None:
            cases["true"] = solo_true
        real = solo_true or default or end
        self.emit("switch", (nd.a if not isinstance(nd.a, list) else nd.b, cases, default or end, real))
        self.ctx.append(("switch", cases, end, default))
        for gl, (labels, body) in zip(glabels, groups):
            self.label(gl)
            self.flatten(body)
            # C# requires break/goto/return at the end of each case; a group without one falls to next (only for empty groups)
        self.ctx.pop()
        self.label(end)

    def stmt(self, s):
        if s == "continue;":
            for c in reversed(self.ctx):
                if c[0] == "loop":
                    self.emit("jmp", c[1])
                    return
            self.emit("ret")
            return
        if s == "break;":
            if self.ctx:
                self.emit("jmp", self.ctx[-1][2])
            else:
                self.emit("ret")
            return
        m = re.match(r"goto case (.+);$", s)
        if m:
            val = case_value(m.group(1).strip())
            for c in reversed(self.ctx):
                if c[0] == "switch":
                    if val in c[1]:
                        self.emit("jmp", c[1][val])
                        return
                    if val == "default" and c[3]:
                        self.emit("jmp", c[3])
                        return
            # not found in enclosing switches: treat like a switch with unknown -> end
            self.emit("stmt", "/*unresolved*/ " + s)
            return
        m = re.match(r"goto ((end_)?IL_[0-9a-fA-F]+);$", s)
        if m:
            self.emit("jmp", m.group(1))
            return
        if s.startswith("return"):
            self.emit("ret", s)
            return
        self.emit("stmt", s)

    def resolve(self):
        out = []
        missing = len(self.ins)  # a goto to a label inside a dropped catch handler ends the walk there
        L = lambda name: self.labels.get(name, missing)  # noqa: E731
        for op, arg in self.ins:
            if op == "jmp":
                out.append(("jmp", L(arg)))
            elif op == "jif":
                out.append(("jif", (arg[0], L(arg[1]), L(arg[2]))))
            elif op == "switch":
                expr, cases, default, real = arg
                out.append(("switch", (expr, {k: L(v) for k, v in cases.items()}, L(default), L(real))))
            else:
                out.append((op, arg))
        out.append(("ret", "return /*label in dropped handler*/;"))
        return out

# ----------------------------------------------------------------------------
# 4. symbolic walk
# ----------------------------------------------------------------------------

NOISE_STMT = re.compile(r"^(_ = 0;|Log\.\w+\(.*\);|Logger\.\w+\(.*\);|\(\(ISTAModule\)this\)\.LastCallingMethod = .*;|switch \(0\).*|int num\d* = default\(int\);|\w+ \w+ = default\(.*\);|[\w<>\.\[\], ]+ \w+ = default\([^;]*\);|[\w<>\.\[\], ]+ \w+;)$")
ENUM_NAMES = {v: k for k, v in COLLECTIVE.items()}


def case_value(label):
    """Normalise a C# case label to the string the walker compares against."""
    m = re.match(r"^CollectiveResultSet\.(\w+)$", label)
    if m and m.group(1) in ENUM_NAMES:
        return str(ENUM_NAMES[m.group(1)])
    m = re.match(r"^\(CollectiveResultSet\)(\d+)$", label)
    if m:
        return m.group(1)
    return label
INT_LIT = re.compile(r"^-?\d+$")
STATEVAR = re.compile(r"^(?:int )?([A-Za-z]\w*) = (-?\d+);$")
COPYVAR = re.compile(r"^(?:int )?([A-Za-z]\w*) = ([A-Za-z]\w*);$")
TEMPVAR = re.compile(r"^(num\d*|iSTAResultAsType\d*|obj\d*|flag\d*|text\d*|array\d*|sELEKT\d*|collectiveResult\d*|_)$")
# only compiler-generated locals (and the SELEKT selection register) are tracked as known constants;
# module fields stay symbolic so real loops over data do not multiply the state space
TRACKED = re.compile(r"^(num\d*|sELEKT\d*|flag\d*|collectiveResult\d*|CollectiveResult|SELEKT|Result)$")
DECL_ASSIGN = re.compile(r"^(?:[\w<>\.\[\]]+ )?(\w+) = (.+);$")


def norm(expr):
    """Strip ilspy cast noise so expressions read naturally."""
    e = expr
    e = e.replace("((ISTAModule)this).", "").replace("((IstaModuleBase)this).", "")
    e = e.replace("(ISTAModule)(object)this", "this").replace("(object)", "").replace("base.", "")
    e = re.sub(r"\(\(IDisposable\)\w+/\*cast due to constrained\. prefix\*/\)", "", e)
    e = re.sub(r"typeof\((\w+)\)", r"typeof:\1", e)
    e = re.sub(r"\((ITextLocator|ParameterContainer|IDiagnosticDeviceResult|ConfigurationContainer|__TextParameter\[\]|IServiceDialog|CollectiveResultSet|string|int|double|bool|long|string\[\]|int\[\]|double\[\]|IEnumerable<ITextLocator>)\)", "", e)
    e = e.replace("(DocumentStatementAction)0", "Add").replace("(DocumentStatementAction)1", "Remove")
    e = re.sub(r'"([^"]*)" \+ (\d+) \+ "([^"]*)"', r'"\1\2\3"', e)
    e = re.sub(r"(\w+)\.getISTAResultAsType\(\(?\"([^\"]+)\"\)?, typeof:(\w+)\)", r'job_result("\2", \3)', e)
    e = re.sub(r"(\w+)\.getParameter\(\"([^\"]+)\"\)", r"\1.\2", e)
    e = re.sub(r'(?<![\w])\("([^"]*)"\)', r'"\1"', e)
    e = e.strip()
    while e.startswith("(") and e.endswith(")") and Walker.balanced(e[1:-1]):
        e = e[1:-1].strip()
    return e


class Walker:
    """Abstract interpreter over the flat instruction list.

    State = (pc, frozen env of known integer variables). Every distinct state becomes a node.
    Events (statements that matter) are attached to the node reached after executing them.
    """

    def __init__(self, ins, method):
        self.ins = ins
        self.method = method
        self.nodes = {}       # key -> node id
        self.events = []      # list of dicts: {id, kind, ...}
        self.edges = []       # (from_id, to_id, label)
        self.queue = []
        self.limit = 20000
        self.trace = set()    # every pc executed (for the completeness validator)
        self.dispatched = {}  # switch pc -> set of values it dispatched on ('*' = forked on all cases)
        self.origin = {}      # tracked var -> non-constant expression it was last loaded from (method-global, generated code)
        # variables worth tracking as known constants: switch subjects, int locals compared with
        # constants in conditions, and (transitively) whatever is copied into them. Everything else
        # (data counters, flags ilspy also names num*) stays symbolic.
        tracked = {"SELEKT", "CollectiveResult", "Result", "num"}   # `num` is always the step's exit register
        for op, arg in ins:
            if op == "switch":
                m = re.match(r"^\(?(?:\(int\))?(\w+)\)?$", arg[0].strip())
                if m:
                    tracked.add(m.group(1))
        for _ in range(4):
            for op, arg in ins:
                if op == "stmt":
                    m = COPYVAR.match(arg)
                    if m and m.group(1) in tracked:
                        tracked.add(m.group(2))
        self.tracked = tracked
        # registers that carry data (incremented, or loaded from a computed value): a switch on them is a
        # real data switch and is forked; a switch on a pure flattening register with no value is an error
        self.data_regs = set()
        self.dict_switch = {}   # out-register of dict.TryGetValue(key, out reg) -> (key expr, dict name)
        self.dict_maps = {}     # dict name -> {index: key string}
        for op, arg in ins:
            text = arg if op == "stmt" else (arg[0] if op in ("jif", "switch") else "")
            if not isinstance(text, str):
                continue
            for m in re.finditer(r"\b(\w+)(\+\+|--|\s*[-+*/]=)", text):
                self.data_regs.add(m.group(1))
            m = re.search(r"(\S+?)\.TryGetValue\(([^,]+), out (\w+)\)", text)
            if m:
                self.dict_switch[m.group(3)] = (m.group(2).strip(), m.group(1).lstrip("(!"))
                self.data_regs.add(m.group(3))
            m = re.match(r"^(\S+?) = new Dictionary<string, int>\(\d+\) \{(.*)\};$", text)
            if m:
                self.dict_maps[m.group(1)] = {int(i): k for k, i in re.findall(r'\{ "([^"]*)", (\d+) \}', m.group(2))}
        for _ in range(4):
            for op, arg in ins:
                if op == "stmt":
                    m = COPYVAR.match(arg)
                    if m and m.group(2) in self.data_regs:
                        self.data_regs.add(m.group(1))
        for op, arg in ins:
            if op == "stmt":
                m = DECL_ASSIGN.match(arg)
                if m and TRACKED.match(m.group(1)) and not INT_LIT.match(m.group(2).strip()) and not m.group(2).strip().startswith("default("):
                    rhs = m.group(2).strip()
                    mm = re.match(r"^\(?(\w+) \? -?\d+ : -?\d+\)?$", rhs)
                    if not mm and not TRACKED.match(rhs):
                        self.origin[m.group(1)] = rhs
        # propagate copies (num4 = num2)
        for _ in range(3):
            for op, arg in ins:
                if op == "stmt":
                    m = COPYVAR.match(arg)
                    if m and m.group(1) not in self.origin and m.group(1) in tracked:
                        src = m.group(2)
                        if re.match(r"^(num|flag|obj|sELEKT|collectiveResult)\d*$", src):
                            if src in self.origin:
                                self.origin[m.group(1)] = self.origin[src]
                        elif src not in ("CollectiveResult",):
                            # copy from a module-level register / variable: name it as the origin
                            self.origin[m.group(1)] = src

    # --- expression evaluation (only what the obfuscator emits) ---------------
    def ev(self, expr, env):
        e = expr.strip()
        while e.startswith("(") and e.endswith(")") and self.balanced(e[1:-1]):
            e = e[1:-1].strip()
        if e in ("true",):
            return True
        if e in ("false",):
            return False
        if INT_LIT.match(e):
            return int(e)
        # null checks on parameter containers / results: assume present
        m = re.match(r"^(.+?) (==|!=) null$", e)
        if m:
            lhs = m.group(1)
            if "getParameter(" in lhs or lhs in ("InParameter", "OutParameter", "InAndOutParameter", "InParameters") or lhs in env:
                return m.group(2) == "!="   # dialog outputs are always set by the dialog
            return None                     # job results may be missing (no communication): fork
        if e.startswith("!"):
            v = self.ev(e[1:], env)
            return None if v is None else (not v)
        for op in (" == ", " != ", " > ", " < ", " >= ", " <= "):
            idx = self.find_top(e, op)
            if idx >= 0:
                l, r = self.ev(e[:idx], env), self.ev(e[idx + len(op):], env)
                if l is None or r is None:
                    return None
                if isinstance(l, bool) or isinstance(r, bool):
                    l, r = int(l), int(r)
                return {" == ": l == r, " != ": l != r, " > ": l > r, " < ": l < r, " >= ": l >= r, " <= ": l <= r}[op]
        m = re.match(r"^\((int|bool)\)(\w+)$", e)
        if m:
            e = m.group(2)
        if re.match(r"^\w+$", e) and e in env:
            return env[e]
        return None

    @staticmethod
    def balanced(s):
        d = 0
        for ch in s:
            if ch == "(":
                d += 1
            elif ch == ")":
                d -= 1
                if d < 0:
                    return False
        return d == 0

    @staticmethod
    def find_top(e, op):
        d = 0
        i = 0
        while i < len(e):
            ch = e[i]
            if ch == "(":
                d += 1
            elif ch == ")":
                d -= 1
            elif ch == '"':
                j = e.find('"', i + 1)
                i = j if j > 0 else i
            elif d == 0 and e.startswith(op, i):
                return i
            i += 1
        return -1

    # --- walk -----------------------------------------------------------------
    def key(self, pc, env):
        return (pc, tuple(sorted(env.items())))

    def node_for(self, pc, env):
        k = self.key(pc, env)
        if k in self.nodes:
            return self.nodes[k], False
        nid = len(self.events)
        self.nodes[k] = nid
        self.events.append({"id": nid, "pc": pc, "kind": "point"})
        return nid, True

    def run(self):
        start, _ = self.node_for(0, {})
        self.queue.append((0, {}, start))
        steps = 0
        while self.queue:
            pc, env, nid = self.queue.pop()
            steps += 1
            if steps > self.limit:
                self.events.append({"id": len(self.events), "kind": "error", "text": "walk limit"})
                break
            self.step(pc, dict(env), nid)
        return start

    def add_event(self, cur, kind, **kw):
        nid = len(self.events)
        ev = {"id": nid, "kind": kind}
        ev.update(kw)
        self.events.append(ev)
        self.edges.append((cur, nid, None))
        return nid

    def goto(self, cur, pc, env, label=None):
        nid, new = self.node_for(pc, env)
        self.edges.append((cur, nid, label))
        if new:
            self.queue.append((pc, env, nid))

    def step(self, pc, env, cur):
        while True:
            if pc >= len(self.ins):
                self.add_event(cur, "end", how="fallthrough")
                return
            self.trace.add(pc)
            op, arg = self.ins[pc]
            if op == "jmp":
                pc = arg
                # loops back into visited territory are joined via node_for
                nid, new = self.node_for(pc, env)
                self.edges.append((cur, nid, None))
                if new:
                    cur = nid
                    continue
                return
            if op == "ret":
                self.add_event(cur, "end", how=(arg or "return"))
                return
            if op == "jif":
                cond, lt, le = arg
                for rm in re.finditer(r"\b(?:ref|out) (\w+)\b", cond):
                    env.pop(rm.group(1), None)      # an out-parameter in a condition gets a fresh value
                v = self.ev(cond, env)
                if v is True:
                    pc = lt
                    continue
                if v is False:
                    pc = le
                    continue
                b = self.add_event(cur, "branch", cond=norm(cond))
                self.goto(b, lt, env, "true")
                self.goto(b, le, env, "false")
                return
            if op == "switch":
                expr, cases, default, real = arg
                v = self.ev(expr, env)
                if v is not None and not isinstance(v, bool):
                    self.dispatched.setdefault(pc, set()).add(str(v))
                    pc = cases.get(str(v), default)
                    continue
                if isinstance(v, bool):
                    # opaque predicate: take the arm the IL really jumps to (see Flat.switch)
                    pc = real if v else default
                    continue
                ex = expr.strip().strip("()")
                if re.match(r"^num\d*$", ex) and ex not in self.origin and ex not in self.data_regs:
                    # dispatch variable with unknown value: the flattening could not be followed
                    self.add_event(cur, "error", text="unknown dispatch state for %s" % expr)
                    return
                labels = None
                subject = self.origin.get(ex, expr)
                if ex in self.dict_switch:
                    key_expr, dict_name = self.dict_switch[ex]
                    subject = key_expr
                    dmap = self.dict_maps.get(dict_name, {})
                    labels = {str(i): '"%s"' % k for i, k in dmap.items()}
                b = self.add_event(cur, "switch", expr=norm(subject), labels=labels)
                self.dispatched.setdefault(pc, set()).add("*")
                for val, target in cases.items():
                    self.goto(b, target, env, val)
                self.goto(b, default, env, "default")
                return
            # statement
            s = arg
            m = re.match(r"^int (\w+)(?: = default\(int\))?;$", s)
            if m and m.group(1) in self.tracked:
                # ilspy hoists declarations onto jump targets; an uninitialised IL local reads as 0,
                # but a value assigned before a `goto` onto this label must survive
                env.setdefault(m.group(1), 0)
                pc += 1
                continue
            if NOISE_STMT.match(s):
                pc += 1
                continue
            m = STATEVAR.match(s)
            if m and TRACKED.match(m.group(1)) and m.group(1) in self.tracked:
                env[m.group(1)] = int(m.group(2))
                pc += 1
                continue
            m = re.match(r"^(?:int )?([A-Za-z]\w*) = \(?(.+?) \? (-?\d+) : (-?\d+)\)?;$", s)
            if m and TRACKED.match(m.group(1)) and m.group(1) in self.tracked:
                # state assignment through a ternary: fork on the condition
                var, cond, a, b = m.group(1), m.group(2), int(m.group(3)), int(m.group(4))
                v = self.ev(cond, env)
                if v is True:
                    env[var] = a
                elif v is False:
                    env[var] = b
                else:
                    br = self.add_event(cur, "branch", cond=norm(cond))
                    ea, eb = dict(env), dict(env)
                    ea[var], eb[var] = a, b
                    self.goto(br, pc + 1, ea, "true")
                    self.goto(br, pc + 1, eb, "false")
                    return
                pc += 1
                continue
            m = COPYVAR.match(s)
            if m and m.group(2) in env and TRACKED.match(m.group(1)) and m.group(1) in self.tracked:
                env[m.group(1)] = env[m.group(2)]
                pc += 1
                continue
            m = re.match(r"^\(\(IstaModuleBase\)this\)\.ResultSet\.CollectiveResult = (?:\(CollectiveResultSet\)(\d+)|CollectiveResultSet\.(\w+));$", s)
            if m:
                val = int(m.group(1)) if m.group(1) else ENUM_NAMES.get(m.group(2), 5)
                env["CollectiveResult"] = val
                cur = self.add_event(cur, "result", value=COLLECTIVE[val])
                pc += 1
                continue
            m = re.match(r"^(\w+) = \(\(IstaModuleBase\)this\)\.ResultSet\.CollectiveResult;$", s)
            if m:
                if "CollectiveResult" in env:
                    env[m.group(1)] = env["CollectiveResult"]
                else:
                    env.pop(m.group(1), None)
                pc += 1
                continue
            # any other assignment / increment invalidates knowledge of the lhs
            m = DECL_ASSIGN.match(s) or re.match(r"^(\w+)(\+\+|--|\s*[-+*/]=.*);$", s)
            if m and m.group(1) in env:
                del env[m.group(1)]
            for rm in re.finditer(r"\b(?:ref|out) (\w+)\b", s):
                env.pop(rm.group(1), None)
            ev = self.classify(s)
            if ev is not None:
                if ev["kind"] == "invoke":
                    env.pop("CollectiveResult", None)  # a dialog may set the collective result
                cur = self.add_event(cur, **ev)
            pc += 1

    # --- statement classification ---------------------------------------------
    def classify(self, s):
        t = norm(s)
        if t.startswith("__StartStep()") or t.startswith("__FinishStep()"):
            return {"kind": "marker", "what": t.split("(")[0]}
        m = re.match(r"^(\w+)\.setParameter\(\"([^\"]+)\", (.*)\);$", t)
        if m:
            return {"kind": "set", "container": m.group(1), "key": m.group(2), "value": m.group(3)}
        m = re.match(r"^(?:IServiceDialog )?(\w+) = Factory\.CreateServiceDialog\(this, \"(\w+)\", \"(-?\d+)\", _globalTabModuleISTA, (\d+), (\w+), (\w+)\);$", t)
        if m:
            return {"kind": "dialog", "var": m.group(1), "step": m.group(2), "ref": m.group(3), "element": int(m.group(4)), "in": m.group(5), "inout": m.group(6)}
        m = re.match(r"^(\w+)\.Invoke\(\"(\w+)\", (\w+|ParameterContainer\.Empty), (\w+|ParameterContainer\.Empty), (\w+|ParameterContainer\.Empty)\);$", t)
        if m:
            return {"kind": "invoke", "var": m.group(1), "method": m.group(2), "in": m.group(3), "out": m.group(4), "inout": m.group(5)}
        m = re.match(r"^(?:ConfigurationContainer )?(\w+) = ConfigurationContainer\.Deserialize\(\"(.*)\"\);$", t, re.S)
        if m:
            return {"kind": "dsc", "var": m.group(1), "xml": m.group(2)}
        m = re.match(r"^(\w+)\.AddRunOverride\(\"([^\"]+)\", (.*)\);$", t)
        if m:
            return {"kind": "override", "var": m.group(1), "path": m.group(2), "value": m.group(3)}
        m = re.match(r"^(\w+)\.AddParametrizationOverride\(\"([^\"]+)\", (.*)\);$", t)
        if m:
            return {"kind": "override", "var": m.group(1), "path": m.group(2), "value": m.group(3), "parametrization": True}
        m = re.match(r"^callModuleRef\(\"(\d+)\", (\w+), ref (\w+), ref (\w+)\);$", t)
        if m:
            return {"kind": "submodule", "ref": m.group(1), "in": m.group(2), "out": m.group(3), "inout": m.group(4)}
        m = re.match(r"^callModule\(\"([^\"]+)\", (\w+), ref (\w+), ref (\w+)\);$", t)
        if m:
            return {"kind": "submodule", "name": m.group(1), "in": m.group(2), "out": m.group(3), "inout": m.group(4)}
        m = re.match(r"^DocumentHandler\((Add|Remove|\(DocumentStatementAction\)\d+)(?:, (.*))?\);$", t)
        if m:
            return {"kind": "document", "action": m.group(1).replace("(DocumentStatementAction)", "action"), "arg": m.group(2)}
        m = re.match(r"^(\w+)\(\);$", t)
        if m and m.group(1) not in ("__handleInParameter", "__handleOutParameter"):
            return {"kind": "call_step", "step": m.group(1)}
        m = re.match(r"^(\w+)\(InParameter, ref OutParameter, ref InAndOutParameter\);$", t)
        if m:
            return {"kind": "call_step", "step": m.group(1)}
        m = re.match(r"^Sleep\((.*)\);$", t)
        if m:
            return {"kind": "sleep", "ms": m.group(1)}
        m = re.match(r"^(__SetSuspiciousItem|__SetOkItem|__SetNotOkItem)\((.*)\);$", t)
        if m:
            return {"kind": "suspicion", "what": m.group(1).strip("_"), "arg": m.group(2)}
        m = re.match(r"^(\w+(?:\[[^\]]*\])?)(\+\+|--);$", t)
        if m:
            return {"kind": "assign", "lhs": m.group(1), "rhs": "%s %s 1" % (m.group(1), "+" if m.group(2) == "++" else "-")}
        m = re.match(r"^(?:[\w<>\[\]\.]+ )?(\w+(?:\[[^\]]*\])?) = (.*);$", t)
        if m:
            return {"kind": "assign", "lhs": m.group(1), "rhs": m.group(2)}
        if t.startswith("_DoLoopHandling"):
            return {"kind": "assign", "lhs": "_DoLoopHandling", "rhs": t.split("=")[1].strip(" ;")}
        m = re.match(r"^(\w+)\.Concat\((.*)\);$", t) or re.match(r"^(\w+)\.TextContent\.Concat\((.*)\);$", t)
        if m:
            return {"kind": "concat", "var": m.group(1), "arg": m.group(2)}
        if "__SetSuspiciousItem" in t or "__SetOkItem" in t or "__SetNotOkItem" in t or t.startswith("Sleep(") or "ClearErrorInfoMemory" in t or "ReadErrorInfoMemory" in t:
            return {"kind": "misc", "text": t}
        if t.startswith("if (") or "MoveNext" in t or t.startswith("KeyValuePair") or "Dispose()" in t or t.startswith("ModuleEnvironment") or t.startswith("__handle"):
            return None
        return {"kind": "misc", "text": t}

# ----------------------------------------------------------------------------
# 5. lift events into a step graph
# ----------------------------------------------------------------------------

TEXT_CALL = re.compile(r"__Text\(\"(\d+)\"(?:, new __TextParameter\[\d+\] \{(.*)\})?\)")
TEXT_PARAM = re.compile(r"new __TextParameter\(\"(\w+)\", ([^)]*)\)")


def value_of(expr, textvars, dscvars):
    """Turn a parameter value expression into JSON."""
    e = norm(expr)
    if e == "null":
        return None
    if e in ("true", "false"):
        return e == "true"
    if INT_LIT.match(e):
        return int(e)
    if re.match(r"^-?\d+\.\d+$", e):
        return float(e)
    if e == "string.Empty":
        return ""
    if e.startswith('"') and e.endswith('"'):
        return e[1:-1]
    m = TEXT_CALL.match(e)
    if m and m.end() == len(e):
        d = {"text": m.group(1)}
        if m.group(2):
            d["params"] = {a: norm(b) for a, b in TEXT_PARAM.findall(m.group(2))}
        return d
    if e in textvars:
        return {"text_concat": textvars[e]}
    if e in dscvars:
        return dscvars[e]
    m = re.match(r'^\("([^"]*)" \+ (\d+) \+ "([^"]*)"\)$', e)
    if m:
        return m.group(1) + m.group(2) + m.group(3)
    return {"expr": e}


def parse_dsc(xml):
    """ConfigurationContainer XML -> job description."""
    xml = xml.encode().decode("unicode_escape") if "\\r\\n" in xml else xml
    xml = xml.replace('\\"', '"')
    try:
        root = ET.fromstring(xml.encode("utf-8"))
    except ET.ParseError as ex:
        return {"error": "xml: %s" % ex, "raw": xml[:200]}
    out = {}
    adapter = root.find("./Header/Adapter")
    if adapter is not None:
        out["adapter"] = adapter.get("Name")
        sub = adapter.find("./SubDeviceCollection/SubDevice")
        if sub is not None:
            out["device"] = sub.get("Name")
            out["no_device"] = sub.get("NoDeviceBehavior")
    conf = root.find("./Body/Configuration")
    if conf is None:
        return out
    out["config"] = conf.get("Name")
    execs = []
    for node in conf.iter("Node"):
        if node.get("{http://www.w3.org/2001/XMLSchema-instance}type") == "Executable":
            ex = {"job": node.get("Name")}
            args = OrderedDict()
            for arg in node.findall("./Children/Node[@Name='Argument']/Children/Node"):
                lit = arg.find("./Literal/*")
                args[arg.get("Name")] = (lit.text or "") if lit is not None else None
            if args:
                ex["args"] = args
            res = []
            for r in node.findall("./Result//Node"):
                if r.get("{http://www.w3.org/2001/XMLSchema-instance}type") == "Value":
                    res.append(r.get("Name"))
            if res:
                ex["results"] = res
            execs.append(ex)
    # path of the first executable (Group/D_MOTOR/VirtualVariantJob)
    path = []
    for node in conf.findall("./Run//Node"):
        if node.get("{http://www.w3.org/2001/XMLSchema-instance}type") in ("SingleChoice",):
            path.append(node.get("Name"))
    if path:
        out["path"] = path
    if execs:
        out["executables"] = execs
    # IMIB parametrisation summary
    param = conf.find("./Parametrization")
    if param is not None:
        fn = param.find(".//Node[@Name='Function']")
        rng = param.find(".//Node[@Name='Range']")
        out["measure"] = {
            "function": fn.get("DefaultChild") if fn is not None else None,
            "range": rng.get("DefaultChild") if rng is not None else None,
        }
        for v in param.iter("Node"):
            if v.get("Name") in ("Coupling", "Filter", "Mode"):
                lit = v.find("./Literal/*")
                out["measure"][v.get("Name").lower()] = lit.text if lit is not None else None
    return out


def lift(walker, start):
    """Collapse the raw event graph into typed step nodes."""
    ev = walker.events
    succ = {}
    for a, b, lab in walker.edges:
        succ.setdefault(a, []).append((b, lab))
    containers = {}   # container var -> OrderedDict of params (global over method; generated code fills right before use)
    textvars = {}
    dscvars = {}
    dialogs = {}      # dialog var -> dialog info
    # first pass: gather sets/dsc/dialogs by scanning events in creation order (creation order == walk order)
    for e in ev:
        k = e["kind"]
        if k == "set":
            containers.setdefault(e["container"], OrderedDict())[e["key"]] = e["value"]
        elif k == "dsc":
            dscvars[e["var"]] = parse_dsc(e["xml"])
        elif k == "override":
            d = dscvars.setdefault(e["var"], {})
            d.setdefault("overrides", OrderedDict())[e["path"]] = value_of(e["value"], textvars, dscvars)
        elif k == "dialog":
            dialogs[e["var"]] = e
        elif k == "assign" and ("__Text(" in e["rhs"] or "Concat" in e["rhs"]) and re.match(r"^(val|text)\d*$", e["lhs"]) and ".PlainText" not in e["rhs"]:
            textvars[e["lhs"]] = text_parts(e["rhs"], textvars)
        elif k == "concat":
            textvars.setdefault(e["var"], []).extend(text_parts(e["arg"], textvars))
    # second pass: build nodes
    nodes = {}
    order = []
    temps = {}        # temp var -> normalised rhs (generated code assigns each temp once per use)
    outvars = {}      # out container var -> dialog node id
    last_job = [None]
    def note_job_reads(expr):
        if last_job[0] is not None and last_job[0] in nodes:
            for p in re.findall(r'job_result\("([^"]+)"', expr):
                if p not in nodes[last_job[0]]["reads"]:
                    nodes[last_job[0]]["reads"].append(p)
    def subst(expr):
        for _ in range(4):
            new = re.sub(r"\b(num\d*|iSTAResultAsType\d*|obj\d*|flag\d*|text\d*|sELEKT\d*)\b", lambda m: "(%s)" % temps[m.group(1)] if m.group(1) in temps else m.group(1), expr)
            if new == expr:
                break
            expr = new
        expr = expr.strip()
        while expr.startswith("(") and expr.endswith(")") and Walker.balanced(expr[1:-1]):
            expr = expr[1:-1].strip()
        return expr
    assign_count = {}
    for e in ev:
        if e["kind"] == "assign" and TEMPVAR.match(e["lhs"]):
            assign_count[e["lhs"]] = assign_count.get(e["lhs"], 0) + 1
    for e in ev:
        k = e["kind"]
        n = None
        if k == "assign" and TEMPVAR.match(e["lhs"]) and e["lhs"] != "_":
            if assign_count.get(e["lhs"], 0) == 1:
                temps[e["lhs"]] = subst(e["rhs"])
                continue
            # multiply-assigned temp (loop counter etc.): keep it as a named variable,
            # except pure buffer set-up (new T[n] {...}) and temp-to-temp copies
            rhs0 = e["rhs"].strip()
            if rhs0.startswith("new ") or TEMPVAR.match(rhs0) or rhs0 == '""':
                continue
            n = {"type": "assign", "lhs": e["lhs"], "rhs": subst(e["rhs"])}
            n["id"] = e["id"]
            nodes[e["id"]] = n
            order.append(e["id"])
            continue
        if k == "invoke":
            d = dialogs.get(e["var"], {"ref": "MessageServiceDlg1", "step": None, "element": None, "in": e["in"], "inout": e["inout"]})
            params = OrderedDict((kk, value_of(v, textvars, dscvars)) for kk, v in containers.get(e["in"], {}).items())
            kind = DIALOG_KIND.get(d["ref"], "dialog")
            if d["ref"] == "MessageServiceDlg1":
                kind = "message"
            n = {"type": kind, "dialog_ref": d["ref"], "method": e["method"], "element": d.get("element"), "params": params, "out": e["out"], "reads": []}
            if e.get("inout") in containers:
                # some dialogs (the fault-list service among them) take their inputs in the inout container
                n["inout_params"] = OrderedDict((kk, value_of(v, textvars, dscvars)) for kk, v in containers[e["inout"]].items())
            if kind == "message" and e["method"] == "HideDialog":
                n["type"] = "hide_message"
            outvars[e["out"]] = e["id"]
            if e.get("inout"):
                outvars.setdefault(e["inout"], e["id"])
            if kind == "ecu_job":
                cfg = params.get("/WurzelIn/DSCConfig") or params.get("DSCConfig")
                if isinstance(cfg, dict):
                    for ex in cfg.get("executables", [])[:1]:
                        n["job"] = ex.get("job")
                        n["args"] = ex.get("args")
                        n["results"] = ex.get("results")
                    n["group_path"] = cfg.get("path")
                    n["overrides"] = cfg.get("overrides")
                    n["adapter"] = cfg.get("adapter")
                last_job[0] = e["id"]
            if kind == "measurement":
                cfg = params.get("DSCConfig1")
                if isinstance(cfg, dict):
                    n["device"] = cfg.get("device")
                    n["no_device"] = cfg.get("no_device")
                    n["measure"] = cfg.get("measure")
                    n["unit"] = params.get("Unit1")
        elif k == "submodule":
            params = OrderedDict((kk, value_of(v, textvars, dscvars)) for kk, v in containers.get(e["in"], {}).items())
            inout = OrderedDict((kk, value_of(v, textvars, dscvars)) for kk, v in containers.get(e["inout"], {}).items())
            n = {"type": "submodule", "ref": e.get("ref"), "name": e.get("name"), "params": params, "inout_params": inout, "out": e["out"], "inout": e["inout"], "reads": []}
            outvars[e["out"]] = e["id"]
            outvars[e["inout"]] = e["id"]
        elif k == "assign":
            if e["lhs"] in textvars or e["lhs"].startswith("val"):
                continue
            rhs = subst(e["rhs"])
            m = re.match(r"^(\w+)\.(\w+)$", rhs)
            if m and m.group(1) in outvars and m.group(1).startswith("val"):
                src = nodes.get(outvars[m.group(1)])
                if src is not None and m.group(2) not in src["reads"]:
                    src["reads"].append(m.group(2))
                if e["lhs"] == "_":
                    continue
                rhs = "out.%s" % m.group(2)
            elif e["lhs"] == "_":
                continue
            note_job_reads(rhs)
            n = {"type": "assign", "lhs": e["lhs"], "rhs": rhs}
        elif k == "branch":
            c = subst(e["cond"])
            note_job_reads(c)
            n = {"type": "branch", "cond": c}
        elif k == "switch":
            n = {"type": "switch", "expr": subst(e["expr"])}
            if e.get("labels"):
                n["labels"] = e["labels"]
        elif k == "call_step":
            n = {"type": "goto_step", "step": e["step"]}
        elif k == "end":
            n = {"type": "end"}
        elif k == "result":
            n = {"type": "result", "value": e["value"]}
        elif k == "document":
            n = {"type": "document", "action": e["action"], "arg": e["arg"]}
        elif k == "marker":
            n = {"type": e["what"].strip("_").lower()}
        elif k == "sleep":
            n = {"type": "sleep", "ms": e["ms"]}
        elif k == "suspicion":
            n = {"type": "suspicion", "what": e["what"], "arg": e["arg"]}
        elif k == "misc":
            n = {"type": "misc", "text": e["text"]}
        elif k == "error":
            n = {"type": "error", "text": e["text"]}
        if n is not None:
            n["id"] = e["id"]
            nodes[e["id"]] = n
            order.append(e["id"])
    # connect: for each node, find next lifted node(s) through 'point'/skipped events
    memo = {}
    sys.setrecursionlimit(max(sys.getrecursionlimit(), 20000))
    def nexts(i, visiting=None):
        """Lifted successors of node i, looking through 'point' nodes (memoised, cycle-safe)."""
        if i in memo:
            return memo[i]
        visiting = visiting if visiting is not None else set()
        if i in visiting:
            return []
        visiting.add(i)
        out = []
        for b, lab in succ.get(i, []):
            if b in nodes:
                out.append((b, lab))
            else:
                for bb, lab2 in nexts(b, visiting):
                    out.append((bb, lab if lab2 is None else lab2))
        visiting.discard(i)
        memo[i] = out
        return out
    for i in order:
        n = nodes[i]
        nx = nexts(i)
        if n["type"] in ("branch", "switch"):
            n["cases"] = OrderedDict()
            for b, lab in nx:
                lab = lab or "?"
                if lab in n["cases"] and n["cases"][lab] != b:
                    lab = lab + "'"
                n["cases"][lab] = b
            if n["type"] == "switch" and re.match(r"^\(?collectiveResult\d*\)?$", n["expr"]):
                n["expr"] = "CollectiveResult"
                n["cases"] = OrderedDict((COLLECTIVE.get(int(k), k) if k.lstrip("-").isdigit() else k, v) for k, v in n["cases"].items())
            if n["type"] == "switch" and n.get("labels"):
                # a switch on a string compiled to a dictionary index: show the strings
                merged = OrderedDict()
                for k, v in n["cases"].items():
                    lab = n["labels"].get(k, k)
                    merged[lab] = v
                n["cases"] = merged
                del n["labels"]
            if n["type"] == "branch":
                n["cond"] = n["cond"].replace("ResultSet.CollectiveResult", "CollectiveResult")
        else:
            uniq = []
            for b, _ in nx:
                if b not in uniq:
                    uniq.append(b)
            if len(uniq) == 1:
                n["next"] = uniq[0]
            elif uniq:
                n["next"] = uniq
    # entry
    entry = None
    for b, _ in nexts(start):
        entry = b
        break
    if start in nodes:
        entry = start
    exits = sorted({n["step"] for n in nodes.values() if n["type"] == "goto_step"})
    ends = any(n["type"] == "end" for n in nodes.values())
    return {"entry": entry, "exits": exits, "can_end": ends, "nodes": [nodes[i] for i in order]}


def text_parts(expr, textvars):
    e = norm(expr)
    parts = []
    for m in re.finditer(r"__Text\(\"(\d+)\"\)|__Text\(\)|\"([^\"]*)\"|\b(val\d*|text\d*)\b", e):
        if m.group(1):
            parts.append({"text": m.group(1)})
        elif m.group(2) is not None:
            if m.group(2) != "":
                parts.append(m.group(2))
            elif m.group(0) == '" "':
                parts.append(" ")
        elif m.group(3) and m.group(3) in textvars:
            parts.extend(textvars[m.group(3)])
    return parts

# ----------------------------------------------------------------------------
# 6. texts from the database
# ----------------------------------------------------------------------------

NS = {"spe": "http://bmw.com/2014/Spe_Text_2.0"}


class Texts:
    def __init__(self):
        self.db = sqlite3.connect(DIAGDOC)
        self.xv = sqlite3.connect(XMLVAL_EN)
        self.std_cache = {}

    def infoobject(self, identifier):
        row = self.db.execute("select ID, CONTROLID, TITLE_ENGB, PROGRAMTYPE, VERSIONNUMBER, USEDDEVICEADAPTERS from XEP_INFOOBJECTS where IDENTIFIER=?", (identifier,)).fetchone()
        if not row:
            return None
        d = {"id": row[0], "control_id": row[1], "title": row[2], "program_type": row[3], "version": row[4]}
        if row[5] and "SubDevice" in row[5]:
            d["devices"] = re.findall(r'SubDevice Name="([^"]+)" NoDeviceBehavior="([^"]+)"', row[5])
        return d

    def by_controlid(self, cid):
        row = self.db.execute("select IDENTIFIER, TITLE_ENGB from XEP_INFOOBJECTS where CONTROLID=?", (int(cid),)).fetchone()
        return {"identifier": row[0], "title": row[1]} if row else None

    def collection(self, infoobject_id):
        row = self.db.execute("select XML_ENGB from XEP_REFSPTEXTCOLL where INFOOBJECT_ID=?", (str(infoobject_id),)).fetchone()
        if not row:
            return {}
        r2 = self.xv.execute("select data from xmlvalueprimitive where id=? order by modified desc limit 1", (int(row[0]),)).fetchone()
        if not r2 or not r2[0]:
            return {}
        root = ET.fromstring(r2[0].encode("utf-8"))
        out = {}
        for ti in root.iter("{%s}TEXTITEM" % NS["spe"]):
            out[ti.get("ID")] = {"name": ti.get("NAME"), "en": self.render(ti)}
        return out

    def standard(self, cid):
        if cid in self.std_cache:
            return self.std_cache[cid]
        row = self.db.execute("select XML_ENGB from XEP_SPTEXTITEMS where CONTROLID=?", (int(cid),)).fetchone()
        txt = None
        if row and row[0]:
            try:
                txt = self.render(ET.fromstring(row[0].encode("utf-8")))
            except ET.ParseError:
                txt = row[0]
        self.std_cache[cid] = txt
        return txt

    def render(self, el):
        """Flatten a spe text element to plain text with {param} placeholders."""
        tag = el.tag.split("}")[-1]
        out = []
        if tag == "STANDARDTEXT":
            t = self.standard(el.get("ID"))
            out.append(t if t is not None else "[%s]" % el.get("TITLE"))
        elif tag == "PARAMETER":
            out.append("{%s}" % el.get("ID"))
        elif tag == "UNIT":
            out.append(" " + (el.get("REF") or ""))
        elif tag == "SYMBOL":
            out.append(el.get("REF") or "")
        elif tag == "DIAGCODE":
            out.append("[diagcode %s: %s]" % (el.get("ID"), el.get("TITLE")))
        if el.text and el.text.strip() and tag not in ("STANDARDTEXT", "PARAMETER", "UNIT", "SYMBOL", "DIAGCODE"):
            out.append(el.text)
        for ch in el:
            ctag = ch.tag.split("}")[-1]
            if ctag == "LISTENTRY":
                out.append("\n- ")
            elif ctag == "HINT":
                out.append("\nNote: ")
            out.append(self.render(ch))
            if ctag in ("PARAGRAPH",):
                out.append("\n")
            if ch.tail and ch.tail.strip():
                out.append(ch.tail)
        s = "".join(out)
        if tag in ("TEXTITEM", "SIMPLE_TEXTITEM"):
            s = re.sub(r"[ \t]*\n[ \t]*", "\n", s)
            s = re.sub(r"\n{3,}", "\n\n", s).strip()
        return s

# ----------------------------------------------------------------------------
# driver
# ----------------------------------------------------------------------------

def walk_module(cs_path, want_walkers=False):
    with open(cs_path, encoding="utf-8", errors="replace") as fh:
        src = fh.read()
    cls, fields, methods = split_methods(src)
    steps = OrderedDict()
    walkers = {}
    diag = {"methods": len(methods), "parse_errors": []}
    for name, (params, body) in methods.items():
        try:
            tree = parse_method(body)
            fl = Flat()
            fl.flatten(tree)
            ins = fl.resolve()
            w = Walker(ins, name)
            start = w.run()
            steps[name] = lift(w, start)
            steps[name]["instructions"] = len(ins)
            steps[name]["raw_events"] = len(w.events)
            walkers[name] = w
        except Exception as ex:  # noqa
            diag["parse_errors"].append({"method": name, "error": "%s: %s" % (type(ex).__name__, ex)})
            steps[name] = {"error": str(ex)}
    variables = OrderedDict()
    for f in fields:
        m = re.match(r"public ([\w\[\]<>\.]+) (\w+);", f)
        if m:
            variables[m.group(2)] = m.group(1)
    if want_walkers:
        return cls, variables, steps, diag, walkers
    return cls, variables, steps, diag


def collect_text_ids(obj, acc):
    if isinstance(obj, dict):
        if "text" in obj and isinstance(obj["text"], str) and obj["text"].isdigit():
            acc.add(obj["text"])
        for v in obj.values():
            collect_text_ids(v, acc)
    elif isinstance(obj, list):
        for v in obj:
            collect_text_ids(v, acc)
    elif isinstance(obj, str):
        for m in re.finditer(r"__Text\(\"(\d+)\"", obj):
            acc.add(m.group(1))


def summarize(steps):
    kinds = {}
    dialog_refs = {}
    jobs = []
    for sname, st in steps.items():
        for n in st.get("nodes", []):
            kinds[n["type"]] = kinds.get(n["type"], 0) + 1
            if "dialog_ref" in n:
                dialog_refs[n["dialog_ref"]] = dialog_refs.get(n["dialog_ref"], 0) + 1
            if n["type"] == "ecu_job":
                cfg = n["params"].get("/WurzelIn/DSCConfig") or n["params"].get("DSCConfig")
                if isinstance(cfg, dict):
                    for ex in cfg.get("executables", []):
                        jobs.append({"step": sname, "job": ex.get("job"), "args": ex.get("args"), "results": ex.get("results"), "overrides": cfg.get("overrides")})
    return {"node_kinds": kinds, "dialog_refs": dialog_refs, "jobs": jobs}


def identifier_of(name):
    """DLL/class name -> XEP_INFOOBJECTS.IDENTIFIER (the first two underscores are hyphens)."""
    return re.sub(r"^ABL_(\w+?)_", r"ABL-\1-", name)


def extract_module(cs_path, texts=None, dll=None, chassis=None):
    """Full recovery of one module. `texts` is a Texts instance or None (no database)."""
    name = os.path.splitext(os.path.basename(cs_path))[0]
    if name.endswith(".decompiled"):
        name = name[: -len(".decompiled")]
    cls, variables, steps, diag, walkers = walk_module(cs_path, want_walkers=True)
    result = OrderedDict()
    result["module"] = name
    result["class"] = cls
    identifier = identifier_of(name)
    result["identifier"] = identifier
    if texts is not None:
        io = texts.infoobject(identifier)
        result["infoobject"] = io
        coll = texts.collection(io["id"]) if io else {}
        ids = set()
        collect_text_ids(steps, ids)
        result["texts"] = OrderedDict((i, coll.get(i, {"name": None, "en": None, "missing": True})) for i in sorted(ids))
        result["texts_missing"] = sorted(i for i in ids if i not in coll)

        def inline(obj):
            if isinstance(obj, dict):
                if "text" in obj and isinstance(obj["text"], str) and obj["text"] in coll:
                    obj["en"] = coll[obj["text"]]["en"]
                    obj["name"] = coll[obj["text"]]["name"]
                for v in obj.values():
                    inline(v)
            elif isinstance(obj, list):
                for v in obj:
                    inline(v)
        inline(steps)
        for st in steps.values():
            for n in st.get("nodes", []):
                if n["type"] == "submodule" and n.get("ref"):
                    n["module"] = texts.by_controlid(n["ref"])
                if n["type"] == "assign":
                    m = re.match(r'^__Text"(\d+)"\.TextContent\.PlainText$', n["rhs"]) or re.match(r'^__Text\("(\d+)"\)\.TextContent\.PlainText$', n["rhs"])
                    if m and m.group(1) in coll:
                        n["rhs_en"] = coll[m.group(1)]["en"]
    result["variables"] = variables
    result["entry"] = "Start"
    order, seen, stack = [], set(), ["Start"]
    while stack:
        s = stack.pop(0)
        if s in seen or s not in steps:
            continue
        seen.add(s)
        order.append(s)
        stack.extend(steps[s].get("exits", []))
    result["step_order"] = order
    result["unreached_steps"] = [s for s in steps if s not in seen and s not in ("run", "Prepare", "Reset", cls)]
    result["steps"] = steps
    result["summary"] = summarize(steps)
    result["diagnostics"] = diag
    # additive fields (see ABL_FORMAT.md)
    findings = validate(cs_path, cls, steps, walkers)
    error_nodes = [(sn, n["text"]) for sn, st in steps.items() for n in st.get("nodes", []) if n["type"] == "error"]
    for sn, txt in error_nodes:
        findings.append({"step": sn, "reason": "error", "detail": txt})
    for pe in diag["parse_errors"]:
        findings.append({"step": pe["method"], "reason": "error", "detail": pe["error"]})
    result["findings"] = findings
    result["dead_steps"] = [f["step"] for f in findings if f["reason"] in DEAD_REASONS]
    result["complete"] = not any(f["reason"] in ("pruned", "unknown", "error") for f in findings)
    result["chassis"] = list(chassis or [])
    result["dll"] = dll or (name + ".dll")
    result["tool"] = TOOL_VERSION
    return result


def main(argv):
    if not argv:
        print(__doc__)
        return 1
    path = argv[0]
    out = None
    use_db = "--no-db" not in argv
    if "--out" in argv:
        out = argv[argv.index("--out") + 1]
    cs_dir = argv[argv.index("--cs-dir") + 1] if "--cs-dir" in argv else os.path.join(HERE, "cs")
    cs = path if path.endswith(".cs") else decompile(path, cs_dir)
    tx = Texts() if use_db else None
    result = extract_module(cs, tx, dll=os.path.basename(path) if path.endswith(".dll") else None)
    js = json.dumps(result, indent=1, ensure_ascii=False)
    if out:
        with open(out, "w") as fh:
            fh.write(js)
        print("%s: %s, %d steps, complete=%s, findings=%d" % (result["module"], (result.get("infoobject") or {}).get("title"), len(result["step_order"]), result["complete"], len(result["findings"])))
    else:
        print(js)
    return 0 if result["complete"] else 2




# ----------------------------------------------------------------------------
# 7. completeness validator
# ----------------------------------------------------------------------------

def validate(cs_path, cls, steps, walkers):
    """Classify every step that is not reachable from Start.

    Returns a list of {step, reason, detail}. `reason` is one of
      never-called            no method contains a call to the step (template leftover)
      exit-never-produced     the step is called only under `case k:` of an exit switch whose register
                              never takes the value k in that method (the flow wires the exit but no
                              ReturnStatement uses it)
      pruned                  the call site exists in reachable code and the exit value is produced, yet
                              the walker did not reach it: a genuine recovery gap
    """
    with open(cs_path, encoding="utf-8", errors="replace") as fh:
        src = fh.read()
    _, _, methods = split_methods(src)
    order, seen, stack = [], set(), ["Start"]
    while stack:
        s = stack.pop(0)
        if s in seen or s not in steps:
            continue
        seen.add(s)
        order.append(s)
        stack.extend(steps[s].get("exits", []))
    findings = []
    for s in steps:
        if s in seen or s in ("run", "Prepare", "Reset", cls):
            continue
        callers = [m for m, (p, body) in methods.items() if any(re.search(r"\b%s\(\);" % re.escape(s), l) for l in body)]
        if not callers:
            findings.append({"step": s, "reason": "never-called", "detail": ""})
            continue
        reasons = []
        for m in callers:
            w = walkers.get(m)
            if w is None:
                reasons.append((m, "caller-not-walked"))
                continue
            ins = w.ins
            sites = [i for i, (op, arg) in enumerate(ins) if op == "stmt" and re.match(r"^%s\(\);$" % re.escape(s), arg)]
            for site in sites:
                if site in w.trace:
                    if m in seen:
                        reasons.append((m, "executed", "call executed in reachable %s but not lifted" % m))
                    else:
                        reasons.append((m, "caller-unreached", "called from unreached step %s" % m))
                    continue
                # which switch case leads here?
                feeding = None
                for i, (op, arg) in enumerate(ins):
                    if op == "switch":
                        for k, t in arg[1].items():
                            if t <= site <= t + 2:
                                feeding = (i, arg[0].strip("()"), k)
                if feeding is None:
                    reasons.append((m, "call-site-unreached"))
                    continue
                i, reg, k = feeding
                # the register may be a copy of the exit register `num`; a value is "produced" by a literal
                # assignment, a ternary arm, or any data-driven load
                srcs = {reg}
                for _ in range(3):
                    for op, arg in ins:
                        mm = COPYVAR.match(arg) if op == "stmt" else None
                        if mm and mm.group(1) in srcs:
                            srcs.add(mm.group(2))
                alt = "|".join(map(re.escape, srcs))
                lit = re.compile(r"^(int )?(%s) = %s;$" % (alt, re.escape(k)))
                tern = re.compile(r"^(int )?(%s) = \(?.+? \? (-?\d+) : (-?\d+)\)?;$" % alt)
                producers = []
                for pc_, (op, arg) in enumerate(ins):
                    if op != "stmt":
                        continue
                    if lit.match(arg):
                        producers.append(pc_)
                        continue
                    mt = tern.match(arg)
                    if mt and k in (mt.group(3), mt.group(4)):
                        producers.append(pc_)
                data_driven = any(r in w.origin or r in w.data_regs for r in srcs)
                seen_values = w.dispatched.get(i, set())
                if not producers and not data_driven:
                    reasons.append((m, "exit-never-produced", "%s never == %s in %s" % (reg, k, m)))
                elif k not in seen_values and "*" not in seen_values:
                    # the flow contains an assignment of the value but no walked path carries it to the
                    # exit switch (over-written, or only reachable through an unreachable case)
                    reasons.append((m, "exit-not-executed", "%s = %s never reaches the exit switch of %s (values seen: %s)" % (reg, k, m, ",".join(sorted(seen_values)) or "none")))
                elif m in seen:
                    reasons.append((m, "pruned", "%s == %s in %s" % (reg, k, m)))
                else:
                    reasons.append((m, "caller-unreached", m))
        kinds = {r[1] for r in reasons}
        det = "; ".join(r[2] for r in reasons if len(r) > 2)
        dead_kinds = {"exit-never-produced", "exit-not-executed", "caller-unreached", "call-site-unreached"}
        if "pruned" in kinds or "executed" in kinds:
            findings.append({"step": s, "reason": "pruned", "detail": det})
        elif kinds <= dead_kinds:
            for reason in ("exit-never-produced", "exit-not-executed", "caller-unreached", "call-site-unreached"):
                if reason in kinds:
                    findings.append({"step": s, "reason": reason, "detail": det})
                    break
        else:
            findings.append({"step": s, "reason": "unknown", "detail": str(reasons)[:200]})
    return findings


DEAD_REASONS = ("never-called", "exit-never-produced", "exit-not-executed", "caller-unreached", "call-site-unreached")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
