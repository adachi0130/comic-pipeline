/* SPDX-License-Identifier: AGPL-3.0
 *
 * 来源：YILING0013/novelai_local_web
 *       提交 4dd42f5aa0fa21fbf149f9ed08beb3b6426152b3
 *       原路径 next_nai_web/src/components/ai-painting/ComicWorkspace/comicDocument.mjs
 * 修改：
 *   1. createClientId 改到本地 comic-id.mjs（去掉 uuid 依赖）。
 *   2. **删除上游自带的 COMIC_TEMPLATES 模板库**，改为 applyTemplateFromShape：
 *      本项目使用自己从 MED 继承的 69 个模板（真实 SVG 多边形），由后端解析后下发，
 *      不使用参考项目的 28 个矩形预设，避免悄悄换掉用户的版式。
 *   3. applyTemplate 保留“只替换所选半页、保留另一页与叠加框”的行为。
 */

import { createClientId } from './comic-id.mjs';
import { ensureComicLayers } from './comicLayers.mjs';

const PAGE_MARGIN = 32;
const FRAME_WIDTH = 3;

export const COMIC_LAYOUTS = {
  portrait: { name: { zh: '竖版', en: 'Portrait' }, width: 896, height: 1280, sections: 1, sectionWidth: 896, sectionHeight: 1280 },
  landscape: { name: { zh: '横版', en: 'Landscape' }, width: 1280, height: 896, sections: 1, sectionWidth: 1280, sectionHeight: 896 },
  spreadPortrait: { name: { zh: '双列', en: 'Side by side' }, width: 2560, height: 896, sections: 2, sectionWidth: 1280, sectionHeight: 896 },
  spreadLandscape: { name: { zh: '双行', en: 'Stacked pages' }, width: 1280, height: 1792, sections: 2, sectionWidth: 1280, sectionHeight: 896 },
};

const rectangle = (x, y, width, height) => [
  { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
];

function rows(heights, columns) {
  let y = 0;
  return heights.flatMap((height, row) => {
    let x = 0;
    const panels = columns[row].map((width) => {
      const points = rectangle(x, y, width, height);
      x += width;
      return points;
    });
    y += height;
    return panels;
  });
}

/**
 * 本项目不使用参考项目自带的矩形模板库。
 *
 * 版式一律来自本项目的 69 个 MED 来源模板（真实 SVG 多边形，由后端解析后下发），
 * 这样“斜切 / 跨格 / 重叠格”不会被矩形化，也不会因为换模板库而改变已有页面的格号。
 * 这里的 `panels` 允许一小段“空白页”预设：手工新建空白页时用，只含一个与画布等大的框。
 *
 * @param {number} width 画布宽（页面坐标）
 * @param {number} height 画布高（页面坐标）
 * @returns {Array} 单格空白版式（points 已是绝对坐标）。
 */
export function blankLayout(width, height) {
  return [{ points: rectangle(0, 0, width, height).map((point) => ({ ...point })), borderWidth: 0 }];
}

/**
 * 把后端下发的模板多边形（百分比坐标）换算成画布绝对坐标的版式。
 *
 * 后端 `geometry.panels[*]` 的 `order` 是**阅读顺序**，`points_pct` 是该格真实顶点；
 * 两者都已排除“文档顺序 ≠ 阅读顺序”的陷阱，前端只做坐标换算，不再重新排序。
 *
 * @param {object} geometry 后端 `GET /api/templates/{id}` 返回的 geometry。
 * @param {{width:number,height:number}} canvas 画布尺寸（与 geometry.canvas 一致）。
 * @returns {Array<{points:Array,borderWidth:number}>} 已按阅读顺序排列的版式。
 */
export function layoutFromGeometry(geometry, canvas) {
  const entries = Array.isArray(geometry?.panels) ? geometry.panels : [];
  const cw = canvas?.width || geometry?.canvas?.[0] || 1;
  const ch = canvas?.height || geometry?.canvas?.[1] || 1;
  const ordered = [...entries].sort((a, b) => (a.order ?? a.index ?? 0) - (b.order ?? b.index ?? 0));
  return ordered.map((entry) => {
    const pct = Array.isArray(entry.points_pct) && entry.points_pct.length >= 3
      ? entry.points_pct
      : [
          [entry.x_pct ?? 0, entry.y_pct ?? 0],
          [(entry.x_pct ?? 0) + (entry.width_pct ?? 0), entry.y_pct ?? 0],
          [(entry.x_pct ?? 0) + (entry.width_pct ?? 0), (entry.y_pct ?? 0) + (entry.height_pct ?? 0)],
          [entry.x_pct ?? 0, (entry.y_pct ?? 0) + (entry.height_pct ?? 0)],
        ];
    return {
      points: pct.map(([x, y]) => ({ x: (Number(x) || 0) / 100 * cw, y: (Number(y) || 0) / 100 * ch })),
      borderWidth: Number(entry.border_width ?? 0) || 0,
    };
  });
}

/**
 * 计算画框或顶点列表的外接矩形，供选框、图片裁剪和导出使用。
 * @param {object|Array} panelOrPoints 画框对象或页面绝对坐标顶点。
 * @returns {{x:number,y:number,width:number,height:number}} 外接矩形。
 */
export function panelBounds(panelOrPoints) {
  const points = Array.isArray(panelOrPoints) ? panelOrPoints : panelOrPoints.points;
  const x = Math.min(...points.map((point) => point.x));
  const y = Math.min(...points.map((point) => point.y));
  return { x, y, width: Math.max(...points.map((point) => point.x)) - x, height: Math.max(...points.map((point) => point.y)) - y };
}

/**
 * 获取单页或跨页中指定半页的范围，不包含页间缝隙。
 * @param {object} page 漫画页。
 * @param {number} section 半页编号，从零开始。
 * @returns {{x:number,y:number,width:number,height:number}} 页面绝对坐标范围。
 */
export function sectionBounds(page, section = 0) {
  if (section === -1) return { x: 0, y: 0, width: page.width, height: page.height };
  // 旧漫画保留自己的画布尺寸，不能随着新建页面默认尺寸一起变形。
  const width = page.layout === 'spreadPortrait' ? page.width / 2 : page.width;
  const height = page.layout === 'spreadLandscape' ? page.height / 2 : page.height;
  return { x: page.layout === 'spreadPortrait' ? section * width : 0, y: page.layout === 'spreadLandscape' ? section * height : 0, width, height };
}

/**
 * 获取漫画生成内容区；页外留白不进入模型图像或角色坐标。
 * @param {object} page 漫画页。
 * @param {number} section 单页或跨页的分区编号。
 * @returns {{x:number,y:number,width:number,height:number}} 去掉四边 32 像素留白的页面绝对坐标范围。
 */
export function comicContentBounds(page, section = 0) {
  const bounds = sectionBounds(page, section);
  return { x: bounds.x + PAGE_MARGIN, y: bounds.y + PAGE_MARGIN, width: bounds.width - PAGE_MARGIN * 2, height: bounds.height - PAGE_MARGIN * 2 };
}

function signedArea(points) {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}

function clipPolygon(points, start, end, offset, side) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  const distance = (point) => side * ((dx * (point.y - start.y) - dy * (point.x - start.x)) / length - offset);
  const result = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const next = points[(index + 1) % points.length];
    const here = distance(point);
    const there = distance(next);
    if (here >= -0.00001) result.push(point);
    if ((here >= 0) !== (there >= 0)) {
      const ratio = here / (here - there);
      result.push({ x: point.x + (next.x - point.x) * ratio, y: point.y + (next.y - point.y) * ratio });
    }
  }
  // 切线经过已有顶点时，只保留一个顶点，避免后续拖动出现零长度边。
  return result.filter((point, index) => {
    const previous = result[(index + result.length - 1) % result.length];
    return Math.hypot(point.x - previous.x, point.y - previous.y) > 0.00001;
  });
}

function insetPolygon(points, amount, outerBounds) {
  const direction = Math.sign(signedArea(points));
  return points.reduce((result, start, index) => {
    const end = points[(index + 1) % points.length];
    // 新页面只给相邻分镜留沟槽，整页最外沿不再额外缩进半个沟槽。
    const outerEdge = outerBounds && (
      [outerBounds.x, outerBounds.x + outerBounds.width].some((x) => Math.abs(start.x - x) < 0.00001 && Math.abs(end.x - x) < 0.00001)
      || [outerBounds.y, outerBounds.y + outerBounds.height].some((y) => Math.abs(start.y - y) < 0.00001 && Math.abs(end.y - y) < 0.00001)
    );
    return clipPolygon(result, start, end, (outerEdge ? 0 : amount) * direction, direction);
  }, points);
}

function isUsablePolygon(points) {
  if (points.length < 3 || Math.abs(signedArea(points)) < 144) return false;
  const bounds = panelBounds(points);
  if (bounds.width < 12 || bounds.height < 12) return false;
  let direction = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const c = points[(index + 2) % points.length];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1) return false;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 0.00001) continue;
    if (direction && Math.sign(cross) !== direction) return false;
    direction = Math.sign(cross);
  }
  return true;
}

function clipToBounds(points, bounds) {
  const border = rectangle(bounds.x, bounds.y, bounds.width, bounds.height);
  return border.reduce((result, start, index) => clipPolygon(result, start, border[(index + 1) % border.length], 0, 1), points);
}

/**
 * 在指定半页套用版式（保留另一半页的图片、参数和画框）。
 *
 * 版式来源是本项目的模板几何（``layoutFromGeometry`` 换算好的绝对坐标），
 * 不再接受参考项目的预设编号——避免出现“用户以为用的是自己的模板”的静默替换。
 *
 * @param {object} page 当前漫画页。
 * @param {object|Array} layout 版式：``{panels:[{points,borderWidth}], gutter?}`` 或 panels 数组。
 * @param {number} section 目标半页编号。
 * @param {string} targetLayerId 指定时仅替换该层，否则处理默认画框层；锁定或隐藏层保持不变。
 * @returns {object} 应用版式后的新页面，不改动原对象。
 */
export function applyTemplate(page, layout, section = 0, targetLayerId) {
  const template = Array.isArray(layout) ? { panels: layout } : layout;
  if (!template || !Array.isArray(template.panels) || !template.panels.length) {
    throw new Error('版式为空，无法套用');
  }
  const ready = ensureComicLayers(page);
  const editableLayers = ready.layers.filter((layer) => layer.visible && !layer.locked && (targetLayerId ? layer.id === targetLayerId : ['panels', 'overlays'].includes(layer.kind)));
  if (!editableLayers.length) return page;
  const editableIds = new Set(editableLayers.map((layer) => layer.id));
  const bounds = sectionBounds(page, section);
  const panels = template.panels.flatMap((item) => {
    const preferred = ready.layers.find((layer) => layer.kind === (item.type === 'overlay' ? 'overlays' : 'panels'));
    const layer = targetLayerId ? editableLayers[0] : preferred || editableLayers.at(-1);
    if (!editableIds.has(layer.id)) return [];
    // 传入的顶点是整页绝对坐标；跨页时按半页原点平移并夹进半页范围。
    const points = item.points.map((point) => ({ x: Math.max(bounds.x, Math.min(bounds.x + bounds.width, point.x + bounds.x)), y: Math.max(bounds.y, Math.min(bounds.y + bounds.height, point.y + bounds.y)) }));
    return [{ id: createClientId(), type: item.type || 'regular', layerId: layer.id, section: item.type === 'overlay' ? -1 : section, ...(item.type === 'overlay' ? { templateSection: section } : {}), points: template.gutter ? insetPolygon(points, template.gutter / 2, page.layoutVersion === 2 ? comicContentBounds(page, section) : undefined) : points, borderWidth: item.borderWidth, image: null, task: null }];
  });
  const sourceOverlays = new Set(template.panels.filter((panel) => panel.type === 'overlay').map((panel) => panel.sourcePanelId));
  const regular = [...ready.panels.filter((panel) => panel.type !== 'overlay' && (panel.section !== section || !editableIds.has(panel.layerId))), ...panels.filter((panel) => panel.type !== 'overlay')].sort((a, b) => a.section - b.section);
  // 回套刚保存的模板时替换源叠加框，避免透明人物在原位置重复叠加。
  const overlays = ready.panels.flatMap((panel) => {
    if (panel.type !== 'overlay') return [];
    if (!editableIds.has(panel.layerId)) return [panel];
    if (panel.templateSection === section) return [];
    if (!sourceOverlays.has(panel.id)) return [panel];
    // 跨页源框只替换当前半页部分，另一半页的原图和形状继续保留。
    if (COMIC_LAYOUTS[page.layout].sections === 1) return [];
    const remaining = clipToBounds(panel.points, sectionBounds(page, 1 - section));
    return isUsablePolygon(remaining) ? [{ ...panel, points: remaining }] : [];
  });
  return ensureComicLayers({ ...ready, panels: [...regular, ...overlays, ...panels.filter((panel) => panel.type === 'overlay')], updatedAt: Date.now() });
}

/**
 * 创建一页漫画。尺寸与版式由调用方给出（来自项目模板几何），不写死预设尺寸。
 *
 * @param {object} options
 * @param {string} [options.id] 指定页面标识（与业务页绑定时可复用）。
 * @param {number} options.width 画布宽（页面坐标）。
 * @param {number} options.height 画布高（页面坐标）。
 * @param {Array|object} [options.layout] 初始版式；省略时给单格留白。
 * @returns {object} 含画框、空笔迹和图层的新页面。
 */
export function createComicPage({ id, width, height, layout } = {}) {
  if (!(width > 0) || !(height > 0)) throw new Error('画布尺寸无效');
  const size = layout || blankLayout(width, height);
  let page = ensureComicLayers({
    id: id || createClientId(), layout: 'portrait', layoutVersion: 2, title: '',
    width, height, panels: [], strokes: [], createdAt: Date.now(), updatedAt: Date.now(),
  });
  page = applyTemplate(page, size, 0);
  return page;
}

/**
 * 沿两点所在的直线切开凸画框，切口留白且不复制生成任务。
 * @param {object} panel 要切割的画框。
 * @param {{x:number,y:number}} start 切线第一点。
 * @param {{x:number,y:number}} end 切线第二点。
 * @param {number} gutter 切口留白宽度，单位为页面像素。
 * @param {number} nextOrder 同层下一项的顺序号，用于把新画框插在原位置。
 * @returns {Array|null} 两个新画框；没有切开或产生过小画框时返回 null。
 */
export function splitPanel(panel, start, end, gutter = 14, nextOrder = (panel.order ?? 0) + 1) {
  if (Math.hypot(end.x - start.x, end.y - start.y) < 1) return null;
  const halves = [clipPolygon(panel.points, start, end, gutter / 2, 1), clipPolygon(panel.points, start, end, -gutter / 2, -1)];
  if (!halves.every(isUsablePolygon)) return null;
  // 两块都使用新编号，旧画框尚未返回的生成结果就不会被填进切割后的画框。
  const order = panel.order ?? 0;
  return halves.map((points, index) => ({ ...panel, id: createClientId(), layerId: panel.layerId || (panel.type === 'overlay' ? 'overlays' : 'panels'), order: index === 0 ? order : (order + nextOrder) / 2, points, image: panel.image ? { ...panel.image } : null, task: null }));
}

/**
 * 拖拽创建矩形画框，自动限制在所选半页内。
 * @param {object} page 当前漫画页。
 * @param {number} section 目标半页编号，-1 创建可跨整页的叠加画框。
 * @param {object} start 拖拽起点。
 * @param {object} end 拖拽终点。
 * @returns {object|null} 新画框，拖拽范围太小时返回 null。
 */
export function createRectanglePanel(page, section, start, end) {
  const bounds = sectionBounds(page, section);
  const x = Math.max(bounds.x, Math.min(start.x, end.x));
  const y = Math.max(bounds.y, Math.min(start.y, end.y));
  const right = Math.min(bounds.x + bounds.width, Math.max(start.x, end.x));
  const bottom = Math.min(bounds.y + bounds.height, Math.max(start.y, end.y));
  if (right - x < 12 || bottom - y < 12) return null;
  const ready = ensureComicLayers(page);
  const layerId = (ready.layers.find((layer) => layer.kind === (section === -1 ? 'overlays' : 'panels')) || ready.layers.at(-1)).id;
  const order = Math.max(-1, ...[...ready.panels, ...ready.strokes, ...ready.elements].filter((item) => item.layerId === layerId).map((item) => item.order)) + 1;
  return { id: createClientId(), type: section === -1 ? 'overlay' : 'regular', layerId, order, section, points: rectangle(x, y, right - x, bottom - y), borderWidth: section === -1 ? 0 : FRAME_WIDTH, image: null, task: null };
}

/**
 * 移动画框顶点并保持凸形，防止边线交叉后无法继续切割。
 * @param {object} panel 当前画框。
 * @param {number} index 要移动的顶点索引。
 * @param {object} point 新位置。
 * @param {object} bounds 所属半页的范围。
 * @returns {object} 移动后的画框，无效移动返回原画框。
 */
export function movePanelVertex(panel, index, point, bounds) {
  const points = panel.points.map((old, vertex) => vertex === index ? { x: Math.max(bounds.x, Math.min(bounds.x + bounds.width, point.x)), y: Math.max(bounds.y, Math.min(bounds.y + bounds.height, point.y)) } : old);
  return isUsablePolygon(points) ? { ...panel, points } : panel;
}

/**
 * 同时移动一条边的两个端点，保持画框凸形和半页边界。
 * @param {object} panel 当前画框。
 * @param {number} index 边的起点索引。
 * @param {{x:number,y:number}} delta 页面坐标中的移动距离。
 * @param {object} bounds 所属半页的范围。
 * @returns {object} 移动后的画框，无效移动返回原画框。
 */
export function movePanelEdge(panel, index, delta, bounds) {
  const next = (index + 1) % panel.points.length;
  const edge = [panel.points[index], panel.points[next]];
  const dx = Math.max(bounds.x - Math.min(...edge.map((p) => p.x)), Math.min(bounds.x + bounds.width - Math.max(...edge.map((p) => p.x)), delta.x));
  const dy = Math.max(bounds.y - Math.min(...edge.map((p) => p.y)), Math.min(bounds.y + bounds.height - Math.max(...edge.map((p) => p.y)), delta.y));
  const points = panel.points.map((point, vertex) => vertex === index || vertex === next ? { x: point.x + dx, y: point.y + dy } : point);
  return isUsablePolygon(points) ? { ...panel, points } : panel;
}

/**
 * 整体移动画框和其中图像，在所属半页或整页边界处停下，保持形状与裁剪关系。
 * @param {object} panel 当前画框。
 * @param {{x:number,y:number}} delta 相对于拖拽起始画框的页面坐标位移。
 * @param {object} bounds 普通框所属半页的范围；叠加框使用整页范围。
 * @returns {object} 移动后的画框，没有实际位移时返回原画框。
 */
export function movePanel(panel, delta, bounds) {
  const frame = panelBounds(panel);
  // 统一限制整框位移，不能逐点裁进边界，否则碰到边缘时会改变凸多边形形状。
  const dx = Math.max(bounds.x - frame.x, Math.min(bounds.x + bounds.width - frame.x - frame.width, delta.x));
  const dy = Math.max(bounds.y - frame.y, Math.min(bounds.y + bounds.height - frame.y - frame.height, delta.y));
  if (dx === 0 && dy === 0) return panel;
  return {
    ...panel,
    points: panel.points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
    image: panel.image ? { ...panel.image, x: panel.image.x + dx, y: panel.image.y + dy } : panel.image,
  };
}

/**
 * 围绕画框中心旋转并平移；整体限制在页面内，保持边长、凸形和图像构图。
 * @param {object} panel 手势开始时的画框。
 * @param {number} angle 相对旋转角度，单位为弧度。
 * @param {object} delta 页面坐标中的平移距离。
 * @param {object} bounds 允许编辑的页面范围。
 * @returns {object|null} 新画框；旋转后尺寸超过页面时返回 null。
 */
export function rotatePanel(panel, angle, delta, bounds) {
  const box = panelBounds(panel), cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  let points = panel.points.map((p) => ({ x: cx + (p.x - cx) * cos - (p.y - cy) * sin + delta.x, y: cy + (p.x - cx) * sin + (p.y - cy) * cos + delta.y }));
  const rotated = panelBounds(points);
  if (rotated.width > bounds.width + 0.00001 || rotated.height > bounds.height + 0.00001) return null;
  const dx = Math.max(bounds.x - rotated.x, Math.min(0, bounds.x + bounds.width - rotated.x - rotated.width));
  const dy = Math.max(bounds.y - rotated.y, Math.min(0, bounds.y + bounds.height - rotated.y - rotated.height));
  points = points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  return { ...panel, points, image: transformPanelImage(panel.image, panel.points, points) };
}

/**
 * 把图像跟随画框的刚性变换移动或旋转；拖动顶点改变形状时不调用。
 * @param {object|null} image 当前图像，允许拖动期间异步填入的新图。
 * @param {Array} before 变换前的画框顶点。
 * @param {Array} after 变换后的画框顶点。
 * @returns {object|null} 保留素材和比例的图像构图。
 */
export function transformPanelImage(image, before, after) {
  if (!image) return image;
  const angle = Math.atan2(after[1].y - after[0].y, after[1].x - after[0].x) - Math.atan2(before[1].y - before[0].y, before[1].x - before[0].x);
  const halfWidth = image.width * image.scale / 2, halfHeight = image.height * image.scale / 2;
  const dx = image.x + halfWidth - before[0].x, dy = image.y + halfHeight - before[0].y;
  return { ...image, x: after[0].x + dx * Math.cos(angle) - dy * Math.sin(angle) - halfWidth, y: after[0].y + dx * Math.sin(angle) + dy * Math.cos(angle) - halfHeight, rotation: (image.rotation || 0) + angle * 180 / Math.PI };
}

/**
 * 切换普通框与叠加框；转回普通框时裁进所选半页，避免跨页顶点失控。
 * @param {object} panel 当前画框。
 * @param {string} type regular 或 overlay。
 * @param {object} page 当前漫画页。
 * @param {number} section 转回普通框的目标半页编号。
 * @returns {object|null} 新画框，没有落在目标半页内时返回 null。
 */
export function convertPanelType(panel, type, page, section = 0) {
  const points = type === 'overlay' ? panel.points : clipToBounds(panel.points, sectionBounds(page, section));
  if (!isUsablePolygon(points)) return null;
  const result = { ...panel, type, points, section: type === 'overlay' ? -1 : section };
  delete result.templateSection;
  return result;
}

/**
 * 将图像居中铺满画框，保留原图尺寸供展开裁剪时缩放和平移。
 * @param {object} panel 目标画框。
 * @param {{dataUrl:string,width:number,height:number}} image 原图数据及实际宽高。
 * @returns {object} 带页面绝对位置 x/y 和缩放 scale 的图像记录。
 */
export function fitPanelImage(panel, image) {
  const bounds = panelBounds(panel);
  const scale = Math.max(bounds.width / image.width, bounds.height / image.height);
  return { ...image, scale, x: bounds.x + (bounds.width - image.width * scale) / 2, y: bounds.y + (bounds.height - image.height * scale) / 2 };
}

/**
 * 保存指定半页的普通框和叠加框形状，剔除图像和生成参数供下次套用。
 * @param {object} page 当前漫画页。
 * @param {number} section 要保存的半页编号。
 * @param {string|object} name 模板名称或中英文名称。
 * @returns {object} 以半页内边距归一化的自定义模板。
 */
export function createComicTemplate(page, section, name) {
  const bounds = sectionBounds(page, section);
  return {
    id: createClientId(), name: typeof name === 'string' ? { zh: name, en: name } : name, gutter: 0, custom: true,
    orientation: bounds.height > bounds.width ? 'portrait' : 'landscape', createdAt: Date.now(),
    panels: page.panels.flatMap((panel) => {
      if (panel.type !== 'overlay' && panel.section !== section) return [];
      const points = panel.type === 'overlay' ? clipToBounds(panel.points, bounds) : panel.points;
      if (!isUsablePolygon(points)) return [];
      return [{ type: panel.type || 'regular', ...(panel.type === 'overlay' ? { sourcePanelId: panel.id } : {}), borderWidth: panel.borderWidth, points: points.map((point) => ({ x: (point.x - bounds.x - PAGE_MARGIN) / (bounds.width - PAGE_MARGIN * 2), y: (point.y - bounds.y - PAGE_MARGIN) / (bounds.height - PAGE_MARGIN * 2) })) }];
    }),
  };
}
