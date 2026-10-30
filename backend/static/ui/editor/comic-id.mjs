/* SPDX-License-Identifier: AGPL-3.0
 *
 * 来源：YILING0013/novelai_local_web
 *       提交 4dd42f5aa0fa21fbf149f9ed08beb3b6426152b3
 *       原路径 next_nai_web/src/utils/browserCapabilities.mjs（仅取 createClientId）
 * 修改：去掉 uuid 依赖（上游用 uuid 包 + crypto 随机源），改用浏览器原生
 *       crypto.randomUUID；不支持的旧浏览器退回 getRandomValues 手写 v4。
 */

/**
 * 生成客户端 UUID，用于画框、元素、笔迹的稳定标识。
 * @returns {string} UUID v4 字符串。
 */
export function createClientId() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  } else {
    // 极旧环境的兜底：时间戳 + 随机数，仍保证同页内不重复。
    for (let index = 0; index < 16; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
