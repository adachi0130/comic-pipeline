// 把 MED 的模板 JS（`const X=[{name, svg}, ...]`）解析成 JSON 输出到 stdout。
// 用 JS 求值而非正则，避免 SVG 内转义引号导致的解析错误。
// 用法：node parse_med_templates.mjs <文件路径> <变量名>
//   node parse_med_templates.mjs .../manga-panels-image-vertical.js MangaPanelsImage_Vertical

import { readFileSync } from "node:fs";

const [file, varName] = process.argv.slice(2);
if (!file || !varName) {
  console.error("用法: node parse_med_templates.mjs <文件> <变量名>");
  process.exit(2);
}

const src = readFileSync(file, "utf8");
let arr;
try {
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${src}\nreturn typeof ${varName} !== "undefined" ? ${varName} : null;`);
  arr = fn();
} catch (e) {
  console.error("解析失败:", e.message);
  process.exit(1);
}

if (!Array.isArray(arr)) {
  console.error(`未找到数组 ${varName}`);
  process.exit(1);
}

// 只保留 name / svg，逐条输出，避免一次性构造超大字符串
process.stdout.write(JSON.stringify(arr.map((it) => ({ name: it.name, svg: it.svg }))));
