/**
 * charts.js —— 图表层：迷你 sparkline、多序列折线（含对数轴/hover）、
 * 日历热力图、柱状图、增长预测块、按天聚合工具。
 */
/* global fmt, escapeHtml */
/* exported sparkline, CHART_COLORS, compactNum, dailyPoints, lineChart, calendarHeatmap, barChart, bindCharts, predictionBlock */
function sparkline(spark) {
  if (!spark || spark.length < 2) {
    return '<svg width="80" height="26" class="spark"><line x1="0" y1="13" x2="80" y2="13" stroke="currentColor" stroke-opacity="0.25"/></svg>';
  }
  const vals = spark.map((p) => p.stars);
  const min = Math.min(...vals),
    max = Math.max(...vals),
    range = max - min || 1;
  const w = 80,
    h = 26,
    pad = 3;
  const step = (w - pad * 2) / (vals.length - 1);
  const pts = vals.map((v, i) => [
    (pad + i * step).toFixed(1),
    ((h - pad * 2) * (1 - (v - min) / range) + pad).toFixed(1),
  ]);
  return `<svg width="${w}" height="${h}" class="spark"><polyline points="${pts.map((p) => p.join(",")).join(" ")}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
}

// ── 图表（C3：多序列 / hover 光标 / 对数轴）──
const CHART_COLORS = ["#58a6ff", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#06b6d4", "#eab308", "#ec4899"];
let chartSeq = 0;
const chartRegistry = new Map();

const compactNum = (n) =>
  n == null
    ? "–"
    : n >= 1e6
      ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M"
      : n >= 1e3
        ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k"
        : String(Math.round(n));

/** 把快照序列按天聚合（每天取最后一条） */
function dailyPoints(history, valueKey = "stars") {
  const m = new Map();
  for (const h of history || []) {
    const d = String(h.captured_at).slice(0, 10);
    const cur = m.get(d);
    if (!cur || h.captured_at > cur.captured_at) m.set(d, h);
  }
  return Array.from(m.values())
    .sort((a, b) => a.captured_at.localeCompare(b.captured_at))
    .map((h) => ({ x: String(h.captured_at).slice(0, 10), y: h[valueKey] }));
}

/**
 * 通用多序列折线图。
 * @param {{series:Array<{name:string,color?:string,points:Array<{x:string,y:number}>}>, width?:number, height?:number, logScale?:boolean, yFormat?:(n:number)=>string}} cfg
 */
function lineChart({ series, width = 680, height = 220, logScale = false, yFormat = fmt, markers = [] }) {
  const labels = Array.from(new Set(series.flatMap((s) => s.points.map((p) => p.x)))).sort();
  if (!labels.length) return '<p class="muted">暂无数据</p>';
  const idx = new Map(labels.map((l, i) => [l, i]));
  const tf = (v) => (logScale ? Math.log10(Math.max(1, v)) : v);
  const vals = series.flatMap((s) => s.points.map((p) => p.y)).filter((v) => Number.isFinite(v));
  let min = Math.min(...vals),
    max = Math.max(...vals);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return '<p class="muted">暂无数据</p>';
  if (min === max) {
    min -= 1;
    max += 1;
  }

  const padL = 50,
    padR = 14,
    padT = 14,
    padB = 28;
  const iw = width - padL - padR,
    ih = height - padT - padB;
  const x = (i) => (labels.length === 1 ? padL + iw / 2 : padL + (iw * i) / (labels.length - 1));
  const y = (v) => padT + ih * (1 - (tf(v) - tf(min)) / (tf(max) - tf(min)));
  const gridY = [0, 0.25, 0.5, 0.75, 1].map((t) => padT + ih * t);
  // 刻度值必须用与位置相同的变换反算，否则对数轴下标签与实际位置不符
  const tfMax = tf(max),
    tfMin = tf(min);
  const gridVals = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const v = logScale ? Math.pow(10, tfMax - t * (tfMax - tfMin)) : max - t * (max - min);
    return Math.abs(v) >= 10 ? Math.round(v) : Number(v.toFixed(2));
  });
  const xLabels =
    labels.length <= 8
      ? labels.map((_, i) => i)
      : [0, Math.floor((labels.length - 1) / 2), labels.length - 1];

  const id = `chart-${++chartSeq}`;
  chartRegistry.set(id, { labels, series, padL, iw, padT, ih, width, height, y, x, yFormat, markers });

  const grid = gridY
    .map(
      (gy) =>
        `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${padL + iw}" y2="${gy.toFixed(1)}" class="grid"/>`,
    )
    .join("");
  const yTicks = gridY
    .map(
      (gy, i) =>
        `<text x="${padL - 6}" y="${(gy + 3).toFixed(1)}" text-anchor="end" class="axis">${escapeHtml(yFormat(gridVals[i]))}</text>`,
    )
    .join("");
  const xTicks = xLabels
    .map((i, k) => {
      const anchor = xLabels.length > 1 && k === 0 ? "start" : k === xLabels.length - 1 ? "end" : "middle";
      return `<text x="${x(i).toFixed(1)}" y="${height - 8}" text-anchor="${anchor}" class="axis">${escapeHtml(labels[i])}</text>`;
    })
    .join("");

  // 事件标注（里程碑 / 告警）
  const markerSvg = (markers || [])
    .filter((m) => idx.has(m.x))
    .map((m) => {
      const mx = x(idx.get(m.x));
      const c = m.color || "#f59e0b";
      return (
        `<line x1="${mx.toFixed(1)}" y1="${padT}" x2="${mx.toFixed(1)}" y2="${padT + ih}" stroke="${c}" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>` +
        (m.label
          ? `<text x="${(mx + 3).toFixed(1)}" y="${padT + 10}" class="axis" fill="${c}">${escapeHtml(m.label)}</text>`
          : "")
      );
    })
    .join("");

  const lines = series
    .map((s, si) => {
      const color = s.color || CHART_COLORS[si % CHART_COLORS.length];
      const pts = s.points
        .filter((p) => idx.has(p.x))
        .map((p) => `${x(idx.get(p.x)).toFixed(1)},${y(p.y).toFixed(1)}`)
        .join(" ");
      const dots = s.points
        .filter((p) => idx.has(p.x))
        .map((p) => {
          const cx = x(idx.get(p.x)).toFixed(1),
            cy = y(p.y).toFixed(1);
          return (
            `<circle cx="${cx}" cy="${cy}" r="8" fill="transparent"><title>${escapeHtml(s.name)} · ${escapeHtml(p.x)}: ${escapeHtml(yFormat(p.y))}</title></circle>` +
            `<circle cx="${cx}" cy="${cy}" r="2.5" fill="${color}" pointer-events="none"/>`
          );
        })
        .join("");
      return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" pointer-events="none"/>${dots}`;
    })
    .join("");

  const legend = series
    .map(
      (s, si) =>
        `<span class="legend-item"><i style="background:${s.color || CHART_COLORS[si % CHART_COLORS.length]}"></i>${escapeHtml(s.name)}</span>`,
    )
    .join("");

  return `<div class="chart-wrap">
    <svg class="line-chart" data-chart-id="${id}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">
      ${grid}${yTicks}${xTicks}${markerSvg}
      <line class="crosshair" x1="0" y1="${padT}" x2="0" y2="${padT + ih}" style="display:none"/>
      ${lines}
    </svg>
    <div class="chart-tip" style="display:none"></div>
  </div>${series.length > 1 ? `<div class="chart-legend">${legend}</div>` : ""}`;
}

/** 日历热力图（GitHub 贡献图样式）：列为周，行为星期 */
function calendarHeatmap(points, { cell = 11, gap = 3 } = {}) {
  if (!points || points.length < 2) return '<p class="muted">暂无数据</p>';
  const map = new Map(points.map((p) => [p.x, p.y]));
  const sorted = points.map((p) => p.x).sort();
  const first = new Date(`${sorted[0]}T00:00:00Z`);
  const last = new Date(`${sorted[sorted.length - 1]}T00:00:00Z`);
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay()); // 对齐到周日
  const days = Math.round((last - start) / 86400000) + 1;
  const weeks = Math.ceil(days / 7);
  const max = Math.max(...points.map((p) => p.y), 1);

  let cells = "";
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    const v = map.get(key);
    const wk = Math.floor(i / 7),
      dow = i % 7;
    const x = wk * (cell + gap),
      y = dow * (cell + gap);
    const opacity = v == null ? 0 : Math.max(0.15, Math.min(1, v / max));
    const fill = v == null ? "var(--surface-2)" : "#58a6ff";
    cells += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${fill}" fill-opacity="${opacity || 1}"><title>${key}: ${v == null ? "无数据" : "+" + fmt(v)}</title></rect>`;
  }
  const width = weeks * (cell + gap),
    height = 7 * (cell + gap);
  return `<div class="chart-wrap"><svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="max-width:100%;height:auto" role="img">${cells}</svg></div>`;
}

/** 简单柱状图（原生 title 提示） */
function barChart(points, { width = 680, height = 160, yFormat = fmt, color = "#58a6ff" } = {}) {
  if (!points.length) return '<p class="muted">暂无数据</p>';
  const padL = 48,
    padR = 12,
    padT = 12,
    padB = 26;
  const iw = width - padL - padR,
    ih = height - padT - padB;
  const max = Math.max(...points.map((p) => p.y), 1);
  const slot = iw / points.length;
  const bw = Math.max(1, slot - 2);
  const bars = points
    .map((p, i) => {
      const h = ih * (p.y / max);
      const bx = padL + slot * i + 1;
      const by = padT + ih - h;
      return `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" fill="${color}" rx="1"><title>${escapeHtml(p.x)}: ${escapeHtml(yFormat(p.y))}</title></rect>`;
    })
    .join("");
  const xLabels =
    points.length <= 8
      ? points.map((_, i) => i)
      : [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const xTicks = xLabels
    .map((i, k) => {
      const anchor = xLabels.length > 1 && k === 0 ? "start" : k === xLabels.length - 1 ? "end" : "middle";
      return `<text x="${(padL + slot * i + bw / 2).toFixed(1)}" y="${height - 8}" text-anchor="${anchor}" class="axis">${escapeHtml(points[i].x)}</text>`;
    })
    .join("");
  return `<div class="chart-wrap"><svg class="line-chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">
    ${bars}${xTicks}
    <text x="${padL - 6}" y="${padT + 8}" text-anchor="end" class="axis">${escapeHtml(yFormat(max))}</text>
  </svg></div>`;
}

/** 为容器内所有折线图绑定 hover 光标与 tooltip */
function bindCharts(root) {
  (root || document).querySelectorAll("svg.line-chart[data-chart-id]").forEach((svg) => {
    if (svg.dataset.bound === "1") return;
    svg.dataset.bound = "1";
    const cfg = chartRegistry.get(svg.dataset.chartId);
    if (!cfg) return;
    const tip = svg.parentElement.querySelector(".chart-tip");
    const cross = svg.querySelector(".crosshair");
    svg.addEventListener("mousemove", (e) => {
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      const mx = (e.clientX - rect.left) * (cfg.width / rect.width);
      let i = Math.round(((mx - cfg.padL) / cfg.iw) * (cfg.labels.length - 1));
      i = Math.max(0, Math.min(cfg.labels.length - 1, i));
      const label = cfg.labels[i];
      const cx = cfg.x(i);
      cross.setAttribute("x1", cx);
      cross.setAttribute("x2", cx);
      cross.style.display = "";
      const rows = cfg.series
        .map((s, si) => {
          const p = s.points.find((q) => q.x === label);
          if (!p) return "";
          const color = s.color || CHART_COLORS[si % CHART_COLORS.length];
          return `<div class="tip-row"><i style="background:${color}"></i><span>${escapeHtml(s.name)}</span><b>${escapeHtml(cfg.yFormat(p.y))}</b></div>`;
        })
        .join("");
      const markRows = (cfg.markers || [])
        .filter((m) => m.x === label)
        .map(
          (m) =>
            `<div class="tip-row tip-marker" style="color:${m.color || "#f59e0b"}">✦ <span>${escapeHtml(m.message || m.label || "")}</span></div>`,
        )
        .join("");
      tip.innerHTML = `<div class="tip-date">${escapeHtml(label)}</div>${rows}${markRows}`;
      tip.style.display = "";
      const leftPx = (cx / cfg.width) * rect.width;
      tip.style.left = `${Math.max(0, Math.min(rect.width - 150, leftPx + 12))}px`;
    });
    svg.addEventListener("mouseleave", () => {
      cross.style.display = "none";
      tip.style.display = "none";
    });
  });
}

function predictionBlock(pred, unitLabel = "星") {
  if (!pred) return '<p class="muted" style="font-size:12px">预测需要至少 3 天的快照数据。</p>';
  const rate = pred.perDay;
  const color = rate > 0 ? "var(--green)" : rate < 0 ? "var(--red)" : "var(--text-2)";
  // 预测可信度（R²）：数值越低说明星数变化越不像直线
  const conf =
    pred.r2 != null
      ? `<div class="muted" style="font-size:12px;margin-top:2px">拟合可信度 R² = ${pred.r2}${pred.samples ? `（${pred.samples} 个日样本）` : ""}${pred.r2 < 0.6 ? " · ⚠️ 偏低，仅供参考" : ""}</div>`
      : "";
  let eta = "";
  if (pred.next100k) {
    eta = `<div class="muted" style="font-size:12px;margin-top:4px">
      按当前速度，约 <b>${pred.next100k.days}</b> 天后达到 <b>${fmt(pred.next100k.milestone)}</b>（预计 ${escapeHtml(pred.next100k.eta)}）
    </div>`;
  }
  return `<div class="detail-chart">
    <div class="detail-chart-title">增长预测（线性回归）</div>
    <div style="font-size:14px">当前速度：<b style="color:${color}">${rate >= 0 ? "+" : ""}${rate} ${escapeHtml(unitLabel)}/天</b></div>
    ${conf}
    ${eta}
  </div>`;
}
