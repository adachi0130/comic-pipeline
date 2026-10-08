"""灌入技法库种子数据（漫画技法 → 提示词词块 / MED 动作 / 是否 PS）。

这也是 S3 提示词里“技法库”的来源。render_mode 决定 S6 用 MED 的哪个能力：
- med_focusline  集中线（MED 原生生成器）
- med_speedline  运动线（MED 原生生成器）
- med_tone       网点（MED 5 个网点生成器）
- text           拟声词/文字（MED 文字工具 + 字体）
- ps             破格等需要 PS 后处理（MED 导出 SVG 矢量框线回填）

用法：.venv/Scripts/python.exe backend/scripts/seed_techniques.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import delete  # noqa: E402

from app.db import SessionLocal, init_db  # noqa: E402
from app.models import Technique  # noqa: E402

TECHNIQUES = [
    {
        "id": "focus_line",
        "name": "集中线",
        "stage": "S3/S4/S6",
        "prompt_block": "concentration lines, focus lines, radial speed lines",
        "render_mode": "med_focusline",
        "config": {"generator": "focusLineStart", "params": ["line_count", "line_size", "center_x", "center_y", "radius_min", "radius_max"]},
    },
    {
        "id": "speed_line",
        "name": "运动线",
        "stage": "S3/S4/S6",
        "prompt_block": "motion lines, speed lines, action lines",
        "render_mode": "med_speedline",
        "config": {"generator": "drawTempCanvasSpeedlines", "params": ["color", "style", "gradient", "density"]},
    },
    {
        "id": "screentone",
        "name": "网点",
        "stage": "S6",
        "prompt_block": "screentone, halftone dots",
        "render_mode": "med_tone",
        "config": {"generators": ["harf-tone", "tone-noise", "snow-tone", "speedline", "focusline"]},
    },
    {
        "id": "sfx",
        "name": "拟声词",
        "stage": "S3/S6",
        "prompt_block": "onomatopoeia, sound effect text",
        "render_mode": "text",
        "config": {"note": "勿让图像模型画字；用 MED 文字工具 + 拟声词字体（23 款）"},
    },
    {
        "id": "panel_break",
        "name": "破格",
        "stage": "S3/S6",
        "prompt_block": "character breaking out of the panel frame, dynamic composition",
        "render_mode": "ps",
        "config": {"note": "MED 图片默认被框裁切；破格走 PS：MED 导出 SVG（框线是矢量）后精修回填"},
    },
    {
        "id": "big_panel",
        "name": "大格/泼墨",
        "stage": "S3/S6",
        "prompt_block": "dynamic splash page, dramatic composition, ink splash",
        "render_mode": "prompt_only",
        "config": {},
    },
]


def main() -> None:
    init_db()
    session = SessionLocal()
    try:
        session.execute(delete(Technique))
        for t in TECHNIQUES:
            session.add(Technique(**t))
        session.commit()
        print(f"技法库已灌入 {len(TECHNIQUES)} 条：{[t['name'] for t in TECHNIQUES]}")
    finally:
        session.close()


if __name__ == "__main__":
    main()
