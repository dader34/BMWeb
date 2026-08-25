"""Decode a write/edit state machine into the little form it really is.

A menu key that setstates into a state machine hands off to a proc whose
whole job is to stage an EEPROM/IDENT write: load a global into a dialog var,
prompt for it, commit the answer back, and -- on the final key -- join the
staged slots with ";" and send them. INPA drops all of that, so the write
key reads as a dead one and the "Change: ..." keys as "not decoded".

Reading the proc recovers three shapes:

  - the WRITE proc's argument order and separator (state_proc -> argOrder),
  - each CHANGE proc's edited field and the caption it prompts with
    (state_proc -> fields), gathered file-wide into a slot -> caption map so
    the write form can name each slot by the Change proc that fills it,
  - a "Set default values" key whose body is a plain run of slot copies
    (inline_copy), reloading the edit buffer from the read-back slots.

Execution cannot reach these fields -- the machine yields at its first prompt
and the VM stops -- so the bytecode is walked statically, the same way the
prior static decoder did.
"""

# the hex/int entry dialogs a Change proc opens. Each takes a run of
# caption/limit strings and commits its answer(s) into a global slot with a
# `store` right after the call. inputhex is one field, input2hex is two.
_INPUT_DIALOGS = {
    0x41: ("inputhex", 1),      # (out, title, caption, min, max)
    0x45: ("input2hex", 2),     # (out, out, title, cap1, cap2, mn1, mx1, ...)
    0x44: ("input2hexnum", 2),
    0x46: ("inputint", 1),
    0x42: ("inputdigital", 1),  # (out bool, title, caption, falseStr, trueStr)
}


def state_proc(body):
    """What a Change / write state proc does: its fields and assembled arg.

    Returns {"fields": [{"slot", "title", "caption", "min", "max", "dialog"}],
    "argOrder": [slot, ...], "sep": ";"} with only the parts a given proc
    holds, or None when it neither prompts nor assembles an argument.

    Each field binds to the slot it writes by the commit `store` that follows
    its input call -- the reliable anchor, since the caption strings sit in
    the call frame just before it. The write proc's argument is the last
    add-chain of slots stored into a global; a ";"-joined chain wins.
    """
    out = {"fields": []}
    frame_strs = []
    pending = None                       # (dialog_name, n_outs, [captions])
    committed = 0

    arg_vars = []                        # slots in concatenation order
    arg_sep = None
    building_arg = False

    for t in body:
        op = t["op"]
        if op == "frame":
            frame_strs = []
            continue
        if op == "const":
            if t.get("t") == "s":
                frame_strs.append(t["v"])
                if building_arg and t["v"] in (";", " ", ",", "/"):
                    arg_sep = arg_sep or t["v"]
            continue
        if op == "call":
            d = _INPUT_DIALOGS.get(t["n"])
            if d:
                pending = (d[0], d[1], list(frame_strs))
                committed = 0
                frame_strs = []
            elif t.get("name") not in ("setstatemachine", "getinputstate"):
                pending = None           # any other call ends a form step
            building_arg = False
            arg_vars = []
            continue
        if op == "binop":
            if t.get("name") == "add":
                building_arg = True
            else:
                building_arg = False
                arg_vars = []
            continue
        if op == "var":
            if building_arg or not arg_vars:
                arg_vars.append(t["n"])
            continue
        if op == "store":
            slot = t["n"]
            if pending and committed < pending[1]:
                _commit_field(out, slot, pending, committed)
                committed += 1
                if committed >= pending[1]:
                    pending = None
                continue
            if building_arg and len(arg_vars) >= 2:
                if "argOrder" not in out or arg_sep == ";":
                    out["argOrder"] = list(arg_vars)
                    out["sep"] = arg_sep or ";"
                building_arg = False
                arg_vars = []
                continue
            arg_vars = []
            continue

    if not out["fields"] and "argOrder" not in out:
        return None
    if not out["fields"]:
        del out["fields"]
    return out


def _commit_field(out, slot, pending, committed):
    """Record one dialog answer as a field, reading its caption from the frame.

    inputhex frames as [title, caption, min, max]; input2hex as
    [title, cap1, cap2, mn1, mx1, mn2, mx2]. The caption is what INPA prints
    over the entry box, i.e. what the field means (BMW part number, Supplier).
    """
    caps = pending[2]
    if pending[0] in ("input2hex", "input2hexnum"):
        cap = caps[2 + committed] if len(caps) > 3 + committed else ""
        mn = caps[4 + committed * 2] if len(caps) > 5 + committed * 2 else ""
        mx = caps[5 + committed * 2] if len(caps) > 5 + committed * 2 else ""
        title = caps[0] if caps else ""
    else:
        title = caps[0] if caps else ""
        cap = caps[1] if len(caps) > 1 else ""
        mn = caps[2] if len(caps) > 2 else ""
        mx = caps[3] if len(caps) > 3 else ""
    out["fields"].append({
        "slot": slot, "title": title, "caption": cap,
        "min": mn, "max": mx, "dialog": pending[0]})


def inline_copy(item_body):
    """A "Set default values" key: `var a -> store b` pairs, no dialog or call.

    INPA reloads the edit buffer from the read-back slots this way. Returns
    [[src, dst], ...] or None when the body is anything but a plain copy.
    """
    pairs, src = [], None
    for t in item_body:
        op = t["op"]
        if op == "var" and t.get("sc", 0) == 0:
            src = t["n"]
        elif op == "store" and src is not None and t.get("sc", 0) == 0:
            pairs.append([src, t["n"]])
            src = None
        elif op in ("call", "calluser", "binop", "const", "procref"):
            return None
    return pairs if len(pairs) >= 2 else None


def slot_captions(procs):
    """{slot -> field} across every state proc: what each edit slot means.

    The write proc names its argument slots but not what they hold; the Change
    proc that fills each slot does, via the caption it prompts with. First
    Change proc to fill a slot wins.
    """
    slot_field = {}
    for body in procs.values():
        form = state_proc(body)
        for f in (form or {}).get("fields", []):
            slot_field.setdefault(f["slot"], f)
    return slot_field


def item_copies(menu_toks):
    """{item nr -> [[src, dst], ...]} for the Set-default keys in one menu."""
    marks = [(k, t.get("nr")) for k, t in enumerate(menu_toks)
             if t["op"] == "ITEM" and t.get("nr") is not None]
    out = {}
    for idx, (k, nr) in enumerate(marks):
        end = marks[idx + 1][0] if idx + 1 < len(marks) else len(menu_toks)
        cp = inline_copy(menu_toks[k + 1:end])
        if cp:
            out[nr] = cp
    return out
