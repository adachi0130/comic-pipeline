/* SPDX-License-Identifier: AGPL-3.0
 *
 * 漫画编辑器主界面（原生 ES module）。
 *
 * 来源与修改说明：
 *   交互模型、画布渲染思路、工具集（选择/切割/画框/叠加框/画笔/橡皮/抓手/缩放）、
 *   快捷键、撤销重做、图层与元素编辑，均移植自 YILING0013/novelai_local_web
 *   （提交 4dd42f5aa0fa21fbf149f9ed08beb3b6426152b3，
 *    next_nai_web/src/components/ai-painting/ComicWorkspace/ComicWorkspace.js）。
 *   **本文件是重写而非照搬**：上游是 React + MUI 组件，本项目前端没有构建链，
 *   因此用原生 DOM/SVG 重新实现同一套交互，几何算法复用同目录的纯 JS 模块。
 *
 * 与上游的差异（都是本项目需求）：
 *   - 模板来自本项目后端（69 个 MED 来源模板的真实多边形），不用上游自带模板库；
 *   - 保存走本项目 editor_doc 接口，服务端是正式存档，本地只做草稿缓存；
 *   - 图片来自本项目已采用的候选图，不接入上游画廊/生成队列；
 *   - 默认不添加任何装饰，用户主动点工具才会加。
 */

import { createClientId } from './comic-id.mjs';
import {
  COMIC_LAYOUTS, applyTemplate, comicContentBounds, convertPanelType,
  createComicPage, createRectanglePanel, fitPanelImage, layoutFromGeometry, movePanel,
  movePanelEdge, movePanelVertex, panelBounds, rotatePanel, sectionBounds, splitPanel,
  transformPanelImage,
} from './comicDocument.mjs';
import { comicCutIntersections, snapComicCutPoint, snapPanelAngle, snapPanelDrag } from './comicSnapping.mjs';
import { comicElementMatrix, loadComicFonts, readComicAsset } from './comicElements.mjs';
import { ensureComicLayers, getComicRenderItems, reorderComicItem } from './comicLayers.mjs';
import { balloonPageSvg } from './comicPaint.mjs';

  const POLY = (points) => points.map((point) => `${point.x},${point.y}`).join(' ');

  /**
   * 后端文档把顶点存成 ``[[x, y], ...]``（便于 JSON 与 Python 渲染共用），
   * 前端几何函数统一用 ``{x, y}``。这里在载入时归一化一次，
   * 避免每个绘制/拖动点都要判断格式。
   */
  function normalizeDocument(document) {
    const toPoint = (point) => (
      Array.isArray(point) ? { x: Number(point[0]) || 0, y: Number(point[1]) || 0 }
        : { x: Number(point?.x) || 0, y: Number(point?.y) || 0 }
    );
    return {
      ...document,
      panels: (document.panels || []).map((panel) => ({
        ...panel,
        points: (panel.points || []).map(toPoint),
      })),
      strokes: (document.strokes || []).map((stroke) => ({
        ...stroke,
        points: (stroke.points || []).map(toPoint),
      })),
      elements: (document.elements || []).map((element) => ({
        ...element,
        mask: (element.mask || []).map((point) => ({ x: Number(point?.x) || 0, y: Number(point?.y) || 0 })),
      })),
    };
  }

/** 工具定义：与上游一致的 8 个常用工具，快捷键也保持相同。 */
const TOOLS = [
  ['select', '选择', 'V', '点击选择，拖动外侧手柄移动、缩放或旋转'],
  ['cut', '切割', 'C', '沿两点连线切开画框，切口留白'],
  ['rectangle', '画框', 'U', '拖出新的矩形画框'],
  ['overlay', '叠加框', 'Shift+U', '拖出可跨分镜的上层框（放透明立绘）'],
  ['brush', '画笔', 'B', '自由笔迹'],
  ['eraser', '橡皮', 'E', '白色遮盖笔迹'],
  ['hand', '抓手', 'H / Space', '平移画布（双击复位）'],
  ['zoom', '缩放', 'Z', '点击放大，Alt 缩小'],
];

export function createComicEditor({ host, api, onDirty, onNotice, onSaved, onEditPanel, onChooseTemplate }) {
  const lifecycle = new AbortController();
  let disposed = false;
  const listen = (target, type, handler, options = {}) => target.addEventListener(type, handler, { ...options, signal: lifecycle.signal });
  const state = {
    projectId: null,
    pageRef: null,
    templateId: '',
    document: null,
    tool: 'select',
    section: 0,
    selectedPanelId: null,
    selectedElementId: null,
    selectedStrokeId: null,
    activeLayerId: 'panels',
    layersOpen: false,
    zoom: 1,
    view: { x: 0, y: 0 },
    gutter: 14,
    brushSize: 5,
    dirty: false,
    saving: false,
    loading: false,
    revision: 0,
    savedRevision: 0,
    // 服务端文档版本基准：打开时记录，保存成功后跟进；
    // 保存请求带上它做并发检查，两个窗口同时编辑同一页时后到者会收到 409。
    baseVersion: 0,
    status: '',
  };
  let spaceHeld = false;
  let panelSliderEdit = false;
  const history = { undo: [], redo: [] };
  const drag = { current: null, frame: null, pending: null };
  const refs = { svg: null, viewport: null, holder: null };

  // ------------------------------------------------------------ DOM 骨架
  // 顶栏已按用户要求移除：状态/缩放/保存收进画布右下浮动区，不再占用画布上方空间。
  host.innerHTML = `
    <div class="ce-root">
      <aside class="ce-tools" data-area="tools"></aside>
      <div class="ce-center">
        <div class="ce-viewport" data-area="viewport">
          <svg class="ce-canvas" data-area="canvas" role="img" aria-label="漫画页画布"></svg>
          <div class="ce-floating-actions">
            <span class="ce-badge" data-area="status" title="">未加载</span>
            <span class="ce-hint" data-area="hint"></span>
            <label class="ce-zoom-control"><select data-opt="zoom" aria-label="画布缩放"></select></label>
            <button class="sm" data-act="fit" title="适应窗口 (Ctrl+0)">适应</button>
            <button class="sm primary" data-act="save" title="保存 (Ctrl+S)">保存漫画页</button>
            <button class="sm" data-act="pin-frames" aria-pressed="false" title="固定画框与画面：防误改版式，滚轮不再移动画面"><svg class="ce-tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3h8l-2 6 4 4v2H6v-2l4-4ZM12 15v7"/></svg><span data-pin-label>固定画框</span></button><button class="sm" data-act="layers-toggle" aria-pressed="false" title="图层面板">▱ 图层</button>
          </div>
        </div>
      </div>
      <aside class="ce-side" hidden data-area="side"></aside>
    </div>
    <input type="file" accept="image/png,image/webp,image/jpeg,image/svg+xml,.svg" data-act="asset-upload" hidden>
    <input type="file" accept="image/png,image/webp,image/jpeg" data-act="panel-upload" hidden>
  `;
  const $ = (selector) => host.querySelector(selector);
  const toolsEl = $('[data-area="tools"]');
  const sideEl = $('[data-area="side"]');
  const statusEl = $('[data-area="status"]');
  const hintEl = $('[data-area="hint"]');
  const viewportEl = $('[data-area="viewport"]');
  const svgEl = $('[data-area="canvas"]');
  const assetInput = $('[data-act="asset-upload"]');
  refs.svg = svgEl;
  refs.viewport = viewportEl;
  refs.holder = $('.ce-canvas');

  // ------------------------------------------------------------ 小工具
  const doc = () => state.document;
  const layers = () => doc()?.layers || [];
  const findLayer = (id) => layers().find((layer) => layer.id === id);
  const selectedPanel = () => (doc()?.panels || []).find((panel) => panel.id === state.selectedPanelId) || null;
  const selectedElement = () => (doc()?.elements || []).find((item) => item.id === state.selectedElementId) || null;
  const selectedStroke = () => (doc()?.strokes || []).find((item) => item.id === state.selectedStrokeId) || null;

  function setStatus(text, kind = '') {
    state.status = text;
    statusEl.textContent = text;
    statusEl.className = 'ce-badge' + (kind ? ' ' + kind : '');
  }
  function notice(text, kind = 'info') {
    hintEl.textContent = text || '';
    // 顶栏已移除：详细消息浮在状态徽标上查看（主页面另有弹窗提示）
    if (text) statusEl.title = text;
    onNotice?.(text, kind);
  }
  function markDirty() {
    state.revision += 1;
    if (!state.dirty) {
      state.dirty = true;
      onDirty?.(true);
    }
  }
  function nextOrder(layerId) {
    const items = getComicRenderItems(doc()).filter(({ item }) => item.layerId === layerId);
    return Math.max(-1, ...items.map(({ item }) => (Number.isFinite(item.order) ? item.order : 0))) + 1;
  }
  function replaceDocument(next, { record = true } = {}) {
    if (record && state.document) {
      history.undo.push(state.document);
      if (history.undo.length > 40) history.undo.shift();
      history.redo = [];
      markDirty();
    }
    state.document = ensureComicLayers(next);
    render();
  }

  // ------------------------------------------------------------ 工具面板
  // 工具顺序、上下文操作与浮动图层沿用上游 ComicWorkspace 的组织方式。
  const ICONS = {
    select: '<path d="m5 3 13 9-6 1-3 6Z"/>', cut: '<path d="m8 8 11 12M8 16 19 4"/><circle cx="5" cy="6" r="3"/><circle cx="5" cy="18" r="3"/>',
    rectangle:'<rect x="4" y="4" width="16" height="16" rx="1"/>',overlay:'<rect x="3" y="3" width="13" height="13" rx="1"/><path d="M9 19h11V9"/>',
    brush:'<path d="m10 13 8-10 3 3-9 9M10 13c-6-2-2 7-7 7 5 2 10-1 9-5"/>',eraser:'<path d="m3 14 10-11 8 7-10 11H9Z"/><path d="m7 10 8 7M11 21h10"/>',
    hand:'<path d="M7 12V7a2 2 0 0 1 4 0V4a2 2 0 0 1 4 0v3a2 2 0 0 1 4 0v4a2 2 0 0 1 3 1v5c0 5-12 6-15 1l-4-5a2 2 0 0 1 3-2Z"/>',
    zoom:'<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6M7 10h6M10 7v6"/>',text:'<path d="M4 5h16M12 5v15M8 20h8"/>',
    bubble:'<path d="M20 11c0 6-8 9-12 6l-5 3 1-6c-5-10 16-15 16-3Z"/>',sticker:'<path d="M4 3h16v12l-6 6H4ZM14 21v-6h6"/>',
    undo:'<path d="m8 3-6 6 6 6M2 9h12a7 7 0 0 1 0 14"/>',redo:'<path d="m16 3 6 6-6 6M22 9H10a7 7 0 0 0 0 14"/>',
    template:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M13 3v18M13 12h8"/>',upload:'<path d="M12 16V3m-5 5 5-5 5 5M3 16v5h18v-5"/>',
    gallery:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="2"/><path d="m3 19 6-6 4 4 4-7 4 7"/>',
    crop:'<path d="M6 2v16h16M2 6h16v16"/>',delete:'<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
    settings:'<path d="M3 6h18M3 12h18M3 18h18"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="9" cy="18" r="2"/>',
    up:'<path d="m5 12 7-7 7 7M12 5v15"/>',down:'<path d="m5 12 7 7 7-7M12 4v15"/>',flip:'<path d="M12 2v20M3 18l5-12v12ZM21 18 16 6v12Z"/>',
  };
  const icon = (name) => `<svg class="ce-tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.settings}</svg>`;
  const action = (act, name, label, disabled = false, extra = '') => `<button type="button" class="ce-tool ${extra}" data-act="${act}" title="${label}" aria-label="${label}" ${disabled ? 'disabled' : ''}>${icon(name)}<span class="ce-tool-label">${label}</span></button>`;

  function renderTools() {
    const panel = selectedPanel(), element = selectedElement();
    toolsEl.innerHTML = `
      ${onChooseTemplate ? `<div class="ce-tool-group"><p class="ce-section-title">版式模板</p>${action('template','template','版式与分格')}</div>` : ''}
      <div class="ce-tool-group">${TOOLS.map(([id,label,key,tip]) => `<button type="button" class="ce-tool${state.tool === id ? ' on' : ''}" data-tool="${id}" ${doc()?.framesLocked && ['cut','rectangle','overlay'].includes(id)?'disabled':''} aria-pressed="${state.tool === id}" title="${tip} (${key})" aria-label="${label}">${icon(id)}<span class="ce-tool-label">${label}</span><span class="ce-tool-key">${key.split(' ')[0].replace('Shift+','⇧')}</span></button>`).join('')}</div>
      <div class="ce-tool-group">${action('bubble','bubble','对话气泡')}<button type="button" class="ce-tool${state.tool === 'text' ? ' on' : ''}" data-tool="text" title="拖出文字区域 (T)" aria-label="文字">${icon('text')}<span class="ce-tool-label">文字</span><span class="ce-tool-key">T</span></button>${action('sticker','sticker','贴纸素材')}</div>
      <div class="ce-tool-group">${action('undo','undo','撤销',!history.undo.length)}${action('redo','redo','重做',!history.redo.length)}</div>
      <label class="ce-field">画框<select data-opt="panel" aria-label="选择画框"><option value="">未选择</option>${(doc()?.panels || []).map((item,index) => `<option value="${escapeHtml(item.id)}" ${item.id===state.selectedPanelId?'selected':''}>${index+1} · ${item.type==='overlay'?'叠加框':'普通框'}</option>`).join('')}</select></label>
      ${state.tool==='cut'?`<label class="ce-field">切割留白 ${state.gutter}px<input aria-label="切割留白" type="range" min="0" max="48" value="${state.gutter}" data-opt="gutter"></label>`:''}
      ${['brush','eraser'].includes(state.tool)?`<label class="ce-field">笔刷 ${state.brushSize}px<input aria-label="笔刷大小" type="range" min="1" max="64" value="${state.brushSize}" data-opt="brush"></label>`:''}
      ${panel ? `<div class="ce-tool-group"><p class="ce-section-title">画框 ${(doc().panels || []).indexOf(panel)+1}</p>${action('upload-image','upload','上传图片')}${action('gallery','gallery','本格候选图',!panel.panelRef)}${action('crop','crop','调整构图',!panel.image)}${action('remove-image','delete','移除图片',!panel.image)}${onEditPanel?action('edit-params','settings','编辑生成参数',!panel.panelRef):''}<label class="ce-field">边框 ${panel.borderWidth || 0}px<input type="range" min="0" max="12" step="0.5" value="${panel.borderWidth || 0}" data-panel-opt="borderWidth" aria-label="画框边框"></label>${action('convert-type','overlay',panel.type==='overlay'?'转普通框':'转叠加框',!!doc()?.framesLocked)}${action('front-panel','up','上移内容')}${action('back-panel','down','下移内容')}${action('delete','delete','删除画框',!!doc()?.framesLocked,'danger')}</div>`:''}
      ${element ? `<div class="ce-tool-group"><p class="ce-section-title">${element.kind==='bubble'?'对话气泡':element.kind==='text'?'文字':'贴纸'}</p>${action('edit-element','settings','编辑内容')}${action('flip-element','flip','水平镜像')}${action('front-element','up','上移内容')}${action('back-element','down','下移内容')}${action('delete','delete','删除内容',false,'danger')}</div>`:''}
    `;
  }

  function renderSide() {
    sideEl.hidden = !state.layersOpen;
    $('[data-act="layers-toggle"]').setAttribute('aria-pressed',String(state.layersOpen));
    const items = getComicRenderItems(doc() || {}).slice().reverse();
    sideEl.innerHTML = `<div class="ce-side-heading"><b>图层与内容</b><button class="ce-icon" data-act="layers-toggle" aria-label="关闭图层">×</button></div>
      <div class="ce-layers">${layers().map((layer) => `<div class="ce-layer${layer.id===state.activeLayerId?' on':''}"><button class="ce-layer-name" data-layer-pick="${escapeHtml(layer.id)}">${escapeHtml(layerName(layer))}</button><button class="ce-icon" data-layer-toggle="${escapeHtml(layer.id)}" data-field="visible" title="${layer.visible?'隐藏':'显示'}图层" aria-label="${layer.visible?'隐藏':'显示'}${escapeHtml(layerName(layer))}">${layer.visible?'◉':'○'}</button><button class="ce-icon" data-layer-toggle="${escapeHtml(layer.id)}" data-field="locked" title="锁定或解锁">${layer.locked?'▣':'□'}</button><button class="ce-icon" data-layer-move="${escapeHtml(layer.id)}" data-dir="1" aria-label="上移图层">↑</button><button class="ce-icon" data-layer-move="${escapeHtml(layer.id)}" data-dir="-1" aria-label="下移图层">↓</button></div>`).join('')}</div>
      <h3>内容</h3><div class="ce-list">${items.map(({kind,item}) => `<button type="button" class="ce-row" data-item-pick="${escapeHtml(item.id)}" data-kind="${kind}"><b>${kind==='panel'?'▧':kind==='stroke'?'╱':'T'}</b><span>${escapeHtml(item.name || item.panelRef || (item.kind==='bubble'?'气泡':item.text || '笔迹'))}</span></button>`).join('')}</div>
      ${doc()?.conversion?`<details class="ce-tip"><summary>旧存档转换详情</summary><ul>${[...(doc().conversion.dropped || []),...(doc().conversion.warnings || [])].map((item)=>`<li>${escapeHtml(item)}</li>`).join('') || '<li>没有未转换元素</li>'}</ul></details>`:''}`;
  }
  function layerName(layer) { return layer?.name || ({panels:'画框',overlays:'叠加框',dialogue:'对白'}[layer?.kind]) || layer?.id || '—'; }

  // ------------------------------------------------------------ 画布渲染
  function renderCanvas() {
    const d = doc();
    if (!d) return;
    const scale = Number(d.width) || 1;
    const handle = Math.max(0.6, scale / Math.max(400, viewportEl.clientWidth || 900)) * (1 / state.zoom);
    svgEl.setAttribute('viewBox', `0 0 ${d.width} ${d.height}`);
    const items = getComicRenderItems(d);

    const parts = [`<rect x="0" y="0" width="${d.width}" height="${d.height}" fill="#fff"/>`];
    for (const { kind, item } of items) {
      if (kind === 'panel') parts.push(panelMarkup(item, handle));
      else if (kind === 'stroke') parts.push(strokeMarkup(item));
      else parts.push(elementMarkup(item, handle));
    }
    // 选中框与手柄
    const panel = selectedPanel();
    if (panel && state.tool === 'select' && !d.framesLocked) parts.push(panelHandles(panel, handle));
    const element = selectedElement();
    if (element && state.tool === 'select') parts.push(elementHandles(element, handle));
    if (state.tool === 'cut') parts.push(`<g class="ce-cut-layer" data-cutfx></g>`);

    svgEl.innerHTML = parts.join('');
    applyCanvasBox();
    const pinButton=$('[data-act="pin-frames"]');
    pinButton.setAttribute('aria-pressed',String(!!d.framesLocked));
    pinButton.title=d.framesLocked
      ? '画框与画面已固定：不能拖动/切割/删除画框，滚轮也不再移动画面（Ctrl+滚轮仍可缩放）。再点一次解除。'
      : '固定画框与画面：防误改版式，滚轮不再移动画面';
    $('[data-pin-label]').textContent=d.framesLocked?'画框已固定':'固定画框';
    // 页面尺寸放进状态徽标的悬停提示，不再单独占一条顶栏。
    statusEl.title = `${Math.round(d.width)} × ${Math.round(d.height)} px${state.templateId ? ' · ' + state.templateId : ''}`;
    const zoomSelect = $('[data-opt="zoom"]');
    zoomSelect.innerHTML = [...new Set([.25,.5,.75,1,1.5,2,3,4,5,state.zoom])].sort((a,b)=>a-b).map((value)=>`<option value="${value}" ${value===state.zoom?'selected':''}>${value===1?'适应':Math.round(value*100)+'%'}</option>`).join('');
  }

  /**
   * 画布显示尺寸：先按视口适配（fit），再乘以用户 zoom。
   * 必须显式设置 svg 的 width/height（像素），否则 SVG 会按 viewBox 比例撑满容器，
   * 造成页面溢出与滚动条；用 viewBox 保留逻辑坐标，几何计算不受显示缩放影响。
   */
  function applyCanvasBox() {
    const d = doc();
    if (!d) return;
    const viewportWidth = viewportEl.clientWidth || 900;
    const viewportHeight = viewportEl.clientHeight || 600;
    const fit = Math.min((viewportWidth - 32) / d.width, (viewportHeight - 32) / d.height);
    const baseWidth = d.width * Math.max(0.01, fit);
    const baseHeight = d.height * Math.max(0.01, fit);
    svgEl.setAttribute('width', String(baseWidth));
    svgEl.setAttribute('height', String(baseHeight));
    svgEl.style.width = `${baseWidth}px`;
    svgEl.style.height = `${baseHeight}px`;
    const level = Number(state.zoom) || 1;
    svgEl.style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${level})`;
  }

  function panelMarkup(panel, handle) {
    const clipId = `clip-${panel.id}`;
    const image = panel.image;
    const active = panel.id === state.selectedPanelId;
    const color = panel.type === 'overlay' ? '#bd7110' : '#287bcc';
    // 图片来自「已采用的候选图」：优先内嵌 dataURL（自包含存档），
    // 其次用后端候选接口的 URL。没有显式构图时直接按画框铺满（cover），
    // 这样打开任何历史页面都能立刻看到画面，不用先手动贴图。
    const href = image?.dataUrl || image?.url || '';
    let img = '';
    if (href) {
      if (image.width > 0 && image.height > 0 && image.scale > 0) {
        img = `<g clip-path="url(#${clipId})"><image href="${href}" x="${image.x}" y="${image.y}" width="${image.width * image.scale}" height="${image.height * image.scale}" transform="rotate(${image.rotation || 0} ${image.x + image.width * image.scale / 2} ${image.y + image.height * image.scale / 2})" preserveAspectRatio="none"/></g>`;
      } else {
        const xs = panel.points.map((point) => point.x);
        const ys = panel.points.map((point) => point.y);
        const x0 = Math.min(...xs), x1 = Math.max(...xs);
        const y0 = Math.min(...ys), y1 = Math.max(...ys);
        img = `<g clip-path="url(#${clipId})"><image href="${href}" x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" preserveAspectRatio="xMidYMid slice"/></g>`;
      }
    }
    return `<g data-panel-id="${panel.id}">
      <defs><clipPath id="${clipId}"><polygon points="${POLY(panel.points)}"/></clipPath></defs>
      ${img}
      <polygon points="${POLY(panel.points)}" fill="none" stroke="${panel.borderWidth > 0 ? '#111' : 'transparent'}" stroke-width="${panel.borderWidth || 0}" stroke-linejoin="round"/>
      <polygon data-hit="${panel.id}" points="${POLY(panel.points)}" fill="transparent" stroke="${color}" stroke-width="${(active ? 1.6 : 0.8) * handle}" stroke-dasharray="${active ? '' : `${6 * handle} ${5 * handle}`}" opacity="${active ? 1 : 0.5}" style="cursor:${state.tool === 'select' ? 'move' : 'crosshair'}"/>
      <g pointer-events="none"><rect x="${panelBounds(panel).x+6}" y="${panelBounds(panel).y+6}" width="${24*handle}" height="${22*handle}" rx="${4*handle}" fill="${color}"/><text x="${panelBounds(panel).x+6+12*handle}" y="${panelBounds(panel).y+6+16*handle}" fill="#fff" text-anchor="middle" font-size="${13*handle}" font-family="sans-serif">${(doc().panels || []).indexOf(panel)+1}</text></g>
    </g>`;
  }

  function strokeMarkup(stroke) {
    const color = stroke.kind === 'erase' ? '#ffffff' : (stroke.color || '#111111');
    if (stroke.points.length === 1) {
      return `<circle cx="${stroke.points[0].x}" cy="${stroke.points[0].y}" r="${stroke.width / 2}" fill="${color}"/>`;
    }
    return `<polyline points="${POLY(stroke.points)}" fill="none" stroke="${color}" stroke-width="${stroke.width}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }

  function elementMarkup(element, handle) {
    const active = element.id === state.selectedElementId;
    const matrix = comicElementMatrix(element);
    const body = balloonPageSvg(element);
    return `<g data-element-id="${element.id}" transform="matrix(${matrix.join(' ')})">
      ${body}
      <polygon data-element-hit="${element.id}" points="${POLY(element.mask.map((point) => ({ x: point.x * element.width, y: point.y * element.height })))}" fill="transparent" stroke="#ad69da" stroke-width="${(active ? 1.8 : 0.8) * handle}" stroke-dasharray="${active ? '' : `${6 * handle} ${5 * handle}`}" opacity="${active ? 1 : 0.35}" style="cursor:${state.tool === 'select' ? 'move' : 'crosshair'}"/>
    </g>`;
  }

  function panelHandles(panel, handle) {
    const color = panel.type === 'overlay' ? '#bd7110' : '#287bcc';
    const bounds = panelBounds(panel);
    const above = bounds.y > 40 * handle;
    const moveY = above ? bounds.y - 30 * handle : bounds.y + bounds.height + 30 * handle;
    const moveX = bounds.x + bounds.width / 2;
    const parts = [];
    panel.points.forEach((point, index) => {
      const next = panel.points[(index + 1) % panel.points.length];
      parts.push(`<g data-handle="edge" data-index="${index}" style="cursor:move">
        <line x1="${point.x}" y1="${point.y}" x2="${next.x}" y2="${next.y}" stroke="transparent" stroke-width="${20 * handle}"/>
        <rect x="${(point.x + next.x) / 2 - 4 * handle}" y="${(point.y + next.y) / 2 - 4 * handle}" width="${8 * handle}" height="${8 * handle}" fill="#fff" stroke="${color}" stroke-width="${1.5 * handle}"/>
      </g>`);
      parts.push(`<g data-handle="vertex" data-index="${index}" style="cursor:move">
        <circle cx="${point.x}" cy="${point.y}" r="${13 * handle}" fill="transparent"/>
        <circle cx="${point.x}" cy="${point.y}" r="${5 * handle}" fill="#fff" stroke="${color}" stroke-width="${1.5 * handle}"/>
      </g>`);
    });
    parts.push(`<line x1="${moveX}" y1="${above ? bounds.y : bounds.y + bounds.height}" x2="${moveX}" y2="${moveY}" stroke="${color}" stroke-width="${1.4 * handle}"/>`);
    parts.push(`<g data-handle="move" style="cursor:grab">
      <circle cx="${moveX}" cy="${moveY}" r="${12 * handle}" fill="transparent"/>
      <circle cx="${moveX}" cy="${moveY}" r="${7 * handle}" fill="${color}" stroke="#fff" stroke-width="${1.5 * handle}"/>
    </g>`);
    const rotateX = moveX + 46 * handle;
    parts.push(`<line x1="${moveX}" y1="${moveY}" x2="${rotateX}" y2="${moveY}" stroke="${color}" stroke-width="${handle}"/>`);
    parts.push(`<g data-handle="rotate" style="cursor:grab">
      <circle cx="${rotateX}" cy="${moveY}" r="${13 * handle}" fill="transparent"/>
      <circle cx="${rotateX}" cy="${moveY}" r="${8 * handle}" fill="#fff" stroke="${color}" stroke-width="${1.5 * handle}"/>
    </g>`);
    return `<g class="ce-handles">${parts.join('')}</g>`;
  }

  function elementHandles(element, handle) {
    const parts = [`<rect width="${element.width}" height="${element.height}" fill="none" stroke="#ad69da" stroke-width="${1.5 * handle}" stroke-dasharray="${5 * handle} ${3 * handle}" pointer-events="none"/>`];
    [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]].forEach(([hx, hy], index) => {
      parts.push(`<g data-handle="resize" data-x="${hx}" data-y="${hy}" style="cursor:nwse-resize">
        <circle cx="${hx * element.width}" cy="${hy * element.height}" r="${11 * handle}" fill="transparent"/>
        <rect x="${hx * element.width - 4 * handle}" y="${hy * element.height - 4 * handle}" width="${8 * handle}" height="${8 * handle}" fill="#fff" stroke="#ad69da" stroke-width="${1.5 * handle}"/>
      </g>`);
    });
    parts.push(`<line x1="${element.width / 2}" y1="${element.height}" x2="${element.width / 2}" y2="${element.height + 30 * handle}" stroke="#ad69da" stroke-width="${1.5 * handle}"/>`);
    parts.push(`<g data-handle="move" style="cursor:grab">
      <circle cx="${element.width / 2}" cy="${element.height + 30 * handle}" r="${12 * handle}" fill="transparent"/>
      <circle cx="${element.width / 2}" cy="${element.height + 30 * handle}" r="${7 * handle}" fill="#ad69da" stroke="#fff" stroke-width="${1.5 * handle}"/>
    </g>`);
    parts.push(`<line x1="${element.width / 2}" y1="0" x2="${element.width / 2}" y2="${-30 * handle}" stroke="#ad69da" stroke-width="${1.5 * handle}"/>`);
    parts.push(`<g data-handle="rotate" style="cursor:grab">
      <circle cx="${element.width / 2}" cy="${-30 * handle}" r="${13 * handle}" fill="transparent"/>
      <circle cx="${element.width / 2}" cy="${-30 * handle}" r="${8 * handle}" fill="#fff" stroke="#ad69da" stroke-width="${1.5 * handle}"/>
    </g>`);
    return `<g class="ce-handles" transform="matrix(${comicElementMatrix(element).join(' ')})">${parts.join('')}</g>`;
  }

  function render() {
    if (!doc()) {
      svgEl.innerHTML = '';
      toolsEl.innerHTML = '';
      sideEl.innerHTML = '<p class="ce-tip">选择一页漫画后开始编辑。</p>';
      return;
    }
    renderTools();
    renderSide();
    renderCanvas();
    updateButtons();
  }
  function updateButtons() {
    const undo = $('[data-act="undo"]');
    const redo = $('[data-act="redo"]');
    if (undo) undo.disabled = !history.undo.length;
    if (redo) redo.disabled = !history.redo.length;
    const save = $('[data-act="save"]');
    if (save) save.disabled = state.saving || state.loading;
  }

  // ------------------------------------------------------------ 载入 / 保存
  async function load(projectId, pageRef) {
    state.projectId = projectId;
    state.pageRef = pageRef;
    state.loading = true;
    state.dirty = false;
    state.revision = 0;
    state.savedRevision = 0;
    state.baseVersion = 0;
    history.undo = [];
    history.redo = [];
    setStatus('加载中', 'run');
    try {
      const payload = await api(`/api/projects/${projectId}/editor-doc/${encodeURIComponent(pageRef)}`);
      if (disposed) return;
      state.templateId = payload.document?.layout?.templateId || payload.template_id || '';
      state.baseVersion = Number(payload.version) || 0;
      state.document = ensureComicLayers(normalizeDocument(payload.document));
      state.selectedPanelId = null;
      state.selectedElementId = null;
      state.activeLayerId = (state.document.layers[0] || {}).id || 'panels';
      state.section = 0;
      state.view = { x: 0, y: 0 };
      if (state.document.fonts?.length) loadComicFonts(state.document.fonts).catch(() => {});
      render();
      const source = payload.source === 'legacy_med_doc'
        ? '已从旧 MED 存档转换（保存后会写为新文档）'
        : payload.source === 'editor_doc'
          ? `已载入已保存文档 v${payload.version}`
          : '已按项目产物生成初始版式';
      const conversion = payload.conversion;
      const dropped = conversion?.dropped?.length ? `；${conversion.dropped.length} 项旧内容未转换` : '';
      setStatus(payload.dirty ? '未保存' : '已就绪', payload.dirty ? 'warn' : 'ok');
      notice(`${source}${dropped}`, payload.source === 'legacy_med_doc' ? 'warn' : 'info');
      fitView();
      return payload;
    } catch (error) {
      setStatus('加载失败', 'err');
      notice(error.message || '加载失败', 'error');
      state.document = null;
      render();
      throw error;
    } finally {
      state.loading = false;
      updateButtons();
    }
  }

  function documentForSave() {
    const d = doc();
    if (!d) throw new Error('没有可保存的页面');
    // 顶点转回后端格式 [[x, y]]，与 Python 渲染器共用同一份数据；
    // 同时剔除纯运行时字段，避免把浏览器状态写进存档。
    const toPair = (point) => [Number(point.x) || 0, Number(point.y) || 0];
    return {
      ...d,
      panels: (d.panels || []).map((panel) => ({
        ...panel,
        task: undefined,
        points: (panel.points || []).map(toPair),
        image: panel.image ? { ...panel.image } : null,
      })),
      strokes: (d.strokes || []).map((stroke) => ({
        ...stroke,
        points: (stroke.points || []).map(toPair),
      })),
      elements: (d.elements || []).map((element) => ({
        ...element,
        mask: (element.mask || []).map((point) => ({ x: Number(point.x) || 0, y: Number(point.y) || 0 })),
      })),
      fonts: d.fonts || [],
    };
  }

  async function save({ force = false } = {}) {
    if (!doc() || state.saving) return null;
    state.saving = true;
    updateButtons();
    setStatus('保存中', 'run');
    const captured = state.revision;
    try {
      const payload = await api(`/api/projects/${state.projectId}/editor-doc/${encodeURIComponent(state.pageRef)}`, {
        method: 'POST',
        body: {
          document: documentForSave(),
          // 强制覆盖表示用户已在冲突提示里确认；此时不再发送旧基准。
          ...(force ? { force: true } : { baseVersion: state.baseVersion }),
        },
      });
      if (disposed) return payload;
      state.baseVersion = Number(payload.version) || state.baseVersion;
      state.savedRevision = captured;
      state.dirty = state.revision !== state.savedRevision;
      setStatus(state.dirty ? '未保存' : `已保存 v${payload.version}`, state.dirty ? 'warn' : 'ok');
      notice(
        payload.has_preview
          ? `已保存 v${payload.version}，整页快照已更新${state.dirty ? '（保存期间又有修改，需再次保存）' : ''}`
          : `画布已保存 v${payload.version}，但整页快照未生成，请重试保存以便成册导出。`,
        payload.has_preview ? 'ok' : 'warn',
      );
      onDirty?.(state.dirty);
      onSaved?.(payload);
      return payload;
    } catch (error) {
      if (error?.status === 409) {
        const current = Number(error.detail?.current_version) || 0;
        const message = `该页已在其他窗口保存为 v${current}（本窗口基于 v${state.baseVersion}）。`
          + '覆盖会丢弃那边保存的内容。';
        setStatus('保存冲突', 'err');
        const overwrite = typeof confirm === 'function'
          && confirm(message + '\n\n确定覆盖吗？（取消可先复制当前内容）');
        if (overwrite) {
          state.saving = false;
          return save({ force: true });
        }
        notice(message + ' 已保留你的画布未保存状态。', 'error');
        return null;
      }
      setStatus('保存失败', 'err');
      notice(`保存失败：${error.message}`, 'error');
      return null;
    } finally {
      state.saving = false;
      updateButtons();
    }
  }

  function fitView() {
    // 适配由 applyCanvasBox 按视口自动完成；这里只把缩放与平移复位。
    state.zoom = 1;
    state.view = { x: 0, y: 0 };
    renderCanvas();
  }

  // ------------------------------------------------------------ 画布交互
  function canvasPoint(event, clamp = true) {
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(svgEl.getScreenCTM().inverse());
    const d = doc();
    if (!clamp) return { x: point.x, y: point.y };
    return { x: Math.max(0, Math.min(d.width, point.x)), y: Math.max(0, Math.min(d.height, point.y)) };
  }
  function handleScale() {
    const d = doc();
    return Math.max(0.5, (Number(d.width) || 800) / Math.max(400, viewportEl.clientWidth || 900)) / state.zoom;
  }

  function changeTool(tool) {
    cancelDrag();
    if (doc()?.framesLocked && ['cut','rectangle','overlay'].includes(tool)) { notice('画框已固定，先点击钉子解除固定。','warn'); return; }
    state.tool = tool;
    render();
  }

  function choosePanel(panel) {
    state.selectedElementId = null;
    state.selectedStrokeId = null;
    state.selectedPanelId = panel?.id || null;

    if (panel?.layerId) state.activeLayerId = panel.layerId;
    renderTools();
    renderSide();
    renderCanvas();
  }
  function chooseElement(element) {
    state.selectedPanelId = null;
    state.selectedStrokeId = null;
    state.selectedElementId = element?.id || null;

    if (element?.layerId) state.activeLayerId = element.layerId;
    renderTools();
    renderSide();
    renderCanvas();
  }

  function pointerDown(event) {
    if (!doc()) return;
    if ((event.button !== 0 && event.button !== 1) || (event.pointerType !== 'touch' && !event.isPrimary)) return;
    if (event.target.closest('button, input, select, textarea')) return;
    const d = doc();
    const scale = handleScale();
    const raw = canvasPoint(event, false);
    const point = canvasPoint(event);

    if (state.tool === 'hand' || state.tool === 'zoom' || spaceHeld || event.button === 1) return;

    if (state.tool === 'cut') {
      if (d.framesLocked) return;
      const candidates = (d.panels || []).filter((panel) => !findLayer(panel.layerId)?.locked);
      const near = snapComicCutPoint(candidates, raw, 14 * scale);
      drag.current = { kind: 'cut', pointerId: event.pointerId, first: near || null, last: raw, before: d };
      svgEl.setPointerCapture(event.pointerId);
      return;
    }

    const elementTarget = event.target.closest('[data-element-hit]');
    const panelTarget = event.target.closest('[data-hit]');
    const handle = event.target.closest('[data-handle]')?.dataset.handle;

    // 只有「选择」工具才做点选/拖动；画框、文字、画笔等工具必须能在图片上开始手势，
    // 否则点击已有画面时会被画框点选吞掉（上游也是先判工具再判命中）。
    if (state.tool === 'select' && (elementTarget || panelTarget || handle)) {
      event.preventDefault();
      const element = elementTarget ? (d.elements || []).find((item) => item.id === elementTarget.dataset.elementHit) : (handle ? selectedElement() : null);
      if (element) {
        if (element.id !== state.selectedElementId) chooseElement(element);
        const layer = findLayer(element.layerId);
        if (!layer?.locked) {
          const matrix = new DOMMatrix(comicElementMatrix(element));
          drag.current = {
            kind: `element-${handle || 'move'}`, pointerId: event.pointerId, element: { ...element },
            start: raw, before: d, inverse: matrix.inverse(),
            center: new DOMPoint(element.width / 2, element.height / 2).matrixTransform(matrix),
            handleX: Number(event.target.closest('[data-handle]')?.dataset.x),
            handleY: Number(event.target.closest('[data-handle]')?.dataset.y),
          };
          svgEl.setPointerCapture(event.pointerId);
        }
        return;
      }
      const panelId = panelTarget?.dataset.hit || (handle ? state.selectedPanelId : null);
      const panel = panelId ? (d.panels || []).find((item) => item.id === panelId) : null;
      if (panel) {
        if (panel.id !== state.selectedPanelId) choosePanel(panel);
        if (d.framesLocked) return;
        if (!handle) return; // 与参考项目一致：画框内部只选中，外置手柄才移动。
        const layer = findLayer(panel.layerId);
        if (!layer?.locked) {
          const bounds = panelBounds(panel);
          const kind = handle || 'move';
          drag.current = {
            kind, pointerId: event.pointerId, panel: { ...panel }, start: raw, before: d,
            index: Number(event.target.closest('[data-handle]')?.dataset.index),
            center: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
            imageStartPoints: ['move', 'rotate'].includes(kind) ? panel.points : null,
          };
          svgEl.setPointerCapture(event.pointerId);
        }
        return;
      }
      // 空白处点选：清空选择
      choosePanel(null);
      return;
    }

    if (state.tool === 'select') {
      choosePanel(null);
      return;
    }

    if (d.framesLocked && ['rectangle','overlay'].includes(state.tool)) return;
    if (state.tool === 'rectangle' || state.tool === 'overlay' || state.tool === 'text') {
      const layer = currentCreationLayer(state.tool === 'overlay' ? 'overlays' : state.tool === 'text' ? 'dialogue' : 'panels');
      if (!layer) return;
      drag.current = {
        kind: state.tool === 'text' ? 'text' : 'rectangle', pointerId: event.pointerId,
        start: point, before: d, section: state.tool === 'overlay' ? -1 : state.section, layerId: layer.id,
      };
      svgEl.setPointerCapture(event.pointerId);
      return;
    }

    if (state.tool === 'brush' || state.tool === 'eraser') {
      const layer = findLayer(state.activeLayerId) || layers()[0];
      if (!layer || layer.locked || !layer.visible) { notice('当前图层已锁定或隐藏，无法绘制。', 'warn'); return; }
      const stroke = {
        id: createClientId(), kind: state.tool === 'eraser' ? 'erase' : 'brush',
        points: [point], color: state.tool === 'eraser' ? '#ffffff' : '#111111',
        width: state.brushSize, layerId: layer.id, order: nextOrder(layer.id),
      };
      drag.current = { kind: 'brush', pointerId: event.pointerId, strokeId: stroke.id, before: d };
      replaceDocument({ ...d, strokes: [...(d.strokes || []), stroke] }, { record: false });
      svgEl.setPointerCapture(event.pointerId);
    }
  }

  function currentCreationLayer(kind) {
    const active = findLayer(state.activeLayerId);
    if (active && active.kind === 'custom' && !active.locked && active.visible) return active;
    const layer = findLayer(kind);
    if (layer && !layer.locked && layer.visible) return layer;
    const fallback = layers().find((item) => item.visible && !item.locked);
    if (!fallback) notice('所有图层都被锁定或隐藏，无法新增内容。', 'warn');
    return fallback || null;
  }

  function pointerMove(event) {
    const action = drag.current;
    if (!action || action.pointerId !== event.pointerId) return;
    // 合并高频移动：松手前同步最后一帧，保证一次手势只记一次撤销
    if (!['brush', 'cut'].includes(action.kind)) {
      drag.pending = { clientX: event.clientX, clientY: event.clientY, shiftKey: event.shiftKey, altKey: event.altKey };
      if (drag.frame === null) drag.frame = requestAnimationFrame(flushDrag);
      return;
    }
    applyMove(event);
  }
  function flushDrag() {
    cancelAnimationFrame(drag.frame);
    drag.frame = null;
    const pending = drag.pending;
    drag.pending = null;
    if (pending && drag.current) applyMove(pending);
  }

  function applyMove(event) {
    const action = drag.current;
    if (!action || !doc()) return;
    const d = doc();
    const raw = canvasPoint(event, false);
    const scale = handleScale();

    if (action.kind === 'cut') {
      const candidates = (d.panels || []).filter((panel) => !findLayer(panel.layerId)?.locked);
      const near = snapComicCutPoint(candidates, raw, 14 * scale);
      if (!action.first && near) action.first = near;
      if (action.first && !action.end) {
        const crossings = candidates.flatMap((panel) => comicCutIntersections(panel, action.last, raw));
        const hit = crossings.find((item) => item.panelId === action.first.panelId && item.edgeIndex !== action.first.edgeIndex);
        if (hit) action.end = hit;
      }
      action.last = raw;
      drawCutPreview(action, raw, scale);
      return;
    }

    if (action.kind === 'rectangle' || action.kind === 'text') {
      const point = canvasPoint(event);
      drawRectPreview(action.start, point, action.kind === 'text' ? '#ad69da' : '#287bcc');
      return;
    }

    if (action.kind === 'brush') {
      const point = canvasPoint(event);
      replaceDocument({
        ...d,
        strokes: (d.strokes || []).map((stroke) => stroke.id === action.strokeId
          ? { ...stroke, points: [...stroke.points, point] } : stroke),
      }, { record: false });
      return;
    }

    if (action.element) {
      const start = action.element;
      let changes = null;
      if (action.kind === 'element-move') {
        changes = { x: start.x + (raw.x - action.start.x), y: start.y + (raw.y - action.start.y) };
      } else if (action.kind === 'element-rotate') {
        const angle = Math.atan2(raw.y - action.center.y, raw.x - action.center.x)
          - Math.atan2(action.start.y - action.center.y, action.start.x - action.center.x);
        changes = { rotation: start.rotation + angle * 180 / Math.PI };
      } else if (action.kind === 'element-resize') {
        const local = new DOMPoint(raw.x, raw.y).matrixTransform(action.inverse);
        const origin = new DOMPoint(action.start.x, action.start.y).matrixTransform(action.inverse);
        const horizontal = action.handleX * 2 - 1;
        const vertical = action.handleY * 2 - 1;
        const width = Math.max(24, start.width + (local.x - origin.x) * horizontal);
        const height = Math.max(24, start.height + (local.y - origin.y) * vertical);
        changes = { width, height, x: start.x + (start.width - width) / 2, y: start.y + (start.height - height) / 2 };
      }
      if (!changes) return;
      replaceDocument({
        ...d,
        elements: (d.elements || []).map((item) => item.id === start.id ? { ...item, ...changes } : item),
      }, { record: false });
      return;
    }

    if (!action.panel) return;
    const start = action.panel;
    const bounds = sectionBounds(d, start.type === 'overlay' ? -1 : (start.section ?? 0));
    const references = (d.panels || []).filter((panel) => panel.id !== start.id && findLayer(panel.layerId)?.visible);
    const delta = { x: raw.x - action.start.x, y: raw.y - action.start.y };
    let moved = null;

    if (action.kind === 'rotate') {
      const orientation = Math.atan2(start.points[1].y - start.points[0].y, start.points[1].x - start.points[0].x) * 180 / Math.PI;
      const angle = Math.atan2(raw.y - action.center.y, raw.x - action.center.x)
        - Math.atan2(action.start.y - action.center.y, action.start.x - action.center.x);
      const snapped = event.altKey
        ? { angle: orientation + angle * 180 / Math.PI }
        : snapPanelAngle(orientation + angle * 180 / Math.PI, references, event.shiftKey);
      moved = rotatePanel(start, (snapped.angle - orientation) * Math.PI / 180, { x: 0, y: 0 }, bounds);
    } else {
      const snapped = event.altKey
        ? { delta }
        : snapPanelDrag({
            panel: start, kind: action.kind, index: action.index, delta, references, bounds,
            threshold: 6 * scale, shift: event.shiftKey,
          });
      moved = action.kind === 'vertex'
        ? movePanelVertex(start, action.index, { x: start.points[action.index].x + snapped.delta.x, y: start.points[action.index].y + snapped.delta.y }, bounds)
        : action.kind === 'move'
          ? movePanel(start, snapped.delta, bounds)
          : movePanelEdge(start, action.index, snapped.delta, bounds);
    }
    if (!moved || moved === start) return;
    replaceDocument({
      ...d,
      panels: (d.panels || []).map((panel) => {
        if (panel.id !== moved.id) return panel;
        const image = action.imageStartPoints ? transformPanelImage(panel.image, panel.points, moved.points) : panel.image;
        return { ...panel, points: moved.points, image };
      }),
    }, { record: false });
  }

  function drawCutPreview(action, raw, scale) {
    const layer = svgEl.querySelector('[data-cutfx]');
    if (!layer) return;
    if (!action.first) { layer.innerHTML = ''; return; }
    const end = action.end?.point || raw;
    layer.innerHTML = `
      <line x1="${action.first.point.x}" y1="${action.first.point.y}" x2="${end.x}" y2="${end.y}" stroke="#d34256" stroke-width="${state.gutter}" opacity="0.18"/>
      <line x1="${action.first.point.x}" y1="${action.first.point.y}" x2="${end.x}" y2="${end.y}" stroke="#d34256" stroke-width="${1.5 * scale}" stroke-dasharray="${6 * scale} ${4 * scale}"/>
      <circle cx="${action.first.point.x}" cy="${action.first.point.y}" r="${5 * scale}" fill="#d34256" stroke="#fff" stroke-width="${scale}"/>`;
  }

  function drawRectPreview(start, end, color) {
    let layer = svgEl.querySelector('[data-rectfx]');
    if (!layer) {
      layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      layer.setAttribute('data-rectfx', '');
      layer.setAttribute('pointer-events', 'none');
      svgEl.appendChild(layer);
    }
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);
    layer.innerHTML = `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${color}20" stroke="${color}" stroke-width="${1.5 * handleScale()}" stroke-dasharray="6 4"/>`;
  }

  function pointerUp(event) {
    const action = drag.current;
    if (!action || action.pointerId !== event.pointerId) return;
    if (action.kind === 'brush' || action.kind === 'rectangle' || action.kind === 'text' || action.cutDone) {
      // 画笔/画框/文字已在手势中改过文档，这里补记一次撤销点
    }
    if (action.kind !== 'cut') flushDrag();
    const d = doc();
    drag.current = null;
    drag.pending = null;
    if (svgEl.hasPointerCapture?.(event.pointerId)) svgEl.releasePointerCapture(event.pointerId);
    const fx = svgEl.querySelector('[data-rectfx]');
    if (fx) fx.remove();
    if (!d) return;

    if (action.kind === 'cut') {
      if (!action.first || !action.end) { svgEl.querySelector('[data-cutfx]')?.replaceChildren(); return; }
      const cutting = (d.panels || []).find((panel) => panel.id === action.first.panelId);
      if (!cutting) return;
      const items = getComicRenderItems(d);
      const nextOrderValue = items.find(({ item }) => item.layerId === cutting.layerId && item.order > cutting.order)?.item.order;
      const parts = splitPanel(cutting, action.first.point, action.end.point, state.gutter, nextOrderValue);
      if (!parts) { notice('这条切线没有把画框分成两个可用形状，换一条线试试。', 'warn'); return; }
      // 切割产生的新框不继承业务格绑定，避免旧图静默落进新框
      const cleaned = parts.map((part) => ({ ...part, panelRef: '', panelOrder: 0, image: null }));
      history.undo.push(d);
      history.redo = [];
      markDirty();
      state.document = ensureComicLayers({
        ...d,
        panels: (d.panels || []).flatMap((panel) => panel.id === cutting.id ? cleaned : [panel]),
      });
      choosePanel(null);
      notice('已切开画框。新画框未绑定业务格，请确认后重新贴图。', 'warn');
      render();
      return;
    }

    if (action.kind === 'text') {
      const end = canvasPoint(event);
      const width = Math.abs(end.x - action.start.x);
      const height = Math.abs(end.y - action.start.y);
      insertElement('text', {
        x: Math.min(action.start.x, end.x), y: Math.min(action.start.y, end.y),
        width: width < 24 ? Math.min(240, d.width * 0.35) : width,
        height: height < 24 ? 110 : height,
      }, { layerId: action.layerId });
      return;
    }

    if (action.kind === 'rectangle') {
      const frame = createRectanglePanel(d, action.section, action.start, canvasPoint(event));
      if (!frame) { notice('拖出的范围太小，至少 12px 才成一个画框。', 'warn'); return; }
      frame.layerId = action.layerId;
      frame.order = nextOrder(action.layerId);
      frame.panelRef = '';
      frame.panelOrder = 0;
      history.undo.push(action.before);
      history.redo = [];
      markDirty();
      state.document = ensureComicLayers({ ...d, panels: [...(d.panels || []), frame] });
      choosePanel(frame);
      render();
      return;
    }

    // 画笔/移动等手势：把“手势前”补进撤销栈
    if (action.before && action.before !== d) {
      history.undo.push(action.before);
      if (history.undo.length > 40) history.undo.shift();
      history.redo = [];
      markDirty();
      updateButtons();
    }
  }

  function cancelDrag() {
    cancelAnimationFrame(drag.frame);
    drag.frame = null;
    drag.pending = null;
    if (drag.current && drag.current.before) {
      state.document = drag.current.before;
    }
    drag.current = null;
    svgEl.querySelector('[data-rectfx]')?.remove();
    svgEl.querySelector('[data-cutfx]')?.replaceChildren();
    render();
  }

  function insertElement(kind, bounds, options = {}) {
    const d = doc();
    const layer = currentCreationLayer('dialogue');
    if (!layer) return;
    const element = {
      id: createClientId(), kind, name: '', layerId: layer.id, order: nextOrder(layer.id),
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      rotation: 0, skewX: 0, skewY: 0, flipX: false, flipY: false, opacity: 1,
      presetId: kind === 'bubble' ? 'speech' : null, dataUrl: null,
      text: kind === 'text' ? '双击编辑文字' : '', fontFamily: 'sans-serif', fontSize: Math.max(14, Math.min(32, bounds.height * 0.22)),
      textAlign: 'center', writingMode: 'horizontal-tb', lineHeight: 1.25,
      color: '#111111', fill: kind === 'bubble' ? '#ffffff' : 'none',
      stroke: '#111111', strokeWidth: kind === 'bubble' ? 2 : 0, feather: 0,
      mask: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      ...options,
    };
    history.undo.push(d);
    history.redo = [];
    markDirty();
    state.document = ensureComicLayers({ ...d, elements: [...(d.elements || []), element] });
    state.tool = 'select';
    chooseElement(element);
    render();
  }

  // ------------------------------------------------------------ 悬停与双击
  function dblClick(event) {
    const d = doc();
    if (!d) return;
    const elementId = event.target.closest('[data-element-hit],[data-element-id]')?.dataset.elementHit
      || event.target.closest('[data-element-id]')?.dataset.elementId;
    const element = elementId ? (d.elements || []).find((item) => item.id === elementId) : null;
    if (element) { chooseElement(element); openElementEditor(); return; }
    const panelId = event.target.closest('[data-hit]')?.dataset.hit;
    const panel = panelId ? (d.panels || []).find((item) => item.id === panelId) : null;
    if (panel) { choosePanel(panel); openCrop(); }
  }

  // ------------------------------------------------------------ 元素编辑弹窗
  function openElementEditor() {
    const element = selectedElement();
    if (!element) { notice('先选中一个气泡或文字。', 'warn'); return; }
    const backdrop = document.createElement('div');
    backdrop.className = 'ce-modal';
    const isBubble = element.kind === 'bubble';
    backdrop.innerHTML = `
      <div class="ce-modal-box" role="dialog" aria-modal="true" aria-label="编辑元素">
        <h3>${isBubble ? '编辑气泡' : element.kind === 'sticker' ? '编辑贴纸' : '编辑文字'}</h3>
        <div class="ce-modal-grid">
          ${element.kind !== 'sticker' ? `
            <label class="ce-field wide">文字
              <textarea data-field="text" rows="3">${escapeHtml(element.text || '')}</textarea>
            </label>
            <label class="ce-field">字号 <input type="number" min="6" max="200" data-field="fontSize" value="${Math.round(element.fontSize)}"></label>
            <label class="ce-field">行距 <input type="number" min="0.8" max="3" step="0.05" data-field="lineHeight" value="${element.lineHeight}"></label>
            <label class="ce-field">排版
              <select data-field="writingMode">
                <option value="horizontal-tb"${element.writingMode !== 'vertical-rl' ? ' selected' : ''}>横排</option>
                <option value="vertical-rl"${element.writingMode === 'vertical-rl' ? ' selected' : ''}>竖排（右→左）</option>
              </select>
            </label>
            <label class="ce-field">对齐
              <select data-field="textAlign">
                <option value="left"${element.textAlign === 'left' ? ' selected' : ''}>左</option>
                <option value="center"${element.textAlign === 'center' ? ' selected' : ''}>中</option>
                <option value="right"${element.textAlign === 'right' ? ' selected' : ''}>右</option>
              </select>
            </label>
            <label class="ce-field">文字颜色 <input type="color" data-field="color" value="${toHex(element.color)}"></label>
          ` : ''}
          ${isBubble ? `
            <label class="ce-field">气泡样式
              <select data-field="presetId">
                ${BUBBLE_PRESETS.map(([id, label]) => `<option value="${id}"${element.presetId === id ? ' selected' : ''}>${label}</option>`).join('')}
              </select>
            </label>
            <label class="ce-field">填充 <input type="color" data-field="fill" value="${toHex(element.fill)}"></label>
            <label class="ce-field">描边 <input type="color" data-field="stroke" value="${toHex(element.stroke)}"></label>
            <label class="ce-field">描边粗细 <input type="number" min="0" max="20" step="0.5" data-field="strokeWidth" value="${element.strokeWidth}"></label>
          ` : ''}
          <label class="ce-field">旋转 <input type="range" min="-180" max="180" data-field="rotation" value="${Math.round(element.rotation || 0)}"></label>
          <label class="ce-field">不透明度 <input type="range" min="0" max="100" data-field="opacity" value="${Math.round((element.opacity ?? 1) * 100)}"></label>
        </div>
        <div class="ce-modal-actions">
          <button class="sm" data-modal="cancel">取消</button>
          <button class="sm primary" data-modal="apply">应用</button>
        </div>
      </div>`;
    const close = () => backdrop.remove();
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop || event.target.dataset.modal === 'cancel') { close(); return; }
      if (event.target.dataset.modal === 'apply') {
        const next = { ...selectedElement() };
        const fields = [...backdrop.querySelectorAll('[data-field]')];
        for (const field of fields) {
          const key = field.dataset.field;
          let value = field.value;
          if (['fontSize', 'lineHeight', 'strokeWidth', 'rotation'].includes(key)) value = Number(value);
          if (key === 'opacity') value = Number(value) / 100;
          if (key === 'fill' && (value === '#ffffff' && element.fill === 'none')) {
            // 用户选了白色就当作开启填充
          }
          next[key] = value;
        }
        const d = doc();
        replaceDocument({
          ...d,
          elements: (d.elements || []).map((item) => item.id === next.id ? next : item),
        });
        close();
      }
    });
    host.appendChild(backdrop);
  }

  const BUBBLE_PRESETS = [
    ['speech', '对白'], ['speech-right', '右侧对白'], ['ellipse', '椭圆'], ['round-box', '圆角对白'],
    ['caption', '旁白方框'], ['thought', '思考'], ['cloud', '云朵'], ['shout', '喊叫'],
    ['impact', '爆发'], ['whisper', '悄悄话'], ['electric', '电波'], ['jagged-star', '不规则锯齿'],
    ['announcement', '宣告'], ['mumble', '喃喃细语'], ['vibration', '颤抖波纹'], ['burst-fine', '细芒爆发'],
  ];

  function openBalloonPicker() {
    if (!doc()) return;
    const modal = document.createElement('div'); modal.className='ce-modal';
    modal.innerHTML=`<div class="ce-modal-box wide" role="dialog" aria-modal="true" aria-label="选择对话气泡"><h3>对话气泡</h3><div class="ce-preset-grid">${BUBBLE_PRESETS.map(([id,label])=>`<button type="button" class="ce-preset" data-bubble-preset="${id}"><svg viewBox="0 0 100 100" aria-hidden="true">${balloonPageSvg({kind:'bubble',presetId:id,width:100,height:100,fill:'#fff',stroke:'#34425b',strokeWidth:1.5,text:''})}</svg><span>${label}</span></button>`).join('')}</div><div class="ce-modal-actions"><button class="sm" data-close>取消</button></div></div>`;
    modal.addEventListener('click',(event)=>{
      if(event.target===modal || event.target.closest('[data-close]')) {modal.remove(); return;}
      const choice=event.target.closest('[data-bubble-preset]');
      if(!choice) return;
      const d=doc(); modal.remove();
      insertElement('bubble',{x:d.width*.35,y:d.height*.08,width:d.width*.3,height:d.width*.22},{presetId:choice.dataset.bubblePreset});
    }); host.appendChild(modal);
  }

  async function openGallery() {
    const panel=selectedPanel(); if(!panel?.panelRef) return;
    const panelId=panel.id;
    const modal=document.createElement('div'); modal.className='ce-modal';
    modal.innerHTML='<div class="ce-modal-box wide" role="dialog" aria-modal="true" aria-label="本格候选图"><h3>本格候选图</h3><div class="ce-gallery-content">正在加载…</div><div class="ce-modal-actions"><button class="sm" data-close>关闭</button></div></div>';
    modal.addEventListener('click',event=>{if(event.target===modal || event.target.closest('[data-close]')) modal.remove();});
    host.appendChild(modal);
    try {
      const board=await api(`/api/projects/${state.projectId}/image-board`);
      if(disposed || !modal.isConnected) return;
      const record=(board.pages || []).flatMap(page=>page.panels || []).find(item=>item.panel_ref===panel.panelRef)?.image;
      const candidates=(record?.candidates || []).filter(item=>item.available && item.url);
      modal.querySelector('.ce-gallery-content').innerHTML=candidates.length?`<div class="ce-gallery">${candidates.map(item=>`<button type="button" data-candidate="${item.index}"><img src="${escapeHtml(item.url)}" alt="候选图 ${item.index+1}"><span>候选图 ${item.index+1}${record.selected_index===item.index?' · 已采用':''}</span></button>`).join('')}</div>`:'<p class="ce-tip">本格还没有可用候选图，可先上传图片或打开生成参数出图。</p>';
      modal.addEventListener('click',async event=>{
        const button=event.target.closest('[data-candidate]'); if(!button) return;
        const candidate=candidates.find(item=>item.index===Number(button.dataset.candidate));
        if(!candidate) return;
        button.disabled=true;
        try {
          const image=new Image(); image.src=candidate.url; await image.decode();
          if(disposed || !modal.isConnected) return;
          const target=doc().panels.find(item=>item.id===panelId); if(!target) return;
          const spec=fitPanelImage(target,{artifactId:record.artifact_id,candidateIndex:candidate.index,url:candidate.url,width:image.naturalWidth,height:image.naturalHeight,rotation:0});
          replaceDocument({...doc(),panels:doc().panels.map(item=>item.id===panelId?{...item,image:spec}:item)});
          modal.remove(); notice('已放入当前画框，保存漫画页后生效。');
        } catch(error) {notice(`图片读取失败：${error.message}`,'error'); button.disabled=false;}
      });
    } catch(error) { if(!disposed && modal.isConnected) modal.querySelector('.ce-gallery-content').textContent=`加载失败：${error.message}`; }
  }

  // ------------------------------------------------------------ 构图调整
  async function openCrop() {
    const panel = selectedPanel();
    if (!panel || !(panel.image?.dataUrl || panel.image?.url)) { notice('这一格还没有图片，无法调整构图。', 'warn'); return; }
    let source = { ...panel.image };
    if (!(source.width > 0 && source.height > 0)) {
      try {
        const image = new Image(); image.src = source.dataUrl || source.url; await image.decode();
        if (disposed || selectedPanel()?.id !== panel.id) return;
        source = { ...source, width:image.naturalWidth, height:image.naturalHeight };
      } catch (error) { if(!disposed) notice(`图片读取失败：${error.message}`, 'error'); return; }
    }
    const bounds = panelBounds(panel);
    const padding = Math.max(bounds.width, bounds.height) * 0.28;
    const view = { x: bounds.x - padding, y: bounds.y - padding, width: bounds.width + padding * 2, height: bounds.height + padding * 2 };
    const fit = fitPanelImage(panel, source);
    let current = source.scale > 0 ? { ...source } : { ...fit };
    const backdrop = document.createElement('div');
    backdrop.className = 'ce-modal';
    backdrop.innerHTML = `
      <div class="ce-modal-box wide" role="dialog" aria-modal="true" aria-label="调整构图">
        <h3>调整构图</h3>
        <p class="ce-tip">拖动图片改变位置，用滑块放大缩小；格子外会被裁掉。</p>
        <svg class="ce-crop" viewBox="${view.x} ${view.y} ${view.width} ${view.height}" data-crop></svg>
        <div class="ce-modal-grid">
          <label class="ce-field wide">缩放 <input type="range" min="20" max="500" value="100" data-crop-zoom></label>
        </div>
        <div class="ce-modal-actions">
          <button class="sm" data-modal="center">居中铺满</button>
          <button class="sm" data-modal="cancel">取消</button>
          <button class="sm primary" data-modal="apply">应用</button>
        </div>
      </div>`;
    const svg = backdrop.querySelector('[data-crop]');
    const path = panel.points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ') + ' Z';
    let dragState = null;
    function draw() {
      svg.innerHTML = `
        <image href="${escapeHtml(current.dataUrl || current.url)}" x="${current.x}" y="${current.y}" width="${current.width * current.scale}" height="${current.height * current.scale}" transform="rotate(${current.rotation || 0} ${current.x + current.width * current.scale / 2} ${current.y + current.height * current.scale / 2})"/>
        <path d="M ${view.x} ${view.y} h ${view.width} v ${view.height} h ${-view.width} Z ${path}" fill="#353545" fill-opacity="0.58" fill-rule="evenodd"/>`;
    }
    draw();
    svg.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const matrix = svg.getScreenCTM().inverse();
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix);
      dragState = { pointerId: event.pointerId, matrix, point, image: { ...current } };
      svg.setPointerCapture(event.pointerId);
    });
    svg.addEventListener('pointermove', (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(dragState.matrix);
      current = { ...dragState.image, x: dragState.image.x + point.x - dragState.point.x, y: dragState.image.y + point.y - dragState.point.y };
      draw();
    });
    const finish = (event) => {
      if (dragState && dragState.pointerId === event.pointerId && svg.hasPointerCapture?.(event.pointerId)) svg.releasePointerCapture(event.pointerId);
      dragState = null;
    };
    svg.addEventListener('pointerup', finish);
    svg.addEventListener('pointercancel', finish);
    backdrop.querySelector('[data-crop-zoom]').addEventListener('input', (event) => {
      const value = Number(event.target.value) / 100;
      const scale = fit.scale * value;
      const ratio = scale / current.scale;
      const cx = bounds.x + bounds.width / 2;
      const cy = bounds.y + bounds.height / 2;
      current = { ...current, scale, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio };
      draw();
    });
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop || event.target.dataset.modal === 'cancel') { backdrop.remove(); return; }
      if (event.target.dataset.modal === 'center') { current = { ...fit }; draw(); return; }
      if (event.target.dataset.modal === 'apply') {
        const d = doc();
        replaceDocument({
          ...d,
          panels: (d.panels || []).map((item) => item.id === panel.id ? { ...item, image: current } : item),
        });
        backdrop.remove();
      }
    });
    host.appendChild(backdrop);
  }

  // ------------------------------------------------------------ 事件绑定
  listen(host, 'click', async (event) => {
    const itemPick = event.target.closest('[data-item-pick]');
    if (itemPick) {
      if (itemPick.dataset.kind==='panel') choosePanel(doc().panels.find((item)=>item.id===itemPick.dataset.itemPick));
      else if (itemPick.dataset.kind==='element') chooseElement(doc().elements.find((item)=>item.id===itemPick.dataset.itemPick));
      else { state.selectedStrokeId=itemPick.dataset.itemPick; state.selectedPanelId=null; state.selectedElementId=null; }
      return;
    }
    const toolButton = event.target.closest('[data-tool]');
    if (toolButton) { changeTool(toolButton.dataset.tool); return; }
    const actButton = event.target.closest('[data-act]');
    if (actButton) {
      const act = actButton.dataset.act;
      if (act === 'undo') { undo(); return; }
      if (act === 'redo') { redo(); return; }
      if (act === 'fit') { fitView(); return; }
      if (act === 'save') { await save(); return; }
      if (act === 'bubble') { openBalloonPicker(); return; }
      if (act === 'pin-frames') { cancelDrag(); if(doc()) { state.tool='select'; replaceDocument({...doc(),framesLocked:!doc().framesLocked}); } return; }
      if (act === 'layers-toggle') { state.layersOpen=!state.layersOpen; renderSide(); return; }
      if (act === 'template') { onChooseTemplate?.(); return; }
      if (act === 'edit-params') { if(selectedPanel()?.panelRef) onEditPanel?.(selectedPanel().panelRef); return; }
      if (act === 'upload-image') { const input=$('[data-act=panel-upload]'); input.dataset.target=selectedPanel()?.id || ''; input.click(); return; }
      if (act === 'gallery') { await openGallery(); return; }
      if (act === 'sticker') { assetInput.dataset.kind = 'sticker'; assetInput.value = ''; assetInput.click(); return; }
      if (act === 'edit-element') { openElementEditor(); return; }
      if (act === 'flip-element') {
        const element = selectedElement();
        if (!element) return;
        const d = doc();
        replaceDocument({ ...d, elements: (d.elements || []).map((item) => item.id === element.id ? { ...item, flipX: !item.flipX } : item) });
        return;
      }
      if (act === 'front-element' || act === 'back-element') { moveSelectedItem(act === 'front-element' ? 1 : -1); return; }
      if (act === 'front-panel' || act === 'back-panel') { moveSelectedItem(act === 'front-panel' ? 1 : -1); return; }
      if (act === 'crop') { openCrop(); return; }
      if (act === 'remove-image') {
        const panel = selectedPanel();
        if (!panel) return;
        const d = doc();
        replaceDocument({ ...d, panels: (d.panels || []).map((item) => item.id === panel.id ? { ...item, image: null } : item) });
        return;
      }
      if (act === 'convert-type') {
        if (doc()?.framesLocked) return;
        const panel = selectedPanel();
        if (!panel) return;
        const converted = convertPanelType(panel, panel.type === 'overlay' ? 'regular' : 'overlay', doc(), state.section);
        if (!converted) { notice('转换后形状不可用，先调整画框。', 'warn'); return; }
        const d = doc();
        replaceDocument({ ...d, panels: (d.panels || []).map((item) => item.id === panel.id ? converted : item) });
        return;
      }
      if (act === 'delete') { deleteSelection(); return; }
    }
    const layerPick = event.target.closest('[data-layer-pick]');
    if (layerPick) { state.activeLayerId = layerPick.dataset.layerPick; render(); return; }
    const layerToggle = event.target.closest('[data-layer-toggle]');
    if (layerToggle) {
      const id = layerToggle.dataset.layerToggle;
      const field = layerToggle.dataset.field;
      const d = doc();
      replaceDocument({
        ...d,
        layers: (d.layers || []).map((layer) => layer.id === id ? { ...layer, [field]: !layer[field] } : layer),
      });
      return;
    }
    const layerMove = event.target.closest('[data-layer-move]');
    if (layerMove) {
      const d = doc();
      replaceDocument(reorderLayer(d, layerMove.dataset.layerMove, Number(layerMove.dataset.dir)));
      return;
    }
    const panelPick = event.target.closest('[data-panel-pick]');
    if (panelPick) {
      const panel = (doc()?.panels || []).find((item) => item.id === panelPick.dataset.panelPick);
      if (panel) { state.tool = 'select'; choosePanel(panel); renderTools(); }
    }
  });

  function reorderLayer(d, id, direction) {
    const list = [...(d.layers || [])];
    const index = list.findIndex((layer) => layer.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= list.length) return d;
    [list[index], list[target]] = [list[target], list[index]];
    return { ...d, layers: list };
  }

  function moveSelectedItem(direction) {
    const d = doc();
    if (!d) return;
    if (selectedElement()) {
      replaceDocument(reorderComicItem(d, 'element', selectedElement().id, direction));
      return;
    }
    if (selectedPanel()) {
      replaceDocument(reorderComicItem(d, 'panel', selectedPanel().id, direction));
    }
  }

  function deleteSelection() {
    if (selectedPanel() && doc()?.framesLocked) { notice('画框已固定，先点击钉子解除固定。','warn'); return; }
    const d = doc();
    if (!d) return;
    if (selectedElement()) {
      replaceDocument({ ...d, elements: (d.elements || []).filter((item) => item.id !== state.selectedElementId) });
      chooseElement(null);
      return;
    }
    if (selectedStroke()) {
      replaceDocument({ ...d, strokes: (d.strokes || []).filter((item) => item.id !== state.selectedStrokeId) });
      state.selectedStrokeId = null;
      render();
      return;
    }
    if (selectedPanel()) {
      const panel = selectedPanel();
      replaceDocument({ ...d, panels: (d.panels || []).filter((item) => item.id !== panel.id) });
      choosePanel(null);
      return;
    }
    notice('先选中要删除的内容。', 'warn');
  }

  listen(host, 'input', (event) => {
    const opt = event.target.dataset.opt;
    if (opt === 'gutter') { state.gutter = Number(event.target.value); return; }
    if (opt === 'brush') { state.brushSize = Number(event.target.value); return; }
    if (opt === 'zoom') { state.zoom = Number(event.target.value); renderCanvas(); return; }
    const panelOpt = event.target.dataset.panelOpt;
    if (panelOpt) {
      const panel = selectedPanel();
      if (!panel) return;
      const d = doc();
      if (!panelSliderEdit) { history.undo.push(d); history.redo=[]; panelSliderEdit=true; }
      state.document=ensureComicLayers({ ...d, panels: (d.panels || []).map((item) => item.id === panel.id ? { ...item, [panelOpt]: Number(event.target.value) } : item) });
      markDirty(); renderCanvas(); updateButtons();
    }
  });
  listen(host, 'change', (event) => {
    if (event.target.dataset.panelOpt) { panelSliderEdit=false; renderTools(); }
    if (event.target.dataset.opt === 'zoom') { state.zoom=Number(event.target.value); if(state.zoom===1) state.view={x:0,y:0}; renderCanvas(); }
    if (event.target.dataset.opt === 'panel') choosePanel(doc().panels.find((item)=>item.id===event.target.value) || null);
  });

  listen($('[data-act="panel-upload"]'),'change',async (event)=>{
    const input=event.target, file=input.files?.[0], targetId=input.dataset.target; input.value='';
    if(!file || !targetId) return;
    try {
      const asset=await readComicAsset(file);
      if(disposed) return;
      const target=doc()?.panels.find(item=>item.id===targetId); if(!target) return;
      const image=fitPanelImage(target,{dataUrl:asset.dataUrl,width:asset.width,height:asset.height,rotation:0});
      replaceDocument({...doc(),panels:doc().panels.map(item=>item.id===targetId?{...item,image}:item)});
      notice('图片已放入原画框，保存后写入漫画页。');
    } catch(error) { if(!disposed) notice(`图片导入失败：${error.message}`,'error'); }
  });

  listen(assetInput, 'change', async () => {
    const file = assetInput.files?.[0];
    assetInput.value = '';
    if (!file) return;
    try {
      const asset = await readComicAsset(file);
      const d = doc();
      if (!d || disposed) return;
      const scale = Math.min(d.width * 0.4 / asset.width, d.height * 0.4 / asset.height, 1);
      const width = asset.width * scale;
      const height = asset.height * scale;
      insertElement('sticker', { x: (d.width - width) / 2, y: (d.height - height) / 2, width, height },
        { dataUrl: asset.dataUrl, name: asset.name });
    } catch (error) {
      notice(`素材导入失败：${error.message}`, 'error');
    }
  });

  listen(svgEl, 'pointerdown', pointerDown);
  listen(svgEl, 'pointermove', pointerMove);
  listen(svgEl, 'pointerup', pointerUp);
  listen(svgEl, 'pointercancel', cancelDrag);
  listen(svgEl, 'lostpointercapture', (event) => {
    if (drag.current && drag.current.pointerId === event.pointerId) pointerUp(event);
  });
  listen(svgEl, 'dblclick', dblClick);
  listen(host, 'dblclick', (event) => {
    if (event.target.closest('[data-tool="hand"]')) fitView();
  });
  listen(svgEl, 'dragstart', (event) => event.preventDefault());

  // 滚轮行为（“固定画框”同时锁住画面）：
  // - 画框已固定：滚轮只允许 Ctrl/⌘+滚轮缩放，普通滚动完全不动画面；
  // - 未固定：普通滚轮平移画布，Ctrl/⌘+滚轮缩放。
  listen(viewportEl, 'wheel', (event) => {
    if (!doc()) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const next = Math.max(0.2, Math.min(5, state.zoom * Math.exp(-event.deltaY * 0.002)));
      const bounds = viewportEl.getBoundingClientRect();
      const x = event.clientX - bounds.left - bounds.width / 2;
      const y = event.clientY - bounds.top - bounds.height / 2;
      const ratio = next / state.zoom;
      state.view = { x: x - (x - state.view.x) * ratio, y: y - (y - state.view.y) * ratio };
      state.zoom = next;
      renderCanvas();
      return;
    }
    if (doc()?.framesLocked) return; // 已固定：画面纹丝不动
    state.view = { x: state.view.x - event.deltaX, y: state.view.y - event.deltaY };
    renderCanvas();
  }, { passive: false });

  listen(viewportEl, 'pointerdown', (event) => {
    if (state.tool !== 'hand' && !spaceHeld && event.button !== 1) return;
    if (event.target.closest('button')) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, view: { ...state.view } };
    const move = (moveEvent) => {
      state.view = { x: start.view.x + moveEvent.clientX - start.x, y: start.view.y + moveEvent.clientY - start.y };
      renderCanvas();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    listen(window, 'pointermove', move);
    listen(window, 'pointerup', up);
  });

  function undo(redoMode = false) {
    cancelDrag();
    const source = redoMode ? history.redo : history.undo;
    if (!source.length) return;
    (redoMode ? history.undo : history.redo).push(state.document);
    state.document = ensureComicLayers(source.pop());
    markDirty();
    state.selectedPanelId = null;
    state.selectedElementId = null;
    render();
  }
  function redo() { undo(true); }

  listen(window, 'keydown', (event) => {
    if (disposed || !doc() || !host.isConnected || host.closest('.hidden') || host.querySelector('.ce-modal')) return;
    if (event.isComposing) return;
    if (event.target.closest('input, textarea, select, [contenteditable="true"], .ce-modal')) return;
    const key = event.key.toLowerCase();
    const command = event.ctrlKey || event.metaKey;
    if (key === ' ') { event.preventDefault(); spaceHeld=true; return; }
    if (event.shiftKey && key==='c') { event.preventDefault(); openCrop(); return; }
    if (command && key === 'z') { event.preventDefault(); undo(event.shiftKey); return; }
    if (command && key === 'y') { event.preventDefault(); redo(); return; }
    if (command && key === 's') { event.preventDefault(); save(); return; }
    if (command && ['0', '=', '+', '-'].includes(key)) {
      event.preventDefault();
      if (key === '0') { state.view = { x: 0, y: 0 }; fitView(); }
      else { state.zoom = Math.max(0.2, Math.min(5, state.zoom * (key === '-' ? 0.8 : 1.25))); renderCanvas(); }
      return;
    }
    if (command) return;
    if (key === 'delete' && (state.selectedPanelId || state.selectedElementId || state.selectedStrokeId)) {
      event.preventDefault(); deleteSelection(); return;
    }
    if (key === 'escape') { event.preventDefault(); cancelDrag(); choosePanel(null); return; }
    if (['[', ']'].includes(key)) {
      state.brushSize = Math.max(1, Math.min(64, state.brushSize + (key === ']' ? 2 : -2)));
      renderTools(); return;
    }
    const toolMap = { v: 'select', c: 'cut', u: event.shiftKey ? 'overlay' : 'rectangle', b: 'brush', e: 'eraser', h: 'hand', z: 'zoom', t: 'text' };
    const next = toolMap[key];
    if (next) { event.preventDefault(); changeTool(next); }
  });

  listen(window, 'keyup', (event)=>{ if(event.key===' ') spaceHeld=false; });
  listen(window, 'blur', ()=>{spaceHeld=false;});
  listen(window, 'resize', () => { if (doc() && state.zoom) renderCanvas(); });

  const resizeObserver = new ResizeObserver(() => {
    if (!disposed && doc() && viewportEl.clientWidth && viewportEl.clientHeight) renderCanvas();
  });
  resizeObserver.observe(viewportEl);

  // ------------------------------------------------------------ 对外接口
  return {
    state,
    load,
    save,
    render,
    fitView,
    changeTool,
    isDirty: () => state.dirty,
    dispose() {
      disposed = true; lifecycle.abort(); resizeObserver.disconnect();
      cancelDrag();
      host.innerHTML = '';
    },
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function toHex(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value)) ? value : '#111111';
}
