#!/usr/bin/env python3
"""Generate index.html — a scrollable page of moots showing name + pfp.

Usage:
    python build_site.py
    python -m http.server 8000   # then open http://localhost:8000
"""
import csv
import html
import json
from pathlib import Path

tags_by_image = {}
for f in sorted(Path("tags").glob("batch_*.json")):
    try:
        tags_by_image.update(json.loads(f.read_text(encoding="utf-8")))
    except json.JSONDecodeError as e:
        print(f"  SKIP {f.name}: {e}")

rows = list(csv.DictReader(open("moots.csv", encoding="utf-8")))
moots = [
    {
        "username": r["username"],
        "display_name": r.get("display_name", ""),
        "image_file": r.get("image_file", ""),
        "matched": bool(r.get("matched_file", "")),
        "tags": tags_by_image.get(r.get("image_file", "")) or r.get("tags", ""),
    }
    for r in rows
]

all_tags = sorted({
    t.strip().lower()
    for m in moots
    for t in (m["tags"] or "").split(",")
    if t.strip()
})
print(f"loaded {len(tags_by_image)} tagged images, {len(all_tags)} unique tags")

data_json = json.dumps(moots, ensure_ascii=False)

html_doc = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Moots</title>
<style>
  :root {{
    color-scheme: dark;
    --bg: #0e0e11;
    --card: #1a1a20;
    --border: #2a2a33;
    --fg: #f4f4f6;
    --muted: #9aa0a6;
    --accent: #7ab7ff;
    --matched: #4ade80;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: system-ui, -apple-system, Segoe UI, Inter, sans-serif;
    padding: 24px 16px 96px;
  }}
  header {{
    max-width: 820px;
    margin: 0 auto 20px;
    display: flex;
    gap: 12px;
    align-items: center;
  }}
  h1 {{ font-size: 20px; margin: 0; letter-spacing: 0.5px; }}
  .count {{ color: var(--muted); font-size: 14px; }}
  .controls {{ margin-left: auto; display: flex; gap: 8px; }}
  input[type="search"] {{
    background: var(--card);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 12px;
    font-size: 14px;
    width: 260px;
  }}
  .tags {{
    margin-top: 8px;
    display: flex; flex-wrap: wrap; gap: 4px;
  }}
  .tag {{
    font-size: 11px;
    color: var(--muted);
    background: #222630;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px 8px;
    cursor: pointer;
    user-select: none;
  }}
  .tag:hover {{ color: var(--accent); border-color: var(--accent); }}
  .hint {{
    max-width: 820px; margin: -10px auto 14px;
    color: var(--muted); font-size: 12px;
  }}
  label.filter {{
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--muted); font-size: 14px; user-select: none; cursor: pointer;
  }}
  .list {{ max-width: 820px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }}
  .card {{
    display: flex; align-items: center; gap: 20px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 16px 20px;
  }}
  .card.matched {{ border-color: var(--matched); }}
  .avatar {{
    width: 128px; height: 128px;
    border-radius: 50%;
    object-fit: cover;
    background: #222;
    flex-shrink: 0;
  }}
  .avatar.placeholder {{
    display: flex; align-items: center; justify-content: center;
    color: var(--muted); font-size: 28px;
  }}
  .names {{ min-width: 0; }}
  .display {{
    font-size: 36px;
    font-weight: 700;
    line-height: 1.1;
    word-break: break-word;
  }}
  .handle {{
    margin-top: 6px;
    font-size: 18px;
    color: var(--muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }}
  .handle a {{ color: var(--accent); text-decoration: none; }}
  .handle a:hover {{ text-decoration: underline; }}
  .badge {{
    margin-left: 10px;
    font-size: 12px;
    color: var(--matched);
    border: 1px solid var(--matched);
    border-radius: 999px;
    padding: 2px 8px;
    vertical-align: middle;
  }}
  .empty {{ color: var(--muted); text-align: center; padding: 40px; }}
</style>
</head>
<body>
<header>
  <h1>Moots</h1>
  <span class="count" id="count"></span>
  <div class="controls">
    <label class="filter"><input type="checkbox" id="onlyMatched"> matched only</label>
    <input type="search" id="q" placeholder="search name, @handle, or tag">
  </div>
</header>
<div class="hint">tip: space-separated terms all must match (AND). click a tag to add it.</div>
<main class="list" id="list"></main>

<script>
const DATA = {data_json};
const list = document.getElementById('list');
const count = document.getElementById('count');
const q = document.getElementById('q');
const onlyMatched = document.getElementById('onlyMatched');

const INDEX = DATA.map(m => ({{
  m,
  blob: [(m.display_name || ''), (m.username || ''), (m.tags || '')].join(' ').toLowerCase()
}}));

function render() {{
  const raw = q.value.trim().toLowerCase();
  const terms = raw ? raw.split(/\\s+/).filter(Boolean) : [];
  const matchedOnly = onlyMatched.checked;
  const filtered = INDEX.filter(({{m, blob}}) => {{
    if (matchedOnly && !m.matched) return false;
    if (!terms.length) return true;
    return terms.every(t => blob.includes(t));
  }}).map(x => x.m);
  count.textContent = `${{filtered.length}} / ${{DATA.length}}`;
  list.innerHTML = '';
  if (!filtered.length) {{
    list.innerHTML = '<div class="empty">no moots match</div>';
    return;
  }}
  const frag = document.createDocumentFragment();
  for (const m of filtered) {{
    const card = document.createElement('div');
    card.className = 'card' + (m.matched ? ' matched' : '');

    if (m.image_file) {{
      const img = document.createElement('img');
      img.className = 'avatar';
      img.loading = 'lazy';
      img.alt = m.username;
      img.src = 'images/' + encodeURIComponent(m.image_file);
      img.onerror = () => {{
        const ph = document.createElement('div');
        ph.className = 'avatar placeholder';
        ph.textContent = (m.display_name || m.username || '?').slice(0,1).toUpperCase();
        img.replaceWith(ph);
      }};
      card.appendChild(img);
    }} else {{
      const ph = document.createElement('div');
      ph.className = 'avatar placeholder';
      ph.textContent = (m.display_name || m.username || '?').slice(0,1).toUpperCase();
      card.appendChild(ph);
    }}

    const names = document.createElement('div');
    names.className = 'names';
    const disp = document.createElement('div');
    disp.className = 'display';
    disp.textContent = m.display_name || m.username;
    if (m.matched) {{
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = 'matched';
      disp.appendChild(b);
    }}
    const handle = document.createElement('div');
    handle.className = 'handle';
    const link = document.createElement('a');
    link.href = 'https://twitter.com/' + encodeURIComponent(m.username);
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = '@' + m.username;
    handle.appendChild(link);
    names.appendChild(disp);
    names.appendChild(handle);

    const tagList = (m.tags || '').split(',').map(s => s.trim()).filter(Boolean);
    if (tagList.length) {{
      const tagWrap = document.createElement('div');
      tagWrap.className = 'tags';
      for (const t of tagList) {{
        const chip = document.createElement('span');
        chip.className = 'tag';
        chip.textContent = t;
        chip.addEventListener('click', () => {{
          const cur = q.value.trim();
          const parts = cur ? cur.split(/\\s+/) : [];
          if (!parts.includes(t)) parts.push(t);
          q.value = parts.join(' ');
          render();
        }});
        tagWrap.appendChild(chip);
      }}
      names.appendChild(tagWrap);
    }}

    card.appendChild(names);
    frag.appendChild(card);
  }}
  list.appendChild(frag);
}}

q.addEventListener('input', render);
onlyMatched.addEventListener('change', render);
render();
</script>
</body>
</html>
"""

Path("index.html").write_text(html_doc, encoding="utf-8")
print(f"wrote index.html with {len(moots)} moots")
