# S1 / S3 / S4 提示词（M1 交付）

本目录放**版本化**的阶段提示词资产，每份包含：系统提示词 + 对应 pydantic schema + 1–2 个少样本 + 自检项。

| 文件 | 阶段 | 输入 | 输出 | 硬约束 |
|---|---|---|---|---|
| `s1_structure.md` | S1 结构规划 | 故事大纲 + 目标页数 | `Structure`（章→场） | 全场 `page_budget` 之和 **严格等于** `target_pages` |
| `s3_script.md` | S3 分格+选模板 | 页正文切片 + 69 模板菜单 + 技法库 | `PageScript`（选模板 + N 格） | `panels` 条数 **等于** 所选模板格数；`panel_order` 连续 |
| `s4_prompt.md` | S4 分镜提示词 | 每格脚本 + 角色/LoRA 资产 + 技法标签 | `PagePrompts` | 自动拼角色词块 + 技法词块 + LoRA 绑定 |

对应 schema 见 `backend/app/schemas.py`（S1=`Structure`、S3=`PageScript`、S4=`PagePrompts`）。
模板菜单由 `backend/scripts/build_template_menu.py` 生成、经 `GET /api/meta` 提供给 S3。
