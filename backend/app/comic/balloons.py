"""对话气泡轮廓（移植自 novelai_local_web ``comicBalloonPaths.mjs``）。

许可说明见 ``docs/漫画编辑器移植来源清单.md``：原文作者 YILING0013，AGPL-3.0。
这里保留同一套节点数据与生成规则，使浏览器预览与后台 S5 拼页画出的气泡一致；
Python 版把三次贝塞尔展开成折线，供 Pillow 填充。

坐标约定与上游一致：轮廓在 0..100 的局部空间，渲染时按元素宽高缩放。
"""

from __future__ import annotations

import math

Point = dict  # {x, y, inX, inY, outX, outY, smooth?}


def _node(x: float, y: float, in_x: float | None = None, in_y: float | None = None,
          out_x: float | None = None, out_y: float | None = None) -> Point:
    return {
        "x": x, "y": y,
        "inX": x if in_x is None else in_x, "inY": y if in_y is None else in_y,
        "outX": x if out_x is None else out_x, "outY": y if out_y is None else out_y,
    }


def _ellipse(cx: float, cy: float, rx: float, ry: float) -> list[Point]:
    k = 0.5522847498307936
    points = [
        _node(cx, cy - ry, cx - rx * k, cy - ry, cx + rx * k, cy - ry),
        _node(cx + rx, cy, cx + rx, cy - ry * k, cx + rx, cy + ry * k),
        _node(cx, cy + ry, cx + rx * k, cy + ry, cx - rx * k, cy + ry),
        _node(cx - rx, cy, cx - rx, cy + ry * k, cx - rx, cy - ry * k),
    ]
    for point in points:
        point["smooth"] = True
    return points


def balloon_contours(preset_id: str) -> list[list[Point]]:
    """取得预设气泡的闭合轮廓；与上游返回的数据结构一致。"""
    speech = [
        _node(25, 76, 25, 76, 9, 70), _node(4, 43, 4, 58, 4, 17), _node(50, 4, 24, 4, 78, 4),
        _node(96, 43, 96, 18, 96, 69), _node(46, 81, 73, 82), _node(18, 96),
    ]
    cloud = [
        _node(19, 20, 4, 21, 17, 8), _node(44, 10, 36, 1, 56, 0), _node(76, 17, 72, 5, 92, 13),
        _node(92, 39, 101, 28, 104, 51), _node(83, 70, 96, 69, 86, 88), _node(54, 86, 65, 97, 40, 101),
        _node(20, 78, 20, 91, 2, 81), _node(9, 50, -2, 58, -1, 37),
    ]
    if preset_id in ("ellipse", "speed-oval"):
        return [_ellipse(50, 50, 46, 45)]
    if preset_id in ("caption", "speed"):
        return [[_node(4, 5), _node(96, 5), _node(96, 95), _node(4, 95)]]
    if preset_id == "round-box":
        return [[
            _node(15, 5, 8, 5), _node(85, 5, 85, 5, 93, 5), _node(96, 17, 96, 9),
            _node(96, 68, 96, 68, 96, 76), _node(84, 80, 92, 80), _node(45, 80),
            _node(21, 96), _node(24, 80), _node(15, 80, 15, 80, 8, 80),
            _node(4, 68, 4, 76), _node(4, 17, 4, 17, 4, 9),
        ]]
    if preset_id == "cloud":
        return [cloud]
    if preset_id == "thought":
        scaled = [
            {
                "x": p["x"] * 0.94 + 3, "y": p["y"] * 0.8 + 1,
                "inX": p["inX"] * 0.94 + 3, "inY": p["inY"] * 0.8 + 1,
                "outX": p["outX"] * 0.94 + 3, "outY": p["outY"] * 0.8 + 1,
                **({"smooth": True} if p.get("smooth") else {}),
            }
            for p in cloud
        ]
        return [scaled, _ellipse(24, 85, 7, 5), _ellipse(14, 94, 3, 2.5)]
    if preset_id in ("shout", "impact", "burst-fine", "jagged-star"):
        count = {"burst-fine": 60, "jagged-star": 34, "shout": 28}.get(preset_id, 18)
        contour = []
        for index in range(count):
            angle = index * math.pi * 2 / count - math.pi / 2
            varied = (math.sin(index * 12.9898 + 4.1) + 1) / 2
            if index % 2:
                radius = {"impact": 0.58, "shout": 0.77, "burst-fine": 0.33 + varied * 0.2}.get(
                    preset_id, 0.72 + varied * 0.08
                )
            else:
                radius = (0.82 + varied * 0.18) if preset_id in ("burst-fine", "jagged-star") else 1.0
            contour.append(_node(50 + math.cos(angle) * 47 * radius, 50 + math.sin(angle) * 46 * radius))
        return [contour]
    if preset_id == "electric":
        coords = [[12, 14], [29, 9], [38, 15], [53, 4], [64, 12], [85, 9], [88, 26], [97, 36],
                  [89, 51], [95, 67], [79, 77], [56, 73], [31, 96], [38, 76], [17, 78], [13, 65],
                  [3, 52], [12, 38], [6, 26]]
        return [[_node(x, y) for x, y in coords]]
    if preset_id == "jaggy-small":
        return [[
            _node(19, 5, 23, 25, 28, 16), _node(52, 11, 39, 15, 65, 15), _node(82, 3, 72, 15, 74, 26),
            _node(84, 42, 78, 34, 88, 45), _node(96, 48, 94, 48, 84, 52), _node(82, 91, 80, 71, 68, 87),
            _node(59, 94, 65, 88, 55, 86), _node(22, 94, 36, 89, 23, 74), _node(5, 51, 20, 61, 23, 49),
        ]]
    if preset_id == "jaggy-wide":
        return [[
            _node(5, 5, 19, 22, 23, 21), _node(47, 6, 33, 16, 53, 17), _node(74, 5, 62, 19, 77, 14),
            _node(95, 7, 88, 15, 84, 31), _node(96, 50, 84, 40, 84, 62), _node(96, 94, 85, 77, 81, 85),
            _node(57, 95, 71, 85, 45, 85), _node(5, 94, 29, 85, 19, 74), _node(4, 48, 16, 58, 19, 32),
        ]]
    if preset_id == "announcement":
        return [[
            _node(4, 13, 11, 37, 15, 18), _node(23, 15, 18, 18), _node(23, 3), _node(41, 16),
            _node(77, 16, 59, 19), _node(92, 4), _node(86, 25), _node(96, 24),
            _node(89, 49, 91, 37, 90, 63), _node(98, 73), _node(84, 72), _node(87, 96),
            _node(69, 88, 75, 89, 51, 85), _node(10, 94, 28, 89, 16, 71), _node(3, 66),
            _node(13, 54, 11, 60, 12, 37),
        ]]
    if preset_id == "whisper-oval":
        return [_ellipse(50, 50, 42, 46)]
    if preset_id in ("vibration", "mumble"):
        count = 24 if preset_id == "vibration" else 16
        points = []
        for index in range(count):
            angle = index * math.pi * 2 / count - math.pi / 2
            if preset_id == "vibration":
                radius = 0.92 if index % 2 else 1.0
            else:
                radius = 0.96 + math.sin(index * 2.3) * 0.045
            rx = 38 if preset_id == "mumble" else 45
            points.append(_node(50 + math.cos(angle) * rx * radius, 50 + math.sin(angle) * 46 * radius))
        contour = []
        for index, point in enumerate(points):
            previous = points[(index - 1) % count]
            nxt = points[(index + 1) % count]
            node = _node(
                point["x"], point["y"],
                point["x"] - (nxt["x"] - previous["x"]) / 6,
                point["y"] - (nxt["y"] - previous["y"]) / 6,
                point["x"] + (nxt["x"] - previous["x"]) / 6,
                point["y"] + (nxt["y"] - previous["y"]) / 6,
            )
            node["smooth"] = True
            contour.append(node)
        return [contour]
    if preset_id == "speech-right":
        return [[{**p, "x": 100 - p["x"], "inX": 100 - p["inX"], "outX": 100 - p["outX"]} for p in speech]]
    return [speech]


def contour_to_polygon(contour: list[Point], *, samples: int = 12) -> list[tuple[float, float]]:
    """把一段闭合贝塞尔轮廓展开成折线（局部 0..100 坐标）。"""
    if not contour:
        return []
    polygon: list[tuple[float, float]] = [(contour[0]["x"], contour[0]["y"])]
    for index, point in enumerate(contour):
        nxt = contour[(index + 1) % len(contour)]
        p0 = (point["x"], point["y"])
        p1 = (point["outX"], point["outY"])
        p2 = (nxt["inX"], nxt["inY"])
        p3 = (nxt["x"], nxt["y"])
        # 控制柄都落在端点上时是直线段，直接连过去，避免退化成密集点。
        if p1 == p0 and p2 == p3:
            polygon.append(p3)
            continue
        for step in range(1, samples + 1):
            t = step / samples
            u = 1 - t
            x = u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0]
            y = u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1]
            polygon.append((x, y))
    return polygon


def balloon_polygons(element: dict) -> list[list[tuple[float, float]]]:
    """元素 → 页面坐标下的气泡轮廓集合（已按元素宽高缩放）。"""
    contours = element.get("balloonContours") or balloon_contours(element.get("presetId") or "speech")
    width = float(element.get("width") or 0)
    height = float(element.get("height") or 0)
    result = []
    for contour in contours:
        polygon = contour_to_polygon(contour)
        result.append([(x / 100.0 * width, y / 100.0 * height) for x, y in polygon])
    return result
