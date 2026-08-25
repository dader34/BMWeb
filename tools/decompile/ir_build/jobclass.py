"""Classify a job by name: does running it change the ECU permanently?

The one answer, used everywhere a write must be gated. PERSISTENT_WRITE is the
real question -- it excludes STEUERN_* (the actuator drive mechanism; flagging
those would disable every activation) but includes the ERASES (LOESCHEN/CLEAR
wipe adaptations for good, as permanent as a write). Kept in one place so the
three call sites that once disagreed cannot: FS_LOESCHEN was flagged on some
items and not others depending only on which decode path found it.
"""

import re

_PERSISTENT_WRITE = re.compile(
    r"EEPROM|SCHREIBEN|_WRITE|PROGRAMMIER|CODIER\w*_SCHREIB|RESET", re.I)
_ERASE = re.compile(r"LOESCHEN|CLEAR", re.I)


def is_write(job):
    """True if `job` changes the ECU permanently (a write or an erase)."""
    if _PERSISTENT_WRITE.search(job):
        return True
    if job.upper().startswith("STEUERN"):
        return False                      # an actuator drive, not a write
    return bool(_ERASE.search(job))
