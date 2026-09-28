#!/usr/bin/env python3
"""Seal the deployed JSON so a text fetch of the site returns nothing readable.

Every figure on the site is drawn in the browser from JSON it fetches after
load. The page source carries no numbers, but the JSON under /data did, in
plain text, so anyone who pointed a language model at the site could have it
read the data files directly and summarise them, which is how a set of
figures that are not on the site came to be attributed to it.

This runs at deploy time, on the copy in _site/data, and never on the
repository's own data/. Each *.json is gzipped, base64-encoded, and written
back under the same name behind a one-line marker. The browser's readFile
sees the marker and decodes; the local preview serves the plain files from
the repository and passes straight through; a fetch gets a marker and a wall
of base64.

This is friction, not security. The repository is public and the plain
files are on github.com. A browser decodes this on every load, and so would
any agent that runs one. What it stops is the common case: a person pasting
the site's address into a chat window and getting a summary of files they
never saw.

A side effect worth having: the largest file goes from about ten megabytes
on the wire to about one and a half.
"""
import base64
import gzip
import sys
from pathlib import Path

MARKER = b"CHIIRP-SEALED-1\n"


def seal(path: Path) -> tuple[int, int]:
    raw = path.read_bytes()
    if raw.startswith(MARKER):
        return len(raw), len(raw)
    packed = base64.b64encode(gzip.compress(raw, compresslevel=9))
    path.write_bytes(MARKER + packed + b"\n")
    return len(raw), len(packed)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: seal_data.py <deployed data dir>", file=sys.stderr)
        return 2
    root = Path(argv[1])
    if not root.is_dir():
        print(f"not a directory: {root}", file=sys.stderr)
        return 2
    total_in = total_out = 0
    for path in sorted(root.glob("*.json")):
        before, after = seal(path)
        total_in += before
        total_out += after
        print(f"sealed {path.name}: {before:,} -> {after:,} bytes")
    print(f"total {total_in:,} -> {total_out:,} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
