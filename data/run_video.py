#!/usr/bin/env python3
"""Batch runner: animate each chibi avatar into a 480p video via Grok's
media pipeline. One job at a time, 10-20s jittered sleep between jobs.

Usage:
    python run_video.py video_prompt.txt                # process all pending
    python run_video.py video_prompt.txt --limit 1      # just one (sanity check)
    python run_video.py video_prompt.txt --dump         # print raw responses, exit after first job
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
CHIBI = ROOT / "chibi_images"
VIDEOS = ROOT / "videos"
CSV_PATH = ROOT / "moots.csv"

ASSETS_URL = "https://grok.com/rest/assets"
PIPELINE_URL = "https://grok.com/rest/media/pipeline/run"
ASSET_CONTENT_URL = "https://assets.grok.com/users/{user_id}/{asset_id}/content"

MIN_SLEEP = 30
MAX_SLEEP = 40
PIPELINE_TIMEOUT = 900
IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp"}


def build_spec_json(prompt_text: str) -> str:
    """Inline pipeline spec: video_gen node, I2V, 480p 1:1 6s."""
    spec = {
        "version": 1,
        "inputs": {
            "photo": {"type": "image", "label": "Your photo"},
            "animate_prompt": {
                "type": "text",
                "fixed": {"type": "text", "value": prompt_text},
            },
        },
        "nodes": {
            "gen_video": {
                "type": "video_gen",
                "inputs": {"image": "$input.photo", "prompt": "$input.animate_prompt"},
                "params": {
                    "aspect_ratio": [1, 1],
                    "resolution_name": "480p",
                    "duration": 6,
                },
            },
        },
        "outputs": {"result": "$gen_video.video"},
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
                "mediaUrl", "videoUrl", "outputUrl", "url", "assetUrl", "contentUrl"
            ) and v.startswith("http"):
                out.append(v)
            else:
                _walk_urls(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _walk_urls(v, out)


def extract_video_urls(final: dict) -> list[str]:
    urls: list[str] = []
    _walk_urls(final, urls)
    seen = set()
    deduped = []
    for u in urls:
        if u in seen:
            continue
        seen.add(u)
        if "/content" in u or u.lower().endswith((".mp4", ".webm", ".mov")):
            deduped.append(u)
    return deduped or urls


def load_rows():
    with CSV_PATH.open(newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        header = list(r.fieldnames or [])
        rows = list(r)
    return header, rows


def save_rows(header, rows):
    if "video_file" not in header:
        header.append("video_file")
    with CSV_PATH.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=header)
        w.writeheader()
        for row in rows:
            for k in header:
                row.setdefault(k, "")
            w.writerow(row)


def pending_chibis():
    existing = {p.stem for p in VIDEOS.iterdir()} if VIDEOS.is_dir() else set()
    todo = []
    for p in sorted(CHIBI.iterdir()):
        if p.suffix.lower() not in IMG_EXTS:
            continue
        if p.stem in existing:
            continue
        todo.append(p)
    return todo


def process_chibi(s, chibi_path, rows_by_user, spec_json, dump=False):
    username = chibi_path.stem
    print(f"  upload {chibi_path.name}")
    asset_id, user_id = upload_asset(s, chibi_path, dump=dump)
    image_url = ASSET_CONTENT_URL.format(user_id=user_id, asset_id=asset_id)
    print(f"  pipeline {image_url}")
    final = run_pipeline(s, image_url, spec_json, dump=dump)
    status = (final.get("result") or {}).get("pipelineStatus")
    if status and "SUCCESS" not in str(status).upper() and "COMPLETE" not in str(status).upper():
        print(f"  non-success status: {status}")
    urls = extract_video_urls(final)
    if not urls:
        print(f"  no output URLs in final frame: {json.dumps(final)[:500]}")
        return False
    print(f"  {len(urls)} output url(s); downloading first")
    dl = s.get(urls[0], timeout=300)
    dl.raise_for_status()
    ext = ".mp4"
    ctype = dl.headers.get("Content-Type", "").lower()
    if "webm" in ctype:
        ext = ".webm"
    elif "quicktime" in ctype:
        ext = ".mov"
    out_name = f"{username}{ext}"
    out_path = VIDEOS / out_name
    out_path.write_bytes(dl.content)
    row = rows_by_user.get(username)
    if row is not None:
        row["video_file"] = out_name
    print(f"  saved {out_path} ({len(dl.content)} bytes)")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("prompt_file", help="path to video prompt text file")
    ap.add_argument("--limit", type=int, default=0, help="stop after N successful jobs")
    ap.add_argument("--dump", action="store_true", help="print raw responses; exit after first row")
    args = ap.parse_args()

    VIDEOS.mkdir(exist_ok=True)
    prompt_text = Path(args.prompt_file).read_text().strip()
    spec_json = build_spec_json(prompt_text)
    print(f"prompt: {prompt_text[:120]}{'…' if len(prompt_text) > 120 else ''}")
    s = make_session()
    header, rows = load_rows()
    rows_by_user = {r["username"]: r for r in rows}
    todo = pending_chibis()
    if not todo:
        print("nothing to do")
        return
    print(f"{len(todo)} chibi(s) pending")

    done = 0
    for i, chibi_path in enumerate(todo):
        print(f"[{i + 1}/{len(todo)}] {chibi_path.stem}")
        try:
            ok = process_chibi(s, chibi_path, rows_by_user, spec_json, dump=args.dump)
        except Exception as e:
            print(f"  ERROR: {e!r}")
            ok = False
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
