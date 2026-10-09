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

# 每个 <polygon> 都有自己的 <g transform="matrix(a b c d e f)">，坐标是局部坐标，
# 必须配对后应用矩阵换算到画布空间，否则位置会全错（负数 / 全挤一行）。
G_POLY_RE = re.compile(
    r'<g[^>]*transform\s*=\s*"matrix\(([^)]*)\)"[^>]*>\s*<polygon[^>]*?\bpoints\s*=\s*"([^"]+)"',
    re.IGNORECASE | re.DOTALL,
)

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

    rects = []
    for m in G_POLY_RE.finditer(svg):
        nums = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", m.group(1))]
        if len(nums) < 6:
            continue
        a, b, c, d, e, f = nums[:6]
        pts = parse_points(m.group(2))
        if not pts:
            continue
        xs, ys = [], []
        for (px, py) in pts:
            xs.append(a * px + c * py + e)   # 应用 transform 矩阵
            ys.append(b * px + d * py + f)
        rects.append((min(xs), max(xs), min(ys), max(ys)))
    if not rects:  # 兜底：没有 transform 的模板直接用原始点
        for pts in POLYGON_RE.findall(svg):
            coords = parse_points(pts)
            if coords:
                xs = [q[0] for q in coords]; ys = [q[1] for q in coords]
                rects.append((min(xs), max(xs), min(ys), max(ys)))
    if not rects:
        return {"canvas": [round(canvas_w, 2), round(canvas_h, 2)], "panels": []}

    # 以 viewBox 画布为基准计算百分比（坐标已被 transform 换算到画布空间）
    cw = canvas_w or max(r[1] for r in rects) or 1.0
    ch = canvas_h or max(r[3] for r in rects) or 1.0
    box_area = cw * ch

    panels = []
    for i, (x0, x1, y0, y1) in enumerate(rects, start=1):
        w, h = max(x1 - x0, 0.0), max(y1 - y0, 0.0)
        ratio = (w / h) if h else 0.0
        shape = "landscape" if ratio > 1.25 else ("portrait" if ratio < 0.8 else "square")
        margin = 0.01 * max(cw, ch)
        bleed = x0 <= margin or y0 <= margin or x1 >= cw - margin or y1 >= ch - margin
        panels.append(
            {
                "index": i,
                "shape": shape,
                "x_pct": round(x0 / cw * 100, 1),
                "y_pct": round(y0 / ch * 100, 1),
                "width_pct": round(w / cw * 100, 1),
                "height_pct": round(h / ch * 100, 1),
                "area_pct": round((w * h) / box_area * 100, 1),
                "bleed": bool(bleed),
            }
        )
    return {
        "canvas": [round(cw, 2), round(ch, 2)],
        "panels": panels,
    }


def _is_background(p: dict) -> bool:
    """整页格（占满整页）：常作大画面/跨格，可叠内嵌格，不参与行分组。"""
    return p.get("width_pct", 0) >= 90 and p.get("height_pct", 0) >= 90


def _rows(panels: list[dict]) -> list[list[dict]]:
    """把格子按纵向位置分组成“行”（按 y 重叠判断同一行）。整页底层格不参与。"""
    ps = [p for p in panels if not _is_background(p)]
    if not ps:
        return []
    ps = sorted(ps, key=lambda p: (p.get("y_pct", 0), p.get("x_pct", 0)))
    rows: list[list[dict]] = []
    for p in ps:
        placed = False
        for row in rows:
            ref = row[0]
            a0, a1 = ref.get("y_pct", 0), ref.get("y_pct", 0) + ref.get("height_pct", 0)
            b0, b1 = p.get("y_pct", 0), p.get("y_pct", 0) + p.get("height_pct", 0)
            if min(a1, b1) - max(a0, b0) > 0.4 * min(a1 - a0, b1 - b0):
                row.append(p)
                placed = True
                break
        if not placed:
            rows.append([p])
    for row in rows:
        row.sort(key=lambda p: p.get("x_pct", 0))
    return rows


def describe(dir_name: str, name: str, panels: list[dict]) -> str:
    """生成“行结构”版式描述，让模型能判断大格位置、横竖构成与整页格，从而选对画面。"""
    n = len(panels)
    orient = "竖版" if dir_name == "vertical" else "横版"
    if n == 0:
        return f"{orient}空版式（无格）"

    parts: list[str] = [f"{orient}{n}格"]
    bg = [p for p in panels if _is_background(p)]
    if bg:
        parts.append(f"其中{len(bg)}格为整页格（适合大画面/跨格，可叠内嵌格）")

    rows = _rows(panels)
    for ri, row in enumerate(rows, start=1):
        sizes = sorted((p.get("area_pct", 0) for p in row), reverse=True)
        shapes = [p.get("shape") for p in row]
        shape_txt = "横格" if all(s == "landscape" for s in shapes) else                     "竖格" if all(s == "portrait" for s in shapes) else                     "方格外" if all(s == "square" for s in shapes) else "横竖混排"
        if len(row) == 1:
            parts.append(f"第{ri}行单格（占{sizes[0]:.0f}%）")
        else:
            big, small = sizes[0], sizes[-1]
            if big >= small * 1.8:
                biggest = max(row, key=lambda p: p.get("area_pct", 0))
                side = "左" if biggest.get("x_pct", 0) < 50 else "右"
                parts.append(f"第{ri}行{len(row)}格（{side}侧大格占{big:.0f}%，其余{len(row) - 1}个小格）")
            else:
                parts.append(f"第{ri}行{len(row)}格{shape_txt}等分")

    # 画面特征：最大格在哪、横竖占比——便于模型按“这页要突出什么”来选
    biggest = max(panels, key=lambda p: p.get("area_pct", 0))
    parts.append(f"最大格占{biggest.get('area_pct', 0):.0f}%")
    land = sum(1 for p in panels if p.get("shape") == "landscape")
    port = sum(1 for p in panels if p.get("shape") == "portrait")
    if land and port:
        parts.append(f"横格{land}竖格{port}")
    return "；".join(parts)


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
