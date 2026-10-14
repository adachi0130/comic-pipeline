"""把 ComfyUI UI 格式工作流里的「子图（subgraph）」展开成扁平节点。

背景：新版 ComfyUI 把一组节点打包成「子图」，在顶层只留一个 UUID 类型的实例节点，
内部定义放在 ``definitions.subgraphs`` 里。这样导出 API / 找采样器时顶层就「看不到」
KSampler 等节点。本模块按定义把子图摊平，使后续 ``ui_to_api`` 能正常处理。

边界规则（实测新版 ComfyUI）：
- 子图内部的 link 里 ``origin_id == -10`` 表示「来自子图第 N 个输入」；
  ``target_id == -20`` 表示「连到子图第 M 个输出」。
- 子图实例节点在父级里，其 ``inputs[i].link`` 是父级喂给它的源；
  ``outputs[o].links`` 是被它喂的父级消费者。
"""

from __future__ import annotations

from typing import Any


def _links_table(links: Any) -> dict[str, tuple]:
    """把连线表统一成 ``{link_id: (origin_id, origin_slot, target_id, target_slot, type)}``。

    顶层 link 是数组 ``[id, origin, origin_slot, target, target_slot, type]``；
    子图内 link 是对象 ``{id, origin_id, origin_slot, target_id, target_slot, type}``。
    """
    out: dict[str, tuple] = {}
    for l in links or []:
        if isinstance(l, dict):
            out[str(l.get("id"))] = (
                str(l.get("origin_id")), l.get("origin_slot"),
                str(l.get("target_id")), l.get("target_slot"), l.get("type"),
            )
        elif isinstance(l, (list, tuple)) and len(l) >= 5:
            out[str(l[0])] = (str(l[1]), l[2], str(l[3]), l[4], (l[5] if len(l) > 5 else None))
    return out


def expand_subgraphs_ui(raw: dict) -> tuple[dict, list[str]]:
    """展开所有子图，返回 ``(扁平 UI 工作流, warnings)``。无子图时原样返回。

    展开后节点 id 用「父路径/子id」命名（如 ``336/19``）避免冲突；连线重建。
    """
    defs = {str(s.get("id")): s for s in (raw.get("definitions") or {}).get("subgraphs", []) or []}
    if not defs:
        return raw, []

    warnings: list[str] = []
    flat_nodes: dict[str, dict] = {}
    flat_links: dict[int, list] = {}
    seq = {"link": 0}

    def add_link(src: str, sslot: int, dst: str, dslot: int, ty: Any) -> None:
        seq["link"] += 1
        lid = seq["link"]
        flat_links[lid] = [lid, src, sslot, dst, dslot, ty]
        if dst in flat_nodes:
            ins = flat_nodes[dst]["inputs"]
            if isinstance(dslot, int) and 0 <= dslot < len(ins):
                ins[dslot]["link"] = lid
        if src in flat_nodes:
            outs = flat_nodes[src]["outputs"]
            if isinstance(sslot, int) and 0 <= sslot < len(outs):
                outs[sslot].setdefault("links", []).append(lid)

    def expand_scope(nodes, links, prefix: str, in_map, depth: int) -> dict:
        """展开一个作用域；返回 ``{输出槽: (源节点, 源槽)}``。"""
        if depth > 10:
            warnings.append("子图嵌套过深，已停止展开")
            return {}
        lt = _links_table(links)
        local: dict[str, str] = {}
        for n in nodes or []:
            if not isinstance(n, dict):
                continue
            oid = str(n.get("id"))
            fid = prefix + oid
            local[oid] = fid
            flat_nodes[fid] = {
                "id": fid, "type": n.get("type") or "", "title": n.get("title", ""),
                "pos": n.get("pos"), "size": n.get("size"),
                "widgets_values": n.get("widgets_values"),
                "inputs": [{"name": i.get("name"), "type": i.get("type"), "link": None}
                           for i in (n.get("inputs") or [])],
                "outputs": [{"name": o.get("name"), "type": o.get("type"), "links": []}
                            for o in (n.get("outputs") or [])],
            }

        # 1) 作用域内部连线
        for lid, (o_id, o_slot, t_id, t_slot, ty) in lt.items():
            if t_id == "-20":
                continue  # 输出边界，稍后统一处理
            dst = local.get(t_id)
            if dst is None:
                continue
            if o_id == "-10":
                src = in_map.get(o_slot) if in_map else None
                if src:
                    add_link(src[0], src[1], dst, t_slot, ty)
            else:
                s = local.get(o_id)
                if s is not None:
                    add_link(s, o_slot, dst, t_slot, ty)

        # 2) 递归展开作用域内的子图实例，并把父级连线改接到展开后的内部节点
        for n in nodes or []:
            if not isinstance(n, dict):
                continue
            cls = n.get("type")
            sub = defs.get(str(cls))
            if sub is None:
                continue
            fid = local[str(n.get("id"))]
            sub_in = {}
            for i, inp in enumerate(flat_nodes[fid]["inputs"]):
                l_id = inp.get("link")
                if l_id and l_id in flat_links:
                    sub_in[i] = (flat_links[l_id][1], flat_links[l_id][2])
            outs = expand_scope(sub.get("nodes") or [], sub.get("links") or [],
                                fid + "/", sub_in, depth + 1)
            # 把「实例输出 → 父级消费者」这条线改接到子图内部的真实源
            for o_index, o in enumerate(flat_nodes[fid]["outputs"]):
                src = outs.get(o_index)
                for l_id in list(o.get("links") or []):
                    if l_id in flat_links and src:
                        flat_links[l_id][1], flat_links[l_id][2] = src[0], src[1]
            # 丢弃实例节点本身及与其相连、且未被改接的线
            del flat_nodes[fid]
            for l_id in [k for k, v in list(flat_links.items()) if v[1] == fid or v[3] == fid]:
                del flat_links[l_id]

        # 3) 计算本作用域的「输出边界」来源
        out_map: dict = {}
        for lid, (o_id, o_slot, t_id, t_slot, ty) in lt.items():
            if t_id != "-20":
                continue
            if o_id == "-10":
                src = in_map.get(o_slot) if in_map else None
                if src:
                    out_map[t_slot] = src
            else:
                s = local.get(o_id)
                if s is not None:
                    out_map[t_slot] = (s, o_slot)
        return out_map

    try:
        expand_scope(raw.get("nodes") or [], raw.get("links") or [], "", None, 0)
    except Exception as e:  # noqa: BLE001 - 展开失败不应让整个流程挂掉
        warnings.append(f"子图展开失败（已回退为不展开）：{type(e).__name__}: {e}")
        return raw, warnings

    flat = dict(raw)
    flat["nodes"] = list(flat_nodes.values())
    flat["links"] = [list(v) for v in flat_links.values()]
    flat.pop("definitions", None)
    if not flat["nodes"]:
        warnings.append("子图展开后没有可用节点")
        return raw, warnings
    return flat, warnings
