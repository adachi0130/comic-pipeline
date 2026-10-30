/* SPDX-License-Identifier: AGPL-3.0
 *
 * 画布上的元素绘制（气泡 / 文字 / 贴纸）。
 *
 * 来源：YILING0013/novelai_local_web
 *       提交 4dd42f5aa0fa21fbf149f9ed08beb3b6426152b3
 *       原路径 next_nai_web/src/components/ai-painting/ComicWorkspace/comicElements.mjs
 *               （comicElementSvg 的绘制规则）
 * 修改：上游把整块元素包成一个内嵌 <image src="data:image/svg+xml,...">，
 *       这里直接返回可内联进页面 SVG 的图形组，省掉一次 base64 解码与异步加载，
 *       交互时重绘更快；气泡轮廓与文字排布规则保持与上游一致，也和后端
 *       backend/app/comic/balloons.py 使用同一份节点数据。
 */

import { comicBalloonContours, comicBalloonPath } from './comicBalloonPaths.mjs';

const BUBBLE_TEXT_BOX = {
  speech: [0.16, 0.14, 0.68, 0.56], 'speech-right': [0.16, 0.14, 0.68, 0.56],
  ellipse: [0.16, 0.2, 0.68, 0.6], 'round-box': [0.13, 0.14, 0.74, 0.55],
  caption: [0.1, 0.12, 0.8, 0.76], thought: [0.2, 0.15, 0.6, 0.5],
  cloud: [0.2, 0.2, 0.6, 0.6], shout: [0.22, 0.23, 0.56, 0.54],
  impact: [0.24, 0.26, 0.52, 0.48], whisper: [0.16, 0.14, 0.68, 0.56],
  speed: [0.24, 0.24, 0.52, 0.52], electric: [0.2, 0.18, 0.6, 0.54],
  'jaggy-small': [0.25, 0.2, 0.5, 0.6], 'jaggy-wide': [0.2, 0.22, 0.6, 0.56],
  vibration: [0.2, 0.17, 0.6, 0.66], mumble: [0.24, 0.14, 0.52, 0.72],
  announcement: [0.24, 0.25, 0.52, 0.51], 'whisper-oval': [0.2, 0.15, 0.6, 0.7],
  'burst-fine': [0.35, 0.35, 0.3, 0.3], 'jagged-star': [0.24, 0.24, 0.52, 0.52],
  'speed-oval': [0.28, 0.26, 0.44, 0.48],
};

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]
  ));
}

let measureContext;
function textWidth(value, fontSize, fontFamily) {
  if (!measureContext && typeof document !== 'undefined') {
    measureContext = document.createElement('canvas').getContext('2d');
  }
  const family = String(fontFamily || 'sans-serif').replace(/["\\]/g, '');
  if (measureContext) {
    measureContext.font = `${fontSize}px ${family}, sans-serif`;
    return measureContext.measureText(value).width;
  }
  return [...value].reduce((sum, ch) => sum + (/[^\x00-\xff]/.test(ch) ? 1 : 0.6) * fontSize, 0);
}

/** 按可用宽度折行；中文逐字断行，英文优先断在空格。 */
function wrapText(text, width, fontSize, fontFamily) {
  const lines = [];
  for (const paragraph of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    let line = '';
    for (const chunk of paragraph.match(/\S+\s*|\s+/gu) || []) {
      if (line && textWidth(line + chunk, fontSize, fontFamily) > width) {
        lines.push(line.trimEnd());
        line = '';
      }
      for (const character of [...(line ? chunk : chunk.trimStart())]) {
        if (line && textWidth(line + character, fontSize, fontFamily) > width) {
          lines.push(line.trimEnd());
          line = '';
        }
        line += character;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/** 元素在页面坐标下的 SVG 片段（不含外层 transform，由调用方加矩阵）。 */
export function balloonPageSvg(element) {
  const { width, height, kind } = element;
  const parts = [];
  const fill = element.fill;
  const text = element.text || '';

  if (kind === 'bubble' && !element.dataUrl) {
    const presetId = element.presetId || 'speech';
    const contours = element.balloonContours || comicBalloonContours(presetId);
    const dash = presetId === 'whisper' ? ' stroke-dasharray="4 3"'
      : presetId === 'whisper-oval' ? ' stroke-dasharray="1 3" stroke-linecap="round"' : '';
    const paths = contours.map((contour) => `<path d="${escapeXml(comicBalloonPath(contour))}"/>`).join('');
    parts.push(`<g transform="scale(${width / 100} ${height / 100})" fill="${fill && fill !== 'none' ? escapeXml(fill) : 'none'}" stroke="${escapeXml(element.stroke || '#111111')}" stroke-width="${Number(element.strokeWidth) || 0}" stroke-linejoin="round" vector-effect="non-scaling-stroke">${paths}</g>`);
  } else if (element.dataUrl) {
    parts.push(`<image href="${escapeXml(element.dataUrl)}" width="${width}" height="${height}" preserveAspectRatio="none"/>`);
  } else if (kind === 'text' && fill && fill !== 'none') {
    parts.push(`<rect width="${width}" height="${height}" fill="${escapeXml(fill)}"/>`);
  }

  if (text) {
    const presetId = element.presetId || 'speech';
    const box = (kind === 'bubble' && !element.dataUrl)
      ? (BUBBLE_TEXT_BOX[presetId] || BUBBLE_TEXT_BOX.speech)
      : [0.04, 0.04, 0.92, 0.92];
    const left = width * box[0];
    const top = height * box[1];
    const availableWidth = width * box[2];
    const availableHeight = height * box[3];
    const fontSize = Number(element.fontSize) || 24;
    const lineHeight = fontSize * (Number(element.lineHeight) || 1.25);
    const anchor = element.textAlign === 'left' ? 'start' : element.textAlign === 'right' ? 'end' : 'middle';
    const vertical = element.writingMode === 'vertical-rl';
    let spans;
    if (vertical) {
      const capacity = Math.max(1, Math.floor(availableHeight / fontSize));
      const segmenter = typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
      const columns = String(text).replace(/\r\n?/g, '\n').split('\n').flatMap((paragraph) => {
        const characters = segmenter
          ? [...segmenter.segment(paragraph)].map(({ segment }) => segment)
          : [...paragraph];
        return Array.from({ length: Math.max(1, Math.ceil(characters.length / capacity)) },
          (_, index) => characters.slice(index * capacity, (index + 1) * capacity).join(''));
      });
      const x = left + availableWidth / 2 + (columns.length - 1) * lineHeight / 2;
      const y = element.textAlign === 'left' ? top
        : element.textAlign === 'right' ? top + availableHeight : top + availableHeight / 2;
      spans = columns.map((column, index) => (
        `<tspan x="${x - index * lineHeight}" y="${y}" xml:space="preserve">${escapeXml(column)}</tspan>`
      )).join('');
    } else {
      const lines = wrapText(text, availableWidth, fontSize, element.fontFamily);
      const baseline = top + (availableHeight - lines.length * lineHeight) / 2 + (lineHeight + fontSize * 0.72) / 2;
      const x = element.textAlign === 'left' ? left
        : element.textAlign === 'right' ? left + availableWidth : left + availableWidth / 2;
      spans = lines.map((line, index) => (
        `<tspan x="${x}" y="${baseline + index * lineHeight}" xml:space="preserve">${escapeXml(line)}</tspan>`
      )).join('');
    }
    const strokeAttrs = element.kind === 'text' && Number(element.strokeWidth) > 0
      ? ` stroke="${escapeXml(element.stroke || '#111111')}" stroke-width="${element.strokeWidth}" paint-order="stroke" stroke-linejoin="round"`
      : '';
    parts.push(`<text fill="${escapeXml(element.color || '#111111')}" font-family="${escapeXml(element.fontFamily || 'sans-serif')}" font-size="${fontSize}" text-anchor="${anchor}"${vertical ? ' writing-mode="vertical-rl" dominant-baseline="central" style="text-orientation:upright"' : ''}${strokeAttrs}>${spans}</text>`);
  }

  // 羽化用模糊近似（上游导出走 feMorphology 精确轮廓），编辑预览足够。
  const feather = Number(element.feather) || 0;
  const opacity = element.opacity ?? 1;
  const filter = feather > 0 ? ` filter="url(#feather-${safeId(element.id)})"` : '';
  const defs = feather > 0
    ? `<defs><filter id="feather-${safeId(element.id)}" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${feather / 3}"/></filter></defs>`
    : '';
  return `${defs}<g opacity="${opacity}"${filter}>${parts.join('')}</g>`;
}

function safeId(value) {
  return String(value || 'x').replace(/[^a-zA-Z0-9_-]/g, '');
}
