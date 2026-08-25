"""Build an ECU's IR by executing its .IPO -- the whole file, one call.

    from ir_build import build_ir
    ir = build_ir("zke5")     # {"ir": 1, "ecu": ..., "entry", "menus", "screens"}

Replaces ipo_ir.py's static inference. The menu tree, item targets, screens
and their dialogs all come from running the program (see menus.py / screens.py);
the guards INPA encodes are branches in the bytecode, so execution produces
them without a rule. Conditional targets (a count-gated or variant-gated
screen) are NOT pre-baked -- INPA and the app resolve those at keypress against
the live ECU, and the IR carries only the item list plus the static targets.
"""

from . import menus, screens, vmpool

IR_VERSION = 1


def _link_pickers(ir, entries):
    """Point a state-entering menu item at the picker screen its machine opens.

    A key that setstates into a togglelist machine (ZKE5's "Remote control
    lock system") has no screen of its own; the machine opens the picker.
    Where that screen carries a pickJob, the item gets a stateScreen so the
    app routes to the actuator list instead of reporting "never sent".
    """
    scrs = ir.get("screens") or {}
    for menu in (ir.get("menus") or {}).values():
        for it in menu.get("items", []):
            tgt = entries.get(it.get("stateEnter"))
            if tgt and not it.get("screen") and scrs.get(tgt, {}).get("pickJob"):
                it["stateScreen"] = tgt


def _prune_sel(ir):
    """Drop a key's record index where no screen job actually reads that slot.

    Every `const; store <global>` in an item body looks like a selector, but
    only a few are: MS450's AIF keys store the slot s_aif hands to AIF_LESEN.
    A key that stored a mode flag no screen reads carries a stray _sel; keep it
    only when it is really used, in one of two shapes:
      1. the screen the key opens runs a job whose argSlot is that slot (AIF);
      2. it is a MODE TOGGLE -- two keys in the same menu store the SAME slot
         with different values (SHD46's with/without Quitting set slot 30 to
         1/0, which the actuator machine reads to gate its acknowledgment). The
         renderer groups these by selSlot, so the slot must survive.
    """
    scrs = ir.get("screens") or {}
    for menu in (ir.get("menus") or {}).values():
        items = menu.get("items", [])
        # slots written by more than one key in this menu = a mode toggle group
        slot_count = {}
        for it in items:
            sel = it.get("_sel")
            slot = sel[0] if isinstance(sel, (tuple, list)) else None
            if slot is not None:
                slot_count[slot] = slot_count.get(slot, 0) + 1
        for it in items:
            sel = it.get("_sel")
            if not sel:
                continue
            slot = sel[0] if isinstance(sel, (tuple, list)) else None
            if slot is not None and slot_count.get(slot, 0) >= 2:
                continue                          # a mode-toggle pair: keep it
            scr = scrs.get(it.get("screen")) if slot is not None else None
            if not (scr and any(j.get("argSlot") == slot
                                for j in scr.get("jobs", []))):
                it.pop("_sel", None)


def build_ir(ecu, budget=20000):
    """The complete execution-derived IR for one ECU, or None if it won't run."""
    try:
        proto = vmpool.prototype(ecu, budget=budget)
    except Exception:                                          # noqa: BLE001
        return None
    tree = menus.build(proto, budget)
    if tree is None:
        return None
    ir = {"ir": IR_VERSION, "ecu": ecu, **tree}
    ir["screens"] = screens.build(proto, budget)
    _link_pickers(ir, screens.state_entry_screens(proto, budget))
    # a stored record index only survives where a screen job reads its slot
    _prune_sel(ir)
    # softkey captions live on the screen; join them onto empty item labels
    # now that both menus and screens exist
    menus.attach_softkey_labels(ir, proto)
    # a shifted key INPA never captioned is still ITEM n+10 -- pair it so both
    # rows do not bind to the same digit
    menus.attach_shift_pairs(ir)
    return ir
