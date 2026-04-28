# -*- coding: utf-8 -*-
"""Extract ChatGPT share HTML -> markdown conversation.

默认输入/输出均在脚本所在目录（仓库的 scripts/）下：
  - 输入：chatgpt-share.html（需自行保存分享页 HTML，或使用 --fetch 下载）
  - 输出：shengji.md

用法：
  python scripts/_chatgpt_share_to_md.py --fetch [分享页URL]
      用 no-cache + 时间戳参数拉取 HTML 写入 scripts/chatgpt-share.html，再生成 shengji.md
  python scripts/_chatgpt_share_to_md.py [输入.html] [输出.md]
      相对路径的输出会写到 scripts/ 下（与脚本同目录）。

关于「2/2」多版本与「没有变化」：
  - 分享链接里嵌的是**服务端当时打包进 HTML 的那条对话路径**；CDN 也可能缓存旧 HTML。
  - 同一轮里点「2/2」切换的是**另一条分支**；若该分支不在当前 share 的 linear 路径上，抓下来的 HTML 里**本来就没有**你正在看的那一版。
  - 在 ChatGPT 里**更新/重新生成分享链接**（或确认分享的是包含新内容的那条会话）后，再执行 --fetch。
  - 同一 message id 下若存在多条节点副本，本脚本优先取 **update_time（_34）/ create_time（_32）** 较新的一条，再按正文更长为辅。
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from urllib.error import URLError, HTTPError
from urllib.request import Request, urlopen

_SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_SHARE_URL = "https://chatgpt.com/share/69e7524b-cbf0-83ea-8f75-b62d2cc407ee"


def extract_enqueue_payload(html: str) -> str:
    """Parse all `streamController.enqueue("...")` chunks; pick the main conversation payload."""
    prefix = 'streamController.enqueue("'
    decoded: list[str] = []
    pos = 0
    while True:
        sidx = html.find(prefix, pos)
        if sidx < 0:
            break
        i = sidx + len(prefix)
        j = i
        while j < len(html):
            c = html[j]
            if c == "\\" and j + 1 < len(html):
                j += 2
                continue
            if c == '"':
                try:
                    decoded.append(json.loads('"' + html[i:j] + '"'))
                except json.JSONDecodeError:
                    pass
                break
            j += 1
        pos = sidx + 1
    if not decoded:
        raise ValueError("streamController.enqueue not found")
    with_linear = [s for s in decoded if "linear_conversation" in s]
    pool = with_linear or decoded
    return max(pool, key=len)


def fetch_share_page_to(url: str, dest: Path) -> None:
    """GET 分享页，绕过常见 CDN 缓存（时间戳 query + no-cache 头）。"""
    sep = "&" if "?" in url else "?"
    bust = int(time.time() * 1000)
    full = f"{url}{sep}_={bust}"
    req = Request(
        full,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
        },
        method="GET",
    )
    try:
        with urlopen(req, timeout=120) as resp:
            raw = resp.read()
    except (HTTPError, URLError) as e:
        raise SystemExit(f"拉取失败: {e}") from e
    dest.write_bytes(raw)


def _message_node_time(data: list, msg_dict_idx: int) -> float:
    d = data[msg_dict_idx]
    if not isinstance(d, dict):
        return float("-inf")
    t34, t32 = d.get("_34"), d.get("_32")
    if isinstance(t34, (int, float)):
        return float(t34)
    if isinstance(t32, (int, float)):
        return float(t32)
    return float("-inf")


def _resolve_content_pointer(data: list, ptr: int) -> str | None:
    if ptr is None or ptr < 0 or ptr >= len(data):
        return None
    cur = data[ptr]
    if isinstance(cur, str) and len(cur) > 0:
        return cur
    if isinstance(cur, list):
        parts: list[str] = []
        for item in cur:
            if isinstance(item, int):
                s = _resolve_content_pointer(data, item)
                if s:
                    parts.append(s)
            elif isinstance(item, str):
                parts.append(item)
        if parts:
            return "\n".join(parts)
    if isinstance(cur, dict):
        for k in ("_187", "_185"):
            if k in cur:
                t = _resolve_content_pointer(data, cur[k])
                if t:
                    return t
    return None


def _body_from_inner(data: list, inner: dict) -> str | None:
    """Older shares use _187; newer use _185 (often a list of string indices)."""
    if not isinstance(inner, dict):
        return None
    for key in ("_187", "_185"):
        if key not in inner:
            continue
        text = _resolve_content_pointer(data, inner[key])
        if text:
            return text
    return None


def _text_and_role_from_message_dict(data: list, msg_idx: int) -> tuple[str | None, str | None]:
    d = data[msg_idx]
    if not isinstance(d, dict) or "_122" not in d or "_129" not in d:
        return None, None
    inner = data[d["_122"]]
    if not isinstance(inner, dict):
        return None, None
    text = _body_from_inner(data, inner)
    if not text:
        return None, None
    meta = data[d["_129"]]
    if not isinstance(meta, dict):
        return text, None
    # Newer shares may use _405/_408 instead of _309 for user metadata.
    if "_135" in meta:
        role = "assistant"
    elif "_309" in meta or "_405" in meta or "_408" in meta:
        role = "user"
    else:
        role = None
    return text, role


def messages_from_devalue(data: list) -> list[tuple[str, str]]:
    """
    Walk `linear_conversation` branch from root toward current leaf.
    Order follows that path (not message timestamps — those are unreliable for sorting).
    """
    conv_idx = None
    for j, x in enumerate(data):
        if x == "linear_conversation":
            conv_idx = j + 1
            break
    if conv_idx is None or not isinstance(data[conv_idx], list):
        return []

    tree_nodes = data[conv_idx]
    ordered_mids: list[int] = []
    for ti in tree_nodes:
        node = data[ti]
        if isinstance(node, dict) and isinstance(node.get("_111"), int):
            mid = node["_111"]
            if mid not in ordered_mids:
                ordered_mids.append(mid)

    results: list[tuple[str, str]] = []

    for mid in ordered_mids:
        candidates = [
            j
            for j, x in enumerate(data)
            if isinstance(x, dict) and x.get("_111") == mid and "_122" in x and "_129" in x
        ]
        if not candidates:
            continue
        best_c: int | None = None
        best_key: tuple[float, int] | None = None
        for c in candidates:
            text, role = _text_and_role_from_message_dict(data, c)
            if not text or not role:
                continue
            ts = _message_node_time(data, c)
            key = (ts, len(text))
            if best_key is None or key > best_key:
                best_key = key
                best_c = c
        if best_c is None:
            continue
        best_text, best_role = _text_and_role_from_message_dict(data, best_c)
        if not best_text or not best_role:
            continue
        results.append((best_role, best_text))

    return results


def main():
    argv = sys.argv[1:]
    fetched_url: str | None = None
    did_fetch = False

    if argv and argv[0] in ("--fetch", "-f"):
        argv.pop(0)
        did_fetch = True
        if argv and (argv[0].startswith("http://") or argv[0].startswith("https://")):
            fetched_url = argv.pop(0)
        else:
            fetched_url = os.environ.get("CHATGPT_SHARE_URL", DEFAULT_SHARE_URL)
        html_out = _SCRIPT_DIR / "chatgpt-share.html"
        print(f"Fetching (no-cache, bust): {fetched_url}", file=sys.stderr)
        fetch_share_page_to(fetched_url, html_out)
        print(f"Wrote {html_out} ({html_out.stat().st_size} bytes)", file=sys.stderr)

    default_html = _SCRIPT_DIR / "chatgpt-share.html"
    if did_fetch:
        html_path = default_html
        out_arg = argv[0] if argv else "shengji.md"
    elif argv:
        p = Path(argv[0])
        if p.is_absolute():
            html_path = p
        else:
            cand = _SCRIPT_DIR / p
            html_path = cand if cand.is_file() else (Path.cwd() / p)
        out_arg = argv[1] if len(argv) > 1 else "shengji.md"
    else:
        html_path = default_html
        out_arg = "shengji.md"
    out_path = Path(out_arg)
    if not out_path.is_absolute():
        out_path = _SCRIPT_DIR / out_path

    if not html_path.is_file():
        print(
            f"找不到输入 HTML：{html_path}\n"
            f"请将 ChatGPT 分享页另存为 HTML，放到：{_SCRIPT_DIR / 'chatgpt-share.html'}\n"
            f"或执行：python scripts/_chatgpt_share_to_md.py <你的.html> [输出.md]",
            file=sys.stderr,
        )
        raise SystemExit(1)

    html = html_path.read_text(encoding="utf-8")
    payload = extract_enqueue_payload(html)
    data = json.loads(payload)
    if not isinstance(data, list):
        raise TypeError("expected list")
    pairs = messages_from_devalue(data)
    ref_url = fetched_url or DEFAULT_SHARE_URL
    lines = [
        "# 交互式应用定义解析",
        "",
        f"来源：<{ref_url}>",
        "",
        "> 说明：分享页内嵌 JSON 只包含 **linear_conversation 当前这条路径**。"
        "界面里的 **2/2** 是同一轮的另一条版本；若该版本不在本次 share 打包的路径里，"
        "下载的 HTML **不会包含**你在 2/2 里看到的那段正文。"
        "请在 ChatGPT 中切到要公开的那版后 **更新分享**，再执行 `python scripts/_chatgpt_share_to_md.py --fetch`。",
    ]
    if did_fetch:
        lines.append(f"> 拉取时间（本地）：{time.strftime('%Y-%m-%d %H:%M:%S')}")
    lines.extend(["", "---", ""])
    for idx, (role, text) in enumerate(pairs, 1):
        label = "用户" if role == "user" else "Assistant"
        lines.append(f"## {idx}. {label}")
        lines.append("")
        lines.append(text.strip())
        lines.append("")
        lines.append("---")
        lines.append("")
    out_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"Wrote {len(pairs)} messages to {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
