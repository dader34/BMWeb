"""One argparse builder for the hand-run generators under tools/.

Almost every generator takes the same shape of command line: zero or more
names (ECUs, SGBDs, chassis) plus a few `--flag` switches, and until now each
script hand-parsed it with its own copy of

    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    write = "--write" in sys.argv

That copy accepted any spelling, silently ignored a misspelt flag, and gave
no `--help`. This module builds an argparse parser from a compact
description so the scripts keep their exact flag names and positional
semantics (names and flags may be interleaved) while gaining help text and
a loud error on an unknown option.

    from _cli import parse_args
    ns = parse_args(__doc__, positional=("ecu", "*", "an ECU (.IPO stem)"),
                    flags={"--write": "write the corpus result to disk"})
    ns.ecu     # list of names
    ns.write   # bool

Importable from any tool directory: tools/ itself is on sys.path for the
sgbd/, export/ and verify/ scripts (see tools/sgbd/_engine.py) and the
decompile/ scripts add it themselves.
"""
import argparse
from typing import Dict, Iterable, List, Optional, Tuple

# (name, nargs, help) -- the positional most generators take
PositionalSpec = Tuple[str, str, str]
# --flag -> help text, each a store_true switch
FlagSpecs = Dict[str, str]
# --option -> (METAVAR, help text), each taking one value
OptionSpecs = Dict[str, Tuple[str, str]]


def build_parser(doc: Optional[str],
                 positional: Optional[PositionalSpec] = None,
                 flags: Optional[FlagSpecs] = None,
                 options: Optional[OptionSpecs] = None,
                 prog: Optional[str] = None) -> argparse.ArgumentParser:
    """Build the parser a generator's `main()` hands to :func:`parse_args`.

    Args:
        doc: The script's module docstring; shown verbatim by ``--help``.
        positional: ``(dest, nargs, help)`` for the positional names, or
            None for a script that takes none.
        flags: ``{"--flag": help}`` switches, each stored as a bool under
            the flag's name without dashes (``--all-jobs`` -> ``all_jobs``).
        options: ``{"--opt": (METAVAR, help)}`` options taking one value,
            stored as a string (None when absent).
        prog: The program name for usage lines; defaults to argparse's.

    Returns:
        The configured :class:`argparse.ArgumentParser`.
    """
    ap = argparse.ArgumentParser(
        prog=prog, description=doc,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    if positional:
        dest, nargs, help_text = positional
        ap.add_argument(dest, nargs=nargs, help=help_text)
    for flag, help_text in (flags or {}).items():
        ap.add_argument(flag, action="store_true", help=help_text)
    for opt, (metavar, help_text) in (options or {}).items():
        ap.add_argument(opt, metavar=metavar, help=help_text)
    return ap


def parse_args(doc: Optional[str],
               positional: Optional[PositionalSpec] = None,
               flags: Optional[FlagSpecs] = None,
               options: Optional[OptionSpecs] = None,
               argv: Optional[Iterable[str]] = None,
               prog: Optional[str] = None) -> argparse.Namespace:
    """Parse a generator's command line, names and flags in any order.

    Args:
        doc: See :func:`build_parser`.
        positional: See :func:`build_parser`.
        flags: See :func:`build_parser`.
        options: See :func:`build_parser`.
        argv: The arguments to parse (default: ``sys.argv[1:]``).
        prog: See :func:`build_parser`.

    Returns:
        The parsed :class:`argparse.Namespace`.

    Raises:
        SystemExit: On ``--help`` or an unknown option (argparse's own exit).
    """
    ap = build_parser(doc, positional, flags, options, prog)
    args: Optional[List[str]] = list(argv) if argv is not None else None
    # intermixed: `ecu1 --write ecu2` keeps both names, the way the old
    # hand-parsing did
    return ap.parse_intermixed_args(args)
