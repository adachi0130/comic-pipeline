"""漫画页渲染器：编辑文档 → 整页 PNG。

设计目标：**手动编辑预览与后台 S5 拼页共用同一套几何与图层算法**，避免出现
“编辑器看着对、导出却错位”的两套实现。因此这里只依赖编辑文档本身（纯数据），
不碰浏览器、不需要 MED、也不需要用户打开页面。

支持的绘制内容（与前端编辑器一致）：
- 分镜框：多边形裁剪 + 图片按 scale/rotation 摆放 + 边框描边
- 元素：气泡（贝塞尔轮廓）、文字、贴纸（内嵌 dataURL 图片），带旋转/倾斜/镜像/蒙版/羽化
- 笔迹：画笔与橡皮（橡皮是白色笔迹，覆盖而非删除）

自动拼页的默认输入只有版式与已采用图片；手工图层仅在文档里真的有内容时才会画出来。
"""

from __future__ import annotations

import base64
import binascii
import io
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from .balloons import balloon_polygons

DEFAULT_BORDER = "#111111"


class RenderError(RuntimeError):
    """渲染失败（文档结构不合法或素材缺失）。"""


# ------------------------------------------------------------------ 图片解码
def _load_data_url(url: str) -> Image.Image:
    if not isinstance(url, str) or not url.startswith("data:"):
        raise RenderError("图片素材不是内嵌 dataURL")
    header, _, payload = url.partition(",")
    try:
        raw = base64.b64decode(payload) if ";base64" in header else payload.encode("utf-8")
    except (binascii.Error, ValueError) as exc:
        raise RenderError(f"图片素材解码失败：{exc}") from exc
    try:
        image = Image.open(io.BytesIO(raw))
        image.load()
        return image.convert("RGBA")
    except OSError as exc:
        raise RenderError(f"图片素材无法识别：{exc}") from exc


def _load_file(path: str | Path) -> Image.Image:
    try:
        image = Image.open(path)
        image.load()
        return image.convert("RGBA")
    except OSError as exc:
        raise RenderError(f"图片文件无法读取：{path}") from exc


def load_image_source(source) -> Image.Image:
    """接受 dataURL 字符串、bytes 或本地路径。"""
    if isinstance(source, Image.Image):
        return source.convert("RGBA")
    if isinstance(source, (bytes, bytearray)):
        return Image.open(io.BytesIO(bytes(source))).convert("RGBA")
    if isinstance(source, str) and source.startswith("data:"):
        return _load_data_url(source)
    if isinstance(source, (str, Path)):
        return _load_file(source)
    raise RenderError("不支持的图片素材类型")


# ------------------------------------------------------------------ 几何工具
def _polygon_mask(size: tuple[int, int], points: list[tuple[float, float]], scale: float = 1.0) -> Image.Image:
    mask = Image.new("L", size, 0)
    if len(points) >= 3:
        ImageDraw.Draw(mask).polygon([(x * scale, y * scale) for x, y in points], fill=255)
    return mask


def _resize_cover(image: Image.Image, scale: float) -> Image.Image:
    width = max(1, int(round(image.width * scale)))
    height = max(1, int(round(image.height * scale)))
    return image.resize((width, height), Image.LANCZOS)


def _rotate_about(image: Image.Image, angle: float) -> Image.Image:
    if not angle:
        return image
    # 用 expand=True 保留完整内容，再按旋转后的外接框重新定位。
    return image.rotate(-angle, resample=Image.BICUBIC, expand=True)


def _hex_to_rgba(value: str, fallback=(0, 0, 0, 255)) -> tuple[int, int, int, int]:
    text = (value or "").strip()
    if text.startswith("#"):
        text = text[1:]
        if len(text) == 3:
            text = "".join(ch * 2 for ch in text)
        if len(text) == 6:
            try:
                return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16), 255)
            except ValueError:
                return fallback
    if text.startswith("rgb"):
        numbers = [int(float(v)) for v in text[text.find("(") + 1: text.rfind(")")].split(",") if v.strip()]
        if len(numbers) >= 3:
            alpha = int(numbers[3] * 255) if len(numbers) > 3 else 255
            return (numbers[0], numbers[1], numbers[2], alpha)
    return fallback


# ------------------------------------------------------------------ 分镜框
def _draw_panel(canvas: Image.Image, panel: dict, *, scale: float, image_source=None) -> None:
    points = [(float(x), float(y)) for x, y in (panel.get("points") or [])]
    if len(points) < 3:
        return
    width, height = canvas.size

    image = None
    if image_source is not None:
        try:
            image = load_image_source(image_source)
        except RenderError:
            image = None
    if image is not None:
        spec = panel.get("image") or {}
        x0, x1 = min(p[0] for p in points), max(p[0] for p in points)
        y0, y1 = min(p[1] for p in points), max(p[1] for p in points)
        img_scale = float(spec.get("scale") or 0)
        explicit = img_scale > 0 and float(spec.get("width") or 0) > 0 and float(spec.get("height") or 0) > 0
        if not explicit:
            # 没有显式构图时居中铺满画框（cover），保证内容不露白。
            # 注意：文档里的 x/y 默认是 0，不能直接拿来当位置；只有"显式构图"才用它。
            img_scale = max((x1 - x0) / image.width, (y1 - y0) / image.height) if image.width and image.height else 1.0
        scaled = _resize_cover(image, img_scale * scale)
        rotation = float(spec.get("rotation") or 0)
        if rotation:
            scaled = _rotate_about(scaled, rotation)
        if explicit:
            left = float(spec.get("x") or 0) * scale
            top = float(spec.get("y") or 0) * scale
        else:
            left = ((x0 + x1) / 2 * scale) - scaled.width / 2
            top = ((y0 + y1) / 2 * scale) - scaled.height / 2
        mask = _polygon_mask((width, height), points, scale)
        layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        layer.paste(scaled, (int(round(left)), int(round(top))), scaled)
        clipped = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        clipped.paste(layer, (0, 0), mask)
        canvas.alpha_composite(clipped)

    border = float(panel.get("borderWidth") or 0)
    if border > 0:
        outline = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(outline)
        draw.polygon([(x * scale, y * scale) for x, y in points],
                     outline=_hex_to_rgba(panel.get("stroke") or DEFAULT_BORDER),
                     width=max(1, int(round(border * scale))))
        canvas.alpha_composite(outline)


# ------------------------------------------------------------------ 文字
_FONT_CANDIDATES = (
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/msyhl.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/System/Library/Fonts/PingFang.ttc",
)


def _font(size: int, family: str | None = None):
    size = max(1, int(round(size)))
    candidates = list(_FONT_CANDIDATES)
    if family and "\\" not in family and "/" not in family:
        candidates.insert(0, family)
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size)
        except (OSError, ValueError):
            continue
    return ImageFont.load_default()


def _wrap_text(text: str, font, max_width: float) -> list[str]:
    """按像素宽度折行；中文逐字断行，英文优先按空格断。"""
    lines: list[str] = []
    for paragraph in str(text).replace("\r\n", "\n").split("\n"):
        if not paragraph:
            lines.append("")
            continue
        current = ""
        for chunk in _chunks(paragraph):
            candidate = current + chunk
            if current and font.getlength(candidate) > max_width:
                lines.append(current.rstrip())
                current = chunk.lstrip() if chunk.isspace() else chunk
            else:
                current = candidate
        lines.append(current.rstrip())
    return lines


def _chunks(text: str) -> list[str]:
    """切成“词 + 尾随空格”或单字，兼顾中英文。"""
    out: list[str] = []
    buffer = ""
    for char in text:
        if char.isspace():
            buffer += char
            out.append(buffer)
            buffer = ""
        elif ord(char) > 0x2E80:  # CJK：逐字断行
            if buffer:
                out.append(buffer)
                buffer = ""
            out.append(char)
        else:
            buffer += char
    if buffer:
        out.append(buffer)
    return out


def _draw_text_block(layer: Image.Image, element: dict, box: tuple[float, float, float, float], scale: float) -> None:
    text = str(element.get("text") or "")
    if not text:
        return
    left, top, width, height = box
    size = float(element.get("fontSize") or 28) * scale
    font = _font(size, element.get("fontFamily"))
    line_height = float(element.get("lineHeight") or 1.25) * size
    color = _hex_to_rgba(element.get("color") or "#111111")
    # 与上游一致：只有独立文字元素带描边，气泡里的字只填充。
    stroke_width = float(element.get("strokeWidth") or 0) * scale if element.get("kind") == "text" else 0.0
    align = element.get("textAlign") or "center"
    vertical = element.get("writingMode") == "vertical-rl"

    draw = ImageDraw.Draw(layer)
    if vertical:
        # 竖排：每列一个字符，从右向左排。
        capacity = max(1, int(height // line_height))
        columns: list[str] = []
        for paragraph in text.replace("\r\n", "\n").split("\n"):
            chars = list(paragraph)
            columns.extend("".join(chars[i:i + capacity]) for i in range(0, len(chars), capacity) or [""])
        x = left + width - size / 2
        for column in columns:
            y = top
            for char in column:
                draw.text((x, y), char, font=font, fill=color,
                          stroke_width=int(stroke_width), stroke_fill=color, anchor="mm")
                y += line_height
            x -= line_height
        return

    lines = _wrap_text(text, font, width)
    block_height = len(lines) * line_height
    y = top + (height - block_height) / 2
    for line in lines:
        if align == "left":
            x, anchor = left, "lm"
        elif align == "right":
            x, anchor = left + width, "rm"
        else:
            x, anchor = left + width / 2, "mm"
        draw.text((x, y + line_height / 2), line, font=font, fill=color,
                  stroke_width=int(stroke_width), stroke_fill=color, anchor=anchor)
        y += line_height


# ------------------------------------------------------------------ 元素
def _element_matrix(element: dict) -> tuple[float, ...]:
    radians = math.pi / 180
    rotation = float(element.get("rotation") or 0) * radians
    cos, sin = math.cos(rotation), math.sin(rotation)
    skew_x = math.tan(float(element.get("skewX") or 0) * radians)
    skew_y = math.tan(float(element.get("skewY") or 0) * radians)
    flip_x = -1 if element.get("flipX") else 1
    flip_y = -1 if element.get("flipY") else 1
    a = flip_x * (cos * (1 + skew_x * skew_y) - sin * skew_y)
    b = flip_x * (sin * (1 + skew_x * skew_y) + cos * skew_y)
    c = flip_y * (cos * skew_x - sin)
    d = flip_y * (sin * skew_x + cos)
    x = float(element.get("x") or 0)
    y = float(element.get("y") or 0)
    w = float(element.get("width") or 0)
    h = float(element.get("height") or 0)
    return (a, b, c, d, x + w / 2 - a * w / 2 - c * h / 2, y + h / 2 - b * w / 2 - d * h / 2)


def _draw_element(canvas: Image.Image, element: dict, *, scale: float) -> None:
    kind = element.get("kind") or "text"
    width = float(element.get("width") or 0)
    height = float(element.get("height") or 0)
    if width <= 0 or height <= 0:
        return

    # 元素先在自身局部坐标里画好，再按矩阵贴到页面。
    local = Image.new("RGBA", (max(1, int(width * scale)), max(1, int(height * scale))), (0, 0, 0, 0))
    fill = element.get("fill") or "none"

    if kind == "bubble" and not element.get("dataUrl"):
        stroke = _hex_to_rgba(element.get("stroke") or "#111111")
        polygons = balloon_polygons(element)
        if fill and fill != "none":
            for polygon in polygons:
                ImageDraw.Draw(local).polygon([(x * scale, y * scale) for x, y in polygon],
                                              fill=_hex_to_rgba(fill))
        stroke_width = max(1, int(round(float(element.get("strokeWidth") or 2) * scale)))
        for polygon in polygons:
            # 补回首点闭合轮廓；polygon 为空时跳过，避免索引错误。
            outline = [(x * scale, y * scale) for x, y in polygon]
            if len(outline) >= 2:
                outline.append(outline[0])
                ImageDraw.Draw(local).line(outline, fill=stroke, width=stroke_width, joint="curve")
        preset = element.get("presetId") or "speech"
        box = _text_box_for_preset(preset, width * scale, height * scale)
        _draw_text_block(local, element, box, scale)
    elif element.get("dataUrl"):
        asset = load_image_source(element.get("dataUrl"))
        asset = asset.resize((local.width, local.height), Image.LANCZOS)
        local.alpha_composite(asset)
        box = (width * 0.04 * scale, height * 0.04 * scale, width * 0.92 * scale, height * 0.92 * scale)
        _draw_text_block(local, element, box, scale)
    else:
        if fill and fill != "none":
            ImageDraw.Draw(local).rectangle([0, 0, local.width - 1, local.height - 1],
                                            fill=_hex_to_rgba(fill))
        box = (width * 0.04 * scale, height * 0.04 * scale, width * 0.92 * scale, height * 0.92 * scale)
        _draw_text_block(local, element, box, scale)

    # 蒙版裁剪（0..1 四角坐标）
    mask_points = element.get("mask") or [
        {"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 1}, {"x": 0, "y": 1},
    ]
    if len(mask_points) >= 3:
        mask = Image.new("L", local.size, 0)
        ImageDraw.Draw(mask).polygon(
            [(float(p.get("x") or 0) * local.width, float(p.get("y") or 0) * local.height) for p in mask_points],
            fill=255,
        )
        clipped = Image.new("RGBA", local.size, (0, 0, 0, 0))
        clipped.paste(local, (0, 0), mask)
        local = clipped

    feather = float(element.get("feather") or 0) * scale
    if feather > 0:
        local = local.filter(ImageFilter.GaussianBlur(radius=feather / 3))

    opacity = float(element.get("opacity") if element.get("opacity") is not None else 1)
    if opacity < 1:
        alpha = local.getchannel("A").point(lambda value: int(value * max(0.0, opacity)))
        local.putalpha(alpha)

    matrix = _element_matrix(element)
    _paste_transformed(canvas, local, matrix, scale)


def _text_box_for_preset(preset: str, width: float, height: float) -> tuple[float, float, float, float]:
    """与前端 ``COMIC_BALLOON_PRESETS[*].textBox`` 保持一致的内边距。"""
    table = {
        "speech": (0.16, 0.14, 0.68, 0.56), "speech-right": (0.16, 0.14, 0.68, 0.56),
        "ellipse": (0.16, 0.2, 0.68, 0.6), "round-box": (0.13, 0.14, 0.74, 0.55),
        "caption": (0.1, 0.12, 0.8, 0.76), "thought": (0.2, 0.15, 0.6, 0.5),
        "cloud": (0.2, 0.2, 0.6, 0.6), "shout": (0.22, 0.23, 0.56, 0.54),
        "impact": (0.24, 0.26, 0.52, 0.48), "whisper": (0.16, 0.14, 0.68, 0.56),
        "speed": (0.24, 0.24, 0.52, 0.52), "electric": (0.2, 0.18, 0.6, 0.54),
        "jaggy-small": (0.25, 0.2, 0.5, 0.6), "jaggy-wide": (0.2, 0.22, 0.6, 0.56),
        "vibration": (0.2, 0.17, 0.6, 0.66), "mumble": (0.24, 0.14, 0.52, 0.72),
        "announcement": (0.24, 0.25, 0.52, 0.51), "whisper-oval": (0.2, 0.15, 0.6, 0.7),
        "burst-fine": (0.35, 0.35, 0.3, 0.3), "jagged-star": (0.24, 0.24, 0.52, 0.52),
        "speed-oval": (0.28, 0.26, 0.44, 0.48),
    }
    left, top, w, h = table.get(preset, (0.16, 0.14, 0.68, 0.56))
    return (left * width, top * height, w * width, h * height)


def _paste_transformed(canvas: Image.Image, local: Image.Image, matrix: tuple[float, ...], scale: float) -> None:
    """按 SVG matrix 语义把元素贴到页面（仅支持旋转/镜像/缩放，倾斜近似）。"""
    a, b, c, d, e, f = matrix
    angle = math.degrees(math.atan2(b, a))
    rotated = _rotate_about(local, -angle) if abs(angle) > 0.01 else local
    # 旋转后的左上角按元素的中心点重新计算，保持位置准确。
    cx = (e + a * local.width / 2 + c * local.height / 2) * scale
    cy = (f + b * local.width / 2 + d * local.height / 2) * scale
    left = int(round(cx - rotated.width / 2))
    top = int(round(cy - rotated.height / 2))
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    layer.paste(rotated, (left, top), rotated)
    canvas.alpha_composite(layer)


# ------------------------------------------------------------------ 笔迹
def _draw_stroke(canvas: Image.Image, stroke: dict, *, scale: float) -> None:
    points = [(float(p["x"]) * scale, float(p["y"]) * scale) for p in (stroke.get("points") or []) if "x" in p]
    if not points:
        return
    color = "#ffffff" if stroke.get("kind") == "erase" else (stroke.get("color") or "#111111")
    width = max(1, int(round(float(stroke.get("width") or 5) * scale)))
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    rgba = _hex_to_rgba(color, (255, 255, 255, 255))
    if len(points) == 1:
        x, y = points[0]
        draw.ellipse([x - width / 2, y - width / 2, x + width / 2, y + width / 2], fill=rgba)
    else:
        draw.line(points, fill=rgba, width=width, joint="curve")
        radius = width / 2
        for x, y in (points[0], points[-1]):
            draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=rgba)
    canvas.alpha_composite(layer)


# ------------------------------------------------------------------ 主入口
def _render_items(document: dict) -> list[tuple[str, dict]]:
    """按图层顺序展开可见内容；锁定层仍参与绘制，隐藏层跳过。"""
    layers = document.get("layers") or []
    if not layers:
        layers = [{"id": "panels", "kind": "panels", "visible": True, "locked": False},
                  {"id": "overlays", "kind": "overlays", "visible": True, "locked": False},
                  {"id": "dialogue", "kind": "dialogue", "visible": True, "locked": False}]
    positions = {layer["id"]: index for index, layer in enumerate(layers) if layer.get("visible", True)}
    items: list[tuple[int, float, str, dict]] = []
    for kind, collection in (("panel", "panels"), ("stroke", "strokes"), ("element", "elements")):
        for item in document.get(collection) or []:
            layer_id = item.get("layerId")
            if layer_id not in positions:
                continue
            order = item.get("order")
            items.append((positions[layer_id], float(order) if isinstance(order, (int, float)) else 0.0, kind, item))
    items.sort(key=lambda entry: (entry[0], entry[1]))
    return [(kind, item) for _layer, _order, kind, item in items]


def render_page(
    document: dict,
    *,
    scale: float = 1.0,
    image_lookup=None,
) -> Image.Image:
    """把编辑文档渲染成 RGBA 整页图。

    ``image_lookup``：``panel_ref``/``panel_order`` → 本地图片路径的回调；缺省时
    使用 ``panel["image"]["dataUrl"]``（编辑器保存的自包含文档）。
    """
    width = int(round(float(document.get("width") or 0)))
    height = int(round(float(document.get("height") or 0)))
    if width <= 0 or height <= 0:
        raise RenderError("编辑文档缺少有效画布尺寸")
    scale = max(0.05, float(scale or 1.0))
    canvas = Image.new("RGBA", (int(round(width * scale)), int(round(height * scale))), (255, 255, 255, 255))

    for kind, item in _render_items(document):
        if kind == "panel":
            source = None
            spec = item.get("image") or {}
            if spec.get("dataUrl"):
                source = spec["dataUrl"]
            elif image_lookup is not None:
                source = image_lookup(item)
            _draw_panel(canvas, item, scale=scale, image_source=source)
        elif kind == "stroke":
            _draw_stroke(canvas, item, scale=scale)
        else:
            _draw_element(canvas, item, scale=scale)
    return canvas


def render_png(document: dict, *, scale: float = 1.0, image_lookup=None, optimize: bool = True) -> bytes:
    image = render_page(document, scale=scale, image_lookup=image_lookup)
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="PNG", optimize=optimize)
    return buffer.getvalue()
