#!/usr/bin/env python3
"""Pull tabs out of the LTV:CAC workbook and write one JSON file per tab.

The workbook stays the source of truth. This script only moves numbers, and
it is deliberately willing to fail. A sync that fetches the wrong rows is
worse than one that stops, because the wrong rows ship silently and then
somebody reads them and believes them.

Never point this at the report tabs (Master, CAC Dashboard, Payback
Forecast, Cohort Retention, Logo Evidence, Customer Matrix). Those are laid
out for a human, with mastheads and merged cells and charts anchored to a
band, and they break the first time a section moves. Everything in them is
derived from the tabs listed in the manifest anyway.
"""

from __future__ import annotations

import gzip
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
MANIFEST_PATH = DATA_DIR / "manifest.json"

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

# Months are text, always YYYY-MM. Sheets parses an unprotected 2025-01 as a
# date and hands it back as 2025-1 or 1/1/2025, and 2025-1 sorts after
# 2025-10 as text, so cost months quietly stop lining up with cohort months.
MONTH_PATTERN = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")

# Things a human or a formula writes to mean "nothing here". These become
# None, never zero. A cohort that never recovers its CAC has no payback
# number, and zero would plot as instant payback, the opposite of the truth.
BLANK_TOKENS = {"", "-", "--", "n/a", "n.a.", "na", "none", "null", "#n/a"}

# Sheet errors are not blanks. A #REF! means a formula broke, and silently
# reading it as missing data hides the breakage.
ERROR_TOKENS = {"#ref!", "#value!", "#div/0!", "#name?", "#num!", "#null!"}


class ValidationError(Exception):
    """Raised when what came back is not what the site can safely read."""


def fail(message):
    print("\nSYNC FAILED\n\n" + message + "\n", file=sys.stderr)
    sys.exit(1)


def normalise_header(raw):
    """Turn a human column heading into the key the site expects.

    "Beginning MRR" and "beginning_mrr" and "Beginning  MRR " all land on
    beginning_mrr, so somebody can retitle a column in the sheet for
    readability without breaking the pull.
    """
    text = str(raw).strip().lower()
    text = re.sub(r"[^a-z0-9]+", "_", text)
    return text.strip("_")


def parse_number(raw, tab, row_number, column):
    """Parse a formatted cell into a float, or None when it is genuinely empty.

    Sheets hands back display strings because we ask for FORMATTED_VALUE, so
    this has to cope with thousands separators, currency symbols, accounting
    parentheses for negatives, and trailing percent signs.
    """
    if raw is None:
        return None

    text = str(raw).strip()
    lowered = text.lower()

    if lowered in BLANK_TOKENS:
        return None
    if lowered in ERROR_TOKENS:
        raise ValidationError(
            "{0!r} row {1}, column {2!r} contains the sheet error {3}. A formula "
            "in the workbook is broken. Fix it there rather than teaching this "
            "script to ignore it.".format(tab, row_number, column, text)
        )

    negative = False
    if text.startswith("(") and text.endswith(")"):
        negative = True
        text = text[1:-1].strip()

    percent = text.endswith("%")
    if percent:
        text = text[:-1].strip()

    for junk in (",", "$", " ", " ", " "):
        text = text.replace(junk, "")

    if text.startswith("-"):
        negative = True
        text = text[1:]
    elif text.startswith("+"):
        text = text[1:]

    if text in ("", "."):
        return None

    try:
        value = float(text)
    except ValueError:
        raise ValidationError(
            "{0!r} row {1}, column {2!r} holds {3!r}, which is not a number. "
            "Either the column moved or a text note was typed into a numeric "
            "cell.".format(tab, row_number, column, raw)
        ) from None

    if percent:
        value /= 100.0

    return -value if negative else value


def load_manifest():
    if not MANIFEST_PATH.exists():
        fail("No manifest at {0}. Nothing tells this script what to pull.".format(MANIFEST_PATH))
    try:
        return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail("{0} is not valid JSON: {1}".format(MANIFEST_PATH, exc))


def build_service():
    """Authenticate as the service account named in GOOGLE_SERVICE_ACCOUNT_JSON."""
    raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip()
    if not raw:
        fail(
            "GOOGLE_SERVICE_ACCOUNT_JSON is not set.\n\n"
            "Two things are needed, and people usually do only the first:\n"
            "  1. Add the service account JSON key as a repository secret\n"
            "     named GOOGLE_SERVICE_ACCOUNT_JSON.\n"
            "  2. Share the spreadsheet with that service account's\n"
            "     client_email address, as Viewer.\n\n"
            "Without step 2 the Sheets API returns 404 rather than a permission\n"
            "error, which sends people looking for the wrong problem.\n\n"
            "See data/README.md for the full walkthrough."
        )

    try:
        info = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(
            "GOOGLE_SERVICE_ACCOUNT_JSON is set but is not valid JSON: {0}\n\n"
            "Paste the whole key file, including the outer braces. A common\n"
            "mistake is pasting only the private_key value.".format(exc)
        )

    missing = [k for k in ("client_email", "private_key") if k not in info]
    if missing:
        fail(
            "GOOGLE_SERVICE_ACCOUNT_JSON parsed but is missing {0}. That is not "
            "a service account key file.".format(", ".join(missing))
        )

    print("Authenticating as " + info["client_email"])
    credentials = service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
    return build("sheets", "v4", credentials=credentials, cache_discovery=False)


def fetch_tab(service, spreadsheet_id, tab, required):
    """Return the raw grid for one tab, or None when an optional tab is absent."""
    try:
        response = (
            service.spreadsheets()
            .values()
            .get(
                spreadsheetId=spreadsheet_id,
                range="'{0}'".format(tab),
                # Formatted values, so months stay the text the workbook wrote
                # rather than being handed back as serial dates.
                valueRenderOption="FORMATTED_VALUE",
                dateTimeRenderOption="FORMATTED_STRING",
            )
            .execute()
        )
    except HttpError as exc:
        status = getattr(exc.resp, "status", None)
        if status == 404:
            fail(
                "The Sheets API returned 404 for spreadsheet {0}.\n\n"
                "This almost always means the service account cannot see the\n"
                "spreadsheet, not that the spreadsheet is missing. The API hides\n"
                "the difference. Share the sheet with the service account's\n"
                "client_email as Viewer and run this again.".format(spreadsheet_id)
            )
        if status == 400 and "Unable to parse range" in str(exc):
            if not required:
                print("  optional tab {0!r} is absent, skipping".format(tab))
                return None
            fail(
                "Tab {0!r} does not exist in the spreadsheet.\n\n"
                "Either it was renamed, or the manifest is pointing at a tab that\n"
                "was never built. Check the tab name exactly, including case and\n"
                "spacing.".format(tab)
            )
        if status == 403:
            fail(
                "The Sheets API returned 403. Either the Google Sheets API is not\n"
                "enabled on the service account's Cloud project, or the key has\n"
                "been disabled."
            )
        fail("Sheets API error while reading {0!r}: {1}".format(tab, exc))

    return response.get("values", [])


def shape_rows(tab_spec, grid):
    """Turn a raw grid into typed dict rows keyed by the manifest column names."""
    tab = tab_spec["tab"]

    if not grid:
        raise ValidationError(
            "{0!r} came back completely empty. The tab exists but has no rows, "
            "which usually means it was cleared and not rebuilt.".format(tab)
        )

    headers_raw = grid[0]
    headers = [normalise_header(h) for h in headers_raw]

    wanted = tab_spec["columns"]
    if not wanted:
        # Optional tabs whose shape nobody has settled yet. Take what is there.
        wanted = [h for h in headers if h]

    missing = [c for c in wanted if c not in headers]
    if missing:
        raise ValidationError(
            "{0!r} is missing required column(s): {1}\n"
            "What row 1 actually contains: {2}\n"
            "Normalised to: {3}\n"
            "A column was probably renamed or reordered, or a title row was "
            "inserted above the headers.".format(
                tab,
                ", ".join(missing),
                ", ".join(repr(h) for h in headers_raw),
                ", ".join(repr(h) for h in headers),
            )
        )

    extras = [h for h in headers if h and h not in wanted]
    if extras:
        print("  note: ignoring extra column(s) " + ", ".join(extras))

    index_of = {c: headers.index(c) for c in wanted}
    numeric = set(tab_spec.get("numeric", []))

    rows = []
    for offset, raw_row in enumerate(grid[1:], start=2):
        # Sheets trims trailing empty cells, so rows come back ragged.
        padded = list(raw_row) + [""] * (len(headers) - len(raw_row))

        if not any(str(cell).strip() for cell in padded):
            continue  # entirely empty row, an artifact of the grid extending down

        record = {}
        for column in wanted:
            cell = padded[index_of[column]]
            if column in numeric:
                record[column] = parse_number(cell, tab, offset, column)
            else:
                text = str(cell).strip()
                record[column] = text if text else None
        rows.append(record)

    return wanted, rows


def validate(tab_spec, columns, rows):
    tab = tab_spec["tab"]
    checks = tab_spec.get("checks", {})

    min_rows = checks.get("min_rows")
    if min_rows is not None and len(rows) < min_rows:
        raise ValidationError(
            "{0!r} returned {1} rows, fewer than the {2} expected. The tab was "
            "probably not rebuilt, or a filter is hiding rows, or the pull that "
            "feeds it failed upstream.".format(tab, len(rows), min_rows)
        )

    for column in checks.get("month_format", []):
        bad = [
            (i, r.get(column))
            for i, r in enumerate(rows, start=2)
            if not (r.get(column) and MONTH_PATTERN.match(str(r[column])))
        ]
        if bad:
            sample = ", ".join("row {0}: {1!r}".format(i, v) for i, v in bad[:5])
            raise ValidationError(
                "{0!r} column {1!r} has {2} value(s) that are not YYYY-MM text.\n"
                "Examples: {3}\n\n"
                "The cause is almost never what the symptom looks like. The column "
                "lost its plain-text formatting, so Sheets reparsed 2025-01 as a "
                "date and wrote it back as 2025-1 or 1/1/2025. Reformat the column "
                "as plain text in the workbook and rewrite the months. Left as is, "
                "2025-1 sorts after 2025-10 and cost months stop lining up with "
                "cohort months.".format(tab, column, len(bad), sample)
            )

    for column in checks.get("not_all_zero", []):
        if all(r.get(column) in (None, 0) for r in rows):
            raise ValidationError(
                "{0!r} column {1!r} is entirely zero or blank across {2} rows. A "
                "real column this central is never all zero, so the formula behind "
                "it is broken or its source is empty.".format(tab, column, len(rows))
            )

    for column, allowed in checks.get("allowed_values", {}).items():
        permitted = set(allowed)
        # Blank is tolerated, since a trailing unfilled cell is not the same
        # as a value that was classified wrongly.
        bad = [
            (i, r.get(column))
            for i, r in enumerate(rows, start=2)
            if r.get(column) is not None and r[column] not in permitted
        ]
        if bad:
            sample = ", ".join("row {0}: {1!r}".format(i, v) for i, v in bad[:5])
            raise ValidationError(
                "{0!r} column {1!r} holds {2} value(s) outside {3}.\n"
                "Examples: {4}\n\n"
                "Either a new bucket was introduced in the workbook without being "
                "added to data/manifest.json, or a typo crept into the "
                "classification.".format(tab, column, len(bad), sorted(permitted), sample)
            )

    for column in checks.get("allowed_values", {}):
        blanks = sum(1 for r in rows if r.get(column) is None)
        if blanks:
            print("  note: {0} row(s) have a blank {1}".format(blanks, column))


def write_tab(tab_spec, columns, rows, threshold):
    payload = {
        "tab": tab_spec["tab"],
        "pulled_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "columns": columns,
        "row_count": len(rows),
        "rows": rows,
    }

    base = tab_spec["output"]
    plain_path = DATA_DIR / base
    gz_path = DATA_DIR / (base + ".gz")

    # Small files stay uncompressed so the diff is readable in a pull request.
    # The customer waterfall is around 51,000 rows and is not readable anyway.
    gzipped = len(rows) > threshold
    body = json.dumps(payload, indent=None if gzipped else 2, ensure_ascii=False)

    if gzipped:
        # mtime=0 so an unchanged pull produces an identical file and no commit.
        with gzip.GzipFile(str(gz_path), "wb", mtime=0) as handle:
            handle.write(body.encode("utf-8"))
        plain_path.unlink(missing_ok=True)
        written = gz_path
    else:
        plain_path.write_text(body + "\n", encoding="utf-8")
        gz_path.unlink(missing_ok=True)
        written = plain_path

    size = written.stat().st_size
    print("  wrote {0}  {1} rows, {2:,} bytes".format(written.name, len(rows), size))

    return {
        "tab": tab_spec["tab"],
        "file": written.name,
        "row_count": len(rows),
        "gzipped": gzipped,
        "bytes": size,
        "pulled_at": payload["pulled_at"],
    }


def main():
    manifest = load_manifest()
    spreadsheet_id = os.environ.get("SPREADSHEET_ID", "").strip() or manifest["spreadsheet_id"]
    threshold = manifest.get("gzip_row_threshold", 5000)

    service = build_service()
    print("Reading spreadsheet {0}\n".format(spreadsheet_id))

    entries = []
    skipped = []

    for tab_spec in manifest["tabs"]:
        tab = tab_spec["tab"]
        required = tab_spec.get("required", True)
        print(tab)

        grid = fetch_tab(service, spreadsheet_id, tab, required)
        if grid is None:
            skipped.append(tab)
            continue

        try:
            columns, rows = shape_rows(tab_spec, grid)
            validate(tab_spec, columns, rows)
        except ValidationError as exc:
            if not required:
                print("  optional tab {0!r} did not validate, skipping: {1}".format(tab, exc))
                skipped.append(tab)
                continue
            fail(str(exc))

        entries.append(write_tab(tab_spec, columns, rows, threshold))

    index = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "spreadsheet_id": spreadsheet_id,
        "files": entries,
        "skipped": skipped,
    }
    (DATA_DIR / "index.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")

    total = sum(e["row_count"] for e in entries)
    print("\nWrote {0} file(s), {1:,} rows total".format(len(entries), total))
    if skipped:
        print("Skipped optional tab(s): " + ", ".join(skipped))


if __name__ == "__main__":
    main()
