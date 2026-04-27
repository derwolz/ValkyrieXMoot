#!/usr/bin/env python3
"""Generate data/moots.json from data/moots.csv.

Schema per row: { id, username, display_name, pfp_file, chibi_file,
animated_file, match_distance, rank }. `animated_file` is null today — it'll
be populated once animated WebPs exist; runtime falls back to chibi_file until
then. `id` stays a string so the Twitter snowflake doesn't lose precision
through a JSON float round-trip.
"""
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / 'data' / 'moots.csv'
OUT_PATH = ROOT / 'data' / 'moots.json'


def s(v):
    return v.strip() if isinstance(v, str) else v


def parse_match_distance(v):
    v = (v or '').strip()
    if not v:
        return None
    try:
        return float(v)
    except ValueError:
        return None


def normalize(row, idx):
    username = s(row.get('username', '')) or ''
    return {
        'id': s(row.get('id', '')) or '',
        'username': username,
        'display_name': s(row.get('display_name', '')) or username,
        'pfp_file': s(row.get('image_file', '')) or None,
        'chibi_file': s(row.get('chibi_file', '')) or None,
        'animated_file': s(row.get('video_file', '')) or None,
        'match_distance': parse_match_distance(row.get('match_distance', '')),
        'rank': idx + 1,
    }


def main():
    rows = []
    with CSV_PATH.open(newline='', encoding='utf-8') as f:
        for i, row in enumerate(csv.DictReader(f)):
            rows.append(normalize(row, i))
    OUT_PATH.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'wrote {len(rows)} moots -> {OUT_PATH}')


if __name__ == '__main__':
    main()
