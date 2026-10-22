/**
 * boards.js —— 各「内容页」的加载与渲染：语言趋势、排名变化、排行榜、
 * 全站星标榜、爆发榜、历史回放、外部指标、仓库对比、全局趋势、信号
 * （异常/黑马/事件聚类）、告警回测、指数与生态。
 */
/* global $, fetchJson, fmt, escapeHtml, timeAgo, showError, compactNum,
   lineChart, barChart, calendarHeatmap, bindCharts, CHART_COLORS, openDetail, loadStats */
/* exported loadLanguageTrends, loadRankChanges, loadLeaderboard, loadFullRanking, loadSurges, loadExternalMetrics, initReplayDefault, updateMetricPlaceholder, runReplay, initCompare, addCompareRepo, editingQueryId, loadOverview, loadSignals, runBacktest, initIndices */
async function loadLanguageTrends() {
  try {
    const win = $("trend-window")?.value || "day";
    const { trends } = await fetchJson(`/api/languages/trends?window=${win}`);
    const el = $("trend-list");
    if (trends.length === 0) {
      el.innerHTML = '<div class="empty"><p>暂无数据，先运行几次抓取</p></div>';
      return;
    }
    const maxGrowth = Math.max(...trends.map((t) => Math.abs(t.totalGrowth)), 1);
    el.innerHTML = trends
      .map(
        (t, i) => `
      <div class="trend-item">
        <span class="trend-rank">${i + 1}</span>
        <span class="trend-lang">${escapeHtml(t.language)}</span>
        <div class="trend-bar-wrap"><div class="trend-bar" style="width:${Math.min(100, (Math.abs(t.totalGrowth) / maxGrowth) * 100).toFixed(1)}%"></div></div>
        <div class="trend-stats">
          <div class="trend-growth">${t.totalGrowth >= 0 ? "+" : ""}${fmt(t.totalGrowth)}</div>
          <div class="trend-count">${t.count} 个仓库 · 总★ ${fmt(t.totalStars)}</div>
        </div>
      </div>`,
      )
      .join("");
  } catch (e) {
    $("trend-list").innerHTML = `<div class="empty"><p>加载失败: ${escapeHtml(e.message)}</p></div>`;
  }
}

// ── 排名变化（P1-5）──
function rankList(items, isUp) {
  if (items.length === 0) return '<div class="empty"><p>暂无排名变化</p></div>';
  return items
    .map(
      (r) => `
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
    </div>`,
    )
    .join("");
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
  const right =
    mode === "stars"
      ? `<div class="lb-value">★ ${fmt(r.stars)}</div>
       <div class="lb-sub">${r.growth != null ? (r.growth >= 0 ? "+" : "") + fmt(r.growth) + " " + escapeHtml(r.growthLabel) : "待积累"}</div>`
      : `<div class="lb-value" style="color:${(r.basisValue ?? 0) >= 0 ? "var(--green)" : "var(--red)"}">${(r.basisValue ?? 0) >= 0 ? "+" : ""}${fmt(r.basisValue)} <small>${escapeHtml(r.basisUnit || "星")}</small></div>
       <div class="lb-sub">★ ${fmt(r.stars)} · 样本 ${(Number(r.avgSampleDays) || 0).toFixed(2)} 天${(Number(r.avgSampleDays) || 0) < 1 ? " ⚠️" : ""}</div>`;
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
    const basis = $("lb-basis")?.value || "avg7";
    const metric = $("lb-metric")?.value || "stars";
    const data = await fetchJson(`/api/leaderboard?limit=${limit}&basis=${basis}&metric=${metric}`);

    // 采样跨度提示（避免把几分钟的数据外推成“每天”）
    const notice = $("lb-notice");
    const d = data.sampleDays || 0;
    const basisLabel = data.basisLabel || "近7天日均";
    const excl = Number(data.excludedForSample) || 0;
    const exclNote = excl
      ? `<br>已从增长榜隐藏 <b>${excl}</b> 个样本跨度不足 ${data.minSampleDays} 天的仓库（仍保留在总星榜，等积累够再进）。`
      : "";
    if (d < 1) {
      notice.className = "lb-notice warn";
      notice.innerHTML = `⚠️ 当前快照采样仅 <b>${(d * 24).toFixed(1)} 小时</b>，${escapeHtml(basisLabel)}为初步估算。建议积累 <b>7 天</b> 以上数据后参考。${exclNote}`;
    } else if (d < 7) {
      notice.className = "lb-notice";
      notice.innerHTML = `ℹ️ 快照采样跨度 <b>${d.toFixed(1)} 天</b> · 增长口径：<b>${escapeHtml(basisLabel)}</b>（满 7 天更准）。${exclNote}`;
    } else {
      notice.className = "lb-notice ok";
      notice.innerHTML = `✅ 快照采样跨度 <b>${d.toFixed(1)} 天</b> · 增长口径：<b>${escapeHtml(basisLabel)}</b>。${exclNote}`;
    }

    const starsEl = $("lb-by-stars");
    const growthEl = $("lb-by-growth");
    starsEl.innerHTML =
      (data.byStars || []).map((r, i) => lbItem(r, i + 1, "stars")).join("") ||
      '<div class="empty"><p>暂无数据</p></div>';
    growthEl.innerHTML =
      (data.byGrowth || []).map((r, i) => lbItem(r, i + 1, "growth")).join("") ||
      '<div class="empty"><p>尚无足够的增长数据（需至少 2 条快照）</p></div>';

    document.querySelectorAll(".lb-item").forEach((el) => {
      el.addEventListener("click", () => openDetail(Number(el.dataset.id)));
    });
  } catch (e) {
    $("lb-by-stars").innerHTML = `<div class="empty"><p>加载失败: ${escapeHtml(e.message)}</p></div>`;
    $("lb-by-growth").innerHTML = "";
  }
}

// ── 📋 全站星标榜（全部仓库，不受最低星数筛选）──
let frPage = 1;
async function loadFullRanking() {
  const size = Number($("fr-page-size")?.value) || 50;
  try {
    const data = await fetchJson(
      `/api/repos?sort=stars&metric=stars&minStars=0&minGrowth=0&page=${frPage}&pageSize=${size}`,
    );
    const start = (data.page - 1) * data.pageSize;
    const rows = (data.repos || [])
      .map(
        (r, i) => `<div class="fr-row" data-id="${r.id}">
        <span class="fr-rank">${start + i + 1}</span>
        <span class="fr-name"><a class="repo-name" href="${escapeHtml(r.url)}" target="_blank" rel="noopener" data-stop="1">${escapeHtml(r.full_name)}</a></span>
        <span class="fr-lang">${escapeHtml(r.language || "—")}</span>
        <span class="fr-stars">★ ${fmt(r.stars)}</span>
      </div>`,
      )
      .join("");
    $("full-rank-list").innerHTML = rows || '<div class="empty"><p>暂无数据</p></div>';
    $("fr-info").textContent = `第 ${data.page} / ${data.totalPages} 页 · 共 ${fmt(data.total)} 个仓库`;
    $("fr-prev").disabled = data.page <= 1;
    $("fr-next").disabled = data.page >= data.totalPages;
    $("full-rank-list")
      .querySelectorAll(".fr-row")
      .forEach((el) => el.addEventListener("click", () => openDetail(Number(el.dataset.id))));
  } catch (e) {
    $("full-rank-list").innerHTML = `<div class="empty"><p>加载失败: ${escapeHtml(e.message)}</p></div>`;
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
    const data = await fetchJson(
      `/api/trends/surge?limit=${limit}&minStars=${minStars}&decaying=1&metric=${metric}`,
    );
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
    const d = await fetchJson(
      `/api/replay?at=${encodeURIComponent(at)}&window=${window}&sort=${sort}&limit=50`,
    );
    statusEl.textContent = `当时共 ${d.total} 个仓库`;
    $("replay-result").innerHTML =
      (d.repos || [])
        .map(
          (r) => `
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
      </div>`,
        )
        .join("") || '<div class="empty"><p>该时刻无数据</p></div>';
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
  const growthTxt =
    r.growth == null
      ? '<span class="muted">待积累</span>'
      : `<span style="color:${r.growth >= 0 ? "var(--green)" : "var(--red)"}">${r.growth >= 0 ? "+" : ""}${fmt(r.growth)}</span> <small class="muted">${escapeHtml(r.growthLabel)}</small>`;
  const avg =
    r.avgDailyGrowth != null
      ? `<span class="avg">日均 ${r.avgDailyGrowth >= 0 ? "+" : ""}${r.avgDailyGrowth}</span>`
      : "";
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
      if (sel)
        sel.innerHTML = SOURCES.map((x) => `<option value="${x.key}">${escapeHtml(x.label)}</option>`).join(
          "",
        );
    }
    const win = $("ext-window")?.value || "day";
    const { metrics } = await fetchJson(`/api/metrics?window=${win}`);
    const el = $("ext-list");
    if (!metrics.length) {
      el.innerHTML =
        '<div class="empty"><p>还没有追踪任何外部指标</p><p class="muted">点击右上角「+ 添加指标」，例如 npm 的 react</p></div>';
      return;
    }
    el.innerHTML = metrics.map((r, i) => extItem(r, i + 1)).join("");
    el.querySelectorAll(".ext-del").forEach((btn) =>
      btn.addEventListener("click", async () => {
        await fetchJson(`/api/metrics/${btn.dataset.id}`, { method: "DELETE" });
        loadExternalMetrics();
        loadStats();
      }),
    );
  } catch (e) {
    $("ext-list").innerHTML = `<div class="empty"><p>加载失败: ${escapeHtml(e.message)}</p></div>`;
  }
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
      $("cmp-options").innerHTML = opts
        .map((r) => `<option value="${escapeHtml(r.full_name)}"></option>`)
        .join("");
      cmpReady = true;
    } catch (e) {
      console.error("initCompare:", e);
    }
  }
  renderCompareChips();
  if (cmpSelection.length >= 2) loadCompare();
  else renderCompareEmpty();
}

function renderCompareChips() {
  const el = $("cmp-chips");
  el.innerHTML = cmpSelection
    .map(
      (s) =>
        `<span class="chip">${escapeHtml(s.full_name)}<button class="chip-x" data-id="${s.id}" aria-label="移除">×</button></span>`,
    )
    .join("");
  el.querySelectorAll(".chip-x").forEach((b) =>
    b.addEventListener("click", () => {
      cmpSelection = cmpSelection.filter((x) => x.id !== Number(b.dataset.id));
      renderCompareChips();
      cmpSelection.length >= 2 ? loadCompare() : renderCompareEmpty();
    }),
  );
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

    $("cmp-table").innerHTML =
      `<table class="data-table"><thead><tr>
        <th>仓库</th><th>语言</th><th>当前</th><th>区间变化</th><th>变化率</th><th>快照</th>
      </tr></thead><tbody>` +
      d.repos
        .map((r, i) => {
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
        })
        .join("") +
      `</tbody></table>`;
    $("cmp-table")
      .querySelectorAll("tr[data-id]")
      .forEach((tr) => tr.addEventListener("click", () => openDetail(Number(tr.dataset.id))));

    // 交叉预测
    const cross = d.crossings || [];
    $("cmp-crossings").innerHTML = cross.length
      ? `<h3 class="chart-title" style="margin-top:18px">交叉预测</h3><div class="cross-list">` +
        cross
          .map(
            (c) => `<div class="cross-item">
          <b>${escapeHtml(c.from)}</b> 预计约 <b>${c.days}</b> 天后超过 <b>${escapeHtml(c.to)}</b>
          <span class="muted">（${escapeHtml(c.eta)} · 置信度 ${Math.round((c.confidence || 0) * 100)}%）</span>
        </div>`,
          )
          .join("") +
        `</div>`
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

    $("ov-stars").innerHTML =
      d.totalStars.length >= 2
        ? lineChart({
            series: [
              {
                name: "总星数",
                color: "#58a6ff",
                points: d.totalStars.map((p) => ({ x: p.date, y: p.totalStars })),
              },
            ],
            yFormat: compactNum,
          })
        : '<p class="muted">数据不足</p>';
    bindCharts($("ov-stars"));

    $("ov-activity").innerHTML = barChart(
      d.snapshotActivity.map((p) => ({ x: p.date, y: p.count })),
      { color: "#22c55e" },
    );
    $("ov-discoveries").innerHTML = barChart(
      d.discoveries.map((p) => ({ x: p.date, y: p.count })),
      { color: "#f59e0b" },
    );

    // 每日新增星数热力图（由总星数曲线求差）
    const heat = [];
    for (let i = 1; i < d.totalStars.length; i++) {
      heat.push({
        x: d.totalStars[i].date,
        y: Math.max(0, d.totalStars[i].totalStars - d.totalStars[i - 1].totalStars),
      });
    }
    $("ov-heatmap").innerHTML = calendarHeatmap(heat);

    const maxCount = Math.max(...d.languages.map((l) => l.c), 1);
    $("ov-languages").innerHTML = d.languages.length
      ? d.languages
          .map(
            (l) => `<div class="lang-row">
          <span class="lang-name">${escapeHtml(l.language)}</span>
          <div class="lang-track"><div class="lang-fill" style="width:${((l.c / maxCount) * 100).toFixed(1)}%"></div></div>
          <span class="muted">${l.c}</span>
        </div>`,
          )
          .join("")
      : '<p class="muted">暂无数据</p>';
  } catch (e) {
    $("ov-stars").innerHTML = `<p class="muted">加载失败：${escapeHtml(e.message)}</p>`;
  }
}

// ── 🔎 信号（异常检测 + 黑马榜）──
async function loadSignals() {
  const an = $("an-days"),
    az = $("an-z"),
    am = $("an-min"),
    ams = $("an-min-stars");
  const rmax = $("rs-max"),
    rmin = $("rs-min"),
    rdays = $("rs-days");
  try {
    const rmaxVal = (rmax.value || "").trim();
    const rmaxQ = rmaxVal === "" ? "" : `&maxStars=${rmaxVal}`;
    const [anomaly, rising, events] = await Promise.all([
      fetchJson(
        `/api/trends/anomaly?days=${an.value}&z=${az.value}&minSamples=${am.value}&minStars=${ams.value}&limit=10`,
      ),
      fetchJson(`/api/trends/rising?minStars=${rmin.value}&minDays=${rdays.value}&limit=15${rmaxQ}`),
      fetchJson(
        `/api/trends/events?days=${$("ev-days").value}&z=${$("ev-z").value}&minRepos=${$("ev-min-repos").value}&minSamples=${$("ev-min").value}&limit=10`,
      ),
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

    document
      .querySelectorAll("#an-spikes .lb-item, #an-drops .lb-item")
      .forEach((el) => el.addEventListener("click", () => openDetail(Number(el.dataset.id))));

    $("rs-notice").className = "lb-notice";
    $("rs-notice").innerHTML =
      `ℹ️ 星数上限为 <b>${fmt(rising.maxStars)}</b>（留空时自动取追踪集星数中位数）· 仅纳入 ≥${rising.minDays} 天前创建的项目 · 按「日增百分比」排序。`;
    $("rs-list").innerHTML = rising.rising.length
      ? rising.rising
          .map(
            (r, i) => `<div class="lb-item" data-id="${r.id}">
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
        </div>`,
          )
          .join("")
      : '<div class="empty"><p>暂无符合条件的数据</p></div>';
    document
      .querySelectorAll("#rs-list .lb-item")
      .forEach((el) => el.addEventListener("click", () => openDetail(Number(el.dataset.id))));

    // 🌊 事件聚类
    $("ev-notice").innerHTML =
      `ℹ️ 同时将「同一天多个仓库 z 异常」归为一波趋势，用语言/描述共同词自动命名。需至少 <b>${events.minSamples + 1}</b> 天日增数据。`;
    $("ev-list").innerHTML = events.events.length
      ? events.events
          .map(
            (e) => `
          <div class="event-card">
            <div class="event-head">
              <span class="event-date">📅 ${escapeHtml(e.date)}</span>
              <span class="event-meta"><b>${e.count}</b> 个仓库 · 合计 <b>+${fmt(e.totalDelta)}</b> 星 · 平均 z ${e.avgZ}${e.dominantLanguage ? ` · ${escapeHtml(e.dominantLanguage)}` : ""}</span>
            </div>
            ${e.terms.length ? `<div class="event-terms">${e.terms.map((t) => `<span class="topic-chip">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
            <div class="event-repos">${e.repos.map((r) => `<span class="event-repo" data-id="${r.id}">${escapeHtml(r.full_name)} <small>+${fmt(r.delta)}</small></span>`).join("")}</div>
          </div>`,
          )
          .join("")
      : '<div class="empty"><p>暂无聚类型事件</p><p class="muted">可降低 z 阈值或最少仓库数</p></div>';
    document
      .querySelectorAll("#ev-list .event-repo")
      .forEach((el) => el.addEventListener("click", () => openDetail(Number(el.dataset.id))));
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
    $("bt-notice").innerHTML =
      `ℹ️ 过去 <b>${d.days}</b> 天评估了 <b>${s.evaluatedRepos}</b> 个仓库（平均 ${s.avgSampleDays} 天样本）。预计 <b>${s.total}</b> 次触发，约 <b>${perDay} 次/天</b>。${s.total > d.days * 2 ? "阈值偏低，建议调高。" : "频率合理。"}回测与生产共用同一套规则（权限覆盖/里程碑/掉星）。`;

    $("bt-repos").innerHTML = d.topRepos.length
      ? d.topRepos
          .map(
            (r, i) =>
              `<div class="lb-item"><span class="lb-rank">${i + 1}</span><div class="lb-main"><span class="repo-name">${escapeHtml(r.full_name)}</span></div><div class="lb-nums"><div class="lb-value">${r.count} 次</div></div></div>`,
          )
          .join("")
      : '<div class="empty"><p>无触发</p></div>';

    $("bt-fires").innerHTML = d.fired.length
      ? d.fired
          .slice(0, 20)
          .map(
            (f) =>
              `<div class="lb-item" data-id="${f.id}"><span class="lb-rank">${f.kind === "growth" ? "📈" : f.kind === "drop" ? "📉" : "🏁"}</span><div class="lb-main"><span class="repo-name">${escapeHtml(f.full_name)}</span><div class="lb-sub">${escapeHtml(f.date)} · ${escapeHtml(f.kind)}</div></div><div class="lb-nums"><div class="lb-value" style="color:${f.growth >= 0 ? "var(--green)" : "var(--red)"}">${f.growth >= 0 ? "+" : ""}${fmt(f.growth)}</div></div></div>`,
          )
          .join("")
      : '<div class="empty"><p>无触发</p></div>';
    document
      .querySelectorAll("#bt-fires .lb-item[data-id]")
      .forEach((el) => el.addEventListener("click", () => openDetail(Number(el.dataset.id))));
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
let editingQueryId = null;

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
    series: [
      { name: `指数（${data.weight === "cap" ? "星数加权" : "等权"}）`, color: "var(--accent)", points },
    ],
    yFormat: (v) => Number(v).toFixed(1),
  });
  bindCharts($(containerId));
}

function membersTable(data) {
  if (!data.members.length) return '<div class="empty"><p>暂无成员</p></div>';
  return (
    `<table class="data-table"><thead><tr><th>成员</th><th>语言</th><th>当前</th><th>区间变化</th><th>占比</th></tr></thead><tbody>` +
    data.members
      .slice(0, 40)
      .map((m) => {
        const up = (m.changePct ?? 0) >= 0;
        return `<tr data-id="${m.id}">
        <td>${escapeHtml(m.full_name)}</td>
        <td>${m.language ? `<span class="lang">${escapeHtml(m.language)}</span>` : "—"}</td>
        <td>${fmt(m.current)}</td>
        <td class="${up ? "up" : "down"}">${m.changePct == null ? "—" : (up ? "+" : "") + m.changePct + "%"}</td>
        <td>${m.sharePct}%</td>
      </tr>`;
      })
      .join("") +
    `</tbody></table>`
  );
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
  try {
    indicesCache = (await fetchJson("/api/indices")).indices || [];
  } catch {
    indicesCache = [];
  }
  const el = $("idx-list");
  el.innerHTML = indicesCache.length
    ? indicesCache
        .map(
          (x) => `<div class="entity-row${x.id === currentIndexId ? " active" : ""}" data-id="${x.id}">
        <span class="entity-name">${escapeHtml(x.name)}</span>
        <span class="entity-spec">${escapeHtml(specText(x.spec))}</span>
        <button class="btn btn-sm btn-danger entity-del" data-id="${x.id}">删除</button>
      </div>`,
        )
        .join("")
    : '<div class="empty"><p>还没有指数</p><p class="muted">用上方表单按语言/星数/关键词创建一组仓库的合成曲线</p></div>';

  el.querySelectorAll(".entity-row").forEach((row) =>
    row.addEventListener("click", (e) => {
      if (e.target.classList.contains("entity-del")) return;
      selectIndex(Number(row.dataset.id));
    }),
  );
  el.querySelectorAll(".entity-del").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      await fetchJson(`/api/indices/${b.dataset.id}`, { method: "DELETE" });
      if (currentIndexId === Number(b.dataset.id)) {
        currentIndexId = null;
        $("idx-chart").innerHTML = "";
        $("idx-members").innerHTML = "";
        $("idx-detail-title").textContent = "指数走势";
      }
      loadIndices();
    }),
  );

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
  document
    .querySelectorAll("#idx-list .entity-row")
    .forEach((r) => r.classList.toggle("active", Number(r.dataset.id) === id));
  try {
    const d = await fetchJson(
      `/api/indices/${id}/series?days=${$("idx-days").value}&weight=${$("idx-weight").value}`,
    );
    $("idx-detail-title").textContent =
      `${d.name} · ${d.memberCount} 个成员 · 区间 ${d.changePct >= 0 ? "+" : ""}${d.changePct}%`;
    aggregateChart("idx-chart", d);
    $("idx-members").innerHTML = membersTable(d);
    $("idx-members")
      .querySelectorAll("tr[data-id]")
      .forEach((tr) => tr.addEventListener("click", () => openDetail(Number(tr.dataset.id))));
  } catch (e) {
    $("idx-chart").innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

async function loadQueries() {
  try {
    queriesCache = (await fetchJson("/api/queries")).queries || [];
  } catch {
    queriesCache = [];
  }
  const el = $("q-list");
  el.innerHTML = queriesCache.length
    ? queriesCache
        .map(
          (x) => `<div class="entity-row${x.id === currentQueryId ? " active" : ""}" data-id="${x.id}">
        <span class="entity-name">${escapeHtml(x.label)}</span>
        <span class="entity-spec"><code>${escapeHtml(x.query)}</code> · ${x.member_count} 成员${x.last_run_at ? ` · ${timeAgo(x.last_run_at)}` : " · 未运行"}</span>
        <button class="btn btn-sm btn-secondary entity-edit" data-id="${x.id}">编辑</button>
        <button class="btn btn-sm btn-danger entity-del" data-id="${x.id}">删除</button>
      </div>`,
        )
        .join("")
    : '<div class="empty"><p>还没有追踪的生态</p><p class="muted">添加一个 GitHub 搜索语法，刷新时自动抓取成员</p></div>';

  el.querySelectorAll(".entity-row").forEach((row) =>
    row.addEventListener("click", (e) => {
      if (e.target.classList.contains("entity-del")) return;
      if (e.target.classList.contains("entity-edit")) return;
      selectQuery(Number(row.dataset.id));
    }),
  );
  el.querySelectorAll(".entity-edit").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const q = queriesCache.find((x) => x.id === Number(b.dataset.id));
      if (!q) return;
      editingQueryId = Number(q.id);
      $("q-label").value = q.label;
      $("q-query").value = q.query;
      $("q-add").textContent = "保存修改";
      $("q-label").focus();
      $("q-status").textContent = `正在编辑「${q.label}」`;
    }),
  );
  el.querySelectorAll(".entity-del").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      await fetchJson(`/api/queries/${b.dataset.id}`, { method: "DELETE" });
      if (currentQueryId === Number(b.dataset.id)) {
        currentQueryId = null;
        $("q-chart").innerHTML = "";
        $("q-members").innerHTML = "";
        $("q-growth").innerHTML = "";
        $("q-detail-title").textContent = "生态走势";
      }
      loadQueries();
    }),
  );

  if (currentQueryId && queriesCache.some((x) => x.id === currentQueryId)) selectQuery(currentQueryId);
  else if (queriesCache.length) selectQuery(queriesCache[0].id);
  else {
    $("q-chart").innerHTML = "";
    $("q-members").innerHTML = "";
    $("q-growth").innerHTML = "";
    $("q-detail-title").textContent = "生态走势";
  }
}

async function selectQuery(id) {
  currentQueryId = id;
  document
    .querySelectorAll("#q-list .entity-row")
    .forEach((r) => r.classList.toggle("active", Number(r.dataset.id) === id));
  try {
    const d = await fetchJson(`/api/queries/${id}?days=${$("q-days").value}&weight=${$("q-weight").value}`);
    $("q-detail-title").textContent =
      `${d.label} · ${d.memberCount} 个成员 · 区间 ${d.changePct == null ? "—" : (d.changePct >= 0 ? "+" : "") + d.changePct + "%"}`;
    aggregateChart("q-chart", d);
    $("q-members").innerHTML = membersTable(d);
    $("q-members")
      .querySelectorAll("tr[data-id]")
      .forEach((tr) => tr.addEventListener("click", () => openDetail(Number(tr.dataset.id))));
    loadQueryGrowth(id);
  } catch (e) {
    $("q-chart").innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

/** 生态/Topic 成员的「新增 star」增长榜 */
async function loadQueryGrowth(id) {
  const el = $("q-growth");
  if (!el) return;
  const basis = $("q-growth-basis")?.value || "today";
  const limit = $("q-growth-limit")?.value || 10;
  try {
    const d = await fetchJson(`/api/queries/${id}/growth?basis=${basis}&limit=${limit}`);
    const excl = Number(d.excludedForSample) || 0;
    const note = excl
      ? `<p class="muted" style="font-size:12px">（已隐藏 ${excl} 个样本跨度不足 ${d.minSampleDays} 天的成员）</p>`
      : "";
    el.innerHTML =
      `<p class="muted" style="font-size:12px">口径：${escapeHtml(d.basisLabel)} · 成员 ${d.memberCount}</p>` +
      ((d.byGrowth || []).map((r, i) => lbItem(r, i + 1, "growth")).join("") ||
        '<div class="empty"><p>暂无增长数据（成员需至少 2 条快照）</p></div>') +
      note;
    el.querySelectorAll(".lb-item").forEach((x) =>
      x.addEventListener("click", () => openDetail(Number(x.dataset.id))),
    );
  } catch (e) {
    el.innerHTML = `<p class="muted">加载失败: ${escapeHtml(e.message)}</p>`;
  }
}
