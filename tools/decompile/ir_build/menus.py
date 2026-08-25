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

import ipo_disasm as D

from . import jobclass, stateforms, vmpool
from .hosts import OkHost

# The builtins that make a key a PC action rather than an ECU one, by opcode:
_FILEOPEN = 0x79       # fileopen(path, mode) -- a write only in "w"/"a"
_FILEWRITE = 0x7b      # filewrite -- emits bytes to disk
_PRINTFILE = 0x18      # printfile -- spools a file to the printer
_VIEWOPEN = 0x5c       # viewopen(file, title) -- DISPLAYS a file, writes nothing
_SCRIPTCHANGE = 0x0f   # loads a different .IPO -- drives INPA, not the car
_CALLWIN = 0x5b        # launches an external program (RDC's kvp_edit)
_SHOWS = "userboxftextout"                    # draws what a job returned
_JOB_OPS = (0x62, 0x6f)                       # INPAapiJob / INP1apiJob
_FSREAD = ("INPAapiFsLesen",)                 # the fault-memory reader is ECU
_INPUT_DIALOGS = (0x3f, 0x43, 0x44, 0x46)     # input dialogs -> a prompt

# the item fields the app reads; empties are dropped so the file stays lean
_ITEM_FIELDS = ("label", "screen", "menu", "action", "job", "jobArg", "shift",
                "stateScreen", "stateJob", "stateEnter", "writeJob",
                "stateForm", "stateEdit", "stateCopy", "localSet",
                # drives INPA not the car (scriptchange/callwin, set by the VM
                # builtins); reads/writes a PC file not the ECU; the fixed record
                # index a shared screen reads; a value the key prompts the user for
                "appTool", "fileAction", "_sel", "prompt")


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


def _eq_operands(toks, i):
    """The (slot, literal) an `eq` at index i consumes -- its two pushes.

    The opcode takes exactly the two tokens before it, so the pairing is
    exact: a wider scan pulls in a neighbouring literal and reads it as the
    compared value. Only a string literal counts; the variant global sits on
    the other side as the (scope, slot) pair.
    """
    if i < 2:
        return None, None
    slot = lit = None
    for x in (toks[i - 2], toks[i - 1]):
        if x.get("op") == "var":
            slot = (x.get("sc", 0), x["n"])
        elif x.get("op") == "const" and isinstance(x.get("v"), str):
            lit = x["v"]
    return slot, lit


def _variant_guard(toks, at, vslots):
    """The variant names guarding the arm that contains the setnav at `at`.

    INPA writes per-variant dispatch as an if/else-if chain: a run of
    `VARIANTE == "NAME"` compares or-ed together, a `jfalse` over the arm, then
    the setscreen/setmenu for that arm. Walking back from the target: the FIRST
    jfalse is this arm's own -- everything before it, up to the previous arm's
    boundary, is the condition, and each `eq` against a variant slot names one
    variant this target serves.

    A name is taken ONLY from an `eq` whose other operand is a variant slot
    (`vslots`), never from how a literal is spelled. Two guards matter for
    correctness: a `jump` reached before any jfalse means the ELSE (fallthrough)
    arm, which carries no condition -- return [] so a fallthrough target is not
    credited to the previous arm's variants. And the INNERMOST jfalse wins, so a
    nested runtime test (`if slot41 == 1`) inside a variant arm hides the outer
    variant name -- the reference leaves such a target unguarded, and so must
    this, or the two decoders disagree.
    """
    names, seen_jfalse = [], False
    lo = max(0, at - 60)
    window = toks[lo:at]
    for j in range(len(window) - 1, -1, -1):
        op = window[j].get("op")
        if op == "jump" and not seen_jfalse:
            return []
        if op == "jfalse" and not seen_jfalse:
            seen_jfalse = True
            continue
        if not seen_jfalse:
            continue
        if op in ("jump", "jfalse", "ITEM"):
            break
        if op == "call":
            break
        if op == "binop" and window[j].get("name") == "eq":
            slot, lit = _eq_operands(window, j)
            if lit and slot and slot[0] == 0 and slot[1] in vslots \
                    and lit not in names:
                names.append(lit)
    return list(reversed(names))


def _nav_targets(proto, toks, start, end, vslots):
    """The setscreen/setmenu targets an item body installs, in bytecode order.

    Yields (slot, target, guard) for each setscreen (slot 'screen') and setmenu
    (slot 'menu') within [start, end), where `target` is the resolved screen or
    menu name and `guard` is the variant names of the arm it sits in (see
    _variant_guard), [] for the ungated default arm. The procref feeding a
    setnav is the token just before it, so the pairing is the compiler's own.
    """
    out = []
    for i in range(start, end):
        t = toks[i]
        if t.get("op") != "call":
            continue
        nm = t.get("name")
        if nm not in ("setscreen", "setmenu"):
            continue
        ref = ref_at = None
        for b in range(i - 1, max(start, i - 8) - 1, -1):
            if toks[b].get("op") == "procref":
                ref, ref_at = toks[b]["n"], b
                break
            if toks[b].get("op") == "call":
                break
        if ref is None:
            continue
        kind = "screen" if nm == "setscreen" else "menu"
        tgt = proto.byid.get((kind, ref))
        if tgt:
            # the guard is anchored on the target PROCREF, not the call after
            # it: the two are a few tokens apart, and anchoring on the later
            # call can push the fixed look-back window past the `var` token the
            # arm's `eq` needs, dropping a real guard (KOMBI's 36C submenu Back)
            out.append((kind, tgt, _variant_guard(toks, ref_at, vslots)))
    return out


def _attach_variant_nav(proto, name, merged, vslots):
    """Fill each item's screen/menu targets and per-variant maps.

    An item's key can install a DIFFERENT screen/menu per VARIANTE: the body is
    an if/else-if chain of `var == CONST` arms, each with its own setscreen/
    setmenu (KOMBI's Coding: 46|46R -> s_code_46, 39|52|IKE.. -> another). The
    app resolves the right one against the live ECU's variant, so the IR carries
    the whole map, not just the arm that ran offline.

    Each item gets, per slot:
      - the primary (first-in-bytecode) target as `screen` / `menu`;
      - `screenAlts` / `menuAlts` = the remaining distinct targets, in order;
      - `screenFor` / `menuFor` = {target: [variant, ...]}, the union of the
        variant names whose guarded arm selects that target (an ungated
        fallthrough target contributes no names, so it stays out of the map).
    These come from the branch STRUCTURE -- the `var == CONST` arm names the
    variant, the setnav procref beside it names the target -- not from running
    one arm and inferring the rest.
    """
    toks = proto.procs.get(name) or []
    marks = [(k, t.get("nr")) for k, t in enumerate(toks)
             if t["op"] == "ITEM" and t.get("nr") is not None]
    for idx, (k, nr) in enumerate(marks):
        if nr not in merged:
            continue
        end = marks[idx + 1][0] if idx + 1 < len(marks) else len(toks)
        navs = _nav_targets(proto, toks, k + 1, end, vslots)
        it = merged[nr]
        for slot in ("screen", "menu"):
            arms = [(tgt, guard) for s, tgt, guard in navs if s == slot]
            if not arms:
                continue
            order = []                              # distinct targets, in order
            formap = {}                             # target -> [variant, ...]
            for tgt, guard in arms:
                if tgt not in order:
                    order.append(tgt)
                for v in guard:
                    bucket = formap.setdefault(tgt, [])
                    if v not in bucket:
                        bucket.append(v)
            it[slot] = order[0]
            alts = [t for t in order[1:] if t != order[0]]
            if alts:
                it[slot + "Alts"] = alts
            else:
                it.pop(slot + "Alts", None)
            formap = {t: vs for t, vs in formap.items() if vs}
            if formap:
                it[slot + "For"] = formap
            else:
                it.pop(slot + "For", None)


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


def _explore_menu(proto, name, variant_slots, budget, base=None):
    """One menu's items, unioned across the default arm and every variant.

    Runs the menu once with nothing bound (the offline default), then once per
    candidate variant so VARIANTE-gated arms appear.
    """
    merged = {}
    bindings = [None] + [(slot, val)
                         for slot, vals in variant_slots.items()
                         for val in vals]
    for binding in bindings:
        vm = vmpool.fresh(proto, OkHost(), base, budget)
        if binding is not None:
            vm.globals[binding[0]] = binding[1]
        try:
            em = vm.run(name)
        except Exception:                                      # noqa: BLE001
            continue
        for it in em.items:
            _merge_item(merged, it)
    return merged


# the input dialogs a key opens to ask for a value (builtin_3f is the fourth,
# matched by opcode) -- an input marks a picker, which is not a file action
_INPUT_CALLS = {"input2text", "input2hexnum", "inputint"}


def _is_file_action(toks, lo, hi):
    """True when this item's body is a PC file operation, not an ECU function.

    INPA's fault and ident menus end with keys that write the memory to a file
    (MS450's "save ident to file") or display/clear a protocol file (LWS5's
    "Read protocol file", "Delete Protocol file"). None question the car, so
    none is a runnable ECU key -- yet each opens a dialog and does file I/O the
    executed body now reaches. The tell is structural: file I/O with no
    INPAapiJob of its own. A key that ALSO sends a job (LWS5's "Read"/"Clear",
    which append their result to the log) is a real function and keeps it.

    A key that only PROMPTS for a path and then views it is a PICKER -- the
    menu's next key sends the file it chose -- so an input dialog disqualifies
    a view/open-only key. A key that WRITES the file itself is the action, not
    a picker, so a filewrite counts even when it prompts for the path first
    (MS450's "save ident to file" asks where before writing).

    A FAULT READ questions the car, even though it writes and views a file:
    INPA's library (INPAapiFsMode + INPAapiFsLesen) puts the memory into
    na_fs.tmp and shows it, so an FS-library call means the key is a real
    function -- like a job -- and is never a file action (RDC's "Read error
    memory" routes through exactly this). SZL's fault reads instead draw the
    memory into a status box and view it, with no library call; the box draw
    (userboxftextout) and the runtime item naming (setitem) are what a pure
    file viewer lacks, so a view-only key that also DRAWS is not a dump either.

    So: opening a file itself -- filewrite to save (MS450's ident-to-file),
    fileopen to truncate/delete (LWS5's "Delete protocol file") -- is a file
    mutation and a file action, even if the key then draws a "done" box.
    Merely VIEWING a file (viewopen) is a file action only when the key draws
    nothing of its own: LWS5's "Read protocol file" just shows the file, while
    SZL's "Read error memory" draws the memory into a status box, so the box
    draw (userboxftextout) tells a viewer from a readout. Anything that
    questions the car or prompts is a real key and kept.
    """
    has_mutate = has_view = has_ecu = has_input = has_draw = False
    for t in toks[lo:hi]:
        if t.get("op") != "call":
            continue
        nm = t.get("name")
        if nm in ("filewrite", "fileopen"):
            has_mutate = True
        elif nm == "viewopen":
            has_view = True
        elif nm in ("INPAapiJob", "INP1apiJob", "INPAapiJobData",
                    "INPAapiFsLesen", "INPAapiFsMode"):
            has_ecu = True
        elif nm in _INPUT_CALLS or t.get("n") == 0x3f:
            has_input = True
        elif nm in ("userboxftextout", "ftextout", "textout", "text",
                    "setitem", "analogout", "digitalout"):
            has_draw = True
    if has_ecu:
        return False
    if has_mutate:
        return True                     # opens/writes a file, asks nothing
    # a bare VIEWER: shows a file and draws nothing of its own. A draw makes it
    # a status readout (SZL's fault read), never a plain file dump.
    return has_view and not has_input and not has_draw


def _resolve_bodies(proto, name, merged, budget, base=None):
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
            vmpool.fresh(proto, OkHost(), base, budget) \
                .run_item(toks, k + 1, end, cur)
        except Exception:                                     # noqa: BLE001
            continue
        _merge_item(merged, cur)
        # a pure file operation (write memory to a file, view/clear a protocol
        # file) is chrome, not an ECU key -- flag it so it is not offered and
        # drop the job, run only to fill the file, that would make the menu
        # look runnable. Applied to the merged item so a job an earlier arm
        # recorded is cleared too.
        if _is_file_action(toks, k + 1, end):
            merged[nr]["fileAction"] = True
            merged[nr].pop("job", None)
            merged[nr].pop("jobArg", None)


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


def attach_shift_pairs(ir):
    """Mark a shifted F-key INPA never captioned, by its ITEM number.

    INPA's softkey bar has two rows; the shifted partner of key n is ITEM n+10
    (it prints "<Shift> + < Fn >"). attach_softkey_labels flags the ones whose
    shifted caption INPA printed, but AFS_70's "AIF 9" carries no help text --
    it is ITEM 11 sitting beside "AIF 1" at 1. An item numbered 11..19 whose
    partner at n-10 exists in the same menu is the shifted half whether or not
    any caption said so; without this both bind to the same digit.
    """
    for menu in (ir.get("menus") or {}).values():
        nrs = {it.get("nr") for it in menu["items"]}
        for it in menu["items"]:
            n = it.get("nr")
            if it.get("shift") or not isinstance(n, int) or isinstance(n, bool):
                continue
            if 11 <= n <= 19 and (n - 10) in nrs:
                it["shift"] = True


def _item_slices(toks):
    """[(nr, start, end)] -- each ITEM's body, bounded by the next ITEM.

    The slice is where a key's own opcodes live: the file/script/input builtins
    that say whether it drives the car, INPA, or a PC file. Bounding by the next
    ITEM header keeps a key's evidence to itself.
    """
    marks = [(k, t.get("nr")) for k, t in enumerate(toks)
             if t["op"] == "ITEM" and t.get("nr") is not None]
    out = []
    for i, (k, nr) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else len(toks)
        out.append((nr, k, end))
    return out


def _fileopen_writes(toks, k):
    """Does the fileopen at k create/append (mode 'w'/'a'), rather than read?"""
    mode = D.arg_str(D.arg_positions(D.frame_of(toks, k)), 1)
    return bool(mode) and mode.strip().lower()[:1] in ("w", "a")


def _slice_prompts(toks, lo, hi):
    """The strings an input dialog in [lo,hi) asks with, in call order.

    An input dialog (inputtext/input2hexnum ...) carries its title and field
    captions as the string constants in its call frame. A key that prompts is a
    picker, not a bare file writer -- LWS5's "Choose File with Coding Data"
    prompts and hands the path on, so its viewopen is a preview, not a write.
    """
    out = []
    for j in range(lo, hi):
        t = toks[j]
        if t["op"] != "call" or t["n"] not in _INPUT_DIALOGS:
            continue
        seg = D.frame_of(toks, j)
        for x in seg:
            if x["op"] == "const" and x.get("t") == "s" \
                    and str(x.get("v", "")).strip() and x["v"] not in out:
                out.append(x["v"])
    return out


def _helper_writes_file(proto, toks, lo, hi, _depth=0, _seen=None):
    """True when a user func the body calls writes/prints a file.

    MS450's "save all faults to a file" runs FS_LESEN and hands the result to
    OutputError2File, which filewrites it -- the export lives in the helper, not
    the item body, so a body-only scan misses it. Following calluser (guarded
    against recursion) sees the helper's whole purpose is filewrite, which is
    what marks the key an export rather than a readout.
    """
    if proto is None or _depth > 3:
        return False
    if _seen is None:
        _seen = set()
    for j in range(lo, hi):
        t = toks[j]
        if t.get("op") != "calluser":
            continue
        fn = proto.byid.get(("func", t["n"]))
        if not fn or fn in _seen or fn not in proto.procs:
            continue
        _seen.add(fn)
        body = proto.procs[fn]
        for tt in body:
            if tt.get("op") == "call" and tt["n"] in (_FILEWRITE, _PRINTFILE):
                return True
        if _helper_writes_file(proto, body, 0, len(body), _depth + 1, _seen):
            return True
    return False


def _reaches_fault_lib(proto, toks, lo, hi, _depth=0, _seen=None):
    """True when the body, or a helper it calls, reads the fault memory.

    INPA's fault library (INPAapiFsLesen/FsMode, and per-SGBD wrappers named
    ...FsLesen.../FsMode... like SZL's INPAapiFsLesen_neu) questions the ECU and
    also logs the result to na_fs.tmp. That log write must NOT read as an export:
    the key is a real fault read. A helper reaching the fault library is the
    tell, so the file write it does is a log, not the key's purpose.
    """
    if proto is None or _depth > 3:
        return False
    if _seen is None:
        _seen = set()
    for j in range(lo, hi):
        t = toks[j]
        if t.get("op") == "call" and "Fs" in (t.get("name") or "") \
                and ("Lesen" in t["name"] or "Mode" in t["name"]):
            return True
        if t.get("op") == "calluser":
            fn = proto.byid.get(("func", t["n"]))
            if not fn or fn in _seen or fn not in proto.procs:
                continue
            _seen.add(fn)
            if "Fs" in fn and ("Lesen" in fn or "Mode" in fn):
                return True
            body = proto.procs[fn]
            if _reaches_fault_lib(proto, body, 0, len(body), _depth + 1, _seen):
                return True
    return False


def _slice_pc_flags(toks, lo, hi, proto=None):
    """(fileAction, appTool, prompts) a single item body [lo,hi) implies.

    Every signal is an OPCODE, never a caption. An item is a PC file action
    when it writes/prints/views a file and NEVER questions the ECU: a job call
    (INPAapiJob), the fault-memory reader, or a viewopen that follows a job all
    mean the file is a log of a real read, not the key's purpose. A key that
    only prompts and views is a picker, exempt. scriptchange/callwin make it an
    INPA tool. This mirrors the reference's file/view/print resolution.

    An item whose HELPER does the writing (MS450's export runs FS_LESEN then
    hands off to a filewriting helper) is an export too: the job only feeds the
    file, so the write -- wherever it lives -- is the key's purpose, and it
    stays a file action despite naming a job.
    """
    calls = {toks[j]["n"] for j in range(lo, hi) if toks[j]["op"] == "call"}
    named = {toks[j].get("name") for j in range(lo, hi)
             if toks[j]["op"] == "call"}
    app_tool = bool(calls & {_SCRIPTCHANGE, _CALLWIN})
    prompts = _slice_prompts(toks, lo, hi)

    # ECU contact: a job, or INPA's own fault-memory reader. Either makes the
    # file work a log of a real read rather than the key's whole purpose.
    asks_ecu = bool(calls & set(_JOB_OPS)) or bool(named & set(_FSREAD))
    # what the key does to a PC file
    wrote = bool(calls & {_FILEWRITE, _PRINTFILE}) \
        or any(toks[j]["op"] == "call" and toks[j]["n"] == _FILEOPEN
               and _fileopen_writes(toks, j) for j in range(lo, hi))
    views = _VIEWOPEN in calls
    # a helper doing the write is the export, even when the item runs a job to
    # fill the file -- the job feeds the writer, it is not a readout of its own.
    # BUT a fault read logs its result too (SZL's "Read error memory" hands off
    # to INPAapiFsLesen_neu, which writes na_fs.tmp): reaching the fault library
    # means the key questions the ECU, so its write is a log, not the purpose.
    helper_wrote = _helper_writes_file(proto, toks, lo, hi) \
        and not _reaches_fault_lib(proto, toks, lo, hi)
    if helper_wrote:
        return True, app_tool, prompts
    file_action = (wrote or views) and not asks_ecu \
        and not _reaches_fault_lib(proto, toks, lo, hi)
    # a key that PROMPTS and only VIEWS is a picker, not a writer -- it chooses
    # a path and hands it on. Only exempt when it did not itself write.
    if file_action and prompts and not wrote:
        file_action = False
    return file_action, app_tool, prompts


def _machine_file_action(proto, name):
    """Does the state machine `name` write a PC file and never ask the ECU?

    LWS5's only Coding key hands off to sm_Codier_Datei, whose whole body is
    "read the coding into a buffer, open a .COD file 'w', write it" -- the read
    goes to disk, never to a screen (no userboxftextout), so the key is a file
    export. A machine that DRAWS what it read (userboxftextout after its job)
    is a real ECU function and is left alone.
    """
    toks = proto.procs.get(name) or []
    calls = {t["n"] for t in toks if t["op"] == "call"}
    named = {t.get("name") for t in toks if t["op"] == "call"}
    writes = bool(calls & {_FILEOPEN, _FILEWRITE, _PRINTFILE})
    if not writes:
        return False
    # it questions the ECU only if it also SHOWS the answer; a read whose
    # result only goes to the file does not count as an ECU function
    shows = _SHOWS in named
    asks = shows and (bool(calls & set(_JOB_OPS)) or bool(named & set(_FSREAD)))
    return not asks


def _attach_pc_flags(proto, menus):
    """Flag each item that drives INPA or a PC file rather than the ECU.

    Two evidences, both structural: the item's own body (file/script/input
    opcodes) and, for a key that enters a state machine, that machine's body
    (LWS5's .COD writer). The VM already sets appTool for an UNGATED
    scriptchange; this static walk also catches one behind a file-exists guard
    (RDC's "Extra"), and adds fileAction, which the VM does not derive.
    """
    for name, menu in menus.items():
        toks = proto.procs.get(name) or []
        slices = {nr: (lo, hi) for nr, lo, hi in _item_slices(toks)}
        for it in menu["items"]:
            nr = it.get("nr")
            # A KEY THAT HANDS OFF TO A .COD/EXPORT MACHINE. sm_Codier_Datei
            # reads the coding into a buffer and writes it to a PC file, drawing
            # nothing -- so even though the run surfaced its CODIERUNG_LESEN as a
            # stateJob, the read only feeds the file and the key is an export.
            # This overrides the surfaced job, as the reference does.
            st = it.get("stateEnter")
            if st and _machine_file_action(proto, st):
                it["fileAction"] = True
            bounds = slices.get(nr)
            if bounds:
                fa, app, prompts = _slice_pc_flags(toks, bounds[0], bounds[1],
                                                   proto)
                if app:
                    it["appTool"] = True
                if prompts and "prompt" not in it:
                    it["prompt"] = prompts
                # a file action from the item's OWN body flags only when it names
                # no job (a real job is ECU contact the reference exempts, e.g.
                # LWS5 F1 ABGLEICH_LESEN writes a log too). But a HELPER that
                # writes the file makes the key an export even with a job -- the
                # job only fills the file -- so that overrides and drops the job.
                if fa:
                    hw = _helper_writes_file(proto, toks, bounds[0], bounds[1]) \
                        and not _reaches_fault_lib(proto, toks, bounds[0],
                                                   bounds[1])
                    if hw or not it.get("job"):
                        it["fileAction"] = True
                    if hw:
                        it.pop("job", None)
                        it.pop("jobArg", None)


def build(proto, budget=20000):
    """{entry, menus} for one ECU, or None if it has no menus."""
    variant_slots = _variant_slots(proto)
    # the state INPA leaves after __inpa_startup__ + inpainit -- the input_ok
    # sentinel a prompting key checks getinputstate against lives here, so a
    # key resolved without it loses the job behind its "dialog accepted" gate
    base = vmpool.init_state(proto, OkHost(), budget)
    menus = {}
    for (_off, typ, name, _pid) in proto.decls:
        if typ != "menu":
            continue
        merged = _explore_menu(proto, name, variant_slots, budget, base)
        _resolve_bodies(proto, name, merged, budget, base)
        # the per-variant screen/menu each item's arms install, read from the
        # branch structure -- overrides the single arm the offline run took
        _attach_variant_nav(proto, name, merged, set(variant_slots))
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
    # after stateEnter is known: flag PC-file / INPA-tool keys from the bytecode
    _attach_pc_flags(proto, menus)
    entry, root_variants, probe = _entry(proto, budget)
    out = {"entry": entry, "menus": menus}
    if root_variants:
        out["rootVariants"] = root_variants
    if probe.get("job"):
        out["variantJob"] = probe["job"]
    if probe.get("key"):
        out["variantKey"] = probe["key"]
    return out
