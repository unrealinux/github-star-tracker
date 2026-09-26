/**
 * SVG 徽章生成（零依赖，shields.io 风格）
 * 可嵌入 README：![stars](http://your-host/badge/owner/repo.svg)
 */

const CHAR_W = 6.6; // 11px Verdana 近似字宽

function textWidth(s) {
  return Math.round(String(s).length * CHAR_W);
}

function escapeXml(s) {
  return String(s ?? "").replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
}

/**
 * 生成左右两段式徽章。
 * @param {string} label 左侧标签
 * @param {string} value 右侧数值
 * @param {string} color 右侧背景色
 */
export function renderBadge(label, value, color = "#58a6ff") {
  const l = escapeXml(label);
  const v = escapeXml(value);
  const lw = textWidth(l) + 12;
  const vw = textWidth(v) + 12;
  const w = lw + vw;
  const lx = lw / 2;
  const vx = lw + vw / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${l}: ${v}">
  <title>${l}: ${v}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${lw}" height="20" fill="#555"/>
    <rect x="${lw}" width="${vw}" height="20" fill="${color}"/>
    <rect width="${w}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text x="${lx}" y="15" fill="#010101" fill-opacity=".3">${l}</text>
    <text x="${lx}" y="14">${l}</text>
    <text x="${vx}" y="15" fill="#010101" fill-opacity=".3">${v}</text>
    <text x="${vx}" y="14">${v}</text>
  </g>
</svg>`;
}

/** 根据增长量选择颜色 */
export function colorForGrowth(growth) {
  if (growth == null) return "#8b949e"; // 灰：待积累
  if (growth >= 100) return "#f59e0b"; // 橙：爆发
  if (growth >= 10) return "#22c55e"; // 绿：健康
  if (growth > 0) return "#58a6ff"; // 蓝：微增
  if (growth === 0) return "#8b949e"; // 灰：持平
  return "#ef4444"; // 红：下降
}

/** 数值紧凑格式：12345 → 12.3k */
export function compactNumber(n) {
  if (n == null) return "–";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

/**
 * 迷你折线走势图（可嵌入 README，比数字徽章更有信息量）。
 * @param {number[]} values 指标序列（升序）
 */
export function renderSparkline(values, { width = 120, height = 32, color = "#58a6ff", fill = true } = {}) {
  const vals = Array.isArray(values) ? values.filter((v) => typeof v === "number" && Number.isFinite(v)) : [];
  if (vals.length < 2) return renderBadge("trend", "no data", "#8b949e");

  const min = Math.min(...vals),
    max = Math.max(...vals);
  const range = max - min || 1;
  const pad = 3;
  const iw = width - pad * 2,
    ih = height - pad * 2;
  const step = iw / (vals.length - 1);
  const pts = vals.map((v, i) => [pad + i * step, pad + ih * (1 - (v - min) / range)]);
  const line = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = fill
    ? `<polygon points="${pad},${height - pad} ${line} ${width - pad},${height - pad}" fill="${color}" fill-opacity="0.15"/>`
    : "";
  const last = pts[pts.length - 1];

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="trend">${area}<polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2" fill="${color}"/></svg>`;
}

/** shields.io endpoint 响应体 */
export function shieldsPayload(label, message, color) {
  return { schemaVersion: 1, label: String(label), message: String(message), color: String(color) };
}
