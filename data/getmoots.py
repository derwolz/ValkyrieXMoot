#!/usr/bin/env python3
"""Collect Twitter mutuals (moots) via twitterapi.io.

Usage:
    export TWITTERAPI_KEY=your_key_here
    python getmoots.py <your_twitter_username>

Outputs:
    moots.csv  - id,username,display_name,image_file
    images/    - profile pictures named <username>.<ext>
"""
import argparse
import csv
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

import requests

BASE = "https://api.twitterapi.io/twitter/user"


def fetch_all(endpoint, username, session):
    key = "followers" if endpoint == "followers" else "followings"
    users = []
    cursor = ""
    while True:
        r = session.get(
            f"{BASE}/{endpoint}",
            params={"userName": username, "cursor": cursor, "pageSize": 200},
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        batch = data.get(key) or []
        users.extend(batch)
        print(f"  {endpoint}: +{len(batch)} (total {len(users)})", file=sys.stderr)
        if not data.get("has_next_page") or not data.get("next_cursor"):
            break
        cursor = data["next_cursor"]
    return users


def download_image(url, dest_dir, stem):
    # Twitter serves _normal (48px) by default; bump to 400x400 for a usable image.
    url = url.replace("_normal.", "_400x400.")
    ext = os.path.splitext(urlparse(url).path)[1] or ".jpg"
    path = dest_dir / f"{stem}{ext}"
    try:
        r = requests.get(url, timeout=30)
        r.raise_for_status()
        path.write_bytes(r.content)
        return path.name
    except requests.RequestException as e:
        print(f"  image download failed for @{stem}: {e}", file=sys.stderr)
        return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("username", help="Your Twitter screen name (no @)")
    ap.add_argument("--out", default=".", help="Output directory (default: cwd)")
    args = ap.parse_args()

    api_key = os.environ.get("TWITTERAPI_KEY")
    if not api_key:
        sys.exit("error: set TWITTERAPI_KEY in your environment")

    out = Path(args.out)
    img_dir = out / "images"
    img_dir.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    session.headers["X-API-Key"] = api_key

    print(f"Fetching followers of @{args.username}…", file=sys.stderr)
    followers = fetch_all("followers", args.username, session)
    print(f"Fetching followings of @{args.username}…", file=sys.stderr)
    followings = fetch_all("followings", args.username, session)

    follower_ids = {u["id"] for u in followers}
    moots = [u for u in followings if u["id"] in follower_ids]
    print(
        f"\n{len(moots)} mutuals "
        f"(followers: {len(followers)}, following: {len(followings)})",
        file=sys.stderr,
    )

    csv_path = out / "moots.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["id", "username", "display_name", "image_file"])
        for i, u in enumerate(moots, 1):
            uname = u["userName"]
            print(f"[{i}/{len(moots)}] @{uname}", file=sys.stderr)
            pic = u.get("profilePicture") or ""
            fname = download_image(pic, img_dir, uname) if pic else ""
            w.writerow([u["id"], uname, u.get("name", ""), fname])

    print(f"\nWrote {csv_path} and {img_dir}/", file=sys.stderr)


if __name__ == "__main__":
    main()
