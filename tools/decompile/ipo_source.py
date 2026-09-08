#!/usr/bin/env python3
"""`.IPO` -> INPA source (`.SRC`): the script the way its author wrote it.

ipo_disasm.py reads the bytecode and names every token; ipo_compile.py
round-trips the bytes through an assembly text. This goes one level up and
writes the C-like INPA language BMW's authors used (MUST_EXX.SRC is the
shipped example): globals with their initialisers, `MENU` / `ITEM` / `INIT`,
`SCREEN` / `LINE`, functions with `in:` / `out:` parameters, `if` / `else` /
`while`, infix expressions, calls with their arguments, `#include` lines.

What the compiler kept and what it threw away decides what comes back:

    kept     proc names, ITEM numbers and captions, LINE captions and key
             lists, every literal, local types, the include list, the DLL
             import table (dllcall #n is the n-th signature in Constant
             Data), the global initialisers (compiled into
             __inpa_startup__, read back here as `type name = value;`)
    lost     variable names (slot numbers only), comments, layout
    recovered anyway
             globals declared by an included header keep their names, in
             slot order (BMW_STD.H's GlobalBuffer, CR, LF, CRLF, HT ...);
             a function the header also defines takes its parameter and
             local names from there; other slots are named by type and
             number (s7, i12, b15 ...). Parameter types come from the
             builtin prototypes in Inpa.h and the other headers
             (`extern midstr(out: string ResultStr, ...)`) whenever a
             parameter is handed straight to one, else from how it is used.

Control flow is rebuilt from the jump shapes the compiler emits:
    cond stmt jfalse->END                       if
    cond stmt jfalse->ELSE ... jump->END ELSE   if / else
    L: cond stmt jfalse->END ... jump->L        while
Anything else (a jump that fits no shape) stays as a `goto` comment with
the target, so nothing is silently dropped.

State machines (34 scripts) are emitted with their `%STATE` labels as
section markers; their in-state jumps are best-effort.

    python3 tools/decompile/ipo_source.py E46              # -> stdout
    python3 tools/decompile/ipo_source.py E46 -o e46.src
    python3 tools/decompile/ipo_source.py --corpus         # every .IPO: stats
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ipo_disasm as D                                          # noqa: E402
import ipo_codec as C                                           # noqa: E402
import ipo_screens as L1                                        # noqa: E402

# ------------------------------------------------------------ constants ----

# operator text and precedence (C's), by the disassembler's binop names
BINOP_TEXT = {
    "add": ("+", 6), "sub": ("-", 6), "mul": ("*", 7), "div": ("/", 7),
    "lt": ("<", 5), "gt": (">", 5), "le": ("<=", 5), "ge": (">=", 5),
    "eq": ("==", 4), "ne": ("!=", 4),
    "and": ("&&", 2), "or": ("||", 1), "xor": ("^^", 1),
    "band": ("&", 3), "bor": ("|", 3), "bxor": ("^", 3),
}
UNOP_TEXT = {"neg": "-", "not": "!"}
PREC_UNARY = 9
PREC_ATOM = 10

# the codec's value-type codes of the global slot table
VT_TEXT = {1: "bool", 2: "byte", 3: "int", 4: "long", 5: "real", 6: "string"}
# a literal's pool type letter -> declared type
LIT_TYPE = {"b": "bool", "y": "byte", "i": "int", "l": "long", "d": "real",
            "s": "string"}
# short names by type for slots nothing else names
TYPE_PREFIX = {"bool": "b", "byte": "y", "int": "i", "long": "l",
               "real": "r", "string": "s"}
# procref kinds -> the declaration table the id indexes
REF_KIND = {0x40: "screen", 0x41: "menu", 0x3e: "state", 0x3f: "statemachine",
            0x42: "state", 0x43: "statemachine"}
# numbered builtins the disassembler leaves as builtin_xx, named by their
# Inpa.h prototype (matched through the runtime's own table)
BUILTIN_ALIASES = {
    "builtin_09": "settimer", "builtin_0a": "testtimer",
    "builtin_12": "control", "builtin_14": "stop",
    "builtin_15": "getapistring", "builtin_16": "togglelist",
    "builtin_1a": "setcolor", "builtin_21": "stringtoint",
    "builtin_22": "hexconvert", "builtin_23": "strcat",
    "builtin_47": "input2int", "builtin_51": "blankscreen",
    "builtin_57": "userboxclear", "builtin_58": "userboxsetcolor",
    "builtin_74": "INP1apiResultReal",
}
GLOBAL, LOCAL = 0, 2
INDENT = "  "
STARTUP, SHUTDOWN = "__inpa_startup__", "__inpa_shutdown__"
SGDAT = os.path.join(os.path.dirname(os.path.dirname(HERE)),
                     "vendor", "EC-APPS", "INPA", "SGDAT")

# ------------------------------------------------------------ headers ------


def _read_text(path):
    with open(path, "rb") as f:
        return f.read().decode("cp1252", "replace")


def _find_in_sgdat(name):
    """A header by its include name, case-insensitively, or None."""
    if not os.path.isdir(SGDAT):
        return None
    low = name.lower()
    for f in os.listdir(SGDAT):
        if f.lower() == low:
            return os.path.join(SGDAT, f)
    return None


_PROTO = re.compile(
    r"(?:extern|import\s+\w+\s+lib\s+\"[^\"]*\")\s+(\w+)\s*\((.*?)\)\s*;",
    re.S)
_PARAM = re.compile(r"(in|out|inout)\s*:\s*(\w+)\s+(\w+)")
_GLOBAL = re.compile(
    r"^\s*(bool|byte|int|long|real|string)\s+(\w+)\s*(?:=\s*([^;/]+?))?\s*;",
    re.M)
_FUNCDEF = re.compile(r"^(\w+)\s*\(([^)]*)\)\s*\{", re.M)
_LOCALDEF = re.compile(
    r"^\s*(bool|byte|int|long|real|string)\s+(\w+)\s*(?:=\s*[^;]+)?;", re.M)


def _strip_comments(text):
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"//[^\n]*", "", text)


class Headers:
    """What the included headers declare: builtin prototypes (parameter
    modes and types), the globals they add (in slot order) and the bodies
    of the functions they define (parameter and local names)."""

    def __init__(self, includes):
        self.protos = {}      # name -> [(mode, type, name)]
        self.globals = []     # (type, name, init) in declaration order
        self.funcs = {}       # name -> {"params": [(mode,type,name)], "locals": [(type,name)]}
        seen = set()
        for inc in includes:
            self._load(inc, seen)

    def _load(self, inc, seen):
        path = _find_in_sgdat(inc)
        if not path or path in seen:
            return
        seen.add(path)
        text = _strip_comments(_read_text(path))
        # nested includes first: their globals sit before this file's
        for m in re.finditer(r"#include\s+\"([^\"]+)\"", text):
            self._load(m.group(1), seen)
        for m in _PROTO.finditer(text):
            self.protos[m.group(1)] = [
                (p.group(1), p.group(2), p.group(3))
                for p in _PARAM.finditer(m.group(2))]
        # top-level globals: declarations outside any brace
        depth = 0
        for line in text.split("\n"):
            if depth == 0:
                g = _GLOBAL.match(line)
                if g:
                    self.globals.append((g.group(1), g.group(2),
                                         (g.group(3) or "").strip()))
            depth += line.count("{") - line.count("}")
        for m in _FUNCDEF.finditer(text):
            name = m.group(1)
            if name in ("if", "while", "for", "switch"):
                continue
            body = text[m.end():]
            close = body.find("\n}")
            body = body[:close] if close >= 0 else body[:4000]
            self.funcs[name] = {
                "params": [(p.group(1), p.group(2), p.group(3))
                           for p in _PARAM.finditer(m.group(2))],
                "locals": [(l.group(1), l.group(2))
                           for l in _LOCALDEF.finditer(body)],
            }


# ------------------------------------------------------------ file -------


class Source:
    """One script's declarations, tokens and names."""

    def __init__(self, ecu):
        self.ecu = ecu
        self.data, self.ps, self.pool, self.decls = D.load(ecu)
        self.notes = []
        try:
            self.file = C.read(self.data)
        except C.IpoError as e:
            # the strict container reader rejects some dialects (inline
            # strings, odd pool types); the tokens still decode, so go on
            # with what the tokens alone say
            self.file = None
            self.notes.append(f"container not fully parsed ({e}): global "
                              "types inferred from use, imports unnamed")
        gb = self.file.globals_block() if self.file else None
        self.global_types = list(gb.globals()) if gb else []
        cb = self.file.constants_block() if self.file else None
        consts = list(cb.constants()) if cb else []
        self.includes, self.imports = self._constant_data(consts)
        if not self.file:
            self.includes = self._includes_from_bytes()
        self.headers = Headers(self.includes)
        self.id2name = {(typ, pid): name for _, typ, name, pid in self.decls}
        self.procs = self._walk_all()
        for p in self.procs:
            for t in p["toks"]:
                if t["op"] == "state":
                    self.id2name.setdefault(("state", t["index"]),
                                            t["name"].lstrip("%"))
        if not self.global_types:
            self.global_types = self._global_types_from_use()
        self.global_names, self.global_inits = self._globals()

    @staticmethod
    def _constant_data(consts):
        """The leading include names and the DLL import signatures, by
        their index (dllcall #n names entry n)."""
        includes = []
        for t, v in consts:
            if t != 6:
                break
            includes.append(v.decode("latin-1"))
        imports = {}
        for i, (t, v) in enumerate(consts):
            if t == 6 and b"::" in v and b"%" in v:
                sig = v.decode("latin-1")
                # "kernel32::GetCurrentDirectoryA:c.lS%I" -> the function
                fn = sig.split("::", 1)[1].split(":", 1)[0]
                imports[i] = fn
        return includes, imports

    def _includes_from_bytes(self):
        """The include names as the Constant Data region lists them, when
        the container reader could not: the strings right after the
        `12 "Constant Data"` marker."""
        m = self.data.find(b"\x12Constant Data\x0a")
        if m < 0:
            return []
        out = []
        i = m + len(b"\x12Constant Data\x0a")
        while i < len(self.data) and self.data[i] == 6:
            j = self.data.find(b"\x0a", i + 1)
            if j < 0:
                break
            out.append(self.data[i + 1:j].decode("latin-1"))
            i = j + 1
        return out

    def _global_types_from_use(self):
        """Global slot types from the literals stored into them, int
        otherwise, for a file whose slot table did not parse."""
        top = 0
        types = {}
        for p in self.procs:
            toks = p["toks"]
            for i, t in enumerate(toks):
                if t["op"] in ("var", "store", "procref") and \
                        t.get("sc", t.get("kind")) == GLOBAL:
                    top = max(top, t["n"])
                if t["op"] == "store" and t.get("sc") == GLOBAL and i > 0 \
                        and toks[i - 1]["op"] == "const":
                    types.setdefault(t["n"], LIT_TYPE.get(toks[i - 1]["t"], "int"))
        inv = {v: k for k, v in VT_TEXT.items()}
        return [0] + [inv.get(types.get(s, "int"), 3) for s in range(1, top + 1)]

    def _walk_all(self):
        procs = []
        for k, (off, typ, name, pid) in enumerate(self.decls):
            lo = D.body_start(self.data, off, name)
            hi = self.decls[k + 1][0] if k + 1 < len(self.decls) else (
                self.ps if self.ps is not None else D.code_end(self.data, None))
            toks, unk, ln = D.walk(self.data, lo, hi, self.pool)
            procs.append({"typ": typ, "name": name, "id": pid, "lo": lo,
                          "hi": hi, "toks": toks, "unknown": unk, "len": ln})
        return procs

    def _globals(self):
        """Names for the global slots (the headers' own, then by type) and
        the initialisers the compiler put into __inpa_startup__."""
        names = {}
        hdr = self.headers.globals
        # slot 0 is the void slot; header globals follow in order
        for k, (typ, name, _init) in enumerate(hdr):
            slot = k + 1
            if slot < len(self.global_types) and \
                    VT_TEXT.get(self.global_types[slot]) == typ:
                names[slot] = name
            else:
                break
        inits = {}
        st = next((p for p in self.procs if p["name"] == STARTUP), None)
        if st:
            toks = st["toks"]
            for i, t in enumerate(toks):
                if t["op"] == "store" and t.get("sc") == GLOBAL and i > 0 \
                        and toks[i - 1]["op"] == "const":
                    inits[t["n"]] = toks[i - 1]
        for slot, vt in enumerate(self.global_types):
            if slot == 0 or slot in names:
                continue
            typ = VT_TEXT.get(vt, "int")
            names[slot] = f"g{TYPE_PREFIX.get(typ, 'v')}{slot}"
        return names, inits

    # -------------------------------------------------------- emit -----

    def emit(self):
        out = []
        out.append(f"// {self.ecu}.IPO decompiled to INPA source by "
                   f"tools/decompile/ipo_source.py")
        out.append("// names of the script's own variables are not in the "
                   "file: slots are named by type and number")
        for inc in self.includes:
            out.append(f'#include "{inc}"')
        out.append("")
        # globals the headers did not declare (theirs come with the include)
        hdr_count = sum(1 for slot in range(1, len(self.global_types))
                        if slot in self.global_names and
                        not re.match(r"^g[a-z]\d+$", self.global_names[slot]))
        own = [s for s in range(1, len(self.global_types))
               if s not in self.global_names or
               re.match(r"^g[a-z]\d+$", self.global_names[s])]
        if own:
            out.append("// globals of this script (the included headers "
                       f"declare the first {hdr_count})")
            for slot in own:
                typ = VT_TEXT.get(self.global_types[slot], "int")
                init = self.global_inits.get(slot)
                line = f"{typ:<7}{self.global_names[slot]}"
                if init is not None:
                    line += f" = {self.literal(init)}"
                out.append(line + ";")
            out.append("")
        for p in self.procs:
            if p["name"] in (STARTUP, SHUTDOWN):
                continue
            out.extend(self.emit_proc(p))
            out.append("")
        if self.notes:
            out.append("// decompiler notes:")
            out.extend(f"//   {n}" for n in self.notes)
        return "\n".join(out) + "\n"

    def emit_proc(self, p):
        typ, name, toks = p["typ"], p["name"], p["toks"]
        fn = Function(self, p)
        if typ == "func":
            return fn.emit_function()
        if typ == "menu":
            return fn.emit_menu()
        if typ == "screen":
            return fn.emit_screen()
        return fn.emit_statemachine()

    # -------------------------------------------------------- names ----

    def literal(self, t):
        v, ty = t.get("v"), t.get("t")
        if ty == "?":
            # a dialect whose literals the pool reader could not place: the
            # pool index is all there is
            return f"__const_{t.get('n')}"
        if ty == "s":
            return '"' + str(v).replace("\\", "\\\\").replace('"', '\\"') + '"'
        if ty == "b":
            return "TRUE" if v else "FALSE"
        if ty == "d":
            s = repr(float(v))
            return s if "." in s or "e" in s else s + ".0"
        return str(v)

    def ref_name(self, t):
        kind = t.get("kind")
        n = t.get("n")
        if kind == GLOBAL:
            return self.global_names.get(n, f"g{n}")
        if kind == LOCAL:
            return None      # the function resolves its own slots
        table = REF_KIND.get(kind)
        for tb in ([table] if table else []) + \
                ["screen", "menu", "state", "statemachine"]:
            nm = self.id2name.get((tb, n))
            if nm:
                return nm
        return f"__ref_{kind:02x}_{n}"


# ------------------------------------------------------------ function ---


class Function:
    """One proc's tokens -> source lines."""

    def __init__(self, src, p):
        self.src = src
        self.p = p
        self.toks = p["toks"]
        self.at = {t["at"]: i for i, t in enumerate(self.toks)}
        # the byte after the last token: a jump there leaves the body
        if self.toks:
            self.at.setdefault(self.toks[-1]["at"] + 4, len(self.toks))
            self.at.setdefault(p["hi"], len(self.toks))
        self.locals = {}          # slot -> (type, name)
        self.params = []          # (mode, type, name, slot)
        self.gotos = 0
        self._scan_slots()

    # ---------------------------------------------------- slots ------

    def _scan_slots(self):
        """Parameters and locals: the prologue declares the locals in
        order (a `decl`, or a bare literal push for an initialised one);
        every lower slot is a parameter."""
        toks = self.toks
        i = 1 if toks and toks[0]["op"] == "block" else 0
        prologue = []
        while i < len(toks):
            t = toks[i]
            if t["op"] == "decl":
                prologue.append(("decl", t["type"]))
            elif t["op"] == "const" and i + 1 < len(toks) and \
                    toks[i + 1]["op"] in ("const", "decl") or \
                    (t["op"] == "const" and self._prologue_const_end(i)):
                prologue.append(("init", LIT_TYPE.get(t["t"], "int"), t))
            else:
                break
            i += 1
        self.prologue_end = i
        used = [t["n"] for t in toks if t["op"] in ("var", "store")
                and t.get("sc") == LOCAL]
        refd = {t["n"] for t in toks if t["op"] in ("var", "store")
                and t.get("sc") == LOCAL and t.get("ref")}
        refd |= {t["n"] for t in toks
                 if t["op"] == "procref" and t.get("kind") == LOCAL}
        max_slot = max(used) if used else -1
        n_params = max(0, max_slot + 1 - len(prologue))
        if prologue and max_slot + 1 - len(prologue) < 0:
            n_params = 0
        hdr = self.src.headers.funcs.get(self.p["name"])
        hdr_params = hdr["params"] if hdr else []
        hdr_locals = hdr["locals"] if hdr else []
        if hdr and len(hdr_params) != n_params:
            hdr_params, hdr_locals = [], []
        types = self._infer_types(n_params)
        for k in range(n_params):
            mode = "inout" if k in refd else "in"
            if k < len(hdr_params):
                mode, typ, name = hdr_params[k]
            else:
                typ = types.get(k, "int")
                name = f"p{TYPE_PREFIX.get(typ, 'v')}{k}"
            self.params.append((mode, typ, name, k))
        slot = n_params
        for k, entry in enumerate(prologue):
            typ = entry[1]
            if k < len(hdr_locals) and hdr_locals[k][0] == typ:
                name = hdr_locals[k][1]
            else:
                name = f"{TYPE_PREFIX.get(typ, 'v')}{slot}"
            init = entry[2] if entry[0] == "init" else None
            self.locals[slot] = (typ, name, init)
            slot += 1
        # a slot the prologue did not declare (a lifted proc, a param
        # miscount): still needs a name
        for s in sorted(set(used)):
            if s >= n_params and s not in self.locals:
                self.locals[s] = (types.get(s, "int"),
                                  f"{TYPE_PREFIX.get(types.get(s, 'int'), 'v')}{s}",
                                  None)

    def _prologue_const_end(self, i):
        """A literal at the prologue's end initialises the last local only
        when the next token does not consume it (a store would)."""
        nxt = self.toks[i + 1]["op"] if i + 1 < len(self.toks) else None
        return nxt in ("frame", "stmt", "ret", "ITEM", "LINE", "state")

    def _infer_types(self, n_params):
        """A slot's type from how it is used: the literal it meets in an
        expression, or the builtin prototype it is handed to."""
        types = {}
        toks = self.toks
        # literal partners in binops: var const binop / const var binop
        for i, t in enumerate(toks):
            if t["op"] != "binop" or i < 2:
                continue
            a, b = toks[i - 2], toks[i - 1]
            for x, y in ((a, b), (b, a)):
                if x["op"] == "var" and x.get("sc") == LOCAL and \
                        y["op"] == "const" and x["n"] not in types:
                    types[x["n"]] = LIT_TYPE.get(y["t"], "int")
        # prototypes: the arguments between a frame and its call
        for i, t in enumerate(toks):
            if t["op"] not in ("call",):
                continue
            proto = self.src.headers.protos.get(t["name"])
            if not proto:
                continue
            j = i - 1
            args = []
            while j >= 0 and toks[j]["op"] != "frame":
                args.append(toks[j])
                j -= 1
            args.reverse()
            if len(args) != len(proto):
                continue
            for arg, (_mode, ptype, _pname) in zip(args, proto):
                if arg["op"] in ("var", "procref") and arg.get("sc", arg.get("kind")) == LOCAL:
                    ptype = ptype.lower()
                    if ptype in TYPE_PREFIX and arg["n"] not in types:
                        types[arg["n"]] = ptype
        for i, t in enumerate(toks):
            if t["op"] == "store" and t.get("sc") == LOCAL and i > 0 and \
                    toks[i - 1]["op"] == "const" and t["n"] not in types:
                types[t["n"]] = LIT_TYPE.get(toks[i - 1]["t"], "int")
        return types

    def slot_name(self, t):
        if t.get("sc") == GLOBAL or t.get("kind") == GLOBAL:
            return self.src.global_names.get(t["n"], f"g{t['n']}")
        n = t["n"]
        for _mode, _typ, name, slot in self.params:
            if slot == n:
                return name
        if n in self.locals:
            return self.locals[n][1]
        return f"v{n}"

    # ---------------------------------------------------- bodies -----

    def emit_function(self):
        params = ", ".join(f"{m}: {t} {n}" for m, t, n, _ in self.params)
        lines = [f"{self.p['name']}({params})", "{"]
        lines.extend(self.local_decls())
        body = self.block(self.prologue_end, len(self.toks), 1)
        lines.extend(body)
        lines.append("}")
        return lines

    def local_decls(self):
        out = []
        for slot in sorted(self.locals):
            typ, name, init = self.locals[slot]
            line = f"{INDENT}{typ:<7}{name}"
            if init is not None:
                line += f" = {self.src.literal(init)}"
            out.append(line + ";")
        if out:
            out.append("")
        return out

    def emit_menu(self):
        toks = self.toks
        lines = [f"MENU {self.p['name']}()", "{"]
        # INIT: everything before the first ITEM
        first_item = next((i for i, t in enumerate(toks) if t["op"] == "ITEM"),
                          len(toks))
        init = self.block(self.prologue_end, first_item, 2)
        if init:
            lines.append(f"{INDENT}INIT {{")
            lines.extend(init)
            lines.append(f"{INDENT}}}")
        i = first_item
        while i < len(toks):
            t = toks[i]
            if t["op"] != "ITEM":
                i += 1
                continue
            end = next((j for j in range(i + 1, len(toks))
                        if toks[j]["op"] == "ITEM"), len(toks))
            label = self.src.literal({"t": "s", "v": t.get("label", "")})
            lines.append(f"{INDENT}ITEM({t['nr']}, {label})")
            lines.append(f"{INDENT}{{")
            lines.extend(self.block(i + 1, end, 2))
            lines.append(f"{INDENT}}}")
            i = end
        lines.append("}")
        return lines

    def emit_screen(self):
        toks = self.toks
        lines = [f"SCREEN {self.p['name']}()", "{"]
        lines.extend(self.local_decls())
        first = next((i for i, t in enumerate(toks) if t["op"] == "LINE"),
                     len(toks))
        lines.extend(self.block(self.prologue_end, first, 1))
        i = first
        while i < len(toks):
            t = toks[i]
            if t["op"] != "LINE":
                i += 1
                continue
            end = next((j for j in range(i + 1, len(toks))
                        if toks[j]["op"] == "LINE"), len(toks))
            label = self.src.literal({"t": "s", "v": t.get("label", "")})
            keys = self.src.literal({"t": "s", "v": t.get("keys", "")})
            lines.append(f"{INDENT}LINE({label}, {keys})")
            lines.append(f"{INDENT}{{")
            lines.extend(self.block(i + 1, end, 2))
            lines.append(f"{INDENT}}}")
            i = end
        lines.append("}")
        return lines

    def emit_statemachine(self):
        toks = self.toks
        lines = [f"STATEMACHINE {self.p['name']}()", "{"]
        lines.extend(self.local_decls())
        first = next((i for i, t in enumerate(toks) if t["op"] == "state"),
                     len(toks))
        self._rebase_states(first)
        lines.extend(self.block(self.prologue_end, first, 1))
        i = first
        while i < len(toks):
            t = toks[i]
            if t["op"] != "state":
                i += 1
                continue
            end = next((j for j in range(i + 1, len(toks))
                        if toks[j]["op"] == "state"), len(toks))
            lines.append(f"{INDENT}%{t['name'].lstrip('%')}    // state {t['index']}")
            lines.extend(self.block(i + 1, end, 2))
            i = end
        lines.append("}")
        self.src.notes.append(
            f"{self.p['name']}: state machine, in-state jumps are best-effort")
        return lines

    def _rebase_states(self, first):
        """The walker resolves a state body's jumps against the machine's
        block start; they count from the body after the label, as an
        ITEM's do. Re-resolve them, and rebuild the byte index."""
        toks = self.toks
        base0 = self.p["lo"] + 4
        body = None
        for i in range(first, len(toks)):
            t = toks[i]
            if t["op"] == "state":
                body = toks[i + 1]["at"] if i + 1 < len(toks) else None
                continue
            if body is not None and t["op"] in ("jump", "jfalse"):
                rel = t["to"] - base0
                t["to"] = body + rel
        self.at = {t["at"]: i for i, t in enumerate(toks)}
        self.at.setdefault(toks[-1]["at"] + 4, len(toks))
        self.at.setdefault(self.p["hi"], len(toks))

    # ---------------------------------------------------- blocks -----

    def block(self, i, end, depth):
        """Statements from token i up to `end`, structured."""
        lines = []
        pad = INDENT * depth
        stack = []
        toks = self.toks
        start = i
        # the WinKFP dialect (the PABD flash procedures) opens a call frame
        # with the opcode the screen dialect uses for `ret`
        frame_ops = ("frame",) if any(t["op"] == "frame" for t in toks) \
            else ("frame", "ret")
        while i < end:
            t = toks[i]
            op = t["op"]
            if op in ("block", "decl", "endproc") or op in frame_ops:
                if op in frame_ops:
                    stack.append(("frame", None))
                i += 1
                continue
            if op == "const":
                stack.append((self.src.literal(t), PREC_ATOM))
            elif op == "var":
                stack.append((self.slot_name(t), PREC_ATOM))
            elif op == "procref":
                nm = self.src.ref_name(t)
                if nm is None:
                    nm = self.slot_name({"sc": LOCAL, "n": t["n"]})
                stack.append((nm, PREC_ATOM))
            elif op == "binop":
                name = t.get("name")
                if name in UNOP_TEXT:
                    a = stack.pop() if stack and stack[-1][0] != "frame" else ("?", PREC_ATOM)
                    stack.append((UNOP_TEXT[name] + self._wrap(a, PREC_UNARY),
                                  PREC_UNARY))
                else:
                    b = stack.pop() if stack and stack[-1][0] != "frame" else ("?", PREC_ATOM)
                    a = stack.pop() if stack and stack[-1][0] != "frame" else ("?", PREC_ATOM)
                    sym, prec = BINOP_TEXT.get(name, (f"?{name}?", 0))
                    text = (f"{self._wrap(a, prec)} {sym} "
                            f"{self._wrap(b, prec + 1)}")
                    stack.append((text, prec))
            elif op == "store":
                val = stack.pop() if stack and stack[-1][0] != "frame" else ("?", PREC_ATOM)
                lines.append(f"{pad}{self.slot_name(t)} = {val[0]};")
            elif op in ("call", "calluser", "dllcall"):
                args = []
                while stack and stack[-1][0] != "frame":
                    args.append(stack.pop()[0])
                if stack:
                    stack.pop()
                args.reverse()
                if op == "call":
                    name = BUILTIN_ALIASES.get(t["name"], t["name"])
                elif op == "calluser":
                    name = self.src.id2name.get(("func", t["n"]),
                                                f"__func_{t['n']}")
                else:
                    name = self.src.imports.get(t["n"], f"__import_{t['n']}")
                lines.append(f"{pad}{name}({', '.join(args)});")
            elif op == "stmt":
                # a condition: the jfalse that follows shapes the block
                if i + 1 < end and toks[i + 1]["op"] == "jfalse":
                    cond = stack.pop()[0] if stack and stack[-1][0] != "frame" else "TRUE"
                    i = self._structure(i + 1, end, depth, cond, lines, start)
                    stack = []
                    continue
                if stack and stack[-1][0] != "frame":
                    # a bare expression statement (rare)
                    lines.append(f"{pad}{stack.pop()[0]};")
                stack = []
            elif op == "jfalse":
                # a jfalse without its stmt (a lifted proc): treat alike
                cond = stack.pop()[0] if stack and stack[-1][0] != "frame" else "TRUE"
                i = self._structure(i, end, depth, cond, lines, start)
                stack = []
                continue
            elif op == "jump":
                tgt = self.at.get(t["to"])
                if tgt is not None and tgt >= self._body_end(i, end):
                    # a jump past everything that follows: the body ends here
                    lines.append(f"{pad}return;")
                else:
                    lines.append(f"{pad}// goto {t['to']}")
                    self.gotos += 1
            elif op == "ret":
                pass
            elif op == "state":
                lines.append(f"{pad}%{t['name'].lstrip('%')}")
            elif op in ("ITEM", "LINE"):
                lines.append(f"{pad}// {op}({t.get('nr')}, {t.get('label')!r})")
            elif op == "unk":
                lines.append(f"{pad}// unknown token {t.get('bytes')}")
            i += 1
        return lines

    def _body_end(self, i, end):
        """Where the body enclosing token i ends: the next ITEM / LINE /
        state header at or after `end`, else the proc's end."""
        toks = self.toks
        for j in range(end, len(toks)):
            if toks[j]["op"] in ("ITEM", "LINE", "state"):
                return j
        return len(toks)

    @staticmethod
    def _wrap(x, prec):
        text, p = x
        return f"({text})" if p < prec else text

    def _structure(self, i, end, depth, cond, lines, start=0):
        """toks[i] is the jfalse of `cond`. Emit if / if-else / while and
        return the token index the block continues at."""
        toks = self.toks
        pad = INDENT * depth
        jf = toks[i]
        tgt = self.at.get(jf["to"])
        if tgt is not None and tgt > end and tgt >= self._body_end(i, end):
            # the condition guards the rest of the body: the target is the
            # body's end, which this block shares
            tgt = end
        if tgt is None or tgt <= i or tgt > end:
            lines.append(f"{pad}if ({cond}) // jump target {jf['to']} not in this block")
            self.gotos += 1
            return i + 1
        last = toks[tgt - 1]
        # while: the token before the target jumps back to the condition
        cond_start = max(self._cond_start(i), start)
        if last["op"] == "jump" and self.at.get(last["to"]) is not None and \
                self.at[last["to"]] <= cond_start and self.at[last["to"]] >= 0 \
                and last["to"] <= toks[cond_start]["at"]:
            lines.append(f"{pad}while ({cond})")
            lines.append(f"{pad}{{")
            lines.extend(self.block(i + 1, tgt - 1, depth + 1))
            lines.append(f"{pad}}}")
            return tgt
        # if / else: the then-block ends in a forward jump over the else
        if last["op"] == "jump" and self.at.get(last["to"]) is not None and \
                tgt < self.at[last["to"]] <= end:
            else_end = self.at[last["to"]]
            lines.append(f"{pad}if ({cond})")
            lines.append(f"{pad}{{")
            lines.extend(self.block(i + 1, tgt - 1, depth + 1))
            lines.append(f"{pad}}}")
            lines.append(f"{pad}else")
            lines.append(f"{pad}{{")
            lines.extend(self.block(tgt, else_end, depth + 1))
            lines.append(f"{pad}}}")
            return else_end
        lines.append(f"{pad}if ({cond})")
        lines.append(f"{pad}{{")
        lines.extend(self.block(i + 1, tgt, depth + 1))
        lines.append(f"{pad}}}")
        return tgt

    def _cond_start(self, i):
        """The first token of the condition whose jfalse is at i: walk back
        over the expression to the previous statement boundary."""
        toks = self.toks
        j = i - 2          # past the stmt
        need = 1           # values the condition still has to supply
        while j >= 0 and need > 0:
            op = toks[j]["op"]
            if op == "binop":
                if toks[j].get("name") not in UNOP_TEXT:
                    need += 1
            elif op in ("const", "var", "procref"):
                need -= 1
            else:
                break
            j -= 1
        return j + 1


# ------------------------------------------------------------ main -------


def decompile(ecu):
    return Source(ecu)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    if "--corpus" in sys.argv:
        names = sorted({f[:-4] for f in os.listdir(SGDAT)
                        if f.lower().endswith(".ipo")})
        ok = bad = 0
        gotos = procs = 0
        for n in names:
            try:
                s = decompile(n)
                text = s.emit()
                ok += 1
                gotos += text.count("// goto ") + text.count("not in this block")
                procs += len(s.procs)
            except Exception as e:                       # noqa: BLE001
                bad += 1
                print(f"{n}: {type(e).__name__}: {e}", file=sys.stderr)
        print(f"{ok} files decompiled, {bad} failed; {procs} procs, "
              f"{gotos} jumps left as goto comments")
        return
    if not args:
        print(__doc__)
        sys.exit(2)
    ecu = args[0]
    out = None
    if "-o" in sys.argv:
        out = sys.argv[sys.argv.index("-o") + 1]
    text = decompile(ecu).emit()
    if out:
        with open(out, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"wrote {out}")
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
