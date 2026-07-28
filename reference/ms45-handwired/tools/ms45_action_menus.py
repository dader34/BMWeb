#!/usr/bin/env python3
"""Emit the MS45.1 actuator/adjust menus, with the argument each key sends.

extract_menus() recovers the softkey labels; ipo_actions.action_tables()
recovers the value behind each key. This pairs the two and writes an
`actionMenus` block into the enriched layout:

    {"menu": "m_elue", "title": "E-fan", "job": "STEUERN_E_LUEFTER",
     "status": "STATUS_E_LUEFTER", "write": false,
     "keys": [{"fkey": 1, "label": "15%", "value": 16},
              {"fkey": 4, "label": "DME", "value": 255, "release": true}]}

Menus that share a label set (m_tev / m_kfk / m_ll_steller are all
0%/15%/50%/90%/DME) can't be told apart by labels alone, so tables are paired
to menus in FILE ORDER -- the compiler emits both sequences in the same order,
which the offsets confirm.

`write: true` marks a menu that changes the ECU permanently (CO adjustment,
idle programming). The renderer must confirm before sending one of those.

    python3 tools/ms45_action_menus.py            # print
    python3 tools/ms45_action_menus.py --write    # merge into MS450.json
"""
import os
import re
import sys
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_layout as L        # noqa: E402
import ipo_actions as A       # noqa: E402

IPO = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "vendor", "EC-APPS", "INPA", "SGDAT", "MS450.IPO")
LAYOUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "..", "data", "inpa-layouts", "enriched", "MS450.json")

# Every actuation screen in the .IPO reads its STATUS_<X> job and draws the same
# thing: STAT_AUSGANG, optionally with STAT_AUSGANG_TEXT (the decoded wording)
# and STAT_AUSGANG_EINH (its unit). Not a gauge array -- one labelled output
# value, which is exactly what "Status Vanoseinlassventil  33 %" is in INPA.
#
# The pairing is read out of the file rather than hand-listed, so a menu can
# never be missed: for a menu driving STEUERN_X, the readout job is STATUS_X.
_AUSGANG = re.compile(r"^STAT_AUSGANG(_TEXT|_EINH)?$")

# The measurement screen INPA shows on an actuation page, beyond the raw output
# duty: the VANOS page draws cam position AND setpoint for both banks, which is
# a richer readout than STAT_AUSGANG alone. Keyed by menu because the .IPO does
# not link them -- the screen is drawn by a different proc than the softkeys.
MENU_GAUGES = {
    "m_st_vanos": "STATUS_MESSWERTE_VANOS",
    "m_ll_steller": "STATUS_ADAPTION_DK_LLSTELLER",
    "m_hls": "STATUS_SYSTEMCHECK_L_SONDE_WERTE",
    "m_st_dmtl": "STATUS_SYSTEMCHECK_DMTL_WERT",
    "m_st_sls": "STATUS_SYSTEMCHECK_SEK_LUFT_WERT",
    "m_llco": "STATUS_CO_ABGLEICH",
}

# menu -> (english title, the STEUERN_ job it drives, its STATUS_ readback)
MENU_JOB = {
    "m_elue": ("Radiator fan", "STEUERN_E_LUEFTER", "STATUS_E_LUEFTER"),
    "m_tev": ("Purge valve (TEV)", "STEUERN_TEV", "STATUS_TEV"),
    "m_kfk": ("Fuel-tank vent (KFK)", "STEUERN_KFK", "STATUS_KFK"),
    "m_ekp": ("Fuel pump (EKP)", "STEUERN_EKP", "STATUS_EKP"),
    "m_hls": ("O2 sensor heaters", "STEUERN_LSVK1H", "STATUS_LSVK1H"),
    "m_glf": ("Idle-speed valve (GLF)", "STEUERN_GLF", "STATUS_GLF"),
    "m_sta": ("Starter", "STEUERN_STA", "STATUS_STA"),
    "m_korel": ("A/C compressor relay", "STEUERN_KOREL", "STATUS_KOREL"),
    "m_ebl": ("E-box fan (EBL)", "STEUERN_EBL", "STATUS_EBL"),
    "m_vimdisa": ("Intake manifold (VIMDISA)", "STEUERN_VIMDISA", "STATUS_VIMDISA"),
    "m_agk": ("Exhaust flap (AGK)", "STEUERN_AGK", "STATUS_AGK"),
    "m_st_dmtl": ("DMTL leak-diagnosis module", "STEUERN_DMTL_P", "STATUS_DMTL_P"),
    "m_st_sls": ("Secondary-air system", "STEUERN_SLP", "STATUS_SLP"),
    "m_st_vanos": ("VANOS (intake / exhaust)", "STEUERN_VANOS_IN", "STATUS_VANOS_IN"),
    "m_ll_steller": ("Idle actuator", "STEUERN_LL_STELLER", "STATUS_LL_STELLER"),
    "m_mil": ("Check-engine lamp (MIL)", "STEUERN_MIL", "STATUS_MIL"),
    "m_fgr_lampe": ("Cruise-control lamp", "STEUERN_FGRL", "STATUS_FGRL"),
    "m_ev_auswahl": ("Injector cut-out", "STEUERN_EV_1", "STATUS_SYSTEMCHECK_EVAUSBL"),
    # these program the ECU rather than drive an output
    "m_llco": ("CO adjustment", "STEUERN_CO_ABGLEICH_VERSTELL", "STATUS_CO_ABGLEICH"),
    "m_ada_loe": ("Clear adaptations", "STEUERN_ADAPTIONEN_LOESCHEN", None),
    # AIF = Auftrags-Identifikations-Feld: the ECU's flash log. Each entry is
    # one programming event (date, dataset, dealer/tester no., mileage).
    "m_aif": ("Programming history (AIF)", None, None),
}

# menus whose keys change the ECU permanently -- the renderer confirms these
WRITE_MENUS = {"m_llco", "m_ada_loe", "m_llabg"}
# a key that commits the change (as opposed to nudging a working value)
COMMIT = re.compile(r"^(progr?|prog|speichern|programmieren)$", re.I)


def pair_tables_to_menus(path):
    """[(menu_name, table)] paired in file order, since labels alone are ambiguous."""
    with open(path, "rb") as f:
        data = f.read()
    menus = L.extract_menus(path)
    by_name = {m["name"]: m for m in menus}
    tables = A.action_tables(data)

    # menu headers in file order, so an ambiguous table takes the next unused menu
    order = []
    seen = set()
    for m in L._RE_MENU_HDR.finditer(data):
        n = m.group(1).decode("latin-1")
        if n not in seen and n in by_name:
            seen.add(n)
            order.append(n)

    used, out = set(), []
    for t in tables:
        labels = [i["label"].strip() for i in t["items"]]
        cands = [n for n in order
                 if all(x in {(i.get("label") or "").strip()
                              for i in by_name[n]["items"]} for x in labels)]
        if not cands:
            continue
        # a table starting past F9 continues the menu it was split from, so it
        # keeps that menu even though it is already used
        if t["items"][0]["fkey"] > 9 and cands[0] in used:
            out.append((cands[0], t))
            continue
        pick = next((n for n in cands if n not in used), cands[0])
        used.add(pick)
        out.append((pick, t))
    return out


def index_order(path):
    """INPA's actuator index (m_iostatus): its F-key number and caption per menu.

    This is the "Stellgliedansteuerungen" screen -- a plain softkey list, not a
    grid of tiles, and its numbering runs past Back (F11-F19). The captions are
    INPA's own short names ("E-Lüfter", "LL_Steller"), and the ORDER is the one
    INPA presents, which is not the order the value tables appear in the file.
    """
    # index caption -> the menu it opens
    caption_menu = {
        "EV": "m_ev_auswahl", "E-Lüfter": "m_elue", "SLS": "m_st_sls",
        "VANOS": "m_st_vanos", "TEV": "m_tev", "KFK": "m_kfk", "EKP": "m_ekp",
        "Lambda": "m_hls", "GLF": "m_glf", "STA": "m_sta", "KOREL": "m_korel",
        "EBL": "m_ebl", "AGK": "m_agk", "DMTL": "m_st_dmtl",
        "VIMDISA": "m_vimdisa", "LL_Steller": "m_ll_steller", "MIL": "m_mil",
        "FGR": "m_fgr_lampe",
    }
    out = {}
    for mu in L.extract_menus(path):
        if mu["name"] != "m_iostatus":
            continue
        for it in mu["items"]:
            label = (it.get("label") or "").strip()
            menu = caption_menu.get(label)
            if menu:
                out[menu] = {"fkey": it["fkey"], "caption": label}
    return out


def screen_titles(path):
    """INPA's own caption for each actuation screen, in file order.

    Every one is "Ansteuerung <component>" followed by the same subtitle
    ("Setzen der Ansteuerung über I/O Status"). These are INPA's real headings,
    so they beat a hand-written title -- "Ansteuerung Klimakompressor Endstufe"
    says rather more than "A/C compressor relay".
    """
    with open(path, "rb") as f:
        data = f.read()
    out = []
    for m in re.finditer(rb"\x06(Ansteuerung[^\x0a]{0,44})\x0a", data):
        out.append((m.start(), m.group(1).decode("latin-1").strip()))
    return out


def readout_jobs(path):
    """{STATUS_ job: [displayed STAT_AUSGANG* keys]} as the .IPO draws them."""
    with open(path, "rb") as f:
        data = f.read()
    strs = [m.group(1).decode("latin-1")
            for m in re.finditer(rb"\x06([\x20-\x7e\xa0-\xff]{2,44})\x0a", data)]
    out = {}
    for i, s in enumerate(strs):
        if not re.fullmatch(r"STATUS_[A-Z0-9_]+", s):
            continue
        shown = [x for x in strs[i + 1:i + 8] if _AUSGANG.match(x)]
        if shown:
            out.setdefault(s, [])
            for k in shown:
                if k not in out[s]:
                    out[s].append(k)
    return out


def build():
    # only reference a job the SGBD actually implements
    with open(LAYOUT, encoding="utf-8") as f:
        lay = json.load(f)
    known_jobs = {x["job"] for x in lay["screens"]}
    readouts = readout_jobs(IPO)

    # "Ansteuerung X" headings appear in the same order as the menus they head,
    # so pair them positionally -- the file gives no explicit link
    heading_order = ["m_elue", "m_st_vanos", "m_st_sls", "m_tev", "m_kfk",
                     "m_ekp", "m_hls", "m_glf", "m_sta", "m_korel", "m_ebl",
                     "m_vimdisa", "m_agk", "m_st_dmtl", "m_ll_steller",
                     "m_mil", "m_fgr_lampe"]
    titles = {n: t for n, (_o, t) in zip(heading_order, screen_titles(IPO))}
    index = index_order(IPO)

    # a menu whose keys run past F9 is emitted as two tables (F1-F9, then F11+);
    # they belong to the same menu, so fold the continuation into the first
    merged = {}
    order = []
    for name, table in pair_tables_to_menus(IPO):
        if name in merged:
            merged[name]["items"].extend(table["items"])
        else:
            merged[name] = {"items": list(table["items"])}
            order.append(name)

    menus = []
    for name in order:
        table = merged[name]
        title, job, status = MENU_JOB.get(name, (name, None, None))
        keys = []
        for i in table["items"]:
            k = {"fkey": i["fkey"], "label": i["label"], "value": i["value"]}
            if i["release"]:
                k["release"] = True          # 0xFF hands the output back to the DME
            if COMMIT.match(i["label"]):
                k["commit"] = True           # writes permanently
            keys.append(k)
        # some menus drive two outputs from one page: INPA's VANOS screen puts
        # Einlass (E) and Auslass (A) side by side, and a key's prefix says which
        # solenoid it commands. Without this every A-key would drive the intake.
        for k in keys:
            side = re.match(r"^([EA])\s", k["label"])
            if side and name == "m_st_vanos":
                k["job"] = ("STEUERN_VANOS_IN" if side.group(1) == "E"
                            else "STEUERN_VANOS_EX")
            elif name == "m_st_dmtl":
                # P/V/H select the pump, valve and heater solenoids
                pre = k["label"].split()[0] if k["label"].split() else ""
                k["job"] = {"P": "STEUERN_DMTL_P", "V": "STEUERN_DMTL_V",
                            "H": "STEUERN_DMTL_H"}.get(pre, job)

        entry = {"menu": name, "title": title, "keys": keys}
        # INPA's own heading for this screen, when the file gave us one. It also
        # names the page as an I/O STATUS screen: the readouts below run live
        # whether or not you press a key, which is why they poll on open.
        idx = index.get(name)
        if idx:
            entry["indexFkey"] = idx["fkey"]      # INPA's own softkey number
            entry["indexLabel"] = idx["caption"]  # and its short caption
        inpa_title = titles.get(name)
        if inpa_title:
            entry["inpaTitle"] = inpa_title
            entry["subtitle"] = "Set the actuation via I/O status"
        # the readout INPA draws under the keys: one per output this menu drives,
        # so the VANOS page shows intake AND exhaust exactly as INPA does
        outs, seen_out = [], set()
        for k in keys:
            kjob = k.get("job") or job
            if not kjob:
                continue
            sjob = re.sub(r"^STEUERN_", "STATUS_", kjob)
            if sjob in seen_out or sjob not in readouts:
                continue
            seen_out.add(sjob)
            outs.append({"job": sjob, "keys": readouts[sjob]})
        if outs:
            entry["readouts"] = outs
        gauges = MENU_GAUGES.get(name)
        if gauges and gauges in known_jobs:
            entry["gauges"] = gauges          # the full measurement screen
        if job:
            entry["job"] = job
        if status:
            entry["status"] = status
        if name in WRITE_MENUS or any(k.get("commit") for k in keys):
            entry["write"] = True
        menus.append(entry)
    return menus


def main():
    menus = build()
    if "--write" not in sys.argv:
        for m in menus:
            flag = "  [WRITES ECU]" if m.get("write") else ""
            print(f"{m['menu']:16} {m['title']}{flag}")
            print(f"                 job={m.get('job')}  status={m.get('status')}")
            for k in m["keys"]:
                extra = " (release)" if k.get("release") else (
                    " (COMMIT)" if k.get("commit") else "")
                print(f"                   F{k['fkey']:<3} {k['label']:10} -> {k['value']}{extra}")
        print(f"\n{len(menus)} action menus. --write to merge.")
        return 0

    with open(LAYOUT, encoding="utf-8") as f:
        lay = json.load(f)
    lay["actionMenus"] = menus
    with open(LAYOUT, "w", encoding="utf-8") as f:
        json.dump(lay, f, ensure_ascii=False, indent=1)
    print(f"{len(menus)} action menus -> {os.path.relpath(LAYOUT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
