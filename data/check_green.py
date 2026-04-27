#!/usr/bin/env python3
"""Report chibi images by their chroma-key-green pixel fraction.

A failed render is ~near-100% green. A normal chibi is background-only-green
(usually 40-70%). Sorted descending so the likely failures are at the top.

Usage:
    python check_green.py                # list all, sorted by green fraction
    python check_green.py --threshold .9 # only show >=90% green
"""
import argparse
from pathlib import Path

import numpy as np
from PIL import Image

CHIBI = Path(__file__).resolve().parent / "chibi_images"


def green_fraction(path: Path) -> float:
    img = np.asarray(Image.open(path).convert("RGB"))
    # #00FA00 is (0, 250, 0). Tolerance: G very high, R and B very low.
    mask = (img[..., 1] > 200) & (img[..., 0] < 60) & (img[..., 2] < 60)
    return float(mask.mean())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--threshold", type=float, default=0.0)
    args = ap.parse_args()

    results = []
    for p in sorted(CHIBI.iterdir()):
        if not p.is_file():
            continue
        try:
            frac = green_fraction(p)
        except Exception as e:
            print(f"{p.name}\tERR\t{e}")
            continue
        results.append((frac, p.name))

    results.sort(reverse=True)
    shown = 0
    for frac, name in results:
        if frac < args.threshold:
            break
        print(f"{frac:6.1%}  {name}")
        shown += 1
    print(f"--- {shown}/{len(results)} shown ---")


if __name__ == "__main__":
    main()
