#!/usr/bin/env python3
"""Batch runner: transform each matched moot image into a chibi avatar via Grok's
media pipeline. One job at a time, 10-20s jittered sleep between jobs.

Usage:
    python run_chibi.py                # process all pending
    python run_chibi.py --limit 1      # just one row (sanity check)
    python run_chibi.py --dump         # print raw responses, exit after first job
"""
import argparse
import base64
import csv
import json
import random
import sys
import time
from pathlib import Path

import browser_cookie3
import requests

ROOT = Path(__file__).resolve().parent
IMAGES = ROOT / "images"
CHIBI = ROOT / "chibi_images"
CSV_PATH = ROOT / "moots.csv"
PROMPT_PATH = ROOT / "prompt.txt"

ASSETS_URL = "https://grok.com/rest/assets"
PIPELINE_URL = "https://grok.com/rest/media/pipeline/run"
ASSET_CONTENT_URL = "https://assets.grok.com/users/{user_id}/{asset_id}/content"

MIN_SLEEP = 10
MAX_SLEEP = 20
PIPELINE_TIMEOUT = 600


def build_spec_json(prompt_text: str) -> str:
    """Inline pipeline spec: image_edit node with our prompt baked in."""
    spec = {
        "version": 1,
        "inputs": {
            "photo": {"type": "image", "label": "Your photo"},
            "style_prompt": {
                "type": "text",
                "fixed": {"type": "text", "value": prompt_text},
            },
        },
        "nodes": {
            "stylize": {
                "type": "image_edit",
                "inputs": {"image": "$input.photo", "prompt": "$input.style_prompt"},
            },
        },
        "outputs": {"result": "$stylize.image"},
    }
    return json.dumps(spec)


def make_session():
    cj = browser_cookie3.brave(domain_name="grok.com")
    s = requests.Session()
    s.cookies = cj
    s.headers.update({
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://grok.com/imagine",
        "Origin": "https://grok.com",
    })
    return s


def mime_for(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in (".jpg", ".jpeg"):
        return "image/jpeg"
    if ext == ".png":
        return "image/png"
    if ext == ".webp":
        return "image/webp"
    if ext == ".gif":
        return "image/gif"
    return "application/octet-stream"


def upload_asset(s: requests.Session, img_path: Path, dump=False) -> tuple[str, str]:
    body = {
        "name": img_path.name,
        "mimeType": mime_for(img_path),
        "content": base64.b64encode(img_path.read_bytes()).decode(),
        "makePublic": True,
        "fileSource": "FILE_SOURCE_USER_UPLOAD",
    }
    r = s.post(ASSETS_URL, json=body, timeout=120)
    if dump:
        print("  [dump] asset status:", r.status_code)
        print("  [dump] asset body:", r.text[:2000])
    r.raise_for_status()
    j = r.json()

    asset_id = (
        j.get("assetId")
        or j.get("id")
        or (j.get("asset") or {}).get("assetId")
        or (j.get("asset") or {}).get("id")
    )
    user_id = (
        j.get("userId")
        or (j.get("asset") or {}).get("userId")
        or (j.get("asset") or {}).get("ownerId")
    )
    # Fallback: parse key like "users/<user_id>/<asset_id>/content"
    if not user_id or not asset_id:
        key = j.get("key") or (j.get("asset") or {}).get("key") or ""
        parts = key.split("/")
        if len(parts) >= 4 and parts[0] == "users":
            user_id = user_id or parts[1]
            asset_id = asset_id or parts[2]
    if not asset_id or not user_id:
        raise RuntimeError(f"could not find asset/user id in response: {json.dumps(j)[:500]}")
    return asset_id, user_id


def run_pipeline(s: requests.Session, image_url: str, spec_json: str, dump=False) -> dict:
    body = {
        "specJson": spec_json,
        "inputs": [{"name": "photo", "imageUrl": image_url}],
    }
    r = s.post(PIPELINE_URL, json=body, stream=True, timeout=PIPELINE_TIMEOUT)
    r.raise_for_status()
    final = None
    last_prog = -1
    for raw in r.iter_lines(decode_unicode=True):
        if not raw:
            continue
        try:
            j = json.loads(raw)
        except Exception:
            continue
        final = j
        res = j.get("result", {})
        status = res.get("pipelineStatus")
        prog = res.get("overallProgressPct", 0)
        if prog != last_prog:
            steps = res.get("steps", [])
            tags = [(st.get("stepName"), st.get("status"), st.get("progressPct")) for st in steps]
            print(f"    {status} prog={prog} {tags}")
            last_prog = prog
    if dump and final is not None:
        print("  [dump] pipeline final:", json.dumps(final)[:3000])
    if final is None:
        raise RuntimeError("no frames in pipeline response")
    return final


def _walk_urls(obj, out):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, str) and k in (
                "mediaUrl", "imageUrl", "outputUrl", "url", "assetUrl", "contentUrl"
            ) and v.startswith("http"):
                out.append(v)
            else:
                _walk_urls(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _walk_urls(v, out)


def extract_image_urls(final: dict) -> list[str]:
    urls: list[str] = []
    _walk_urls(final, urls)
    seen = set()
    deduped = []
    for u in urls:
        if u in seen:
            continue
        seen.add(u)
        if "/content" in u or any(u.lower().endswith(e) for e in (".png", ".jpg", ".jpeg", ".webp")):
            deduped.append(u)
    return deduped or urls


def load_rows():
    with CSV_PATH.open(newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        header = list(r.fieldnames or [])
        rows = list(r)
    return header, rows


def save_rows(header, rows):
    if "chibi_file" not in header:
        header.append("chibi_file")
    with CSV_PATH.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=header)
        w.writeheader()
        for row in rows:
            for k in header:
                row.setdefault(k, "")
            w.writerow(row)


def pending(rows):
    existing = {p.stem for p in CHIBI.iterdir()} if CHIBI.is_dir() else set()
    return [r for r in rows if r.get("image_file") and r["username"] not in existing]


def process_row(s, row, spec_json, dump=False):
    username = row["username"]
    img_path = IMAGES / row["image_file"]
    if not img_path.is_file():
        print(f"  skip: missing {img_path}")
        return False
    print(f"  upload {img_path.name}")
    asset_id, user_id = upload_asset(s, img_path, dump=dump)
    image_url = ASSET_CONTENT_URL.format(user_id=user_id, asset_id=asset_id)
    print(f"  pipeline {image_url}")
    final = run_pipeline(s, image_url, spec_json, dump=dump)
    status = (final.get("result") or {}).get("pipelineStatus")
    if status and "SUCCESS" not in str(status).upper() and "COMPLETE" not in str(status).upper():
        print(f"  non-success status: {status}")
    urls = extract_image_urls(final)
    if not urls:
        print(f"  no output URLs in final frame: {json.dumps(final)[:500]}")
        return False
    print(f"  {len(urls)} output url(s); downloading first")
    dl = s.get(urls[0], timeout=120)
    dl.raise_for_status()
    ext = ".png"
    ctype = dl.headers.get("Content-Type", "").lower()
    if "jpeg" in ctype:
        ext = ".jpg"
    elif "webp" in ctype:
        ext = ".webp"
    out_name = f"{username}{ext}"
    out_path = CHIBI / out_name
    out_path.write_bytes(dl.content)
    row["chibi_file"] = out_name
    print(f"  saved {out_path} ({len(dl.content)} bytes)")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="stop after N successful jobs")
    ap.add_argument("--dump", action="store_true", help="print raw responses; exit after first row")
    ap.add_argument("--prompt-extra", default="", help="text appended to prompt.txt for this run")
    args = ap.parse_args()

    CHIBI.mkdir(exist_ok=True)
    prompt_text = PROMPT_PATH.read_text().strip()
    if args.prompt_extra:
        prompt_text = f"{prompt_text} {args.prompt_extra.strip()}"
    spec_json = build_spec_json(prompt_text)
    print(f"prompt: {prompt_text[:120]}{'…' if len(prompt_text) > 120 else ''}")
    s = make_session()
    header, rows = load_rows()
    todo = pending(rows)
    if not todo:
        print("nothing to do")
        return
    print(f"{len(todo)} row(s) pending")

    done = 0
    for i, row in enumerate(todo):
        print(f"[{i + 1}/{len(todo)}] {row['username']}")
        try:
            ok = process_row(s, row, spec_json, dump=args.dump)
        except Exception as e:
            print(f"  ERROR: {e!r}")
            ok = False
        # Persist after each attempt so re-runs resume cleanly.
        save_rows(header, rows)
        if ok:
            done += 1
        if args.dump:
            break
        if args.limit and done >= args.limit:
            break
        if i < len(todo) - 1:
            delay = random.uniform(MIN_SLEEP, MAX_SLEEP)
            print(f"  sleep {delay:.1f}s")
            time.sleep(delay)

    print(f"done. {done} success.")


if __name__ == "__main__":
    sys.exit(main())
