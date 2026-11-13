#!/usr/bin/env python3
"""Compile ISTA's own screen layouts into templates the app can render.

ISTA's screens are WPF: one XAML file per view, compiled to BAML inside
ISTAGUI.exe. Decompiled back to XAML they are NOT obfuscated, so they are
the tool's own statement of what each screen holds: which columns a table
has and how wide, which buttons sit in which order, which string key each
label shows, and which binding shows, hides or disables a control.

This turns one XAML file into one JSON template. screens/ista/xaml.js draws a
template against a data context the app supplies, so a screen's STRUCTURE is
BMW's and only its data and its button handlers are ours.

    python3 tools/ista/xaml_compile.py                      # the pilot views
    python3 tools/ista/xaml_compile.py --all                # every ISTAGUI view
    python3 tools/ista/xaml_compile.py views/tabs/pcodeview.xaml
    python3 tools/ista/xaml_compile.py --src /path/decompiled --out data/ista/xaml

Reads $BMWFILES/ista/extracted/decompiled/<assembly>/xaml/ (see that folder's
README for how the BAML was converted) and the localization table beside it.
Writes <View>.json per view, strings.<culture>.json per language and
index.json. The output is BMW-derived data: data/ista/ is gitignored and
hosted like the rest of the ISTA extracts.

WHAT A TEMPLATE KEEPS. Structure (panels, grids, tables and their columns),
sizes, every text as a string key or a binding, and the visibility / enabled /
command / items bindings. WHAT IT DROPS. Styles, control templates, triggers
and animations: the app paints with its own stylesheet, and a WPF control
template has no HTML equivalent worth generating. A style's KEY is kept so
the renderer can map it to a class.

A custom control that is itself a XAML view (a status bar part, a legend) is
inlined, so a template is self-contained. One that is C# only (the control
unit tree, the fault filter graph) stays a named placeholder for the app to
fill with its own widget.
"""
import argparse
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
BMWFILES = os.environ.get("BMWFILES", os.path.expanduser("~/Development/code/BMWFILES"))
SRC = os.path.join(BMWFILES, "ista", "extracted", "decompiled")

X = "{http://schemas.microsoft.com/winfx/2006/xaml}"

# The assemblies whose views can be inlined into one another.
ASSEMBLIES = ["ISTAGUI", "RheingoldPresentationFramework"]

# The views the pilot ships.
PILOT = [
    "views/tabs/faultmemoryview.xaml",
    "views/tabs/testplanview.xaml",
    "views/tabs/basicfeaturesview.xaml",
]

# Converters that only translate their ConverterParameter.
TRANSLATORS = {"GuiTranslator": False, "GuiTranslatorColon": True,
               "LanguageMeasuresConverter": False}

# Property elements that carry nothing a template keeps.
DROP = {"Resources", "Style", "Triggers", "RenderTransform", "LayoutTransform",
        "Template", "ItemContainerStyle", "GroupStyle", "ColumnHeaderContainerStyle",
        "ContextMenu", "Effect", "OpacityMask", "CellStyle", "RowStyle",
        "ItemsPanel", "Background", "Foreground", "BorderBrush", "Tag",
        "SortDescriptions", "CommandBindings", "HeaderStyle", "ColumnHeaderStyle",
        "ElementStyle", "EditingElementStyle"}

# Layout attributes copied through as they are.
LAYOUT = {"Width", "Height", "MinWidth", "MinHeight", "MaxWidth", "MaxHeight",
          "Margin", "Padding", "HorizontalAlignment", "VerticalAlignment",
          "Orientation", "TextWrapping", "TextAlignment", "FontWeight",
          "FontSize", "LastChildFill", "GroupName", "MaxLength"}
ATTACHED = {"Grid.Row": "row", "Grid.Column": "col", "Grid.RowSpan": "rowSpan",
            "Grid.ColumnSpan": "colSpan", "DockPanel.Dock": "dock",
            # the BAML decompiler writes a Grid child's cell without the owner
            "Row": "row", "Column": "col", "RowSpan": "rowSpan",
            "ColumnSpan": "colSpan"}

# Attribute -> the template slot its expression lands in.
SLOTS = {"Text": "text", "Content": "text", "Header": "header",
         "Visibility": "vis", "IsEnabled": "en", "Command": "cmd",
         "CommandParameter": "cmdParam", "ItemsSource": "items",
         "SelectedItem": "sel", "SelectedIndex": "selIndex",
         "IsChecked": "checked", "ToolTip": "tip", "DataContext": "dc",
         "Source": "src", "Binding": "bind", "DisplayMemberBinding": "bind",
         "SortMemberPath": "sort", "Value": "value"}

# Tags that are table columns.
COLUMNS = {"GridViewColumn", "DataGridTextColumn", "DataGridTemplateColumn",
           "DataGridCheckBoxColumn"}


def local(tag):
    """The element name without its namespace."""
    return tag.rsplit("}", 1)[-1]


def is_custom(tag):
    """Whether an element comes from a clr-namespace (a BMW control)."""
    return tag.startswith("{clr-namespace:")


# ---- markup extensions -------------------------------------------------------

def split_top(s, sep=","):
    """Split on `sep` outside braces and quotes."""
    out, depth, cur, quote = [], 0, "", None
    for ch in s:
        if quote:
            cur += ch
            if ch == quote:
                quote = None
            continue
        if ch in "'\"":
            quote = ch
            cur += ch
        elif ch == "{":
            depth += 1
            cur += ch
        elif ch == "}":
            depth -= 1
            cur += ch
        elif ch == sep and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += ch
    if cur.strip():
        out.append(cur)
    return [p.strip() for p in out]


def res_key(v):
    """The key inside {StaticResource K} / {DynamicResource K}, or None."""
    m = re.fullmatch(r"\{(?:Static|Dynamic)Resource\s+([^}]+)\}", (v or "").strip())
    return m.group(1).strip() if m else None


def parse_binding(body):
    """The fields of a Binding markup extension's inside, as a dict."""
    out, last = {}, None
    for i, part in enumerate(split_top(body)):
        if "=" in part and not part.startswith("{"):
            k, v = part.split("=", 1)
            last = k.strip()
            out[last] = v.strip()
        elif i == 0:
            out["Path"] = part
        elif last:
            # a value with commas of its own (ConverterParameter=ISTA,ISTA_PLUS)
            # is not quoted in BAML, so a bare part continues the one before
            out[last] += "," + part
    return out


def binding_expr(f):
    """A template expression from a Binding's fields."""
    conv = res_key(f.get("Converter"))
    param = f.get("ConverterParameter")
    if conv in TRANSLATORS and param and param.startswith("#"):
        e = {"loc": param}
        if TRANSLATORS[conv]:
            e["colon"] = True
        return e
    e = {"bind": f.get("Path", ".")}
    if conv:
        e["conv"] = conv
    if param is not None:
        e["param"] = res_key(param) or param
    src = f.get("Source")
    if src:
        e["res" if res_key(src) else "source"] = res_key(src) or src
    if f.get("ElementName"):
        e["el"] = f["ElementName"]
    if f.get("RelativeSource"):
        e["rel"] = True
    fmt = f.get("StringFormat")
    if fmt:
        e["fmt"] = fmt[2:] if fmt.startswith("{}") else fmt
    fb = f.get("FallbackValue")
    if fb and not fb.startswith(("?", "{")):
        e["fallback"] = fb
    return e


def expr(value):
    """An attribute value as a template expression."""
    v = value.strip()
    if v.startswith("{}"):
        return {"lit": v[2:]}
    m = re.fullmatch(r"\{Binding\s*(.*)\}", v, re.S)
    if m:
        return binding_expr(parse_binding(m.group(1)))
    key = res_key(v)
    if key:
        return {"resource": key}
    if v.startswith("{"):
        return {"raw": v}
    return {"lit": v}


def multi_expr(el):
    """A <MultiBinding> element as a template expression."""
    parts = []
    for b in el.iter():
        if local(b.tag) != "Binding":
            continue
        f = dict(b.attrib)
        parts.append(binding_expr({
            "Path": f.get("Path", "."), "Converter": f.get("Converter"),
            "ConverterParameter": f.get("ConverterParameter"),
            "Source": f.get("Source"), "ElementName": f.get("ElementName"),
        }))
    e = {"multi": parts}
    conv = res_key(el.get("Converter"))
    if conv:
        e["conv"] = conv
    fmt = el.get("StringFormat")
    if fmt:
        e["fmt"] = fmt[2:] if fmt.startswith("{}") else fmt
    return e


def property_expr(el):
    """The expression inside a property element (<TextBlock.Text>...)."""
    for c in el:
        n = local(c.tag)
        if n == "MultiBinding":
            return multi_expr(c)
        if n == "Binding":
            return binding_expr(dict(c.attrib))
    text = (el.text or "").strip()
    return {"lit": text} if text else None


# ---- the compiler ------------------------------------------------------------

class Compiler:
    """Compiles views of one decompiled tree, inlining the ones they nest."""

    def __init__(self, src):
        self.src = src
        self.classes = {}
        self.unknown = {}
        self.styles = {}
        for asm in ASSEMBLIES:
            base = os.path.join(src, asm, "xaml")
            for dp, _, fs in os.walk(base):
                for f in fs:
                    if not f.endswith(".xaml"):
                        continue
                    p = os.path.join(dp, f)
                    try:
                        head = open(p, encoding="utf-8").read(600)
                    except OSError:
                        continue
                    m = re.search(r'x:Class="([^"]+)"', head)
                    if m:
                        self.classes[m.group(1).rsplit(".", 1)[-1]] = p

    def resources(self, root):
        """The CollectionViewSources a view declares: what its tables list."""
        out = {}
        for el in root.iter():
            if local(el.tag) != "CollectionViewSource":
                continue
            key = el.get(X + "Key")
            if not key:
                continue
            r = {}
            if el.get("Source"):
                r["source"] = expr(el.get("Source"))
            sort, group = [], []
            for d in el.iter():
                n = local(d.tag)
                if n == "SortDescription":
                    sort.append({"prop": d.get("PropertyName"),
                                 "desc": d.get("Direction") == "Descending"})
                elif n == "PropertyGroupDescription":
                    group.append(d.get("PropertyName"))
            if sort:
                r["sort"] = sort
            if group:
                r["group"] = group
            out[key] = r
        return out

    def local_styles(self, root):
        """{style key: {property: value}} for the styles a view declares.

        Only what a grid track needs: a view spaces its rows with a keyed
        style (RowDistanceHeight) rather than a Height on each definition,
        and a track without its size collapses the spacing.
        """
        out = {}
        for el in root.iter():
            if local(el.tag) != "Style" or not el.get(X + "Key"):
                continue
            out[el.get(X + "Key")] = {
                local(st.get("Property", "")): st.get("Value")
                for st in el if local(st.tag) == "Setter" and st.get("Value")}
        return out

    def track(self, el, prop):
        """A row's Height or a column's Width, through its style if need be."""
        if el.get(prop):
            return el.get(prop)
        style = self.styles.get(res_key(el.get("Style")) or "", {})
        return style.get(prop, "*")

    def column(self, el, depth):
        """One table column."""
        c = {"t": local(el.tag)}
        if el.get("Name") or el.get(X + "Name"):
            c["n"] = el.get("Name") or el.get(X + "Name")
        for k in ("Width", "MinWidth", "MaxWidth"):
            if el.get(k) and not el.get(k).startswith("{"):
                c[k[0].lower() + k[1:]] = el.get(k)
        for k, slot in (("Header", "header"), ("Binding", "bind"),
                        ("DisplayMemberBinding", "bind"), ("Visibility", "vis")):
            if el.get(k):
                c[slot] = expr(el.get(k))
        if el.get("SortMemberPath"):
            c["sort"] = el.get("SortMemberPath")
        # a header written as a bare "#Key" is a string key: the grid control
        # translates it, so the template says so
        h = c.get("header")
        if h and h.get("lit", "").startswith("#"):
            c["header"] = {"loc": h["lit"]}
        for ch in el:
            n = local(ch.tag)
            if n == "GridViewColumnHeader":
                if ch.get("Content"):
                    c["header"] = expr(ch.get("Content"))
                if ch.get("Tag"):
                    c["tag"] = ch.get("Tag")
            elif n.endswith(".CellTemplate"):
                for dt in ch:
                    kids = [self.node(k, depth + 1) for k in dt]
                    kids = [k for k in kids if k]
                    if kids:
                        c["cell"] = kids[0] if len(kids) == 1 else {"t": "StackPanel", "kids": kids}
            elif n.endswith(".Binding"):
                e = property_expr(ch)
                if e:
                    c["bind"] = e
        return c

    def node(self, el, depth=0):
        """One element as a template node, or None when it carries nothing."""
        name = local(el.tag)
        if "." in name or name in ("Style", "ResourceDictionary", "Storyboard"):
            return None
        n = {"t": name}
        if el.get("Name") or el.get(X + "Name"):
            n["n"] = el.get("Name") or el.get(X + "Name")
        a = {}
        for k, v in el.attrib.items():
            lk = local(k)
            if lk in ATTACHED:
                a[ATTACHED[lk]] = v
            elif lk in LAYOUT and not v.startswith("{"):
                a[lk[0].lower() + lk[1:]] = v
            elif lk == "Style":
                key = res_key(v)
                if key:
                    n["style"] = key
            elif lk in SLOTS:
                n[SLOTS[lk]] = expr(v)
        if a:
            n["a"] = a
        text = (el.text or "").strip()
        if text and "text" not in n:
            n["text"] = {"lit": text}

        kids, cols = [], []
        for ch in el:
            cn = local(ch.tag)
            if "." in cn:
                prop = cn.split(".", 1)[1]
                if prop in DROP:
                    continue
                if prop == "RowDefinitions":
                    n["rows"] = [self.track(r, "Height") for r in ch]
                elif prop == "ColumnDefinitions":
                    n["cols"] = [self.track(c, "Width") for c in ch]
                elif prop == "InputBindings":
                    for ib in ch:
                        g = ib.get("Gesture") or ib.get("MouseAction") or ib.get("Key") or ""
                        if ib.get("Command"):
                            slot = "dbl" if "DoubleClick" in g else "key"
                            n[slot] = expr(ib.get("Command"))
                elif prop == "Columns":
                    cols += [self.column(c, depth) for c in ch if local(c.tag) in COLUMNS]
                elif prop == "View":
                    for gv in ch:
                        for c in gv.iter():
                            if local(c.tag) in COLUMNS:
                                cols.append(self.column(c, depth))
                elif prop in ("ItemTemplate", "ContentTemplate"):
                    for dt in ch:
                        tk = [self.node(k, depth + 1) for k in dt]
                        tk = [k for k in tk if k]
                        if tk:
                            n["item"] = tk[0]
                elif prop in SLOTS:
                    slot = SLOTS[prop]
                    e = property_expr(ch)
                    if e:
                        n[slot] = e
                    elif prop == "ToolTip":
                        # a tooltip written as a control: keep its first text
                        for t in ch.iter():
                            if t.get("Text"):
                                n["tip"] = expr(t.get("Text"))
                                break
                    elif prop == "Content":
                        kids += [k for k in (self.node(c, depth + 1) for c in ch) if k]
                elif prop == "Bindings":
                    pass
                continue
            if cn in COLUMNS:
                cols.append(self.column(ch, depth))
                continue
            k = self.node(ch, depth + 1)
            if k:
                kids.append(k)
        if cols:
            n["columns"] = cols

        # a BMW control that is itself a view: inline it, so the template is
        # self-contained; its DataContext binding is kept on the node
        if is_custom(el.tag) and not kids and not cols and depth < 12:
            path = self.classes.get(name)
            if path:
                sub = ET.parse(path).getroot()
                outer, self.styles = self.styles, self.local_styles(sub)
                inner = [k for k in (self.node(c, depth + 1) for c in sub) if k]
                self.styles = outer
                res = self.resources(sub)
                n["view"] = name
                if res:
                    n["resources"] = res
                kids = inner
            else:
                n["custom"] = True
                self.unknown[name] = self.unknown.get(name, 0) + 1
        elif is_custom(el.tag) and name not in self.classes and not kids and not cols:
            n["custom"] = True
        if kids:
            n["kids"] = kids
        return n

    def compile(self, rel):
        """One view file as a template."""
        path = os.path.join(self.src, "ISTAGUI", "xaml", rel)
        root = ET.parse(path).getroot()
        if local(root.tag) == "ResourceDictionary":
            # styles and converters only: nothing a page draws
            return {"view": "", "root": {"t": "ResourceDictionary"}}
        self.styles = self.local_styles(root)
        cls = root.get(X + "Class", "")
        kids = [k for k in (self.node(c, 1) for c in root) if k]
        return {
            "version": 1,
            "view": cls.rsplit(".", 1)[-1] or os.path.basename(rel)[:-5],
            "source": rel,
            "resources": self.resources(root),
            "root": {"t": local(root.tag), "kids": kids},
        }


# ---- strings -----------------------------------------------------------------

def strings(src):
    """{culture: {key: text}} from ISTA's localization table, every module."""
    path = os.path.join(src, "RheingoldCoreFramework",
                        "BMW.Rheingold.CoreFramework.Localization.Localization.xml")
    out = {}
    for mod in ET.parse(path).getroot():
        for lang in mod:
            cul = lang.get("culture")
            table = out.setdefault(cul, {})
            for t in lang:
                if t.get("id") and t.get("name") is not None:
                    table.setdefault(t.get("id"), t.get("name"))
    # the table falls back to en-US for a key a culture lacks
    base = out.get("en-US", {})
    for cul, table in out.items():
        for k, v in base.items():
            table.setdefault(k, v)
    return {c: t for c, t in out.items() if t}


def count(node, acc):
    """Tally a template's node types, for the summary line."""
    acc[node["t"]] = acc.get(node["t"], 0) + 1
    for k in node.get("kids", []):
        count(k, acc)
    return acc


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("views", nargs="*", help="view files under ISTAGUI/xaml (default: the pilot)")
    ap.add_argument("--all", action="store_true", help="every ISTAGUI view")
    ap.add_argument("--src", default=SRC)
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "ista", "xaml"))
    ns = ap.parse_args()
    base = os.path.join(ns.src, "ISTAGUI", "xaml")
    if not os.path.isdir(base):
        raise SystemExit(f"no layouts at {base} (see $BMWFILES/ista/README.md, 'Screen layouts')")
    rels = ns.views or PILOT
    if ns.all:
        rels = sorted(
            os.path.relpath(os.path.join(dp, f), base)
            for dp, _, fs in os.walk(base) for f in fs
            if f.endswith(".xaml") and not dp.endswith("themes"))
    comp = Compiler(ns.src)
    os.makedirs(ns.out, exist_ok=True)
    index = {"version": 1, "views": {}, "cultures": []}
    for rel in rels:
        try:
            tpl = comp.compile(rel)
        except ET.ParseError as e:
            print(f"  SKIP {rel}: {e}", file=sys.stderr)
            continue
        if not tpl["root"].get("kids"):
            continue
        name = tpl["view"]
        with open(os.path.join(ns.out, f"{name}.json"), "w", encoding="utf-8") as f:
            json.dump(tpl, f, ensure_ascii=False, separators=(",", ":"))
        tally = count(tpl["root"], {})
        index["views"][name] = {"source": rel, "nodes": sum(tally.values())}
        print(f"  {name:44} {sum(tally.values()):4} nodes")
    for cul, table in sorted(strings(ns.src).items()):
        with open(os.path.join(ns.out, f"strings.{cul}.json"), "w", encoding="utf-8") as f:
            json.dump(table, f, ensure_ascii=False, separators=(",", ":"))
        index["cultures"].append(cul)
    with open(os.path.join(ns.out, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
    if comp.unknown:
        named = ", ".join(f"{k} x{v}" for k, v in sorted(comp.unknown.items()))
        print(f"C#-only controls left as placeholders: {named}")
    print(f"{len(index['views'])} views, {len(index['cultures'])} languages -> {ns.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
