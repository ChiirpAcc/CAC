#!/usr/bin/env python3
"""Print the body of the sync commit message.

The data diffs are large and entirely numbers, so nobody will ever read one.
The commit message is the only part of this history that carries meaning,
which is why row counts go in it rather than being left for someone to
reconstruct from the diff.
"""

import json
import sys
from pathlib import Path

INDEX_PATH = Path(__file__).resolve().parent.parent / "data" / "index.json"


def main():
    if not INDEX_PATH.exists():
        print("No data/index.json, so the pull did not get far enough to write one.")
        return

    index = json.loads(INDEX_PATH.read_text(encoding="utf-8"))
    files = index.get("files", [])

    lines = ["Pulled {0} at {1}".format(index.get("spreadsheet_id", "unknown sheet"),
                                        index.get("generated_at", "unknown time")), ""]

    width = max((len(f["tab"]) for f in files), default=0)
    for entry in files:
        marker = " (gzipped)" if entry.get("gzipped") else ""
        lines.append("  {0}  {1:>7,} rows{2}".format(entry["tab"].ljust(width),
                                                     entry["row_count"], marker))

    total = sum(f["row_count"] for f in files)
    lines.append("")
    lines.append("  {0}  {1:>7,} rows".format("total".ljust(width), total))

    skipped = index.get("skipped", [])
    if skipped:
        lines.append("")
        lines.append("Optional tabs not present: " + ", ".join(skipped))

    reason = sys.argv[1].strip() if len(sys.argv) > 1 and sys.argv[1].strip() else ""
    if reason:
        lines.append("")
        lines.append("Reason: " + reason)

    print("\n".join(lines))


if __name__ == "__main__":
    main()
