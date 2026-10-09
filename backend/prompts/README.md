# 各阶段提示词（版本化资产）

本目录放**版本化**的阶段提示词，每份包含：系统提示词 + 对应 pydantic schema 参考 + 少样本/自检项。

新流程（**已去掉结构规划**）：

| 文件 | 阶段 | 输入 | 输出 | 硬约束 |
|---|---|---|---|---|
| `s2_script.md` | S2 分页分格 | 已通过的小说全文 + 起始页 + 69 模板菜单 + 技法库 | `Storyboard`（多页 `PageScript`） | 每页 `panels` 条数 **等于** 所选模板格数；`panel_order` 连续 |
| `s3_prompt.md` | S3 分镜提示词 | 每页分格脚本 + 角色/LoRA 资产 + 技法标签 | `PagePrompts` | 自动拼角色词块 + 技法词块 + LoRA 绑定 |

- S1 正文**不用提示词文件**：由酒馆（角色卡/世界书/预设）生成，引导词/续写提示由前端传入。
- schema 见 `backend/app/schemas.py`（`Storyboard` / `PageScript` / `PagePrompts`）。
- 模板菜单由 `backend/scripts/build_template_menu.py` 生成，经 `GET /api/meta` 提供给 S2。
