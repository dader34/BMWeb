"""Menus and their items, derived by executing the .IPO.

INPA's menu tree is not inferred here -- it is run. inpainit gives the entry
point; each menu proc, executed, yields its items with the screens/menus/jobs
they resolve to. The guards INPA encodes (variant arms, keypress-gated bodies)
are branches in the bytecode, so execution produces them without a rule.

What execution does NOT pre-resolve is a target behind a runtime condition --
a count-gated screen (`if reads >= 6`), a variant arm before the car names its
VARIANTE. INPA resolves those when the key is pressed against the live ECU,
and so does the app; the IR only needs the item LIST plus the static targets.
The variant explore below is the one exception: it binds each candidate
VARIANTE and unions the arms, so the offline IR still lists every variant's
page rather than only the default arm's.
"""

from . import jobclass, stateforms, vmpool
from .hosts import OkHost

# the item fields the app reads; empties are dropped so the file stays lean
_ITEM_FIELDS = ("label", "screen", "menu", "action", "job", "jobArg", "shift",
                "stateScreen", "stateJob", "stateEnter", "writeJob",
                "stateForm", "stateEdit", "stateCopy", "localSet")


def _clean_item(it):
    """One menu item, only the fields the app reads."""
    out = {"nr": it["nr"]}
    for k in _ITEM_FIELDS:
        if it.get(k):
            out[k] = it[k]
    return out


def _variant_slots(vm):
    """{global slot -> [candidate strings]} a menu compares a variable against.

    INPA branches menu arms on VARIANTE with `if (var == "ABSMK4G") ...`.
    Binding each value and re-running enumerates the arms with no dispatch
    decoding. A slot compared against ONE value is a status test (ERROR_BLS),
    not a variant switch, so only slots with several candidates count. Order
    is preserved: INPA evaluates top-down, so the first arm wins a tie.
    """
    slots = {}
    for (_off, typ, name, _pid) in vm.decls:
        if typ != "menu":
            continue
        toks = vm.procs.get(name) or []
        for j in range(len(toks) - 2):
            a, b, c = toks[j], toks[j + 1], toks[j + 2]
            if (a["op"] == "var" and b["op"] == "const"
                    and isinstance(b.get("v"), str) and b["v"]
                    and c["op"] == "binop" and c.get("name") == "eq"):
                seen = slots.setdefault(a["n"], [])
                if b["v"] not in seen:
                    seen.append(b["v"])
    return {slot: vals for slot, vals in slots.items() if len(vals) >= 2}


def _merge_item(merged, item):
    """Fold a run's item into the accumulator, first-seen field wins.

    A gated screen/menu/job surfaces only under its own variant binding or
    keypress, so later runs fill fields earlier ones left blank -- but never
    overwrite, so the default/first arm keeps priority.
    """
    nr = item.get("nr")
    if nr is None:
        return
    clean = _clean_item(item)
    if nr not in merged:
        merged[nr] = clean
    else:
        for k, v in clean.items():
            if v and not merged[nr].get(k):
                merged[nr][k] = v


def _explore_menu(proto, name, variant_slots, budget):
    """One menu's items, unioned across the default arm and every variant.

    Runs the menu once with nothing bound (the offline default), then once per
    candidate variant so VARIANTE-gated arms appear.
    """
    merged = {}
    bindings = [None] + [(slot, val)
                         for slot, vals in variant_slots.items()
                         for val in vals]
    for binding in bindings:
        vm = vmpool.fresh(proto, OkHost(), budget=budget)
        if binding is not None:
            vm.globals[binding[0]] = binding[1]
        try:
            em = vm.run(name)
        except Exception:                                      # noqa: BLE001
            continue
        for it in em.items:
            _merge_item(merged, it)
    return merged


def _resolve_bodies(proto, name, merged, budget):
    """Fill each item's action behind its keypress/enable guard.

    Running a menu straight through records ITEM headers but not the body
    behind `if flag == 1 ...` -- the job/screen an item runs when its key is
    pressed. run_item executes each item body as-if-pressed to recover it.
    """
    toks = proto.procs.get(name) or []
    marks = [(k, t.get("nr"), t.get("label")) for k, t in enumerate(toks)
             if t["op"] == "ITEM" and t.get("nr") is not None]
    for idx, (k, nr, label) in enumerate(marks):
        # BACKFILL an item the straight run never reached. An earlier item's
        # body can be an actuator ramp (dimming 0..255) that runs to the step
        # budget, so the walk never passes the later ITEM headers -- yet they
        # are real keys. run_item executes each body in ISOLATION (bounded to
        # its own slice), so a prior item's loop cannot starve it.
        if nr not in merged:
            merged[nr] = {"nr": nr}
            if label:
                merged[nr]["label"] = label
        end = marks[idx + 1][0] if idx + 1 < len(marks) else len(toks)
        cur = dict(merged[nr])
        try:
            vmpool.fresh(proto, OkHost(), budget=budget) \
                .run_item(toks, k + 1, end, cur)
        except Exception:                                     # noqa: BLE001
            continue
        _merge_item(merged, cur)


def _frame_args(toks, k):
    """The constant args of the call at k, in push order (from its FRAME on)."""
    start = k
    for b in range(k - 1, max(0, k - 16) - 1, -1):
        if toks[b].get("op") == "frame":
            start = b
            break
    return [toks[j].get("v") for j in range(start + 1, k)
            if toks[j].get("op") == "const"]


def _setitem_labels(toks):
    """{nr: caption} a menu proc binds with setitem(nr, caption, enabled).

    This is INPA's OWN item->caption link: setitem names the key by number and
    hands it its label, so the caption is decoded from the opcode's arguments,
    not parsed out of printed help. The call is often gated (`if fitted
    setitem(...)`), so every branch is scanned, not only the executed one.
    First binding for a number wins, matching top-down evaluation.
    """
    out = {}
    for k, t in enumerate(toks):
        if t.get("op") != "call" or t.get("name") != "setitem":
            continue
        args = _frame_args(toks, k)
        nr = next((x for x in args if isinstance(x, int)
                   and not isinstance(x, bool)), None)
        cap = next((x for x in args if isinstance(x, str) and x.strip()), None)
        if nr is not None and cap:
            out.setdefault(nr, cap)
    return out


def _menu_after(proto, toks, k):
    """The menu a setmenu within the next few tokens installs, or None."""
    for j in range(k, min(k + 12, len(toks))):
        if toks[j].get("op") == "call" and toks[j].get("name") == "setmenu":
            for b in range(j - 1, max(k, j - 6) - 1, -1):
                if toks[b].get("op") == "procref":
                    return proto.byid.get(("menu", toks[b]["n"]))
    return None


def _variant_probe(toks):
    """(job, key) inpainit runs to learn its VARIANTE -- how the app re-asks.

    inpainit runs INITIALISIERUNG and reads its VARIANTE result, then branches
    the root menu on that value. The app needs the same job+key to resolve the
    variant against a live ECU, so the first job name and the first result key
    read in inpainit are recorded.
    """
    job = key = None
    for i, t in enumerate(toks):
        if t.get("op") != "call":
            continue
        nm = t.get("name") or ""
        first_str = None
        for b in range(i - 1, max(0, i - 10) - 1, -1):
            v = toks[b].get("v") if toks[b].get("op") == "const" else None
            if isinstance(v, str) and v:
                first_str = v
                break
        if "Job" in nm and job is None:
            job = first_str
        elif "Result" in nm and key is None:
            key = first_str
    return job, key


def _root_variants(proto):
    """(roots, job, key): the per-variant roots and the probe that selects them.

    inpainit derives VARIANTE into a slot, then `if var == "KOMBI46" setmenu(
    m_..._46)` installs the matching root. It COMPUTES that slot first, so
    binding it before the run is overwritten -- the arms are read statically
    instead: each `var == CONST` immediately guarding a setmenu names one root
    and the variant that selects it. Order preserved (INPA evaluates top-down).
    """
    toks = proto.procs.get("inpainit") or []
    roots = {}
    for k in range(len(toks) - 2):
        a, b, c = toks[k], toks[k + 1], toks[k + 2]
        if (a.get("op") == "var" and b.get("op") == "const"
                and isinstance(b.get("v"), str) and b["v"]
                and c.get("op") == "binop" and c.get("name") == "eq"):
            menu = _menu_after(proto, toks, k)
            if menu:
                roots.setdefault(menu, [])
                if b["v"] not in roots[menu]:
                    roots[menu].append(b["v"])
    job, key = _variant_probe(toks) if roots else (None, None)
    return roots, job, key


def _entry(proto, budget):
    """The screen and root menu inpainit opens, per variant -- the tree's root.

    On multi-variant ECUs inpainit picks a DIFFERENT root per VARIANTE (KOMBI's
    E46 root is m_main_..._46, its E34 root another) and the default arm may set
    none. The executed run gives the entry screen and the default menu when it
    is ungated; rootVariants (built statically, see _root_variants) records the
    per-variant roots and supplies a default when the choice is fully gated.
    """
    entry = {}
    root_variants, job, key = _root_variants(proto)
    if "inpainit" in proto.procs:
        try:
            em = vmpool.fresh(proto, OkHost(), budget=budget).run("inpainit")
            if em.screen:
                entry["screen"] = em.screen
            if em.menu:
                entry["menu"] = em.menu
        except Exception:                                     # noqa: BLE001
            pass
    # a fully gated root sets no menu on the default arm -> widest-serving root
    if "menu" not in entry and root_variants:
        entry["menu"] = max(root_variants, key=lambda m: len(root_variants[m]))
    # single-root ECUs whose inpainit spins in a check loop (SZL's SgbdInpaCheck)
    # exhaust the budget before the setmenu runs; the sole ungated target is
    # still recoverable statically.
    if "menu" not in entry:
        toks = proto.procs.get("inpainit") or []
        for k, t in enumerate(toks):
            if t.get("op") == "call" and t.get("name") == "setmenu":
                m = _menu_after(proto, toks, max(0, k - 6))
                if m:
                    entry["menu"] = m
                    break
    # When inpainit spins before its setscreen runs, the executed run leaves no
    # entry screen -- yet the root menu is drawn on one, and the app needs it to
    # tell a redraw-in-place key from a real target. Recover it from the same
    # setscreen/setmenu pairing that draws every other menu.
    if "screen" not in entry and entry.get("menu"):
        drawn = _menu_screens(proto).get(entry["menu"])
        if drawn:
            entry["screen"] = drawn
    probe = {"job": job, "key": key} if len(root_variants) > 1 else {}
    return entry, root_variants, probe


def _attach_state_forms(proto, menus):
    """Decode each state-entering item's machine into its form/edit/copy.

    A write key (IDENT_SCHREIBEN) gets stateForm -- the slots it joins with
    ";", each named by the Change proc that fills it. A Change key (no job)
    gets stateEdit -- the one or more fields its dialog stages. A Set-default
    key gets stateCopy -- the read-back -> edit slot pairs it copies. Every
    persistent-write job is flagged writeJob so a keypress cannot fire it.
    """
    slot_field = stateforms.slot_captions(proto.procs)
    for name, menu in menus.items():
        copies = stateforms.item_copies(proto.procs.get(name) or [])
        for it in menu["items"]:
            if it.get("job") and jobclass.is_write(it["job"]):
                it["writeJob"] = True
            cp = copies.get(it.get("nr"))
            if cp and not it.get("job"):
                it["stateCopy"] = cp
            st = it.get("stateEnter")
            form = stateforms.state_proc(proto.procs[st]) if st in proto.procs \
                else None
            if not form:
                continue
            # the write key spells out its assembled argument as a form: each
            # slot named by the Change proc that fills it, in send order
            if form.get("argOrder"):
                fields = [dict(slot_field.get(s, {"slot": s}), slot=s)
                          for s in form["argOrder"]]
                it["stateForm"] = {"fields": fields, "sep": form.get("sep", ";")}
            # a Change key runs no job of its own; it only stages the buffer
            if not it.get("job") and form.get("fields"):
                it["stateEdit"] = {"fields": form["fields"]}


def _menu_screens(proto):
    """{menu name -> the screen its items are drawn on}.

    A key installs a menu and the screen that draws it in one breath -- the
    compiler emits `setscreen(S); setmenu(M)` adjacently (KOMBI F6 Activate ->
    s_steuern + m_steuern). Pairing the setmenu's menu ref with the setscreen
    ref right beside it names the screen each menu is captioned on, which is
    the screen whose softkey legend belongs to that menu's items. The pairing
    is the compiler's own, so there is nothing to score.

    The adjacency wins where it exists. A menu that draws its OWN screen from
    its INIT (LWS5's m_steuern setscreens s_steuern with no following setmenu)
    is a FALLBACK only, filled after -- taking it first would override the
    entry-screen pairing a root menu needs for its full softkey bar.
    """
    out = {}
    for (_off, typ, name, _pid) in proto.decls:
        if typ not in ("menu", "screen", "state"):
            continue
        toks = proto.procs.get(name) or []
        last_screen = None
        for i, t in enumerate(toks):
            if t.get("op") != "call":
                continue
            nm = t.get("name")
            if nm not in ("setscreen", "setmenu"):
                continue
            ref = None
            for b in range(i - 1, max(0, i - 8) - 1, -1):
                if toks[b].get("op") == "procref":
                    ref = toks[b]["n"]
                    break
                if toks[b].get("op") == "call":
                    break
            if ref is None:
                continue
            if nm == "setscreen":
                last_screen = proto.byid.get(("screen", ref))
            elif last_screen is not None:
                mn = proto.byid.get(("menu", ref))
                if mn:
                    out.setdefault(mn, last_screen)
    # FALLBACK: a menu the adjacency never paired, that draws its own screen.
    for (_off, typ, name, _pid) in proto.decls:
        if typ != "menu" or name in out:
            continue
        toks = proto.procs.get(name) or []
        for i, t in enumerate(toks):
            if t.get("op") == "call" and t.get("name") == "setscreen":
                ref = next((toks[b]["n"] for b in range(i - 1, max(0, i - 8) - 1,
                            -1) if toks[b].get("op") == "procref"), None)
                sc = proto.byid.get(("screen", ref)) if ref is not None else None
                if sc:
                    out[name] = sc
                    break
    return out


def attach_softkey_labels(ir, proto):
    """Fill empty menu-item labels from the drawing screen's softkey legend.

    Many keys (Error memory, Activate, actuator keys) carry an empty ITEM
    label; INPA captions them only in the softkey bar, which screens.py
    harvested statically. For each menu, the screen it is drawn on supplies
    the captions by F-number: a SHIFTED key's caption always wins (its item
    label is the cramped half of a pair), a plain key's wins only when longer
    than the label already there. The short item form is kept as `short` so a
    narrow F-key bar can still label the button.
    """
    m2s = _menu_screens(proto)
    entry_screen = (ir.get("entry") or {}).get("screen")
    root = (ir.get("entry") or {}).get("menu")
    screens = ir.get("screens") or {}
    for mname, menu in (ir.get("menus") or {}).items():
        target = m2s.get(mname)
        if mname == root and entry_screen:
            target = entry_screen           # the root is drawn on the entry
        if not target or target not in screens:
            continue
        sk = screens[target].get("softkeys") or {}
        for it in menu["items"]:
            hit = sk.get(str(it.get("nr")))
            if not hit:
                continue
            cap, shifted = hit
            # a whitespace-only ITEM label is a blank the compiler padded, not
            # a real caption, so it is measured stripped: the softkey then wins
            # by length where it should (s_status_lenkwinkel's "Digital").
            short = (it.get("label") or "").strip()
            if shifted or len(cap) > len(short):
                if short and short != cap and len(short) < len(cap):
                    it["short"] = short
                it["label"] = cap
            if shifted:
                it["shift"] = True


def build(proto, budget=20000):
    """{entry, menus} for one ECU, or None if it has no menus."""
    variant_slots = _variant_slots(proto)
    menus = {}
    for (_off, typ, name, _pid) in proto.decls:
        if typ != "menu":
            continue
        merged = _explore_menu(proto, name, variant_slots, budget)
        _resolve_bodies(proto, name, merged, budget)
        # INPA's own item->caption link: a gated setitem the run skipped still
        # names the key. This is the structural source; the softkey bar (below,
        # after screens exist) only fills what no setitem covered.
        setlabels = _setitem_labels(proto.procs.get(name) or [])
        for nr, cap in setlabels.items():
            if nr in merged and not (merged[nr].get("label") or "").strip():
                merged[nr]["label"] = cap
        for it in merged.values():
            # a picker resolved into `screen` needs no duplicate stateScreen;
            # keep stateScreen only when it names a DIFFERENT (deferred) target
            if it.get("stateScreen") == it.get("screen"):
                it.pop("stateScreen", None)
        items = [merged[nr] for nr in sorted(merged)]
        if items:
            menus[name] = {"items": items}
    if not menus:
        return None
    _attach_state_forms(proto, menus)
    entry, root_variants, probe = _entry(proto, budget)
    out = {"entry": entry, "menus": menus}
    if root_variants:
        out["rootVariants"] = root_variants
    if probe.get("job"):
        out["variantJob"] = probe["job"]
    if probe.get("key"):
        out["variantKey"] = probe["key"]
    return out
