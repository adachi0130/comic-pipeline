"""解析 69 个 MED 版式模板，生成 templates 表 + 一份 JSON 供 S3 提示词当"可选版式菜单"。

模板 JS 的每个元素是 ``{name, svg}``，其中 ``svg`` 的 ``viewBox`` 即页面画布尺寸，
里面的 ``<polygon>`` 数量即该模板的格数。本脚本据此补出 MED 原生缺失的
"格数 / 每格形状 / 占比 / 是否出血"，并合成 LLM 可读的版式描述。

用法（在项目根执行）：
    .venv/Scripts/python.exe backend/scripts/build_template_menu.py \
        --vertical  /tmp/med/js/manga-panels-image-vertical.js \
        --landscape /tmp/med/js/manga-panels-image-landscape.js
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import delete  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.models import Template  # noqa: E402

HERE = Path(__file__).resolve().parent
PARSER = HERE / "parse_med_templates.mjs"

POLYGON_RE = re.compile(r"<polygon\b[^>]*?\bpoints\s*=\s*\"([^\"]+)\"", re.IGNORECASE)
VIEWBOX_RE = re.compile(r"viewBox\s*=\s*\"([^\"]+)\"", re.IGNORECASE)
WH_RE = re.compile(r"width\s*=\s*\"([0-9.]+)\"[^>]*?height\s*=\s*\"([0-9.]+)\"", re.IGNORECASE)


def run_parser(js_file: Path, var_name: str) -> list[dict]:
    out = subprocess.run(
        ["node", str(PARSER), str(js_file), var_name],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if out.returncode != 0:
        raise RuntimeError(f"解析 {js_file.name} 失败：{out.stderr[:500]}")
    return json.loads(out.stdout or "[]")


def parse_points(points: str) -> list[tuple[float, float]]:
    nums = re.findall(r"-?\d+(?:\.\d+)?", points)
    vals = [float(n) for n in nums]
    return list(zip(vals[0::2], vals[1::2]))


def analyze(svg: str) -> dict:
    vb = VIEWBOX_RE.search(svg)
    if vb:
        vb_nums = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", vb.group(1))]
        canvas_w, canvas_h = vb_nums[2], vb_nums[3]
    else:
        wh = WH_RE.search(svg)
        canvas_w, canvas_h = (float(wh.group(1)), float(wh.group(2))) if wh else (1.0, 1.0)

    canvas_area = canvas_w * canvas_h or 1.0
    polys = POLYGON_RE.findall(svg)

    panels = []
    for i, pts in enumerate(polys, start=1):
        coords = parse_points(pts)
        if not coords:
            continue
        xs = [c[0] for c in coords]
        ys = [c[1] for c in coords]
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        w, h = max(x1 - x0, 0.0), max(y1 - y0, 0.0)
        area_share = (w * h) / canvas_area
        ratio = (w / h) if h else 0.0
        shape = "landscape" if ratio > 1.25 else ("portrait" if ratio < 0.8 else "square")
        # 出血：贴到画布边缘 1% 以内
        margin = 0.01 * max(canvas_w, canvas_h)
        bleed = x0 <= margin or y0 <= margin or x1 >= canvas_w - margin or y1 >= canvas_h - margin
        panels.append(
            {
                "index": i,
                "shape": shape,
                "width_pct": round(w / canvas_w * 100, 1),
                "height_pct": round(h / canvas_h * 100, 1),
                "area_pct": round(area_share * 100, 1),
                "bleed": bool(bleed),
            }
        )
    return {
        "canvas": [round(canvas_w, 2), round(canvas_h, 2)],
        "panels": panels,
    }


def describe(dir_name: str, name: str, panels: list[dict]) -> str:
    n = len(panels)
    orient = "竖版" if dir_name == "vertical" else "横版"
    if n == 0:
        return f"{orient}空版式（无格）"
    biggest = max(panels, key=lambda p: p["area_pct"])
    parts = [f"{orient}{n}格"]
    parts.append(f"最大格约占总面积{biggest['area_pct']:.0f}%")
    if any(p["bleed"] for p in panels):
        parts.append("含出血格")
    shapes = [p["shape"] for p in panels]
    if shapes.count("landscape") and shapes.count("portrait"):
        parts.append("横竖格混排")
    return "，".join(parts) + f"（代码名 {name}）"


def build(vertical: Path, landscape: Path) -> list[dict]:
    rows: list[dict] = []
    settings = get_settings()
    svg_dir = settings.data_dir / "templates"
    svg_dir.mkdir(parents=True, exist_ok=True)

    for dir_name, path, var in (
        ("vertical", vertical, "MangaPanelsImage_Vertical"),
        ("landscape", landscape, "MangaPanelsImage_Landscape"),
    ):
        items = run_parser(path, var)
        for item in items:
            name = item.get("name") or "?"
            svg = item.get("svg") or ""
            info = analyze(svg)
            tid = f"{dir_name}:{name}"
            svg_path = svg_dir / f"{dir_name}_{re.sub(r'[^0-9A-Za-z_-]', '_', name)}.svg"
            svg_path.write_text(svg, encoding="utf-8")
            rows.append(
                {
                    "id": tid,
                    "dir": dir_name,
                    "panels_count": len(info["panels"]),
                    "layout_desc": describe(dir_name, name, info["panels"]),
                    "svg_path": str(svg_path),
                    "geometry": info,
                }
            )
        print(f"  {dir_name}: 解析 {len(items)} 个模板")
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--vertical", required=True)
    ap.add_argument("--landscape", required=True)
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    rows = build(Path(args.vertical), Path(args.landscape))

    init_db()
    session = SessionLocal()
    try:
        session.execute(delete(Template))
        for r in rows:
            session.add(Template(**r))
        session.commit()
    finally:
        session.close()

    counts: dict[int, int] = {}
    for r in rows:
        counts[r["panels_count"]] = counts.get(r["panels_count"], 0) + 1
    print(f"入库 templates：{len(rows)} 条；格数分布：{dict(sorted(counts.items()))}")

    out = Path(args.out) if args.out else get_settings().data_dir / "template_menu.json"
    out.write_text(
        json.dumps(
            [{"id": r["id"], "dir": r["dir"], "panels": r["panels_count"], "desc": r["layout_desc"]} for r in rows],
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"模板菜单已写出：{out}")


if __name__ == "__main__":
    main()
