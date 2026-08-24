"""Where a screen's questions about the car get answered, at build time.

The VM runs each screen offline. `OkHost` answers as a healthy module would
(JOB_STATUS OKAY, one of everything for a count) so a screen renders its full
structure; `FailHost` answers as an absent one so the error arm executes and
its dialogs are captured. Running both is how the derived IR carries what INPA
shows on success AND on failure.
"""

import ipo_vm as V


class OkHost(V.Host):
    """The default offline host: every read succeeds, structure fully drawn."""


class FailHost(V.Host):
    """Every job fails -- whatever a screen does now is its error arm."""

    def status(self):
        return "ERROR_ECU_NICHT_VORHANDEN"
