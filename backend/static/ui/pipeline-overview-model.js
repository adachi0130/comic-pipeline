export const STAGES = [
  { id: 'S1', name: '正文', tab: 'novel', kind: 'prose' },
  { id: 'S2', name: '分格分页', tab: 'pages', kind: 'script' },
  { id: 'S3', name: '分镜提示词', tab: 'prompts', kind: 'prompt' },
  { id: 'S4', name: '逐格出图', tab: 'images', kind: 'image' },
  { id: 'S5', name: '整页合成', tab: 'compose', kind: 'compose' },
  { id: 'S6', name: '成册导出', tab: 'exports', kind: 'book' },
];
export const activeJob = (job) => ['queued', 'running'].includes(job.status);
export const jobStage = (job) => STAGES.find((stage) => stage.kind === job.kind) || STAGES.find((stage) => stage.id === job.stage);
export function shapeTitle(board) {
  if (board.book?.downloads.length && board.book.status !== 'stale') return '漫画已成册';
  if (board.summary.composed) return '漫画已有整页成图';
  if (board.summary.with_image) return '画面正在填入漫画页';
  if (board.pages.length) return '故事已分成漫画页';
  if (board.prose.length) return board.prose.every((item) => item.status === 'approved') ? '故事正文已就绪' : '故事正文待审核';
  return '从故事正文开始';
}
export function suggestedStage(board) {
  if (!board.prose.length || !board.prose.some((item) => item.status === 'approved')) return 'S1';
  if (!board.pages.length) return 'S2';
  if (board.pages.some((page) => page.script?.status !== 'approved')) return 'S2';
  if (board.pages.some((page) => page.panels.some((panel) => !panel.prompt || panel.prompt.status !== 'approved'))) return 'S3';
  if (board.pages.some((page) => page.panels.some((panel) => !panel.approved_image))) return 'S4';
  if (board.pages.some((page) => !page.page_image_url || page.page_image?.status !== 'approved' || page.needs_update)) return 'S5';
  return 'S6';
}
export function panelBox(page, panel, index) {
  const geometry = (Array.isArray(page.geometry) ? page.geometry : []).find((item) => Number(item.index) === Number(panel.order));
  if (geometry) {
    const values = [geometry.x_pct, geometry.y_pct, geometry.width_pct, geometry.height_pct].map(Number);
    if (values.every(Number.isFinite) && values[0] >= 0 && values[0] < 100 && values[1] >= 0 && values[1] < 100 && values[2] > 0 && values[3] > 0) {
      return [Math.min(99, values[0]), Math.min(99, values[1]), Math.min(100 - values[0], values[2]), Math.min(100 - values[1], values[3])];
    }
  }
  const columns = page.panels.length === 1 ? 1 : 2, rows = Math.ceil(page.panels.length / columns);
  return [3 + (columns - 1 - index % columns) * (94 / columns), 3 + Math.floor(index / columns) * (94 / rows), 94 / columns - 2, 94 / rows - 2];
}
export function dateValue(value) {
  if (!value) return NaN;
  return new Date(value + (/Z$|[+-]\d\d:\d\d$/.test(value) ? '' : 'Z')).getTime();
}
export function duration(job, now = Date.now()) {
  const started = dateValue(job.started_at || job.created_at);
  const finished = dateValue(job.finished_at);
  const seconds = Math.max(0, Math.floor(((Number.isFinite(finished) ? finished : now) - started) / 1000));
  if (!Number.isFinite(seconds)) return '';
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
