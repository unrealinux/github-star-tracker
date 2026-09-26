const $ = (id) => document.getElementById(id);

const state = {
  minStars: 1000, minGrowth: 0, language: "", sort: "growth", window: "day",
  highlightThreshold: 50, pinHot: false, todayOnly: false,
  page: 1, pageSize: 50, totalPages: 1, total: 0,
  keyword: "", onlyCustom: false, onlyFavorite: false,
  metric: "stars",
  activeTab: "repos",
  favPage: 1, customPage: 1,
};

let allRepos = [];
let languages = [];

// ── API Key 管理（P0-1）──
const getApiKey = () => localStorage.getItem("gst_api_key") || "";
const setApiKey = (k) => k ? localStorage.setItem("gst_api_key", k) : localStorage.removeItem("gst_api_key");
const getSession = () => localStorage.getItem("gst_session") || "";
const setSession = (t) => t ? localStorage.setItem("gst_session", t) : localStorage.removeItem("gst_session");

let authPrompted = false;
function handleUnauthorized() {
  if (authPrompted) return;
  authPrompted = true;
  const k = prompt("该服务已启用访问控制，请输入 API Key：");
  if (k) { setApiKey(k.trim()); location.reload(); }
}

async function fetchJson(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const key = getApiKey();
  if (key) headers["X-API-Key"] = key;
  const session = getSession();
  if (session) headers["X-Session"] = session;
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) {
    if (!url.startsWith("/api/auth/")) showAuth("login");
    handleUnauthorized();
    throw new Error("未授权");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

const fmt = (n) => (n == null ? "–" : n.toLocaleString("zh-CN"));
const timeAgo = (iso) => {
  if (!iso) return "–";
  const t = Date.parse(iso);
  if (!t) return "–";
  const d = Date.now() - t, m = Math.floor(d / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
};
const timeUntil = (iso) => {
  if (!iso) return "–";
  const d = Date.parse(iso) - Date.now();
  if (d <= 0) return "即将触发";
  const m = Math.floor(d / 60000);
  if (m < 60) return `${m} 分钟内`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时后`;
  return `${Math.floor(h / 24)} 天后`;
};
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

// CSP 下不可用内联 onclick：仓库名链接用 data-stop，在捕获阶段阻止冒泡到卡片
// （否则点链接会连带触发卡片的 openDetail）
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-stop]")) e.stopPropagation();
}, true);

// ── Tab 切换 ──
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => {
      c.classList.remove("active");
      c.classList.add("hidden");
    });
    tab.classList.add("active");
    state.activeTab = tab.dataset.tab;
    const target = $(`tab-${state.activeTab}`);
    if (target) { target.classList.remove("hidden"); target.classList.add("active"); }
    if (state.activeTab === "favorites") loadFavorites();
    else if (state.activeTab === "custom") loadCustomRepos();
    else if (state.activeTab === "language-trend") loadLanguageTrends();
    else if (state.activeTab === "rank") loadRankChanges();
    else if (state.activeTab === "leaderboard") loadLeaderboard();
    else if (state.activeTab === "surge") { loadSurges(); initReplayDefault(); }
    else if (state.activeTab === "compare") initCompare();
    else if (state.activeTab === "overview") loadOverview();
    else if (state.activeTab === "signals") loadSignals();
    else if (state.activeTab === "indices") initIndices();
    else if (state.activeTab === "external") loadExternalMetrics();
    else if (state.activeTab === "settings") loadSettings();
  });
});

// ── 统计 ──
function renderStats(stats) {
  $("stat-repos").textContent = fmt(stats.repoCount);
  $("stat-custom").textContent = fmt(stats.customCount || 0);
  $("stat-fav").textContent = fmt(stats.favoriteCount || 0);
  $("stat-snapshots").textContent = fmt(stats.snapCount);
  $("stat-last").textContent = timeAgo(stats.lastRefresh);
  const auto = stats.auto || {};
  $("stat-next").textContent = !auto.enabled ? "已停用" : timeUntil(auto.nextRun);
  // token 状态如实展示：只看「有没有配置」会把一个失效 token 显示成 ✅
  const tokenState = stats.tokenState || (stats.tokenConfigured ? "unknown" : "none");
  const TOKEN_VIEW = {
    ok:      { text: "Token ✅",            cls: "ok",   title: "token 已校验可用" },
    invalid: { text: "Token 失效·已回退匿名", cls: "warn", title: "GitHub 返回 401，已自动改用匿名请求（配额较低）。请更换 GITHUB_TOKEN 或 GH_TOKEN" },
    none:    { text: "匿名模式",            cls: "warn", title: "未配置 GITHUB_TOKEN / GH_TOKEN，搜索配额仅约 10 次/分钟" },
    unknown: { text: "Token 待验证",         cls: "warn", title: "已配置 token，尚未校验" },
  };
  const tv = TOKEN_VIEW[tokenState] || TOKEN_VIEW.none;
  $("token-status").textContent = tv.text;
  $("token-status").className = "token-status " + tv.cls;
  $("token-status").title = tv.title;
  const q = stats.quota || { used: 0, limit: 60, pct: 0 };
  $("quota-badge").textContent = `配额: ${q.used}/${q.limit} (${q.pct}%)`;
  $("quota-badge").style.color = q.pct >= 90 ? "var(--red)" : q.pct >= 70 ? "var(--orange)" : "var(--text-2)";
  const gq = stats.githubQuota;
  if (gq?.search) $("quota-badge").title = `GitHub 搜索配额剩余 ${gq.search.remaining}/${gq.search.limit}（低于保护下限时自动刷新会跳过）`;
}

// ── 加载 ──
let webhookTypesLoaded = false;
async function loadWebhookTypes() {
  const sel = $("set-webhook-type");
  if (!sel || webhookTypesLoaded) return;
  try {
    const { types } = await fetchJson("/api/webhook-types");
    const labels = {
      generic: "通用 JSON", slack: "Slack", discord: "Discord", telegram: "Telegram",
      feishu: "飞书", dingtalk: "钉钉", ntfy: "ntfy", bark: "Bark", serverchan: "Server酱",
    };
    sel.innerHTML = (types || []).map((t) => `<option value="${t}">${escapeHtml(labels[t] || t)}</option>`).join("");
    webhookTypesLoaded = true;
  } catch { /* 保留下拉框现状 */ }
}

async function loadSettings() {
  try {
    await loadWebhookTypes();
    const s = await fetchJson("/api/settings");
    state.minStars = s.minStars;
    state.minGrowth = s.minGrowth;
    state.highlightThreshold = Number(s.alertThreshold) || 50;
    if ($("min-stars")) $("min-stars").value = s.minStars;
    if ($("min-growth")) $("min-growth").value = s.minGrowth;
    if ($("highlight")) $("highlight").value = s.alertThreshold || 50;
    if ($("set-min-stars")) $("set-min-stars").value = s.minStars;
    if ($("set-min-growth")) $("set-min-growth").value = s.minGrowth;
    if ($("set-retention")) $("set-retention").value = s.retentionDays || 90;
    if ($("set-alert-threshold")) $("set-alert-threshold").value = s.alertThreshold || 50;
    if ($("set-auto-poll")) $("set-auto-poll").value = s.autoPollMinutes || 0;
    if ($("set-theme")) $("set-theme").value = s.theme || "dark";
    if ($("set-search-query")) $("set-search-query").value = s.searchQuery || "";
    if ($("set-webhook-url")) $("set-webhook-url").value = s.webhookUrl || "";
    if ($("set-webhook-type")) $("set-webhook-type").value = s.webhookType || "generic";
    if ($("set-alert-drop")) $("set-alert-drop").checked = Boolean(s.alertOnDrop);
    if ($("set-drop-threshold")) $("set-drop-threshold").value = s.dropThreshold ?? 50;
    if ($("set-alert-milestone")) $("set-alert-milestone").checked = Boolean(s.alertOnMilestone);
    if ($("set-digest-enabled")) $("set-digest-enabled").checked = Boolean(s.digestEnabled);
    if ($("set-digest-time")) $("set-digest-time").value = s.digestTime || "09:00";
    if ($("set-auto-backup")) $("set-auto-backup").checked = s.autoBackup !== false;
    if ($("set-quota-floor")) $("set-quota-floor").value = s.quotaFloor ?? 3;
    if ($("set-ext-interval")) $("set-ext-interval").value = s.externalIntervalHours ?? 24;
    if ($("set-rollup-days")) $("set-rollup-days").value = s.rollupAfterDays ?? 30;
    refreshPushStatus();
    if (authStatus.user?.role === "admin") loadUsers();
    if ($("bt-threshold")) $("bt-threshold").value = s.alertThreshold ?? 50;
    if ($("bt-drop")) $("bt-drop").value = s.dropThreshold ?? 50;
    if ($("bt-ondrop")) $("bt-ondrop").checked = Boolean(s.alertOnDrop);
    if ($("bt-onmilestone")) $("bt-onmilestone").checked = Boolean(s.alertOnMilestone);
    if ($("set-api-key")) $("set-api-key").value = getApiKey();
    if ($("api-key-status")) $("api-key-status").textContent = s.authEnabled ? "（服务端已启用认证）" : "（服务端未启用认证）";
    if (s.theme) document.documentElement.setAttribute("data-theme", s.theme);
  } catch (e) { console.error("loadSettings:", e); }
}

async function loadRepos() {
  try {
    const qs = new URLSearchParams({
      minStars: state.minStars, minGrowth: state.minGrowth,
      language: state.language, sort: state.sort, window: state.window,
      page: state.page, pageSize: state.pageSize,
      todayOnly: state.todayOnly ? "1" : "0",
      keyword: state.keyword,
      onlyCustom: state.onlyCustom ? "1" : "0",
      onlyFavorite: state.onlyFavorite ? "1" : "0",
      metric: state.metric,
    });
    const data = await fetchJson(`/api/repos?${qs}`);
    languages = data.languages || [];
    allRepos = data.repos || [];
    state.totalPages = data.totalPages || 1;
    state.total = data.total || 0;
    state.page = data.page || 1;
    renderRepos();
  } catch (e) {
    if ($("list")) $("list").innerHTML = `<div class="empty"><p>加载失败: ${escapeHtml(e.message)}</p></div>`;
  }
}

async function loadStats() {
  try { renderStats(await fetchJson("/api/stats")); } catch (e) { console.error("loadStats:", e); }
}

async function loadAll() {
  await Promise.all([loadSettings(), loadRepos(), loadStats(), loadViews()]);
  loadAlerts();
  syncTodayBanner();
}

// ── 工具 ──
function populateLanguages() {
  const sel = $("language");
  if (!sel) return;
  sel.innerHTML = '<option value="">全部</option>' +
    languages.map((l) => `<option value="${escapeHtml(l.language)}">${escapeHtml(l.language)}（${l.c}）</option>`).join("");
  sel.value = state.language;
}

function sparkline(spark) {
  if (!spark || spark.length < 2) {
    return '<svg width="80" height="26" class="spark"><line x1="0" y1="13" x2="80" y2="13" stroke="currentColor" stroke-opacity="0.25"/></svg>';
  }
  const vals = spark.map((p) => p.stars);
  const min = Math.min(...vals), max = Math.max(...vals), range = max - min || 1;
  const w = 80, h = 26, pad = 3;
  const step = (w - pad * 2) / (vals.length - 1);
  const pts = vals.map((v, i) => [(pad + i * step).toFixed(1), ((h - pad * 2) * (1 - (v - min) / range) + pad).toFixed(1)]);
  return `<svg width="${w}" height="${h}" class="spark"><polyline points="${pts.map((p) => p.join(",")).join(" ")}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
}

// ── 图表（C3：多序列 / hover 光标 / 对数轴）──
const CHART_COLORS = ["#58a6ff", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#06b6d4", "#eab308", "#ec4899"];
let chartSeq = 0;
const chartRegistry = new Map();

const compactNum = (n) => (n == null ? "–"
  : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M"
  : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k"
  : String(Math.round(n)));

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
  let min = Math.min(...vals), max = Math.max(...vals);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return '<p class="muted">暂无数据</p>';
  if (min === max) { min -= 1; max += 1; }

  const padL = 50, padR = 14, padT = 14, padB = 28;
  const iw = width - padL - padR, ih = height - padT - padB;
  const x = (i) => (labels.length === 1 ? padL + iw / 2 : padL + (iw * i) / (labels.length - 1));
  const y = (v) => padT + ih * (1 - (tf(v) - tf(min)) / (tf(max) - tf(min)));
  const gridY = [0, 0.25, 0.5, 0.75, 1].map((t) => padT + ih * t);
  // 刻度值必须用与位置相同的变换反算，否则对数轴下标签与实际位置不符
  const tfMax = tf(max), tfMin = tf(min);
  const gridVals = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const v = logScale ? Math.pow(10, tfMax - t * (tfMax - tfMin)) : max - t * (max - min);
    return Math.abs(v) >= 10 ? Math.round(v) : Number(v.toFixed(2));
  });
  const xLabels = labels.length <= 8 ? labels.map((_, i) => i) : [0, Math.floor((labels.length - 1) / 2), labels.length - 1];

  const id = `chart-${++chartSeq}`;
  chartRegistry.set(id, { labels, series, padL, iw, padT, ih, width, height, y, x, yFormat, markers });

  const grid = gridY.map((gy) => `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${padL + iw}" y2="${gy.toFixed(1)}" class="grid"/>`).join("");
  const yTicks = gridY.map((gy, i) => `<text x="${padL - 6}" y="${(gy + 3).toFixed(1)}" text-anchor="end" class="axis">${escapeHtml(yFormat(gridVals[i]))}</text>`).join("");
  const xTicks = xLabels.map((i, k) => {
    const anchor = xLabels.length > 1 && k === 0 ? "start" : k === xLabels.length - 1 ? "end" : "middle";
    return `<text x="${x(i).toFixed(1)}" y="${height - 8}" text-anchor="${anchor}" class="axis">${escapeHtml(labels[i])}</text>`;
  }).join("");

  // 事件标注（里程碑 / 告警）
  const markerSvg = (markers || []).filter((m) => idx.has(m.x)).map((m) => {
    const mx = x(idx.get(m.x));
    const c = m.color || "#f59e0b";
    return `<line x1="${mx.toFixed(1)}" y1="${padT}" x2="${mx.toFixed(1)}" y2="${padT + ih}" stroke="${c}" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>`
      + (m.label ? `<text x="${(mx + 3).toFixed(1)}" y="${padT + 10}" class="axis" fill="${c}">${escapeHtml(m.label)}</text>` : "");
  }).join("");

  const lines = series.map((s, si) => {
    const color = s.color || CHART_COLORS[si % CHART_COLORS.length];
    const pts = s.points.filter((p) => idx.has(p.x)).map((p) => `${x(idx.get(p.x)).toFixed(1)},${y(p.y).toFixed(1)}`).join(" ");
    const dots = s.points.filter((p) => idx.has(p.x)).map((p) => {
      const cx = x(idx.get(p.x)).toFixed(1), cy = y(p.y).toFixed(1);
      return `<circle cx="${cx}" cy="${cy}" r="8" fill="transparent"><title>${escapeHtml(s.name)} · ${escapeHtml(p.x)}: ${escapeHtml(yFormat(p.y))}</title></circle>`
        + `<circle cx="${cx}" cy="${cy}" r="2.5" fill="${color}" pointer-events="none"/>`;
    }).join("");
    return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" pointer-events="none"/>${dots}`;
  }).join("");

  const legend = series.map((s, si) => `<span class="legend-item"><i style="background:${s.color || CHART_COLORS[si % CHART_COLORS.length]}"></i>${escapeHtml(s.name)}</span>`).join("");

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
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());   // 对齐到周日
  const days = Math.round((last - start) / 86400000) + 1;
  const weeks = Math.ceil(days / 7);
  const max = Math.max(...points.map((p) => p.y), 1);

  let cells = "";
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    const v = map.get(key);
    const wk = Math.floor(i / 7), dow = i % 7;
    const x = wk * (cell + gap), y = dow * (cell + gap);
    const opacity = v == null ? 0 : Math.max(0.15, Math.min(1, v / max));
    const fill = v == null ? "var(--surface-2)" : "#58a6ff";
    cells += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${fill}" fill-opacity="${opacity || 1}"><title>${key}: ${v == null ? "无数据" : "+" + fmt(v)}</title></rect>`;
  }
  const width = weeks * (cell + gap), height = 7 * (cell + gap);
  return `<div class="chart-wrap"><svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="max-width:100%;height:auto" role="img">${cells}</svg></div>`;
}

/** 简单柱状图（原生 title 提示） */
function barChart(points, { width = 680, height = 160, yFormat = fmt, color = "#58a6ff" } = {}) {
  if (!points.length) return '<p class="muted">暂无数据</p>';
  const padL = 48, padR = 12, padT = 12, padB = 26;
  const iw = width - padL - padR, ih = height - padT - padB;
  const max = Math.max(...points.map((p) => p.y), 1);
  const slot = iw / points.length;
  const bw = Math.max(1, slot - 2);
  const bars = points.map((p, i) => {
    const h = ih * (p.y / max);
    const bx = padL + slot * i + 1;
    const by = padT + ih - h;
    return `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" fill="${color}" rx="1"><title>${escapeHtml(p.x)}: ${escapeHtml(yFormat(p.y))}</title></rect>`;
  }).join("");
  const xLabels = points.length <= 8 ? points.map((_, i) => i) : [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const xTicks = xLabels.map((i, k) => {
    const anchor = xLabels.length > 1 && k === 0 ? "start" : k === xLabels.length - 1 ? "end" : "middle";
    return `<text x="${(padL + slot * i + bw / 2).toFixed(1)}" y="${height - 8}" text-anchor="${anchor}" class="axis">${escapeHtml(points[i].x)}</text>`;
  }).join("");
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
      cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.style.display = "";
      const rows = cfg.series.map((s, si) => {
        const p = s.points.find((q) => q.x === label);
        if (!p) return "";
        const color = s.color || CHART_COLORS[si % CHART_COLORS.length];
        return `<div class="tip-row"><i style="background:${color}"></i><span>${escapeHtml(s.name)}</span><b>${escapeHtml(cfg.yFormat(p.y))}</b></div>`;
      }).join("");
      const markRows = (cfg.markers || []).filter((m) => m.x === label)
        .map((m) => `<div class="tip-row tip-marker" style="color:${m.color || "#f59e0b"}">✦ <span>${escapeHtml(m.message || m.label || "")}</span></div>`).join("");
      tip.innerHTML = `<div class="tip-date">${escapeHtml(label)}</div>${rows}${markRows}`;
      tip.style.display = "";
      const leftPx = (cx / cfg.width) * rect.width;
      tip.style.left = `${Math.max(0, Math.min(rect.width - 150, leftPx + 12))}px`;
    });
    svg.addEventListener("mouseleave", () => { cross.style.display = "none"; tip.style.display = "none"; });
  });
}

function predictionBlock(pred, unitLabel = "星") {
  if (!pred) return '<p class="muted" style="font-size:12px">预测需要至少 3 天的快照数据。</p>';
  const rate = pred.perDay;
  const color = rate > 0 ? "var(--green)" : rate < 0 ? "var(--red)" : "var(--text-2)";
  // 预测可信度（R²）：数值越低说明星数变化越不像直线
  const conf = pred.r2 != null
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

// ── 仓库列表 ──
function growthCell(r) {
  const avg = r.avgDailyGrowth != null
    ? `<span class="avg">日均 ${r.avgDailyGrowth >= 0 ? "+" : ""}${r.avgDailyGrowth}</span>`
    : "";
  if (r.growth == null) return `<span class="growth muted">待积累${avg}</span>`;
  const cls = r.growth >= 50 ? "hot" : r.growth >= 10 ? "good" : "";
  return `<span class="growth ${cls}">+${fmt(r.growth)} <small>${escapeHtml(r.growthLabel)}</small>${avg}</span>`;
}

/** 当前指标的主数值与图标 */
function metricValueCell(r) {
  const noun = r.metricNoun || "★";
  if (r.metric === "stars" || !r.metric) return `★ ${fmt(r.stars)}`;
  return `${noun} ${fmt(r.metricValue)} <small class="muted">★${fmt(r.stars)}</small>`;
}
const isHot = (r) => r.growth !== null && r.growth >= state.highlightThreshold;

function renderRepos() {
  const el = $("list");
  let list = allRepos.slice();
  if (state.pinHot) list.sort((a, b) => (isHot(b) ? 1 : 0) - (isHot(a) ? 1 : 0));

  $("list-count").textContent = `${state.total} 个项目`;
  populateLanguages();

  if (state.total === 0) {
    el.innerHTML = '<div class="empty"><p>没有符合条件的项目</p><p class="muted">可降低筛选阈值，或点击「立即更新数据」。</p></div>';
    renderPagination();
    return;
  }

  const start = (state.page - 1) * state.pageSize;
  el.innerHTML = list.map((r, i) => `
    <div class="repo-row${isHot(r) ? " repo-hot" : ""}" data-id="${r.id}">
      <div class="rank">${start + i + 1}</div>
      <div class="repo-main">
        <a class="repo-name" href="${escapeHtml(r.url)}" target="_blank" rel="noopener" data-stop="1">
          ${escapeHtml(r.full_name)}${r.is_custom ? ' <span class="custom-badge">📌</span>' : ""}
        </a>
        <p class="repo-desc">${escapeHtml(r.description || "（无描述）")}</p>
        <div class="repo-meta">
          ${r.language ? `<span class="lang">${escapeHtml(r.language)}</span>` : ""}
          <span class="muted">收录 ${timeAgo(r.first_seen_at)}</span>
        </div>
      </div>
      <div class="repo-spark">${sparkline(r.spark)}</div>
      <div class="repo-star">${metricValueCell(r)}</div>
      <div class="repo-growth">${growthCell(r)}</div>
    </div>`).join("");

  el.querySelectorAll(".repo-row").forEach((row) => {
    row.addEventListener("click", () => openDetail(Number(row.dataset.id)));
  });
  renderPagination();
}

function renderPagination() {
  const el = $("pagination");
  const pages = state.totalPages;
  if (state.total === 0 || pages <= 1) { el.innerHTML = ""; return; }
  el.innerHTML = `
    <button class="btn btn-secondary" id="pg-prev" ${state.page <= 1 ? "disabled" : ""}>上一页</button>
    <span class="pg-info">第 ${state.page} / ${pages} 页（共 ${state.total} 个）</span>
    <button class="btn btn-secondary" id="pg-next" ${state.page >= pages ? "disabled" : ""}>下一页</button>`;
  $("pg-prev")?.addEventListener("click", () => { state.page--; loadRepos(); });
  $("pg-next")?.addEventListener("click", () => { state.page++; loadRepos(); });
}

// ── 详情 ──
async function openDetail(id) {
  try {
    const data = await fetchJson(`/api/repos/${id}/history?metric=${encodeURIComponent(state.metric || "stars")}`);
    const r = data.repo;
    const ratio = r.forks > 0 ? (r.stars / r.forks).toFixed(1) : "—";
    $("detail-body").innerHTML = `
      <div class="detail-head">
        <a class="repo-name" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.full_name)}</a>
        <span class="detail-stars">★ ${fmt(r.stars)}</span>
        <button id="fav-btn" class="btn btn-sm btn-secondary">☆ 收藏</button>
      </div>
      ${r.description ? `<p class="detail-desc">${escapeHtml(r.description)}</p>` : ""}
      <div class="metric-cards">
        <div class="metric-card"><div class="mc-val">${fmt(r.stars)}</div><div class="mc-label">⭐ 星标</div></div>
        <div class="metric-card"><div class="mc-val">${fmt(r.forks)}</div><div class="mc-label">🍴 复刻</div></div>
        <div class="metric-card"><div class="mc-val">${fmt(r.open_issues)}</div><div class="mc-label">❗ Issue</div></div>
        <div class="metric-card"><div class="mc-val">${ratio}</div><div class="mc-label">星/复刻比</div></div>
      </div>
      <div class="detail-meta">
        ${r.language ? `<span class="lang">${escapeHtml(r.language)}</span>` : ""}
        ${r.is_custom ? '<span class="custom-badge">📌 自定义追踪</span>' : ""}
        <span class="muted">收录 ${timeAgo(r.first_seen_at)}</span>
        ${r.gh_created_at ? `<span class="muted">始建于 ${escapeHtml(r.gh_created_at.slice(0, 10))}</span>` : ""}
        ${r.homepage ? `<a class="link" href="${escapeHtml(r.homepage)}" target="_blank" rel="noopener">主页</a>` : ""}
      </div>
      <div class="detail-chart">
        <div class="detail-chart-title">项目画像 <span class="muted" style="font-size:11px;font-weight:400">来自 GitHub</span></div>
        <div id="enrich-block"><p class="muted" style="font-size:12px">加载中…</p></div>
      </div>
      <div class="detail-chart">
        <div class="detail-chart-title">${escapeHtml(data.metricLabel || "星标")}历史</div>
        <div class="detail-actions" id="hist-controls">
          <button data-range="7" class="btn btn-sm btn-secondary">近 7 天</button>
          <button data-range="30" class="btn btn-sm btn-secondary">近 30 天</button>
          <button data-range="all" class="btn btn-sm btn-primary">全部</button>
          <label class="check-label" style="font-size:12px"><input type="checkbox" id="hist-log" /> 对数轴</label>
        </div>
        <div id="hist-chart"></div>
      </div>
      ${predictionBlock(data.prediction, data.metricLabel)}
      <div class="detail-chart">
        <div class="detail-chart-title">相似项目</div>
        <div id="similar-block"><p class="muted" style="font-size:12px">加载中…</p></div>
      </div>
      <div class="detail-chart">
        <div class="detail-chart-title">历史回填与告警</div>
        <div class="detail-actions">
          <button id="bf-btn" class="btn btn-sm btn-secondary">📜 回填历史</button>
          <label style="font-size:12px">告警阈值 <input id="repo-threshold" type="number" min="0" style="width:90px" placeholder="全局" /></label>
          <button id="repo-threshold-save" class="btn btn-sm btn-secondary">保存</button>
          <span id="repo-threshold-hint" class="muted" style="font-size:12px"></span>
        </div>
        <p class="muted" style="font-size:12px;margin-top:6px">回填用 GitHub stargazers 的 starred_at 重建历史曲线（近似值，无法感知取关）。</p>
      </div>
    `;
    $("detail-overlay").classList.remove("hidden");

    // C3: 历史图（范围切换 + 对数轴 + hover）
    let histRange = "all";
    const drawHistory = () => {
      const src = histRange === "all" ? data.history : data.history.slice(-Number(histRange));
      const pts = dailyPoints(src);
      if (pts.length < 2) { $("hist-chart").innerHTML = '<p class="muted">快照不足，继续积累后可查看趋势。</p>'; return; }
      $("hist-chart").innerHTML = lineChart({
        series: [{ name: data.metricLabel || "指标", color: "var(--accent)", points: pts }],
        logScale: $("hist-log").checked,
        markers: data.metric === "stars" ? (data.events || []).map((e) => ({
          x: String(e.date).slice(0, 10),
          label: e.type === "milestone" ? e.label : "",
          message: e.message,
          color: e.type === "milestone" ? "#f59e0b" : e.type === "drop" ? "var(--red)" : "var(--green)",
        })) : [],
      });
      bindCharts($("hist-chart"));
    };
    $("hist-controls").querySelectorAll("button[data-range]").forEach((b) => b.addEventListener("click", () => {
      histRange = b.dataset.range;
      $("hist-controls").querySelectorAll("button[data-range]").forEach((x) => x.className = `btn btn-sm ${x === b ? "btn-primary" : "btn-secondary"}`);
      drawHistory();
    }));
    $("hist-log").addEventListener("change", drawHistory);
    drawHistory();

    $("fav-btn").addEventListener("click", async () => {
      const res = await fetchJson(`/api/favorites/${r.id}/toggle`, { method: "POST" });
      $("fav-btn").textContent = res.added ? "★ 已收藏" : "☆ 收藏";
      $("fav-btn").className = `btn btn-sm ${res.added ? "btn-primary" : "btn-secondary"}`;
      loadStats();
      if (state.activeTab === "favorites") loadFavorites();
    });

    try {
      const a = await fetchJson(`/api/repos/${r.id}/alert`);
      $("repo-threshold").value = a.threshold ?? "";
      $("repo-threshold-hint").textContent = a.threshold == null ? `（当前用全局 ${a.global}）` : "";
    } catch { /* 忽略 */ }

    $("repo-threshold-save").addEventListener("click", async () => {
      const raw = $("repo-threshold").value.trim();
      try {
        const res = await fetchJson(`/api/repos/${r.id}/alert`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threshold: raw === "" ? null : Number(raw) }),
        });
        $("repo-threshold-hint").textContent = res.threshold == null ? "已恢复全局阈值" : `已设为 ${res.threshold}`;
      } catch (err) { showError(err.message); }
    });

    $("bf-btn").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = "回填中…";
      try {
        const res = await fetchJson(`/api/repos/${r.id}/backfill`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
        });
        btn.textContent = `已补 ${res.inserted} 个历史点`;
        loadStats();
      } catch (err) {
        btn.textContent = "📜 回填历史";
        showError(err.message);
      }
    });

    // C4: 相似项目
    try {
      const sim = await fetchJson(`/api/repos/${r.id}/similar?limit=6`);      $("similar-block").innerHTML = sim.similar.length
        ? sim.similar.map((x) => `<div class="similar-item" data-id="${x.id}">
            <span class="repo-name">${escapeHtml(x.full_name)}</span>
            <span class="lang">${escapeHtml(x.reason)}</span>
            <span class="muted">★ ${fmt(x.stars)}</span>
          </div>`).join("")
        : '<p class="muted" style="font-size:12px">暂无相似项目</p>';
      $("similar-block").querySelectorAll(".similar-item").forEach((el) =>
        el.addEventListener("click", () => openDetail(Number(el.dataset.id))));
    } catch { $("similar-block").innerHTML = ""; }

    // A4: 项目画像（topics / license / release / contributors）
    try {
      const e = await fetchJson(`/api/repos/${r.id}/enrich`);
      const chips = (e.topics || []).map((t) => `<span class="topic-chip">${escapeHtml(t)}</span>`).join("");
      const facts = [
        e.license ? `<span class="fact">📄 ${escapeHtml(e.license)}</span>` : "",
        e.contributors != null ? `<span class="fact">👥 ${fmt(e.contributors)} 贡献者</span>` : "",
        e.subscribers_count != null ? `<span class="fact">👁 ${fmt(e.subscribers_count)} 关注</span>` : "",
        e.network_count != null ? `<span class="fact">🍴 ${fmt(e.network_count)} 派生网络</span>` : "",
        e.pushed_at ? `<span class="fact">🕒 最后推送 ${timeAgo(e.pushed_at)}</span>` : "",
        e.archived ? '<span class="fact warn">⛔ 已归档</span>' : "",
        e.disabled ? '<span class="fact warn">⛔ 已禁用</span>' : "",
        e.is_fork ? '<span class="fact">⑂ Fork</span>' : "",
        e.default_branch ? `<span class="fact">🌿 ${escapeHtml(e.default_branch)}</span>` : "",
        e.size_kb != null ? `<span class="fact">💾 ${compactNum(e.size_kb)} KB</span>` : "",
      ].filter(Boolean).join("");
      const rel = e.latestRelease
        ? `<div class="release-line">🏷 最新版本 <a class="link" href="${escapeHtml(e.latestRelease.url)}" target="_blank" rel="noopener">${escapeHtml(e.latestRelease.name || e.latestRelease.tag)}</a>${e.latestRelease.published_at ? ` · ${timeAgo(e.latestRelease.published_at)}` : ""}${e.latestRelease.prerelease ? ' <span class="muted">(预发布)</span>' : ""}</div>`
        : '<div class="muted" style="font-size:12px">暂无 release</div>';
      $("enrich-block").innerHTML = `${chips ? `<div class="topic-row">${chips}</div>` : ""}<div class="fact-row">${facts}</div>${rel}`;
    } catch (err) {
      $("enrich-block").innerHTML = `<p class="muted" style="font-size:12px">获取失败：${escapeHtml(err.message)}</p>`;
    }
  } catch (e) { showError(e.message); }
}

function closeDetail() { $("detail-overlay").classList.add("hidden"); $("detail-body").innerHTML = ""; }

// ── 收藏（分页）──
async function loadFavorites() {
  try {
    const data = await fetchJson(`/api/favorites?page=${state.favPage}&pageSize=50`);
    const repos = data.repos || [];
    const el = $("fav-list");
    $("fav-count").textContent = `${data.total} 个收藏`;
    if (repos.length === 0) {
      el.innerHTML = '<div class="empty"><p>还没有收藏任何仓库</p><p class="muted">点击仓库行查看详情，在弹窗中点「☆ 收藏」</p></div>';
      $("fav-pagination").innerHTML = "";
      return;
    }
    el.innerHTML = repos.map((r) => `
      <div class="repo-row" data-id="${r.id}">
        <div class="rank">⭐</div>
        <div class="repo-main">
          <a class="repo-name" href="${escapeHtml(r.url)}" target="_blank" rel="noopener" data-stop="1">${escapeHtml(r.full_name)}</a>
          <p class="repo-desc">${escapeHtml(r.description || "（无描述）")}</p>
          <div class="repo-meta"><span class="muted">收藏于 ${timeAgo(r.added_at)}</span></div>
        </div>
        <div class="repo-star">★ ${fmt(r.stars)}</div>
        <button class="btn btn-sm btn-danger unfav-btn" data-id="${r.id}">移除</button>
      </div>`).join("");
    el.querySelectorAll(".unfav-btn").forEach((btn) => btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await fetchJson(`/api/favorites/${btn.dataset.id}/toggle`, { method: "POST" });
      loadFavorites(); loadStats();
    }));
    el.querySelectorAll(".repo-row").forEach((row) => row.addEventListener("click", () => openDetail(Number(row.dataset.id))));
    renderPager("fav-pagination", data, (p) => { state.favPage = p; loadFavorites(); });
  } catch (e) {
    $("fav-list").innerHTML = `<div class="empty"><p>加载失败: ${escapeHtml(e.message)}</p></div>`;
  }
}

// ── 自定义（分页）──
async function loadCustomRepos() {
  try {
    const data = await fetchJson(`/api/custom-repos?page=${state.customPage}&pageSize=50`);
    const repos = data.repos || [];
    const el = $("custom-list");
    if (repos.length === 0) {
      el.innerHTML = '<div class="empty"><p>还没有添加自定义仓库</p><p class="muted">点击右上角「+ 添加仓库」开始追踪</p></div>';
      $("custom-pagination").innerHTML = "";
      return;
    }
    el.innerHTML = repos.map((r) => `
      <div class="custom-item">
        <span class="ci-name">${escapeHtml(r.full_name)}</span>
        ${r.stale ? `<span class="ci-stale" title="${escapeHtml(r.last_error || "")}${r.stale_since ? " · 自 " + escapeHtml(String(r.stale_since).slice(0, 10)) : ""}">⚠️ 已失效</span>` : ""}
        ${r.user_note ? `<span class="ci-note">${escapeHtml(r.user_note)}</span>` : ""}
        <span class="ci-added">${timeAgo(r.added_at)}</span>
        <button class="btn btn-sm btn-danger del-custom" data-name="${escapeHtml(r.full_name)}">删除</button>
      </div>`).join("");
    el.querySelectorAll(".del-custom").forEach((btn) => btn.addEventListener("click", async () => {
      await fetchJson(`/api/custom-repos/${encodeURIComponent(btn.dataset.name)}`, { method: "DELETE" });
      loadCustomRepos();
    }));
    renderPager("custom-pagination", data, (p) => { state.customPage = p; loadCustomRepos(); });
  } catch (e) {
    $("custom-list").innerHTML = `<div class="empty"><p>加载失败: ${escapeHtml(e.message)}</p></div>`;
  }
}

function renderPager(elId, data, onPage) {
  const el = $(elId);
  if (!el) return;
  if (!data || data.totalPages <= 1) { el.innerHTML = ""; return; }
  el.innerHTML = `
    <button class="btn btn-secondary" id="${elId}-prev" ${data.page <= 1 ? "disabled" : ""}>上一页</button>
    <span class="pg-info">第 ${data.page} / ${data.totalPages} 页（共 ${data.total} 个）</span>
    <button class="btn btn-secondary" id="${elId}-next" ${data.page >= data.totalPages ? "disabled" : ""}>下一页</button>`;
  $(`${elId}-prev`)?.addEventListener("click", () => onPage(data.page - 1));
  $(`${elId}-next`)?.addEventListener("click", () => onPage(data.page + 1));
}

// ── 语言趋势 ──
async function loadLanguageTrends() {
  try {
    const win = $("trend-window")?.value || "day";
    const { trends } = await fetchJson(`/api/languages/trends?window=${win}`);
    const el = $("trend-list");
    if (trends.length === 0) { el.innerHTML = '<div class="empty"><p>暂无数据，先运行几次抓取</p></div>'; return; }
    const maxGrowth = Math.max(...trends.map((t) => Math.abs(t.totalGrowth)), 1);
    el.innerHTML = trends.map((t, i) => `
      <div class="trend-item">
        <span class="trend-rank">${i + 1}</span>
        <span class="trend-lang">${escapeHtml(t.language)}</span>
        <div class="trend-bar-wrap"><div class="trend-bar" style="width:${Math.min(100, Math.abs(t.totalGrowth) / maxGrowth * 100).toFixed(1)}%"></div></div>
        <div class="trend-stats">
          <div class="trend-growth">${t.totalGrowth >= 0 ? "+" : ""}${fmt(t.totalGrowth)}</div>
          <div class="trend-count">${t.count} 个仓库 · 总★ ${fmt(t.totalStars)}</div>
        </div>
      </div>`).join("");
  } catch (e) {
    $("trend-list").innerHTML = `<div class="empty"><p>加载失败: ${escapeHtml(e.message)}</p></div>`;
  }
}

// ── 排名变化（P1-5）──
function rankList(items, isUp) {
  if (items.length === 0) return '<div class="empty"><p>暂无排名变化</p></div>';
  return items.map((r) => `
    <div class="rank-item" data-id="${r.id}">
      <span class="rank-delta ${isUp ? "up" : "down"}">${isUp ? "↑" : "↓"}${Math.abs(r.delta)}</span>
      <div class="rank-main">
        <span class="repo-name">${escapeHtml(r.full_name)}</span>
        ${r.language ? `<span class="lang">${escapeHtml(r.language)}</span>` : ""}
      </div>
      <div class="rank-nums">
        <div class="rank-now">第 ${r.rank} 名 <small class="muted">(前 ${r.prevRank})</small></div>
        <div class="muted" style="font-size:11px">★ ${fmt(r.stars)} · ${r.growth >= 0 ? "+" : ""}${fmt(r.growth)}</div>
      </div>
    </div>`).join("");
}

async function loadRankChanges() {
  try {
    const win = $("rank-window")?.value || "day";
    const data = await fetchJson(`/api/trends/rank?window=${win}&limit=20`);
    $("rank-risers").innerHTML = rankList(data.risers || [], true);
    $("rank-fallers").innerHTML = rankList(data.fallers || [], false);
    document.querySelectorAll(".rank-item").forEach((el) => {
      el.addEventListener("click", () => openDetail(Number(el.dataset.id)));
    });
  } catch (e) {
    $("rank-risers").innerHTML = `<div class="empty"><p>加载失败: ${escapeHtml(e.message)}</p></div>`;
  }
}

// ── 🏆 排行榜 ──
function lbItem(r, rank, mode) {
  const right = mode === "stars"
    ? `<div class="lb-value">★ ${fmt(r.stars)}</div>
       <div class="lb-sub">${r.growth != null ? (r.growth >= 0 ? "+" : "") + fmt(r.growth) + " " + escapeHtml(r.growthLabel) : "待积累"}</div>`
    : `<div class="lb-value" style="color:${r.avgDailyGrowth >= 0 ? "var(--green)" : "var(--red)"}">${r.avgDailyGrowth >= 0 ? "+" : ""}${r.avgDailyGrowth} <small>星/天</small></div>
       <div class="lb-sub">★ ${fmt(r.stars)} 共</div>`;
  const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : rank;
  return `<div class="lb-item" data-id="${r.id}">
    <span class="lb-rank">${medal}</span>
    <div class="lb-main">
      <span class="repo-name">${escapeHtml(r.full_name)}</span>
      ${r.language ? `<span class="lang">${escapeHtml(r.language)}</span>` : ""}
    </div>
    <div class="lb-nums">${right}</div>
  </div>`;
}

async function loadLeaderboard() {
  try {
    const limit = $("lb-limit")?.value || 10;
    const win = $("lb-window")?.value || "day";
    const metric = $("lb-metric")?.value || "stars";
    const data = await fetchJson(`/api/leaderboard?limit=${limit}&window=${win}&metric=${metric}`);

    // 采样跨度提示（避免把几分钟的数据外推成“每天”）
    const notice = $("lb-notice");
    const d = data.sampleDays || 0;
    if (d < 1) {
      notice.className = "lb-notice warn";
      notice.innerHTML = `⚠️ 当前快照采样仅 <b>${(d * 24).toFixed(1)} 小时</b>，日均增长为初步估算。建议积累 <b>7 天</b> 以上数据后参考。`;
    } else if (d < 7) {
      notice.className = "lb-notice";
      notice.innerHTML = `ℹ️ 快照采样跨度 <b>${d.toFixed(1)} 天</b>，日均增长已具参考性（满 7 天更准）。`;
    } else {
      notice.className = "lb-notice ok";
      notice.innerHTML = `✅ 快照采样跨度 <b>${d.toFixed(1)} 天</b>，日均增长基于近 7 天数据计算。`;
    }

    const starsEl = $("lb-by-stars");
    const growthEl = $("lb-by-growth");
    starsEl.innerHTML = (data.byStars || []).map((r, i) => lbItem(r, i + 1, "stars")).join("") || '<div class="empty"><p>暂无数据</p></div>';
    growthEl.innerHTML = (data.byGrowth || []).map((r, i) => lbItem(r, i + 1, "growth")).join("") || '<div class="empty"><p>尚无足够的增长数据（需至少 2 条快照）</p></div>';

    document.querySelectorAll(".lb-item").forEach((el) => {
      el.addEventListener("click", () => openDetail(Number(el.dataset.id)));
    });
  } catch (e) {
    $("lb-by-stars").innerHTML = `<div class="empty"><p>加载失败: ${escapeHtml(e.message)}</p></div>`;
    $("lb-by-growth").innerHTML = "";
  }
}

// ── 🚀 爆发榜（P0-1）──
function surgeItem(r, i) {
  const ratio = r.surgeRatio == null ? "∞" : `${r.surgeRatio}×`;
  const medal = i === 1 ? "🥇" : i === 2 ? "🥈" : i === 3 ? "🥉" : i;
  const accelColor = r.accel > 0 ? "var(--green)" : r.accel < 0 ? "var(--red)" : "var(--text-2)";
  return `<div class="lb-item" data-id="${r.id}">
    <span class="lb-rank">${medal}</span>
    <div class="lb-main">
      <span class="repo-name">${escapeHtml(r.full_name)}</span>
      ${r.language ? `<span class="lang">${escapeHtml(r.language)}</span>` : ""}
    </div>
    <div class="lb-nums">
      <div class="lb-value" style="color:${accelColor}">${r.accel >= 0 ? "+" : ""}${r.accel} <small>星/天²</small></div>
      <div class="lb-sub">近日均 ${r.recentAvg} · 前期均 ${r.priorAvg} · ${ratio}</div>
    </div>
  </div>`;
}

async function loadSurges() {
  try {
    const limit = $("surge-limit")?.value || 10;
    const minStars = Number($("surge-min-stars")?.value) || 0;
    const metric = $("surge-metric")?.value || "stars";
    const data = await fetchJson(`/api/trends/surge?limit=${limit}&minStars=${minStars}&decaying=1&metric=${metric}`);
    const rising = data.surges || [];
    const decaying = data.decaying || [];

    const notice = $("surge-notice");
    notice.className = "lb-notice warn";
    notice.innerHTML = `ℹ️ 爆发检测对比「近 3 天日均」与「更早的日均」。需至少 <b>3 天</b>快照数据才有效；当前累计快照天数不足时列表为空。`;

    $("surge-rising").innerHTML = rising.length
      ? rising.map((r, i) => surgeItem(r, i + 1)).join("")
      : '<div class="empty"><p>暂无爆发项目</p><p class="muted">需至少 3 天快照数据</p></div>';
    $("surge-decaying").innerHTML = decaying.length
      ? decaying.map((r, i) => surgeItem(r, i + 1)).join("")
      : '<div class="empty"><p>暂无衰减项目</p></div>';

    document.querySelectorAll("#surge-rising .lb-item, #surge-decaying .lb-item").forEach((el) => {
      el.addEventListener("click", () => openDetail(Number(el.dataset.id)));
    });
  } catch (e) {
    $("surge-rising").innerHTML = `<div class="empty"><p>加载失败: ${escapeHtml(e.message)}</p></div>`;
  }
}

// ── ⏪ 历史回放（P0-2）──
function toLocalInput(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}

function initReplayDefault() {
  const el = $("replay-at");
  if (el && !el.value) el.value = toLocalInput(new Date(Date.now() - 3600000));
}

/** 根据选中的数据源更新输入框提示 */
function updateMetricPlaceholder() {
  const key = $("metric-source")?.value;
  const src = SOURCES.find((s) => s.key === key);
  const input = $("metric-key");
  if (input) input.placeholder = src ? src.placeholder : "请输入名称";
}

async function runReplay() {
  const atLocal = $("replay-at")?.value;
  if (!atLocal) return showError("请选择回放时刻");
  const at = new Date(atLocal).toISOString();
  const window = $("replay-window")?.value || "day";
  const sort = $("replay-sort")?.value || "stars";
  const statusEl = $("replay-status");
  statusEl.textContent = "加载中…";
  try {
    const d = await fetchJson(`/api/replay?at=${encodeURIComponent(at)}&window=${window}&sort=${sort}&limit=50`);
    statusEl.textContent = `当时共 ${d.total} 个仓库`;
    $("replay-result").innerHTML = (d.repos || []).map((r) => `
      <div class="repo-row" data-id="${r.id}">
        <div class="rank">${r.rank}</div>
        <div class="repo-main">
          <a class="repo-name" href="${escapeHtml(r.url)}" target="_blank" rel="noopener" data-stop="1">${escapeHtml(r.full_name)}</a>
          <p class="repo-desc">${escapeHtml(r.description || "（无描述）")}</p>
          <div class="repo-meta">${r.language ? `<span class="lang">${escapeHtml(r.language)}</span>` : ""}<span class="muted">${escapeHtml(d.at.slice(0, 16).replace("T", " "))}</span></div>
        </div>
        <div class="repo-star">★ ${fmt(r.stars)}</div>
        <div class="repo-growth">
          ${r.growth != null ? `<span class="growth">${r.growth >= 0 ? "+" : ""}${fmt(r.growth)} <small>${escapeHtml(r.growthLabel)}</small></span>` : '<span class="growth muted">—</span>'}
          <span class="avg">至今 ${r.sinceThen >= 0 ? "+" : ""}${fmt(r.sinceThen)}</span>
        </div>
      </div>`).join("") || '<div class="empty"><p>该时刻无数据</p></div>';
    document.querySelectorAll("#replay-result .repo-row").forEach((row) => {
      row.addEventListener("click", () => openDetail(Number(row.dataset.id)));
    });
  } catch (e) {
    statusEl.textContent = "";
    $("replay-result").innerHTML = `<div class="empty"><p>${escapeHtml(e.message)}</p></div>`;
  }
}

// ── 📦 外部指标（P3）──
let SOURCES = [];

function extItem(r, i) {
  const growthTxt = r.growth == null
    ? '<span class="muted">待积累</span>'
    : `<span style="color:${r.growth >= 0 ? "var(--green)" : "var(--red)"}">${r.growth >= 0 ? "+" : ""}${fmt(r.growth)}</span> <small class="muted">${escapeHtml(r.growthLabel)}</small>`;
  const avg = r.avgDailyGrowth != null ? `<span class="avg">日均 ${r.avgDailyGrowth >= 0 ? "+" : ""}${r.avgDailyGrowth}</span>` : "";
  return `<div class="ext-item">
    <span class="ext-rank">${i}</span>
    <div class="ext-main">
      <a class="repo-name" href="${escapeHtml(r.url || "#")}" target="_blank" rel="noopener">${escapeHtml(r.label || r.key)}</a>
      <span class="lang">${escapeHtml(r.source)}</span>
      <div class="repo-meta"><span class="muted">${r.snapshots} 条快照 · ${timeAgo(r.updatedAt)}</span></div>
    </div>
    <div class="ext-value">${fmt(r.value)} <small class="muted">${escapeHtml(r.unit || "")}</small></div>
    <div class="ext-growth">${growthTxt}${avg}</div>
    <button class="btn btn-sm btn-danger ext-del" data-id="${r.id}">删除</button>
  </div>`;
}

async function loadExternalMetrics() {
  try {
    if (!SOURCES.length) {
      const s = await fetchJson("/api/sources");
      SOURCES = s.sources || [];
      const sel = $("metric-source");
      if (sel) sel.innerHTML = SOURCES.map((x) => `<option value="${x.key}">${escapeHtml(x.label)}</option>`).join("");
    }
    const win = $("ext-window")?.value || "day";
    const { metrics } = await fetchJson(`/api/metrics?window=${win}`);
    const el = $("ext-list");
    if (!metrics.length) {
      el.innerHTML = '<div class="empty"><p>还没有追踪任何外部指标</p><p class="muted">点击右上角「+ 添加指标」，例如 npm 的 react</p></div>';
      return;
    }
    el.innerHTML = metrics.map((r, i) => extItem(r, i + 1)).join("");
    el.querySelectorAll(".ext-del").forEach((btn) => btn.addEventListener("click", async () => {
      await fetchJson(`/api/metrics/${btn.dataset.id}`, { method: "DELETE" });
      loadExternalMetrics(); loadStats();
    }));
  } catch (e) {
    $("ext-list").innerHTML = `<div class="empty"><p>加载失败: ${escapeHtml(e.message)}</p></div>`;
  }
}

// ── 告警 ──
async function loadAlerts() {
  try {
    const { unread, recent } = await fetchJson("/api/alerts");
    const badge = $("alert-badge");
    if (unread > 0) { badge.classList.remove("hidden"); $("alert-count").textContent = unread; }
    else badge.classList.add("hidden");

    const el = $("alerts-preview");
    if (el) {
      el.innerHTML = recent.length === 0
        ? '<p class="muted">暂无告警。当仓库 24h 内新增星数达到阈值时会在此显示。</p>'
        : recent.map((a) => {
          // 掉星告警的 growth 是负数，不能无条件加 "+"（会显示成 "+-500"）；
          // 颜色也要跟着走，否则掉星和涨星长得一模一样。
          const down = a.growth < 0;
          const sign = down ? "" : "+";
          return `
          <div class="alert-item ${a.read ? "" : "unread"}">
            <span class="ai-name">${escapeHtml(a.full_name)}</span>
            <span class="ai-growth${down ? " down" : ""}">${sign}${fmt(a.growth)} 星</span>
            <span class="ai-time">${timeAgo(a.triggered_at)}</span>
          </div>`;
        }).join("");
    }
  } catch (e) { console.error("loadAlerts:", e); }
}

// ── 今日榜 / 导出 ──
function syncTodayBanner() {
  $("today")?.classList.toggle("active", state.todayOnly);
  const banner = $("today-banner");
  if (!banner) return;
  if (state.todayOnly) {
    banner.textContent = `🔥 今日新增榜：仅显示今日获星的项目（增速 > 0），共 ${state.total} 个`;
    banner.classList.remove("hidden");
  } else banner.classList.add("hidden");
}

async function toggleToday() {
  state.todayOnly = !state.todayOnly;
  state.page = 1;
  if (state.todayOnly) { state.window = "day"; state.sort = "growth"; $("window").value = "day"; $("sort").value = "growth"; }
  await loadRepos();
  syncTodayBanner();
}

function exportCsv() {
  if (allRepos.length === 0) return setStatus("没有可导出的数据", "warn");
  const header = ["排名", "仓库", "链接", "星数", "增速", "窗口", "语言", "描述", "收录时间"];
  const rows = allRepos.map((r, i) => [
    (state.page - 1) * state.pageSize + i + 1, r.full_name, r.url || "", r.stars ?? "",
    r.growth ?? "", r.growthLabel || "", r.language || "",
    (r.description || "").replace(/\s+/g, " "), r.first_seen_at || "",
  ]);
  const csv = "\uFEFF" + [header, ...rows].map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  a.download = `github-stars-${state.window}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus(`已导出当前页 ${allRepos.length} 行 CSV`, "ok");
}

function setStatus(text, kind) {
  const el = $("status");
  if (!el) return;
  el.textContent = text;
  el.className = "status " + (kind || "");
}
function showError(msg) {
  const el = $("error");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 6000);
}

// ── ⚖️ 仓库对比（C1）──
let cmpSelection = [];
let cmpIndex = new Map();
let cmpReady = false;

async function initCompare() {
  if (!cmpReady) {
    try {
      const d = await fetchJson("/api/repos?sort=stars&minStars=0&pageSize=200&page=1");
      const opts = d.repos || [];
      cmpIndex = new Map(opts.map((r) => [r.full_name, { id: r.id, full_name: r.full_name }]));
      $("cmp-options").innerHTML = opts.map((r) => `<option value="${escapeHtml(r.full_name)}"></option>`).join("");
      cmpReady = true;
    } catch (e) { console.error("initCompare:", e); }
  }
  renderCompareChips();
  if (cmpSelection.length >= 2) loadCompare(); else renderCompareEmpty();
}

function renderCompareChips() {
  const el = $("cmp-chips");
  el.innerHTML = cmpSelection.map((s) => `<span class="chip">${escapeHtml(s.full_name)}<button class="chip-x" data-id="${s.id}" aria-label="移除">×</button></span>`).join("");
  el.querySelectorAll(".chip-x").forEach((b) => b.addEventListener("click", () => {
    cmpSelection = cmpSelection.filter((x) => x.id !== Number(b.dataset.id));
    renderCompareChips();
    cmpSelection.length >= 2 ? loadCompare() : renderCompareEmpty();
  }));
}

function renderCompareEmpty() {
  $("cmp-chart").innerHTML = '<p class="muted">请至少添加 2 个仓库开始对比。</p>';
  $("cmp-table").innerHTML = "";
}

function addCompareRepo(name) {
  const key = String(name || "").trim();
  if (!key) return;
  const hit = cmpIndex.get(key);
  if (!hit) return showError(`未在候选列表中找到：${key}`);
  if (cmpSelection.some((s) => s.id === hit.id)) return;
  if (cmpSelection.length >= 8) return showError("最多同时对比 8 个仓库");
  cmpSelection.push(hit);
  $("cmp-input").value = "";
  renderCompareChips();
  cmpSelection.length >= 2 ? loadCompare() : renderCompareEmpty();
}

async function loadCompare() {
  if (cmpSelection.length < 2) return renderCompareEmpty();
  const ids = cmpSelection.map((s) => s.id).join(",");
  const qs = new URLSearchParams({ ids, window: $("cmp-window").value, metric: $("cmp-metric").value });
  try {
    const d = await fetchJson(`/api/compare?${qs}`);
    const usePct = $("cmp-pct").checked;
    const series = d.repos.map((r, i) => ({
      name: r.full_name,
      color: CHART_COLORS[i % CHART_COLORS.length],
      points: r.series.map((p) => ({ x: p.t, y: usePct ? p.pct : p.value })),
    }));
    $("cmp-chart").innerHTML = lineChart({
      series,
      logScale: !usePct && $("cmp-log").checked,
      yFormat: (v) => (usePct ? `${v}%` : fmt(v)),
    });
    bindCharts($("cmp-chart"));

    $("cmp-table").innerHTML = `<table class="data-table"><thead><tr>
        <th>仓库</th><th>语言</th><th>当前</th><th>区间变化</th><th>变化率</th><th>快照</th>
      </tr></thead><tbody>` +
      d.repos.map((r, i) => {
        const up = (r.change ?? 0) >= 0;
        const upPct = (r.changePct ?? 0) >= 0;
        return `<tr data-id="${r.id}">
          <td><i class="dot" style="background:${CHART_COLORS[i % CHART_COLORS.length]}"></i>${escapeHtml(r.full_name)}</td>
          <td>${r.language ? `<span class="lang">${escapeHtml(r.language)}</span>` : "—"}</td>
          <td>${fmt(r.current)}</td>
          <td class="${up ? "up" : "down"}">${r.change == null ? "—" : (up ? "+" : "") + fmt(r.change)}</td>
          <td class="${upPct ? "up" : "down"}">${r.changePct == null ? "—" : (upPct ? "+" : "") + r.changePct + "%"}</td>
          <td>${r.snapshots}</td>
        </tr>`;
      }).join("") + `</tbody></table>`;
    $("cmp-table").querySelectorAll("tr[data-id]").forEach((tr) =>
      tr.addEventListener("click", () => openDetail(Number(tr.dataset.id))));

    // 交叉预测
    const cross = d.crossings || [];
    $("cmp-crossings").innerHTML = cross.length
      ? `<h3 class="chart-title" style="margin-top:18px">交叉预测</h3><div class="cross-list">` +
        cross.map((c) => `<div class="cross-item">
          <b>${escapeHtml(c.from)}</b> 预计约 <b>${c.days}</b> 天后超过 <b>${escapeHtml(c.to)}</b>
          <span class="muted">（${escapeHtml(c.eta)} · 置信度 ${Math.round((c.confidence || 0) * 100)}%）</span>
        </div>`).join("") + `</div>`
      : "";
  } catch (e) {
    $("cmp-chart").innerHTML = `<p class="muted">加载失败：${escapeHtml(e.message)}</p>`;
  }
}

// ── 📉 全局趋势（C2）──
async function loadOverview() {
  const days = $("ov-days")?.value || 60;
  try {
    const d = await fetchJson(`/api/overview?days=${days}`);
    const h = d.health;
    $("ov-health").innerHTML = `
      <div class="stat"><div class="stat-value">${fmt(d.totals.repoCount)}</div><div class="stat-label">收录项目</div></div>
      <div class="stat"><div class="stat-value">${h.coveragePct}%</div><div class="stat-label">有增长数据</div></div>
      <div class="stat"><div class="stat-value">${h.avgSnapshots}</div><div class="stat-label">平均快照/仓库</div></div>
      <div class="stat"><div class="stat-value">${fmt(d.totals.snapCount)}</div><div class="stat-label">总快照</div></div>
      <div class="stat"><div class="stat-value">${timeAgo(h.lastRefresh)}</div><div class="stat-label">最后更新</div></div>
      <div class="stat"><div class="stat-value" style="color:${h.staleCount > 0 ? "var(--orange)" : "inherit"}">${h.staleCount || 0}</div><div class="stat-label">失效/已删除</div></div>`;

    $("ov-stars").innerHTML = d.totalStars.length >= 2
      ? lineChart({ series: [{ name: "总星数", color: "#58a6ff", points: d.totalStars.map((p) => ({ x: p.date, y: p.totalStars })) }], yFormat: compactNum })
      : '<p class="muted">数据不足</p>';
    bindCharts($("ov-stars"));

    $("ov-activity").innerHTML = barChart(d.snapshotActivity.map((p) => ({ x: p.date, y: p.count })), { color: "#22c55e" });
    $("ov-discoveries").innerHTML = barChart(d.discoveries.map((p) => ({ x: p.date, y: p.count })), { color: "#f59e0b" });

    // 每日新增星数热力图（由总星数曲线求差）
    const heat = [];
    for (let i = 1; i < d.totalStars.length; i++) {
      heat.push({ x: d.totalStars[i].date, y: Math.max(0, d.totalStars[i].totalStars - d.totalStars[i - 1].totalStars) });
    }
    $("ov-heatmap").innerHTML = calendarHeatmap(heat);

    const maxCount = Math.max(...d.languages.map((l) => l.c), 1);
    $("ov-languages").innerHTML = d.languages.length
      ? d.languages.map((l) => `<div class="lang-row">
          <span class="lang-name">${escapeHtml(l.language)}</span>
          <div class="lang-track"><div class="lang-fill" style="width:${(l.c / maxCount * 100).toFixed(1)}%"></div></div>
          <span class="muted">${l.c}</span>
        </div>`).join("")
      : '<p class="muted">暂无数据</p>';
  } catch (e) {
    $("ov-stars").innerHTML = `<p class="muted">加载失败：${escapeHtml(e.message)}</p>`;
  }
}

// ── 🔎 信号（异常检测 + 黑马榜）──
async function loadSignals() {
  const an = $("an-days"), az = $("an-z"), am = $("an-min"), ams = $("an-min-stars");
  const rmax = $("rs-max"), rmin = $("rs-min"), rdays = $("rs-days");
  try {
    const rmaxVal = (rmax.value || "").trim();
    const rmaxQ = rmaxVal === "" ? "" : `&maxStars=${rmaxVal}`;
    const [anomaly, rising, events] = await Promise.all([
      fetchJson(`/api/trends/anomaly?days=${an.value}&z=${az.value}&minSamples=${am.value}&minStars=${ams.value}&limit=10`),
      fetchJson(`/api/trends/rising?minStars=${rmin.value}&minDays=${rdays.value}&limit=15${rmaxQ}`),
      fetchJson(`/api/trends/events?days=${$("ev-days").value}&z=${$("ev-z").value}&minRepos=${$("ev-min-repos").value}&minSamples=${$("ev-min").value}&limit=10`),
    ]);

    const sigItem = (r, up) => `<div class="lb-item" data-id="${r.id}">
      <span class="lb-rank">${up ? "📈" : "📉"}</span>
      <div class="lb-main">
        <span class="repo-name">${escapeHtml(r.full_name)}</span>
        ${r.language ? `<span class="lang">${escapeHtml(r.language)}</span>` : ""}
        <div class="lb-sub">样本 ${r.samples} 天 · 均值 ${r.mean} · σ ${r.sd}</div>
      </div>
      <div class="lb-nums">
        <div class="lb-value" style="color:${up ? "var(--green)" : "var(--red)"}">${r.z >= 0 ? "+" : ""}${r.z}σ</div>
        <div class="lb-sub">当日 ${r.delta >= 0 ? "+" : ""}${fmt(r.delta)} · ★${fmt(r.stars)}</div>
      </div>
    </div>`;

    $("an-spikes").innerHTML = anomaly.spikes.length
      ? anomaly.spikes.map((r) => sigItem(r, true)).join("")
      : '<div class="empty"><p>暂无突增项目</p></div>';
    $("an-drops").innerHTML = anomaly.drops.length
      ? anomaly.drops.map((r) => sigItem(r, false)).join("")
      : '<div class="empty"><p>暂无骤降项目</p></div>';

    const notice = $("an-notice");
    notice.className = "lb-notice warn";
    notice.innerHTML = `ℹ️ z-score 衡量的是「相对该仓库自身历史」的偏离，而不是绝对增量。需至少 <b>${anomaly.minSamples + 1}</b> 天日增数据；样本越少越易误报，请结合「样本数 / σ」判断。`;

    document.querySelectorAll("#an-spikes .lb-item, #an-drops .lb-item").forEach((el) =>
      el.addEventListener("click", () => openDetail(Number(el.dataset.id))));

    $("rs-notice").className = "lb-notice";
    $("rs-notice").innerHTML = `ℹ️ 星数上限为 <b>${fmt(rising.maxStars)}</b>（留空时自动取追踪集星数中位数）· 仅纳入 ≥${rising.minDays} 天前创建的项目 · 按「日增百分比」排序。`;
    $("rs-list").innerHTML = rising.rising.length
      ? rising.rising.map((r, i) => `<div class="lb-item" data-id="${r.id}">
          <span class="lb-rank">${i + 1}</span>
          <div class="lb-main">
            <span class="repo-name">${escapeHtml(r.full_name)}</span>
            ${r.language ? `<span class="lang">${escapeHtml(r.language)}</span>` : ""}
            <div class="lb-sub">★${fmt(r.stars)} · ${r.ageDays != null ? r.ageDays + " 天前创建" : "年龄未知"} · 样本 ${r.sampleDays} 天</div>
          </div>
          <div class="lb-nums">
            <div class="lb-value" style="color:var(--green)">+${r.pctPerDay}%/天</div>
            <div class="lb-sub">日均 +${r.avgDailyGrowth} 星</div>
          </div>
        </div>`).join("")
      : '<div class="empty"><p>暂无符合条件的数据</p></div>';
    document.querySelectorAll("#rs-list .lb-item").forEach((el) =>
      el.addEventListener("click", () => openDetail(Number(el.dataset.id))));

    // 🌊 事件聚类
    $("ev-notice").innerHTML = `ℹ️ 同时将「同一天多个仓库 z 异常」归为一波趋势，用语言/描述共同词自动命名。需至少 <b>${events.minSamples + 1}</b> 天日增数据。`;
    $("ev-list").innerHTML = events.events.length
      ? events.events.map((e) => `
          <div class="event-card">
            <div class="event-head">
              <span class="event-date">📅 ${escapeHtml(e.date)}</span>
              <span class="event-meta"><b>${e.count}</b> 个仓库 · 合计 <b>+${fmt(e.totalDelta)}</b> 星 · 平均 z ${e.avgZ}${e.dominantLanguage ? ` · ${escapeHtml(e.dominantLanguage)}` : ""}</span>
            </div>
            ${e.terms.length ? `<div class="event-terms">${e.terms.map((t) => `<span class="topic-chip">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
            <div class="event-repos">${e.repos.map((r) => `<span class="event-repo" data-id="${r.id}">${escapeHtml(r.full_name)} <small>+${fmt(r.delta)}</small></span>`).join("")}</div>
          </div>`).join("")
      : '<div class="empty"><p>暂无聚类型事件</p><p class="muted">可降低 z 阈值或最少仓库数</p></div>';
    document.querySelectorAll("#ev-list .event-repo").forEach((el) =>
      el.addEventListener("click", () => openDetail(Number(el.dataset.id))));
  } catch (e) {
    $("an-spikes").innerHTML = `<div class="empty"><p>加载失败：${escapeHtml(e.message)}</p></div>`;
    $("an-drops").innerHTML = "";
    $("rs-list").innerHTML = "";
    $("ev-list").innerHTML = "";
  }
}

/** 🧪 告警规则回测 */
async function runBacktest() {
  const btn = $("bt-run");
  btn.disabled = true;
  try {
    const qs = new URLSearchParams({
      days: $("bt-days").value,
      threshold: $("bt-threshold").value,
      dropThreshold: $("bt-drop").value,
      onDrop: $("bt-ondrop").checked ? "1" : "0",
      onMilestone: $("bt-onmilestone").checked ? "1" : "0",
      minStars: $("bt-minstars").value,
      limit: 40,
    });
    const d = await fetchJson(`/api/alerts/backtest?${qs}`);
    const s = d.summary;
    $("bt-summary").innerHTML = `
      <div class="stat"><div class="stat-value">${fmt(s.total)}</div><div class="stat-label">预计触发次数</div></div>
      <div class="stat"><div class="stat-value">${fmt(s.repos)}</div><div class="stat-label">涉及仓库</div></div>
      <div class="stat"><div class="stat-value">${fmt(s.byKind.growth)}</div><div class="stat-label">增长告警</div></div>
      <div class="stat"><div class="stat-value">${fmt(s.byKind.drop)}</div><div class="stat-label">掉星告警</div></div>
      <div class="stat"><div class="stat-value">${fmt(s.byKind.milestone)}</div><div class="stat-label">里程碑</div></div>
      <div class="stat"><div class="stat-value">${s.avgSampleDays}</div><div class="stat-label">平均样本天数</div></div>`;

    const perDay = d.days ? (s.total / d.days).toFixed(1) : 0;
    $("bt-notice").className = s.total > d.days * 2 ? "lb-notice warn" : "lb-notice ok";
    $("bt-notice").innerHTML = `ℹ️ 过去 <b>${d.days}</b> 天评估了 <b>${s.evaluatedRepos}</b> 个仓库（平均 ${s.avgSampleDays} 天样本）。预计 <b>${s.total}</b> 次触发，约 <b>${perDay} 次/天</b>。${s.total > d.days * 2 ? "阈值偏低，建议调高。" : "频率合理。"}回测与生产共用同一套规则（权限覆盖/里程碑/掉星）。`;

    $("bt-repos").innerHTML = d.topRepos.length
      ? d.topRepos.map((r, i) => `<div class="lb-item"><span class="lb-rank">${i + 1}</span><div class="lb-main"><span class="repo-name">${escapeHtml(r.full_name)}</span></div><div class="lb-nums"><div class="lb-value">${r.count} 次</div></div></div>`).join("")
      : '<div class="empty"><p>无触发</p></div>';

    $("bt-fires").innerHTML = d.fired.length
      ? d.fired.slice(0, 20).map((f) => `<div class="lb-item" data-id="${f.id}"><span class="lb-rank">${f.kind === "growth" ? "📈" : f.kind === "drop" ? "📉" : "🏁"}</span><div class="lb-main"><span class="repo-name">${escapeHtml(f.full_name)}</span><div class="lb-sub">${escapeHtml(f.date)} · ${escapeHtml(f.kind)}</div></div><div class="lb-nums"><div class="lb-value" style="color:${f.growth >= 0 ? "var(--green)" : "var(--red)"}">${f.growth >= 0 ? "+" : ""}${fmt(f.growth)}</div></div></div>`).join("")
      : '<div class="empty"><p>无触发</p></div>';
    document.querySelectorAll("#bt-fires .lb-item[data-id]").forEach((el) =>
      el.addEventListener("click", () => openDetail(Number(el.dataset.id))));
  } catch (e) {
    $("bt-notice").className = "lb-notice warn";
    $("bt-notice").textContent = "回测失败：" + e.message;
  } finally {
    btn.disabled = false;
  }
}

// ── 🧭 指数与生态（P4）──
let indicesCache = [];
let queriesCache = [];
let currentIndexId = null;
let currentQueryId = null;

async function initIndices() {
  await Promise.all([loadIndices(), loadQueries()]);
}

function aggregateChart(containerId, data) {
  const points = data.dates.map((d, i) => ({ x: d, y: data.index[i] })).filter((p) => p.y != null);
  if (points.length < 2) {
    $(containerId).innerHTML = '<p class="muted">数据不足（至少需要 2 天快照）</p>';
    return;
  }
  $(containerId).innerHTML = lineChart({
    series: [{ name: `指数（${data.weight === "cap" ? "星数加权" : "等权"}）`, color: "var(--accent)", points }],
    yFormat: (v) => Number(v).toFixed(1),
  });
  bindCharts($(containerId));
}

function membersTable(data) {
  if (!data.members.length) return '<div class="empty"><p>暂无成员</p></div>';
  return `<table class="data-table"><thead><tr><th>成员</th><th>语言</th><th>当前</th><th>区间变化</th><th>占比</th></tr></thead><tbody>` +
    data.members.slice(0, 40).map((m) => {
      const up = (m.changePct ?? 0) >= 0;
      return `<tr data-id="${m.id}">
        <td>${escapeHtml(m.full_name)}</td>
        <td>${m.language ? `<span class="lang">${escapeHtml(m.language)}</span>` : "—"}</td>
        <td>${fmt(m.current)}</td>
        <td class="${up ? "up" : "down"}">${m.changePct == null ? "—" : (up ? "+" : "") + m.changePct + "%"}</td>
        <td>${m.sharePct}%</td>
      </tr>`;
    }).join("") + `</tbody></table>`;
}

function specText(spec) {
  const parts = [];
  if (spec.language) parts.push(spec.language);
  if (spec.minStars) parts.push(`\u2265${spec.minStars}\u2605`);
  if (spec.maxStars) parts.push(`\u2264${spec.maxStars}\u2605`);
  if (spec.keyword) parts.push(`\u201c${spec.keyword}\u201d`);
  return parts.length ? parts.join(" \u00b7 ") : "全部仓库";
}

async function loadIndices() {
  try { indicesCache = (await fetchJson("/api/indices")).indices || []; } catch { indicesCache = []; }
  const el = $("idx-list");
  el.innerHTML = indicesCache.length
    ? indicesCache.map((x) => `<div class="entity-row${x.id === currentIndexId ? " active" : ""}" data-id="${x.id}">
        <span class="entity-name">${escapeHtml(x.name)}</span>
        <span class="entity-spec">${escapeHtml(specText(x.spec))}</span>
        <button class="btn btn-sm btn-danger entity-del" data-id="${x.id}">删除</button>
      </div>`).join("")
    : '<div class="empty"><p>还没有指数</p><p class="muted">用上方表单按语言/星数/关键词创建一组仓库的合成曲线</p></div>';

  el.querySelectorAll(".entity-row").forEach((row) => row.addEventListener("click", (e) => {
    if (e.target.classList.contains("entity-del")) return;
    selectIndex(Number(row.dataset.id));
  }));
  el.querySelectorAll(".entity-del").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    await fetchJson(`/api/indices/${b.dataset.id}`, { method: "DELETE" });
    if (currentIndexId === Number(b.dataset.id)) {
      currentIndexId = null;
      $("idx-chart").innerHTML = ""; $("idx-members").innerHTML = "";
      $("idx-detail-title").textContent = "指数走势";
    }
    loadIndices();
  }));

  if (currentIndexId && indicesCache.some((x) => x.id === currentIndexId)) selectIndex(currentIndexId);
  else if (indicesCache.length) selectIndex(indicesCache[0].id);
  else {
    $("idx-chart").innerHTML = "";
    $("idx-members").innerHTML = "";
    $("idx-detail-title").textContent = "指数走势";
  }
}

async function selectIndex(id) {
  currentIndexId = id;
  document.querySelectorAll("#idx-list .entity-row").forEach((r) => r.classList.toggle("active", Number(r.dataset.id) === id));
  try {
    const d = await fetchJson(`/api/indices/${id}/series?days=${$("idx-days").value}&weight=${$("idx-weight").value}`);
    $("idx-detail-title").textContent = `${d.name} · ${d.memberCount} 个成员 · 区间 ${d.changePct >= 0 ? "+" : ""}${d.changePct}%`;
    aggregateChart("idx-chart", d);
    $("idx-members").innerHTML = membersTable(d);
    $("idx-members").querySelectorAll("tr[data-id]").forEach((tr) => tr.addEventListener("click", () => openDetail(Number(tr.dataset.id))));
  } catch (e) {
    $("idx-chart").innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

async function loadQueries() {
  try { queriesCache = (await fetchJson("/api/queries")).queries || []; } catch { queriesCache = []; }
  const el = $("q-list");
  el.innerHTML = queriesCache.length
    ? queriesCache.map((x) => `<div class="entity-row${x.id === currentQueryId ? " active" : ""}" data-id="${x.id}">
        <span class="entity-name">${escapeHtml(x.label)}</span>
        <span class="entity-spec"><code>${escapeHtml(x.query)}</code> · ${x.member_count} 成员${x.last_run_at ? ` · ${timeAgo(x.last_run_at)}` : " · 未运行"}</span>
        <button class="btn btn-sm btn-danger entity-del" data-id="${x.id}">删除</button>
      </div>`).join("")
    : '<div class="empty"><p>还没有追踪的生态</p><p class="muted">添加一个 GitHub 搜索语法，刷新时自动抓取成员</p></div>';

  el.querySelectorAll(".entity-row").forEach((row) => row.addEventListener("click", (e) => {
    if (e.target.classList.contains("entity-del")) return;
    selectQuery(Number(row.dataset.id));
  }));
  el.querySelectorAll(".entity-del").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    await fetchJson(`/api/queries/${b.dataset.id}`, { method: "DELETE" });
    if (currentQueryId === Number(b.dataset.id)) {
      currentQueryId = null;
      $("q-chart").innerHTML = ""; $("q-members").innerHTML = "";
      $("q-detail-title").textContent = "生态走势";
    }
    loadQueries();
  }));

  if (currentQueryId && queriesCache.some((x) => x.id === currentQueryId)) selectQuery(currentQueryId);
  else if (queriesCache.length) selectQuery(queriesCache[0].id);
  else {
    $("q-chart").innerHTML = "";
    $("q-members").innerHTML = "";
    $("q-detail-title").textContent = "生态走势";
  }
}

async function selectQuery(id) {
  currentQueryId = id;
  document.querySelectorAll("#q-list .entity-row").forEach((r) => r.classList.toggle("active", Number(r.dataset.id) === id));
  try {
    const d = await fetchJson(`/api/queries/${id}?days=${$("q-days").value}&weight=${$("q-weight").value}`);
    $("q-detail-title").textContent = `${d.label} · ${d.memberCount} 个成员 · 区间 ${d.changePct == null ? "—" : (d.changePct >= 0 ? "+" : "") + d.changePct + "%"}`;
    aggregateChart("q-chart", d);
    $("q-members").innerHTML = membersTable(d);
    $("q-members").querySelectorAll("tr[data-id]").forEach((tr) => tr.addEventListener("click", () => openDetail(Number(tr.dataset.id))));
  } catch (e) {
    $("q-chart").innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

// ── 💾 保存的筛选视图（C5）──
let savedViews = [];

async function loadViews() {
  try { savedViews = (await fetchJson("/api/views")).views || []; } catch { savedViews = []; }
  const sel = $("view-select");
  if (!sel) return;
  sel.innerHTML = '<option value="">— 保存的视图 —</option>' +
    savedViews.map((v) => `<option value="${escapeHtml(v.name)}">${escapeHtml(v.name)}</option>`).join("");
}

function currentFilters() {
  return {
    minStars: state.minStars, minGrowth: state.minGrowth, language: state.language,
    sort: state.sort, window: state.window, metric: state.metric, keyword: state.keyword,
    todayOnly: state.todayOnly, onlyCustom: state.onlyCustom, onlyFavorite: state.onlyFavorite,
  };
}

function applyFilters(f) {
  if (!f || typeof f !== "object") return;
  state.minStars = Number(f.minStars) || 0;
  state.minGrowth = Number(f.minGrowth) || 0;
  state.language = f.language || "";
  state.sort = f.sort || "growth";
  state.window = f.window || "day";
  state.metric = f.metric || "stars";
  state.keyword = f.keyword || "";
  state.todayOnly = Boolean(f.todayOnly);
  state.onlyCustom = Boolean(f.onlyCustom);
  state.onlyFavorite = Boolean(f.onlyFavorite);
  state.page = 1;
  if ($("min-stars")) $("min-stars").value = state.minStars;
  if ($("min-growth")) $("min-growth").value = state.minGrowth;
  if ($("sort")) $("sort").value = state.sort;
  if ($("window")) $("window").value = state.window;
  if ($("metric")) $("metric").value = state.metric;
  if ($("keyword")) $("keyword").value = state.keyword;
  syncTodayBanner();
  loadRepos();
}

// ── 事件绑定 ──
const on = (id, evt, fn) => { const el = $(id); if (el) el.addEventListener(evt, fn); };

on("apply", "click", async () => {
  state.minStars = Number($("min-stars").value) || 0;
  state.minGrowth = Number($("min-growth").value) || 0;
  state.keyword = ($("keyword")?.value || "").trim();
  state.page = 1;
  try {
    await fetchJson("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minStars: state.minStars, minGrowth: state.minGrowth }) });
    setStatus("已应用筛选", "ok");
    await loadRepos();
  } catch (e) { showError(e.message); }
});
on("min-stars", "keydown", (e) => e.key === "Enter" && $("apply").click());
on("min-growth", "keydown", (e) => e.key === "Enter" && $("apply").click());
on("keyword", "keydown", (e) => e.key === "Enter" && $("apply").click());
on("language", "change", (e) => { state.language = e.target.value; state.page = 1; loadRepos(); });
  on("metric", "change", (e) => {
    state.metric = e.target.value; state.page = 1;
    // 切到非星标指标时，默认改为按指标值排序更直观
    if (state.metric !== "stars" && state.sort === "stars") { state.sort = "metric"; $("sort").value = "metric"; }
    loadRepos();
  });
on("sort", "change", (e) => { state.sort = e.target.value; state.page = 1; loadRepos(); });
on("window", "change", (e) => { state.window = e.target.value; state.page = 1; loadRepos(); });
on("highlight", "input", (e) => { state.highlightThreshold = Number(e.target.value) || 0; renderRepos(); });
on("pin-hot", "change", (e) => { state.pinHot = e.target.checked; renderRepos(); });
on("today", "click", toggleToday);
on("export", "click", exportCsv);
on("refresh", "click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  setStatus("正在抓取 GitHub，请稍候…", "loading");
  try {
    const r = await fetchJson("/api/refresh", { method: "POST" });
    setStatus(`抓取完成：热门 ${r.upserted}，自定义 ${r.customUpserted || 0}，共 ${r.total} 项目`, "ok");
    await Promise.all([loadRepos(), loadStats()]);
  } catch (err) { showError(err.message); }
  finally { btn.disabled = false; }
});
on("detail-close", "click", closeDetail);
on("detail-overlay", "click", (e) => { if (e.target === $("detail-overlay")) closeDetail(); });
on("theme-toggle", "click", async () => {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "light" ? "dark" : cur === "dark" ? "contrast" : "light";
  document.documentElement.setAttribute("data-theme", next);
  try { await fetchJson("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: next }) }); } catch {}
});
on("alert-badge", "click", () => document.querySelector('.tab[data-tab="settings"]')?.click());
on("clear-alerts", "click", async () => { await fetchJson("/api/alerts/read", { method: "POST" }); loadAlerts(); });

on("add-custom-btn", "click", () => {
  $("custom-overlay").classList.remove("hidden");
  $("custom-name").value = ""; $("custom-note").value = "";
  $("custom-error").classList.add("hidden");
});
on("custom-close", "click", () => $("custom-overlay").classList.add("hidden"));
on("custom-cancel", "click", () => $("custom-overlay").classList.add("hidden"));
on("custom-overlay", "click", (e) => { if (e.target === $("custom-overlay")) $("custom-overlay").classList.add("hidden"); });
on("custom-add", "click", async () => {
  const fullName = $("custom-name").value.trim();
  const note = $("custom-note").value.trim();
  const errEl = $("custom-error");
  if (!fullName || !/^[\w-]+\/[\w.-]+$/.test(fullName)) {
    errEl.textContent = "格式不正确，应为 owner/repo（如 microsoft/vscode）";
    errEl.classList.remove("hidden");
    return;
  }
  try {
    await fetchJson("/api/custom-repos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ full_name: fullName, note }) });
    $("custom-overlay").classList.add("hidden");
    loadCustomRepos();
    setStatus(`已添加 ${fullName}，下次抓取时同步追踪`, "ok");
  } catch (e) { errEl.textContent = e.message; errEl.classList.remove("hidden"); }
});
on("custom-name", "keydown", (e) => e.key === "Enter" && $("custom-add").click());

on("save-settings", "click", async () => {
  try {
    const res = await fetchJson("/api/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        minStars: Number($("set-min-stars").value) || 0,
        minGrowth: Number($("set-min-growth").value) || 0,
        retentionDays: Number($("set-retention").value) || 90,
        alertThreshold: Number($("set-alert-threshold").value) || 50,
        autoPollMinutes: Number($("set-auto-poll").value) || 0,
        searchQuery: $("set-search-query")?.value || "",
        webhookUrl: $("set-webhook-url")?.value || "",
        webhookType: $("set-webhook-type")?.value || "generic",
        theme: $("set-theme").value,
        alertOnDrop: Boolean($("set-alert-drop")?.checked),
        dropThreshold: Number($("set-drop-threshold")?.value) || 0,
        alertOnMilestone: Boolean($("set-alert-milestone")?.checked),
        digestEnabled: Boolean($("set-digest-enabled")?.checked),
        digestTime: $("set-digest-time")?.value || "09:00",
        autoBackup: $("set-auto-backup")?.checked ?? true,
        quotaFloor: Number($("set-quota-floor")?.value) || 0,
        externalIntervalHours: Number($("set-ext-interval")?.value) || 0,
        rollupAfterDays: Number($("set-rollup-days")?.value) || 0,
      }),
    });
    document.documentElement.setAttribute("data-theme", $("set-theme").value);
    setStatus("设置已保存", "ok");
    loadStats();
  } catch (e) { showError(e.message); }
});
on("save-api-key", "click", () => {
  setApiKey(($("set-api-key").value || "").trim());
  $("api-key-status").textContent = "已保存，正在重新加载…";
  setTimeout(() => location.reload(), 500);
});
on("test-webhook", "click", async (e) => {
  const btn = e.currentTarget;
  const url = ($("set-webhook-url").value || "").trim();
  const type = $("set-webhook-type").value;
  if (!url) return showError("请先填写 Webhook 地址");
  btn.disabled = true;
  try {
    const r = await fetchJson("/api/notify/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, type }) });
    setStatus(`测试通知已发送（HTTP ${r.status}）`, "ok");
  } catch (err) { showError("发送失败: " + err.message); }
  finally { btn.disabled = false; }
});
async function downloadWithAuth(url, filename) {
  const headers = {};
  const key = getApiKey();
  if (key) headers["X-API-Key"] = key;
  const session = getSession();
  if (session) headers["X-Session"] = session;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`下载失败（${res.status}）`);
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}
on("export-db", "click", async () => {
  const stamp = new Date().toISOString().slice(0, 10);
  try { await downloadWithAuth("/api/maintenance/export", `github-star-tracker-backup-${stamp}.db`); }
  catch (err) { showError(err.message); }
});
on("export-json", "click", async () => {
  const stamp = new Date().toISOString().slice(0, 10);
  try { await downloadWithAuth("/api/maintenance/export?format=json", `github-star-tracker-export-${stamp}.json`); }
  catch (err) { showError(err.message); }
});
on("import-json", "change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const mode = confirm("确定 = 合并导入（保留现有数据）\n取消 = 覆盖导入（先清空再导入）") ? "merge" : "replace";
  try {
    const data = JSON.parse(await file.text());
    const r = await fetchJson("/api/maintenance/import", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, data }),
    });
    setStatus(`导入完成（${mode}）：${r.counts.repos} 仓库 / ${r.counts.snapshots} 快照`, "ok");
    loadStats();
  } catch (err) {
    showError("导入失败: " + err.message);
  } finally {
    e.target.value = "";
  }
});
on("test-digest", "click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const r = await fetchJson("/api/notify/digest", { method: "POST" });
    setStatus(`摘要已发送（HTTP ${r.status}）`, "ok");
  } catch (err) { showError(err.message); }
  finally { btn.disabled = false; }
});
on("backfill-btn", "click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  setStatus("正在回填历史（可能需要一会儿）…", "loading");
  try {
    const r = await fetchJson("/api/backfill", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "custom", limit: 10 }),
    });
    const inserted = (r.results || []).reduce((a, x) => a + (x.inserted || 0), 0);
    setStatus(`回填完成：${r.count} 个仓库，新增 ${inserted} 个历史点`, "ok");
    await Promise.all([loadStats(), loadCustomRepos()]);
  } catch (err) { showError(err.message); }
  finally { btn.disabled = false; }
});
on("cleanup-btn", "click", async () => {
  try {
    const r = await fetchJson("/api/maintenance/cleanup", { method: "POST" });
    const roll = r.rolledUp ? `，降采样 ${r.rolledUp} 条` : "";
    setStatus(`已清理 ${r.removed} 条过期快照${roll}`, "ok");
    loadStats();
  } catch (e) { showError(e.message); }
});
on("trend-window", "change", loadLanguageTrends);
on("rank-window", "change", loadRankChanges);
on("lb-limit", "change", loadLeaderboard);
on("lb-window", "change", loadLeaderboard);
on("lb-metric", "change", loadLeaderboard);
on("surge-limit", "change", loadSurges);
on("surge-min-stars", "change", loadSurges);
on("surge-metric", "change", loadSurges);
on("ext-window", "change", loadExternalMetrics);
on("refresh-metrics", "click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const r = await fetchJson("/api/metrics/refresh", { method: "POST" });
    setStatus(`已刷新 ${r.fetched}/${r.total} 个外部指标`, "ok");
    loadExternalMetrics();
  } catch (err) { showError(err.message); }
  finally { btn.disabled = false; }
});
on("add-metric-btn", "click", () => {
  $("metric-overlay").classList.remove("hidden");
  $("metric-key").value = "";
  $("metric-error").classList.add("hidden");
  updateMetricPlaceholder();
});
on("metric-source", "change", updateMetricPlaceholder);
on("metric-close", "click", () => $("metric-overlay").classList.add("hidden"));
on("metric-cancel", "click", () => $("metric-overlay").classList.add("hidden"));
on("metric-overlay", "click", (e) => { if (e.target === $("metric-overlay")) $("metric-overlay").classList.add("hidden"); });
on("metric-add", "click", async () => {
  const source = $("metric-source").value;
  const key = $("metric-key").value.trim();
  const errEl = $("metric-error");
  if (!key) { errEl.textContent = "请输入指标名称"; errEl.classList.remove("hidden"); return; }
  try {
    const r = await fetchJson("/api/metrics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source, key }) });
    $("metric-overlay").classList.add("hidden");
    setStatus(`已添加，当前值 ${fmt(r.value)}`, "ok");
    loadExternalMetrics(); loadStats();
  } catch (e) { errEl.textContent = e.message; errEl.classList.remove("hidden"); }
});
on("metric-key", "keydown", (e) => e.key === "Enter" && $("metric-add").click());
on("surge-reload", "click", loadSurges);

// ⚖️ 对比
on("cmp-add", "click", () => addCompareRepo($("cmp-input").value));
on("cmp-input", "keydown", (e) => { if (e.key === "Enter") addCompareRepo(e.target.value); });
on("cmp-clear", "click", () => { cmpSelection = []; renderCompareChips(); renderCompareEmpty(); });
on("cmp-window", "change", loadCompare);
on("cmp-metric", "change", loadCompare);
on("cmp-pct", "change", loadCompare);
on("cmp-log", "change", loadCompare);

// 📉 全局趋势
on("ov-days", "change", loadOverview);
on("ov-reload", "click", loadOverview);

// 🔎 信号
on("an-reload", "click", loadSignals);
on("rs-reload", "click", loadSignals);
on("ev-reload", "click", loadSignals);
on("bt-run", "click", runBacktest);
on("bt-days", "change", runBacktest);
["an-days", "an-z", "an-min", "an-min-stars", "rs-max", "rs-min", "rs-days", "ev-days", "ev-z", "ev-min-repos", "ev-min"].forEach((id) => on(id, "change", loadSignals));

// 🧭 指数与生态
on("idx-add", "click", async () => {
  const name = ($("idx-name").value || "").trim();
  if (!name) return showError("请输入指数名称");
  try {
    const r = await fetchJson("/api/indices", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        language: $("idx-language").value.trim(),
        minStars: $("idx-min").value,
        maxStars: $("idx-max").value,
        keyword: $("idx-keyword").value.trim(),
      }),
    });
    $("idx-name").value = "";
    currentIndexId = r.id;
    await loadIndices();
    setStatus(`已创建指数「${name}」`, "ok");
  } catch (e) { showError(e.message); }
});
on("idx-days", "change", () => currentIndexId && selectIndex(currentIndexId));
on("idx-weight", "change", () => currentIndexId && selectIndex(currentIndexId));

on("q-add", "click", async () => {
  const label = ($("q-label").value || "").trim();
  const query = ($("q-query").value || "").trim();
  if (!label || !query) return showError("请输入名称和搜索语法");
  try {
    const r = await fetchJson("/api/queries", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, query }),
    });
    $("q-label").value = ""; $("q-query").value = "";
    currentQueryId = r.id;
    await loadQueries();
    $("q-status").textContent = "已添加，点「立即刷新成员」抓取";
  } catch (e) { showError(e.message); }
});
on("q-refresh", "click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  $("q-status").textContent = "正在抓取成员…";
  try {
    const r = await fetchJson("/api/queries/refresh", { method: "POST" });
    $("q-status").textContent = `已刷新 ${r.updated}/${r.queries} 个追踪，共 ${r.members} 个成员`;
    await loadQueries();
  } catch (err) { showError(err.message); $("q-status").textContent = ""; }
  finally { btn.disabled = false; }
});
on("q-days", "change", () => currentQueryId && selectQuery(currentQueryId));
on("q-weight", "change", () => currentQueryId && selectQuery(currentQueryId));

// 💾 保存的视图
on("view-save", "click", async () => {
  const name = ($("view-name").value || "").trim();
  if (!name) return showError("请输入视图名称");
  try {
    savedViews = (await fetchJson("/api/views", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, filters: currentFilters() }),
    })).views;
    await loadViews();
    $("view-select").value = name;
    $("view-name").value = "";
    setStatus(`已保存视图「${name}」`, "ok");
  } catch (e) { showError(e.message); }
});
on("view-select", "change", (e) => {
  const v = savedViews.find((x) => x.name === e.target.value);
  if (v) applyFilters(v.filters);
});
on("view-delete", "click", async () => {
  const name = $("view-select").value;
  if (!name) return showError("请先选择要删除的视图");
  try {
    savedViews = (await fetchJson(`/api/views/${encodeURIComponent(name)}`, { method: "DELETE" })).views;
    await loadViews();
    setStatus(`已删除视图「${name}」`, "ok");
  } catch (e) { showError(e.message); }
});
on("replay-go", "click", runReplay);
on("replay-now", "click", () => { initReplayDefault(); $("replay-result").innerHTML = ""; $("replay-status").textContent = ""; });

// ── 📲 Web Push（浏览器/手机系统级通知）──
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function refreshPushStatus() {
  const el = $("push-status");
  if (!el) return;
  try {
    const r = await fetchJson("/api/push/subscriptions");
    let local = "本设备未订阅";
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      local = sub ? "本设备已订阅" : "本设备未订阅";
    }
    el.textContent = `${local} · 服务端共 ${r.count} 个订阅`;
  } catch { el.textContent = ""; }
}

async function enablePush() {
  const el = $("push-status");
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      throw new Error("当前环境不支持（需 HTTPS 或 localhost）");
    }
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await fetchJson("/api/push/public-key");
    const existing = await reg.pushManager.getSubscription();
    const sub = existing || await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    const json = sub.toJSON();
    await fetchJson("/api/push/subscribe", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint, keys: json.keys }),
    });
    el.textContent = "✅ 已启用，可点「发送测试推送」验证";
    refreshPushStatus();
  } catch (e) {
    el.textContent = "";
    showError("启用失败：" + e.message);
  }
}

async function disablePush() {
  const el = $("push-status");
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      await fetchJson("/api/push/unsubscribe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      await sub.unsubscribe();
    }
    el.textContent = "已取消订阅";
    refreshPushStatus();
  } catch (e) { showError(e.message); }
}

// ── 👤 多用户：登录 / 账号 / 用户管理 ──
let authMode = "login";
let authStatus = { hasUsers: false, canRegister: true, user: null };

async function checkAuth() {
  try {
    authStatus = await (await fetch("/api/auth/status", { headers: getSession() ? { "X-Session": getSession() } : {} })).json();
  } catch {
    authStatus = { hasUsers: false, canRegister: true, user: null };
  }
  const who = $("account-who");
  if (who) {
    who.textContent = authStatus.user
      ? `当前登录：${authStatus.user.username}（${authStatus.user.role === "admin" ? "管理员" : "成员"}）`
      : (authStatus.hasUsers ? "未登录" : "单用户模式（未启用登录）");
  }
  const adminSection = $("user-admin-section");
  if (adminSection) {
    const isAdmin = authStatus.user?.role === "admin" || !authStatus.hasUsers;
    adminSection.classList.toggle("hidden", !isAdmin || !authStatus.hasUsers);
  }
  // 单用户模式：不打断使用，只在设置页提供「启用多用户」入口
  const enableBtn = $("enable-multiuser-btn");
  if (enableBtn) enableBtn.classList.toggle("hidden", authStatus.hasUsers || Boolean(authStatus.user));

  // 仅当系统已启用多用户、而当前未登录时才强制登录
  if (authStatus.hasUsers && !authStatus.user) { showAuth("login"); return false; }
  return true;
}

function showAuth(mode) {
  authMode = mode;
  $("auth-overlay").classList.remove("hidden");
  $("auth-title").textContent = mode === "register" ? "创建管理员账号" : "登录";
  $("auth-hint").textContent = mode === "register"
    ? "首次使用：创建第一个管理员账号后即启用多用户模式（数据将按用户隔离）。"
    : "该服务已启用多用户模式，请登录。";
  $("auth-submit").textContent = mode === "register" ? "创建并登录" : "登录";
  $("auth-error").classList.add("hidden");
  $("auth-password").value = "";
  $("auth-username").focus();
}

async function submitAuth() {
  const username = ($("auth-username").value || "").trim();
  const password = $("auth-password").value || "";
  const errEl = $("auth-error");
  try {
    const path = authMode === "register" ? "/api/auth/register" : "/api/auth/login";
    const res = await fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
    setSession(data.session);
    $("auth-overlay").classList.add("hidden");
    await loadAll();
    checkAuth();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove("hidden");
  }
}

async function logout() {
  try {
    await fetch("/api/auth/logout", { method: "POST", headers: { "X-Session": getSession() } });
  } catch { /* ignore */ }
  setSession("");
  location.reload();
}

async function loadUsers() {
  const el = $("user-list");
  if (!el) return;
  try {
    const { users } = await fetchJson("/api/auth/users");
    el.innerHTML = users.length
      ? users.map((u) => `<div class="entity-row">
          <span class="entity-name">${escapeHtml(u.username)}</span>
          <span class="entity-spec">${u.role === "admin" ? "管理员" : "成员"} · 创建于 ${timeAgo(u.created_at)}</span>
          <button class="btn btn-sm btn-danger del-user" data-id="${u.id}" data-name="${escapeHtml(u.username)}">删除</button>
        </div>`).join("")
      : '<div class="empty"><p>暂无用户</p></div>';
    el.querySelectorAll(".del-user").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm(`确定删除用户「${b.dataset.name}」？其个人数据将保留但不再可访问。`)) return;
      try { await fetchJson(`/api/auth/users/${b.dataset.id}`, { method: "DELETE" }); loadUsers(); }
      catch (e) { showError(e.message); }
    }));
  } catch { el.innerHTML = ""; }
}

on("auth-submit", "click", submitAuth);
on("enable-multiuser-btn", "click", () => showAuth("register"));
on("auth-username", "keydown", (e) => e.key === "Enter" && submitAuth());
on("auth-password", "keydown", (e) => e.key === "Enter" && submitAuth());
on("logout-btn", "click", logout);
on("change-pass-btn", "click", async () => {
  const pw = $("my-new-pass").value || "";
  try {
    await fetchJson("/api/auth/password", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    $("my-new-pass").value = "";
    setStatus("密码已修改，请重新登录", "ok");
    setTimeout(() => { setSession(""); location.reload(); }, 800);
  } catch (e) { showError(e.message); }
});
on("add-user-btn", "click", async () => {
  const username = ($("new-user-name").value || "").trim();
  const password = $("new-user-pass").value || "";
  try {
    await fetchJson("/api/auth/users", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, role: $("new-user-role").value }),
    });
    $("new-user-name").value = ""; $("new-user-pass").value = "";
    loadUsers();
  } catch (e) { showError(e.message); }
});

// ── ⌘K 命令面板（UX）──
let paletteItems = [];
let paletteActive = 0;
let paletteRepoCommands = [];
let paletteReposLoaded = false;

const paletteActions = () => [
  { kind: "动作", title: "🔄 立即刷新数据", run: () => $("refresh")?.click() },
  { kind: "动作", title: "🌓 切换主题", run: () => $("theme-toggle")?.click() },
  { kind: "动作", title: "🧹 清理过期快照", run: () => $("cleanup-btn")?.click() },
  { kind: "动作", title: "🔎 打开信号面板", run: () => document.querySelector('.tab[data-tab=signals]')?.click() },
];

const paletteTabCommands = () => Array.from(document.querySelectorAll(".tab")).map((t) => ({
  kind: "页面", title: t.textContent.trim(), run: () => t.click(),
}));

async function loadPaletteRepos() {
  if (paletteReposLoaded) return;
  try {
    const d = await fetchJson("/api/repos?sort=stars&minStars=0&pageSize=300&page=1");
    paletteRepoCommands = (d.repos || []).map((r) => ({
      kind: "仓库",
      title: r.full_name,
      subtitle: `★ ${fmt(r.stars)}${r.language ? " · " + r.language : ""}`,
      run: () => openDetail(r.id),
    }));
    paletteReposLoaded = true;
  } catch { /* 离线时仅保留页面/动作） */ }
}

function openPalette() {
  $("palette-overlay").classList.remove("hidden");
  const input = $("palette-input");
  input.value = "";
  renderPalette("");
  input.focus();
  loadPaletteRepos().then(() => { if (!$("palette-overlay").classList.contains("hidden")) renderPalette(input.value); });
}

function closePalette() { $("palette-overlay").classList.add("hidden"); }

function renderPalette(q) {
  const query = String(q || "").trim().toLowerCase();
  const all = [...paletteActions(), ...paletteTabCommands(), ...paletteRepoCommands];
  paletteItems = query
    ? all.filter((x) => x.title.toLowerCase().includes(query)).slice(0, 40)
    : [...paletteActions(), ...paletteTabCommands(), ...paletteRepoCommands.slice(0, 12)];
  paletteActive = 0;
  const el = $("palette-list");
  el.innerHTML = paletteItems.length
    ? paletteItems.map((x, i) => `<div class="palette-item${i === 0 ? " active" : ""}" data-i="${i}">
        <span class="palette-kind">${escapeHtml(x.kind)}</span>
        <span class="palette-title">${escapeHtml(x.title)}</span>
        ${x.subtitle ? `<span class="palette-sub">${escapeHtml(x.subtitle)}</span>` : ""}
      </div>`).join("")
    : '<div class="palette-empty">无匹配结果</div>';
  el.querySelectorAll(".palette-item").forEach((item) => {
    item.addEventListener("click", () => runPaletteItem(Number(item.dataset.i)));
    item.addEventListener("mousemove", () => {
      paletteActive = Number(item.dataset.i);
      el.querySelectorAll(".palette-item").forEach((n) => n.classList.toggle("active", n === item));
    });
  });
}

function runPaletteItem(i) {
  const item = paletteItems[i];
  if (!item) return;
  closePalette();
  item.run();
}

function movePalette(delta) {
  if (!paletteItems.length) return;
  paletteActive = Math.max(0, Math.min(paletteItems.length - 1, paletteActive + delta));
  const el = $("palette-list");
  el.querySelectorAll(".palette-item").forEach((n, i) => n.classList.toggle("active", i === paletteActive));
  el.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" });
}

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openPalette();
  } else if (e.key === "Escape" && !$("palette-overlay").classList.contains("hidden")) {
    closePalette();
  }
});
on("palette-btn", "click", openPalette);
on("push-enable", "click", enablePush);
on("push-disable", "click", disablePush);
on("push-test", "click", async () => {
  const el = $("push-status");
  try {
    const r = await fetchJson("/api/push/test", { method: "POST" });
    el.textContent = `测试推送已发送（成功 ${r.sent}/${r.total}）`;
  } catch (e) { showError(e.message); }
});
on("palette-overlay", "click", (e) => { if (e.target === $("palette-overlay")) closePalette(); });
on("palette-input", "input", (e) => renderPalette(e.target.value));
on("palette-input", "keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); movePalette(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); movePalette(-1); }
  else if (e.key === "Enter") { e.preventDefault(); runPaletteItem(paletteActive); }
});

// 启动：先确认登录状态，再加载数据
(async () => {
  const ok = await checkAuth();
  if (ok) loadAll();
})();

// PWA：注册 Service Worker（离线可打开界面）
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => { /* 非 https/localhost 时忽略 */ });
  });
}
