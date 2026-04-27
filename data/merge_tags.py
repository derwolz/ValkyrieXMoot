#!/usr/bin/env python3
"""Merge tags/batch_*.json into moots.csv as a tags column.

Usage:
    python merge_tags.py
"""
import csv
import json
from pathlib import Path

tag_files = sorted(Path("tags").glob("batch_*.json"))
print(f"found {len(tag_files)} batch files")

merged = {}
for f in tag_files:
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"  SKIP {f.name}: {e}")
        continue
    merged.update(data)
    print(f"  {f.name}: {len(data)} entries")

print(f"total tagged: {len(merged)}")

csv_path = Path("moots.csv")
rows = list(csv.DictReader(csv_path.open(encoding="utf-8")))
fields = list(rows[0].keys()) if rows else []
if "tags" not in fields:
    fields.append("tags")

missing = 0
for r in rows:
    r["tags"] = merged.get(r.get("image_file", ""), "")
    if r.get("image_file") and not r["tags"]:
        missing += 1

tmp = csv_path.with_suffix(".csv.tmp")
with tmp.open("w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=fields)
    w.writeheader()
    for r in rows:
        w.writerow({k: r.get(k, "") for k in fields})
tmp.replace(csv_path)

print(f"wrote moots.csv — {missing} rows have an image but no tags")
