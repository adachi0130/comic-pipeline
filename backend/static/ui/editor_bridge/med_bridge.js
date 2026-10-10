/* Manga Editor Desu! 驱动桥（frame-side）。
 *
 * 用法：由同源包装页把本文件**作为 <script> 注入到 MED 的 iframe 文档内**，
 * 让代码运行在 MED 的全局作用域里（MED 的顶层函数是 function/var 声明，
 * 裸名可用；部分 const 只存在于全局词法作用域，故不能靠 parent 侧跨帧取属性）。
 * 注入后 MED 的 window 上出现 `__MED` 门面，父页用同源方式调用。
 *
 * 依赖的 MED 全局函数（已在锁定版本核实存在，均为 function 声明）：
 *   loadSVGPlusReset / getPanelObjectList / sortPanelsInReadingOrder /
 *   promptApplyToOrderedPanels / putImageInFrame / ImageUtil.canvas2DataURL
 * 以及全局 `canvas`（fabric.Canvas 实例）、`fabric`。
 *
 * 该门面刻意只暴露这几个函数，把 MED 无 API、版本易变的风险收敛在这一层；
 * 升级 MED 后跑 smoke 测试即可确认桥未失效。
 */
(function () {
  "use strict";

  const REQUIRED = [
    "loadSVGPlusReset",
    "getPanelObjectList",
    "sortPanelsInReadingOrder",
    "promptApplyToOrderedPanels",
    "putImageInFrame",
    "ImageUtil",
    "canvas",
  ];

  function missing() {
    const miss = [];
    for (const name of REQUIRED) {
      // 裸名可能存在于全局词法作用域，用 try 探测
      let ok = false;
      try {
        // eslint-disable-next-line no-eval
        ok = eval("typeof " + name) !== "undefined";
      } catch (e) {
        ok = false;
      }
      if (!ok) miss.push(name);
    }
    return miss;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** 轮询等待条件成立（MED 的模板加载是 fabric 回调式，异步）。 */
  async function waitFor(cond, { timeout = 8000, interval = 60 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (cond()) return true;
      await sleep(interval);
    }
    return false;
  }

  function panelList() {
    // eslint-disable-next-line no-undef
    return getPanelObjectList();
  }

  function orderedPanels(rightToLeft) {
    const panels = panelList();
    // eslint-disable-next-line no-undef
    return sortPanelsInReadingOrder(panels, rightToLeft !== false);
  }

  const api = {
    /** 探测桥是否可用。 */
    ready() {
      const miss = missing();
      return { ok: miss.length === 0, missing: miss, href: location.href };
    },

    /** 当前页面上的分镜框数量。 */
    panelCount() {
      return panelList().length;
    },

    /** 取画布尺寸（像素）。 */
    canvasSize() {
      // eslint-disable-next-line no-undef
      return { width: canvas.getWidth(), height: canvas.getHeight() };
    },

    /**
     * 安装版式模板。svg 为模板 SVG 全文。
     * @returns {Promise<{ok:boolean, panels:number}>}
     */
    async installTemplate(svg, isLandscape) {
      const before = panelList().length;
      // eslint-disable-next-line no-undef
      loadSVGPlusReset(svg, !!isLandscape);
      const ok = await waitFor(() => panelList().length !== before || panelList().length > 0);
      return { ok, panels: panelList().length };
    },

    /** 按阅读顺序返回每格的稳定序号与基本信息（供后端建立 panel_order 映射）。 */
    readingOrder(rightToLeft) {
      const ordered = orderedPanels(rightToLeft);
      return ordered.map((item, i) => {
        const p = item.panel || item;
        const rect = (p.getBoundingRect && p.getBoundingRect()) || {};
        return {
          order: i + 1,
          width: Math.round(rect.width || 0),
          height: Math.round(rect.height || 0),
          prompt: p.text2img_prompt || "",
        };
      });
    },

    /**
     * 把有序的提示词数组按阅读顺序落到各格（复用 MED 的 promptApplyToOrderedPanels）。
     * @param {string[]} prompts
     */
    applyPrompts(prompts, { rightToLeft = true, append = false } = {}) {
      const ordered = orderedPanels(rightToLeft);
      const results = ordered.map((item, i) => ({ panel: item.panel || item, prompt: String(prompts[i] ?? "") }));
      // eslint-disable-next-line no-undef
      const applied = promptApplyToOrderedPanels(ordered, results, append);
      return { applied, total: ordered.length };
    },

    /**
     * 把我们后端出好的图片贴进第 order 格（1-based 阅读顺序）。
     * dataUrl 为 data:image/... 字符串。
     */
    async placeImage(order, dataUrl, { rightToLeft = true } = {}) {
      const ordered = orderedPanels(rightToLeft);
      const item = ordered[order - 1];
      if (!item) throw new Error("格序号越界：" + order + "（共 " + ordered.length + "）");
      const panel = item.panel || item;
      // eslint-disable-next-line no-undef
      const img = await new Promise((resolve, reject) => {
        // eslint-disable-next-line no-undef
        fabric.Image.fromURL(
          dataUrl,
          (im) => (im ? resolve(im) : reject(new Error("图片加载失败"))),
          { crossOrigin: "anonymous" }
        );
      });
      const rect = panel.getBoundingRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      // isNotActive=false, notReplace=false, isFit=true, targetLayer=panel
      // eslint-disable-next-line no-undef
      putImageInFrame(img, cx, cy, false, false, true, panel);
      return { ok: true, order };
    },

    /**
     * 叠加网点/集中线/运动线。
     *
     * MED 这些生成器不是纯函数：它们读侧栏控件的值、并用 ``getLastObject()`` 决定落到哪。
     * 正确做法是走 ``applyMangaTone(MODE)``——它会先构建控件（带默认值）再生成。
     * 若目标格存在，先把它置顶，让生成器把网点落进该格；否则作为自由对象落在画布上。
     * 失败不抛异常，返回 ``{ok:false,error}``，由上层记为 warning（可改为人工在 UI 里叠加）。
     */
    addTone(kind, opts) {
      const modeMap = { focus: "FocusingLine", speed: "SpeedLine", tone: "Tone" };
      const mode = modeMap[kind];
      if (!mode) return { ok: false, error: "未知技法：" + kind };

      const o = opts || {};
      // 目标格置顶，使生成器把它当作“当前对象”
      if (o.panel_order) {
        try {
          const ordered = orderedPanels(o.rightToLeft !== false);
          const item = ordered[o.panel_order - 1];
          const panel = item && (item.panel || item);
          if (panel && typeof canvas.bringToFront === "function") canvas.bringToFront(panel);
        } catch (e) {
          /* 忽略：不置顶也能生成，只是可能落成自由对象 */
        }
      }

      let apply = null;
      try {
        // eslint-disable-next-line no-eval
        apply = eval('typeof applyMangaTone === "function" ? applyMangaTone : null');
      } catch (e) {
        apply = null;
      }
      if (!apply) return { ok: false, error: "当前 MED 版本未暴露 applyMangaTone" };

      try {
        apply(mode);
        return { ok: true, mode };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },

    /** 导出整页 PNG 为 dataURL（比只会触发下载的 cropAndDownload 更适合自动化）。 */
    exportPNG(multiplier) {
      const m = multiplier || 1;
      // eslint-disable-next-line no-undef
      return ImageUtil.canvas2DataURL(m, "png");
    },

    /** 导出当前画布 JSON（含已贴图/已加对话气泡等编辑状态），可日后 loadDoc 继续编辑。 */
    exportDoc() {
      // eslint-disable-next-line no-undef
      return JSON.stringify(canvas.toJSON(["text2img_prompt", "name", "relatedPoly", "isPanel"]));
    },

    /** 载入画布 JSON，继续编辑。 */
    async loadDoc(docJson) {
      const obj = typeof docJson === "string" ? JSON.parse(docJson) : docJson;
      await new Promise((resolve) => {
        // eslint-disable-next-line no-undef
        canvas.loadFromJSON(obj, () => { canvas.renderAll(); resolve(); });
      });
      return { ok: true, objects: (canvas.getObjects && canvas.getObjects().length) || 0 };
    },

    /** 快照：每格的现有提示词与是否有图，便于后端核对。 */
    snapshot() {
      return panelList().map((p, i) => ({
        index: i,
        prompt: p.text2img_prompt || "",
        hasImage: Array.isArray(p._objects) || !!p.relatedPoly,
      }));
    },

    /**
     * 注册中文字体（MED 未内置简体中文字体，只有日文 Noto Sans JP）。
     * 走 MED 自带的字体管理器 `fontManager.loadFont({type:'local'})`，
     * 用 local() 取系统字体，**不改 MED 源码**，故重新拉取 MED 也不丢。
     * @returns {Promise<{registered:string[], failed:string[]}>}
     */
    async setupCJKFonts(names) {
      const candidates = names || [
        "Microsoft YaHei",
        "微软雅黑",
        "Noto Sans SC",
        "Source Han Sans SC",
        "SimHei",
        "SimSun",
      ];
      let fm = null;
      try {
        // eslint-disable-next-line no-eval
        fm = eval('typeof fontManager !== "undefined" ? fontManager : null');
      } catch (e) {
        fm = null;
      }
      if (!fm || typeof fm.loadFont !== "function") {
        return { registered: [], failed: candidates, error: "未找到 fontManager" };
      }
      const registered = [];
      const failed = [];
      for (const name of candidates) {
        try {
          await fm.loadFont({ name, type: "local" });
          registered.push(name);
          break; // 一个够用
        } catch (e) {
          failed.push(name);
        }
      }
      return { registered, failed };
    },
  };

  // eslint-disable-next-line no-undef
  window.__MED = api;
  // 方便父页知道桥已注入
  // eslint-disable-next-line no-undef
  window.dispatchEvent(new Event("med-bridge-ready"));
})();
