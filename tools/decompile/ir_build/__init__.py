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
    # softkey captions live on the screen; join them onto empty item labels
    # now that both menus and screens exist
    menus.attach_softkey_labels(ir, proto)
    return ir
