"""一次性脚本：修正模板几何——改用「所有格子的包围盒」归一化。

问题：MED 模板 SVG 的 <polygon> 坐标被父级 <g transform="translate(...)"> 偏移，
直接除以 viewBox 尺寸会得到负数（如 x=-49.9），导致行分组全乱、
模型得到的版式描述错误（“5 格全在同一行”）。

修法：先算出所有格子的包围盒 (minx,miny,maxx,maxy)，再用它做基准表达每格
的相对位置与尺寸。因为所有格子被同一个 transform 平移/缩放，比值是不变量，
所以这样得到的位置与大小既正确又与 transform 无关。
"""
from __future__ import annotations

import pathlib

TARGET = pathlib.Path("backend/scripts/build_template_menu.py")

OLD = '''    canvas_area = canvas_w * canvas_h or 1.0
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
    }'''

NEW = '''    polys = POLYGON_RE.findall(svg)

    # 第一步：取每格原始矩形
    rects = []
    for pts in polys:
        coords = parse_points(pts)
        if not coords:
            continue
        xs = [c[0] for c in coords]
        ys = [c[1] for c in coords]
        rects.append((min(xs), max(xs), min(ys), max(ys)))
    if not rects:
        return {"canvas": [round(canvas_w, 2), round(canvas_h, 2)], "panels": []}

    # 第二步：用所有格子的包围盒做归一化基准（抵消 SVG 的 translate/scale）
    minx = min(r[0] for r in rects)
    maxx = max(r[1] for r in rects)
    miny = min(r[2] for r in rects)
    maxy = max(r[3] for r in rects)
    bw = (maxx - minx) or canvas_w or 1.0
    bh = (maxy - miny) or canvas_h or 1.0
    box_area = bw * bh

    panels = []
    for i, (x0, x1, y0, y1) in enumerate(rects, start=1):
        w, h = max(x1 - x0, 0.0), max(y1 - y0, 0.0)
        ratio = (w / h) if h else 0.0
        shape = "landscape" if ratio > 1.25 else ("portrait" if ratio < 0.8 else "square")
        # 出血：贴到整页包围盒边缘 1% 以内
        margin = 0.01 * max(bw, bh)
        bleed = x0 <= minx + margin or y0 <= miny + margin or x1 >= maxx - margin or y1 >= maxy - margin
        panels.append(
            {
                "index": i,
                "shape": shape,
                "x_pct": round((x0 - minx) / bw * 100, 1),
                "y_pct": round((y0 - miny) / bh * 100, 1),
                "width_pct": round(w / bw * 100, 1),
                "height_pct": round(h / bh * 100, 1),
                "area_pct": round((w * h) / box_area * 100, 1),
                "bleed": bool(bleed),
            }
        )
    return {
        # canvas 用真实包围盒尺寸（即“整页”的实际比例），比 viewBox 更可靠
        "canvas": [round(bw, 2), round(bh, 2)],
        "panels": panels,
    }'''


def main() -> None:
    t = TARGET.read_text(encoding="utf-8")
    if "box_area" in t:
        print("已修正，跳过")
        return
    assert OLD in t, "锚点未命中"
    t = t.replace(OLD, NEW, 1)
    TARGET.write_text(t, encoding="utf-8")
    print("analyze() 已改为包围盒归一化")


if __name__ == "__main__":
    main()
