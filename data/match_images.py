#!/usr/bin/env python3
"""Match each moot's profile picture in images/ against a reference folder
using perceptual hashing. Adds a matched_file column to moots.csv with the
reference filename of the best match (blank if none within threshold).

Usage:
    python match_images.py <reference_folder> [--threshold 8]
"""
import argparse
import csv
import sys
from pathlib import Path

from PIL import Image
import imagehash

IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}


def hash_folder(folder):
    """Return {filename: phash} for every image file in folder."""
    hashes = {}
    for p in sorted(folder.iterdir()):
        if p.suffix.lower() not in IMG_EXTS or not p.is_file():
            continue
        try:
            with Image.open(p) as im:
                hashes[p.name] = imagehash.phash(im)
        except Exception as e:
            print(f"  skip {p.name}: {e}", file=sys.stderr)
    return hashes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("reference", help="Folder of reference images to match against")
    ap.add_argument("--threshold", type=int, default=8,
                    help="Max hamming distance for a match (default 8)")
    ap.add_argument("--images", default="images", help="Folder with moot images")
    ap.add_argument("--csv", default="moots.csv", help="CSV to update")
    args = ap.parse_args()

    ref_dir = Path(args.reference)
    img_dir = Path(args.images)
    csv_path = Path(args.csv)

    print(f"hashing reference ({ref_dir})…", file=sys.stderr)
    ref_hashes = hash_folder(ref_dir)
    print(f"  {len(ref_hashes)} reference images", file=sys.stderr)

    print(f"hashing moot images ({img_dir})…", file=sys.stderr)
    moot_hashes = hash_folder(img_dir)
    print(f"  {len(moot_hashes)} moot images", file=sys.stderr)

    with csv_path.open(encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
        original_fields = list(rows[0].keys()) if rows else ["id", "username", "display_name", "image_file"]

    out_fields = list(original_fields)
    if "matched_file" not in out_fields:
        out_fields.append("matched_file")
    if "match_distance" not in out_fields:
        out_fields.append("match_distance")

    matched = 0
    tmp = csv_path.with_suffix(".csv.tmp")
    with tmp.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=out_fields)
        w.writeheader()
        for row in rows:
            img_name = row.get("image_file", "")
            best_name, best_dist = "", None
            if img_name and img_name in moot_hashes:
                h = moot_hashes[img_name]
                for ref_name, ref_h in ref_hashes.items():
                    d = h - ref_h
                    if best_dist is None or d < best_dist:
                        best_name, best_dist = ref_name, d
            if best_dist is not None and best_dist <= args.threshold:
                row["matched_file"] = best_name
                row["match_distance"] = best_dist
                matched += 1
            else:
                row["matched_file"] = ""
                row["match_distance"] = ""
            w.writerow({k: row.get(k, "") for k in out_fields})

    tmp.replace(csv_path)
    print(f"done — {matched}/{len(rows)} moots matched (threshold {args.threshold})", file=sys.stderr)


if __name__ == "__main__":
    main()
