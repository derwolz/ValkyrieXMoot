#!/usr/bin/env python3
"""Tag images in images/ using gemma3:4b on dt via ollama.

Runs over every image. For each image, appends new tags to whatever batch
file already contains it (or tags/batch_11.json if it's new), deduping
comma-separated tokens case-insensitively while preserving first-seen order.

Resumable: skips filenames listed in tags/.described.json, which this
script updates incrementally.

Usage:
    python tag_images.py              # run all pending
    python tag_images.py --limit 5    # sanity check
"""
import argparse
import base64
import json
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
IMAGES = ROOT / "images"
TAGS = ROOT / "tags"
DEFAULT_BATCH = TAGS / "batch_11.json"
DONE_FILE = TAGS / ".described.json"

MODEL = "gemma3:4b"
SSH_HOST = "dt"
HOST = "127.0.0.1"
PORT = 11434
API = f"http://{HOST}:{PORT}/api/chat"

PROMPT = """You are a visual content tagger. Output ONE line of 5-15 lowercase comma-separated tags that literally describe what is in the image.

Describe what you actually see:
- The subject(s) and what they literally are (cat, woman holding phone, sports car, skull, city skyline, logo, pizza slice, book cover)
- Objects, props, and accessories present in the frame
- Setting or background (indoor, beach, studio, forest, street, night sky)
- Actions or poses (sitting, running, looking down, holding drink)
- Any visible text, symbols, or branding
- Notable colors, materials, or lighting (chrome, neon, pastel, wooden, backlit)

Rules: lowercase, comma-separated, no period, no preamble, no "the image shows", no numbering, no category labels. Just the tags."""


def port_open(timeout=2):
    with socket.socket() as s:
        s.settimeout(timeout)
        try:
            s.connect((HOST, PORT))
            return True
        except OSError:
            return False


def api_reachable():
    try:
        urllib.request.urlopen(f"http://{HOST}:{PORT}/api/version", timeout=3).read()
        return True
    except Exception:
        return False


def ensure_tunnel():
    if api_reachable():
        return None
    print(f"[tunnel] ssh -L {PORT}:localhost:{PORT} {SSH_HOST} ...", flush=True)
    p = subprocess.Popen(
        ["ssh", "-N", "-o", "ServerAliveInterval=30", "-L",
         f"{PORT}:localhost:{PORT}", SSH_HOST],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(40):
        if api_reachable():
            return p
        time.sleep(0.5)
    p.terminate()
    sys.exit("ssh tunnel failed to reach ollama")


def dedup_tags(s: str) -> str:
    seen = set()
    out = []
    for tok in s.split(","):
        t = tok.strip()
        if not t:
            continue
        k = t.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append(t)
    return ", ".join(out)


def load_batches():
    batches = {}
    index = {}
    for p in sorted(TAGS.glob("batch_*.json")):
        data = json.loads(p.read_text(encoding="utf-8"))
        batches[p] = data
        for name in data:
            index[name] = p
    if DEFAULT_BATCH not in batches:
        batches[DEFAULT_BATCH] = {}
    return batches, index


def load_done():
    if DONE_FILE.exists():
        return set(json.loads(DONE_FILE.read_text(encoding="utf-8")))
    return set()


def save_done(done):
    DONE_FILE.write_text(json.dumps(sorted(done), ensure_ascii=False))


def tag_one(path: Path, timeout=180):
    img = base64.b64encode(path.read_bytes()).decode()
    payload = {
        "model": MODEL,
        "messages": [{"role": "user", "content": PROMPT, "images": [img]}],
        "stream": False,
        "options": {"temperature": 0.2},
    }
    req = urllib.request.Request(
        API,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read())
    text = (data.get("message") or {}).get("content", "").strip()
    text = text.lstrip("-* \n\t").strip()
    text = " ".join(text.split())
    return text


def write_batch(path: Path, data: dict):
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--flush-every", type=int, default=5)
    args = ap.parse_args()

    tunnel = ensure_tunnel()
    try:
        batches, index = load_batches()
        done = load_done()
        files = sorted(p for p in IMAGES.iterdir() if p.is_file())
        pending = [p for p in files if p.name not in done]
        print(f"[tagger] described={len(done)} pending={len(pending)} total={len(files)}")
        if args.limit:
            pending = pending[: args.limit]

        dirty = set()
        t0 = time.time()
        errors = 0
        for i, p in enumerate(pending, 1):
            t = time.time()
            try:
                new_tags = tag_one(p)
            except Exception as e:
                errors += 1
                print(f"  [{i}/{len(pending)}] {p.name} ERR {type(e).__name__}: {e}",
                      flush=True)
                continue

            batch_path = index.get(p.name, DEFAULT_BATCH)
            existing = batches[batch_path].get(p.name, "")
            merged = dedup_tags(f"{existing}, {new_tags}" if existing else new_tags)
            batches[batch_path][p.name] = merged
            index[p.name] = batch_path
            done.add(p.name)
            dirty.add(batch_path)

            print(f"  [{i}/{len(pending)}] {p.name} {time.time()-t:.1f}s "
                  f"[{batch_path.name}] {merged[:90]}", flush=True)

            if i % args.flush_every == 0:
                for bp in dirty:
                    write_batch(bp, batches[bp])
                dirty.clear()
                save_done(done)

        for bp in dirty:
            write_batch(bp, batches[bp])
        save_done(done)
        print(f"[tagger] processed {len(pending)-errors} images in "
              f"{time.time()-t0:.0f}s (errors: {errors})")
    finally:
        if tunnel:
            tunnel.terminate()


if __name__ == "__main__":
    main()
