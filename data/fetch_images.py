#!/usr/bin/env python3
"""Read moots.csv, fetch profile pictures via batch_info_by_ids, save images
and overwrite moots.csv with the image_file column populated.

Usage:
    export TWITTERAPI_KEY=your_key
    python fetch_images.py
"""
import csv
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

import requests

BASE = "https://api.twitterapi.io/twitter/user"
IMAGE_KEYS = ("profilePicture", "profile_image_url_https", "profile_image_url")


def pic_url(user):
    for k in IMAGE_KEYS:
        v = user.get(k)
        if v:
            return v
    return ""


def download(url, dest_dir, stem):
    url = url.replace("_normal.", "_400x400.")
    ext = os.path.splitext(urlparse(url).path)[1] or ".jpg"
    path = dest_dir / f"{stem}{ext}"
    try:
        r = requests.get(url, timeout=30)
        r.raise_for_status()
        path.write_bytes(r.content)
        return path.name
    except requests.RequestException as e:
        print(f"  download failed @{stem}: {e}", file=sys.stderr)
        return ""


def batches(seq, n=100):
    for i in range(0, len(seq), n):
        yield seq[i : i + n]


def main():
    api_key = os.environ.get("TWITTERAPI_KEY")
    if not api_key:
        sys.exit("error: set TWITTERAPI_KEY")

    session = requests.Session()
    session.headers["X-API-Key"] = api_key

    with open("moots.csv", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    print(f"loaded {len(rows)} moots", file=sys.stderr)

    img_dir = Path("images")
    img_dir.mkdir(exist_ok=True)

    id_to_url = {}
    first = True
    for chunk in batches([r["id"] for r in rows]):
        r = session.get(
            f"{BASE}/batch_info_by_ids",
            params={"userIds": ",".join(chunk)},
            timeout=60,
        )
        r.raise_for_status()
        data = r.json()
        users = data.get("users") or []
        if first and users:
            print("sample user field names:", list(users[0].keys()), file=sys.stderr)
            print("sample pic value:", repr(pic_url(users[0])), file=sys.stderr)
            first = False
        for u in users:
            id_to_url[str(u.get("id"))] = pic_url(u)
        print(f"  batch: got {len(users)} users (total {len(id_to_url)})", file=sys.stderr)

    missing_url = sum(1 for r in rows if not id_to_url.get(r["id"]))
    print(f"{missing_url} moots had no image URL in API response", file=sys.stderr)

    with open("moots.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["id", "username", "display_name", "image_file"])
        for i, row in enumerate(rows, 1):
            url = id_to_url.get(row["id"], "")
            fname = download(url, img_dir, row["username"]) if url else ""
            print(f"[{i}/{len(rows)}] @{row['username']}{' [no url]' if not url else ''}", file=sys.stderr)
            w.writerow([row["id"], row["username"], row["display_name"], fname])

    print("done", file=sys.stderr)


if __name__ == "__main__":
    main()
