const $ = (id) => document.getElementById(id);

const state = {
  minStars: 1000,
  minGrowth: 0,
  language: "",
  sort: "growth",
  window: "day",
  highlightThreshold: 50,
  pinHot: false,
  todayOnly: false,
  page: 1,
  pageSize: 50,
};

let allRepos = [];
let languages = [];

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

const fmt = (n) => (n == null ? "–" : n.toLocaleString("zh-CN"));

function timeAgo(iso) {
  if (!iso) return "–";
  const norm = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso)
    ? iso.replace(" ", "T") + "Z"
    : iso;
  const t = Date.parse(norm);
  if (!t) return "–";
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

function timeUntil(iso) {
  if (!iso) return "–";
  const t = Date.parse(iso);
  if (!t) return "–";
  const diff = t - Date.now();
  if (diff <= 0) return "即将触发";
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m} 分钟内`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时后`;
  const d = Math.floor(h / 24);
  return `${d} 天后`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderStats(stats) {
  $("stat-repos").textContent = fmt(stats.repoCount);
  $("stat-snapshots").textContent = fmt(stats.snapCount);
  $("stat-last").textContent = timeAgo(stats.lastRefresh);
  $("stat-pending").textContent = fmt(stats.pendingGrowth);
  const auto = stats.auto || {};
  $("stat-next").textContent = !auto.enabled ? "已停用" : timeUntil(auto.nextRun);
  $("token-status").textContent = stats.tokenConfigured ? "已配置 Token" : "匿名模式（配额低）";
  $("token-status").className = "token-status " + (stats.tokenConfigured ? "ok" : "warn");
}

function populateLanguages() {
  const sel = $("language");
  const current = state.language;
  sel.innerHTML = '<option value="">全部</option>' +
    languages.map((l) => `<option value="${escapeHtml(l.language)}">${escapeHtml(l.language)}（${l.c}）</option>`).join("");
  sel.value = current;
}

function sparkline(spark, w = 80, h = 26) {
  if (!spark || spark.length < 2) {
    return `<svg width="${w}" height="${h}" class="spark" aria-hidden="true"><line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" stroke="currentColor" stroke-opacity="0.25" stroke-width="1"/></svg>`;
  }
  const vals = spark.map((p) => p.stars);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const pad = 3;
  const step = (w - pad * 2) / (vals.length - 1);
  const pts = vals.map((v, i) => [
    (pad + i * step).toFixed(1),
    ((h - pad * 2) * (1 - (v - min) / range) + pad).toFixed(1),
  ]);
  return `<svg width="${w}" height="${h}" class="spark" aria-hidden="true"><polyline points="${pts.map((p) => p.join(",")).join(" ")}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
}

function growthCell(r) {
  if (r.growth == null) return `<span class="growth muted">待积累</span>`;
  const cls = r.growth >= 50 ? "hot" : r.growth >= 10 ? "good" : "";
  return `<span class="growth ${cls}">+${fmt(r.growth)} <small>${escapeHtml(r.growthLabel)}</small></span>`;
}

const isHot = (r) => r.growth !== null && r.growth >= state.highlightThreshold;

/** 当前视图的仓库：先做今日榜过滤，再按需把高增长置顶。 */
function viewRepos() {
  let list = allRepos;
  if (state.todayOnly) list = list.filter((r) => r.growth !== null && r.growth > 0);
  if (state.pinHot) list = list.slice().sort((a, b) => (isHot(b) ? 1 : 0) - (isHot(a) ? 1 : 0));
  return list;
}

function renderRepos() {
  const el = $("list");
  const list = viewRepos();
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  if (state.page > pages) state.page = pages;
  const start = (state.page - 1) * state.pageSize;
  const slice = list.slice(start, start + state.pageSize);

  $("list-count").textContent = `${total} 个项目`;

  if (total === 0) {
    el.innerHTML = `<div class="empty"><p>没有符合条件的项目</p><p class="muted">可降低筛选阈值，或先点击「立即更新数据」获取快照。</p></div>`;
    renderPagination();
    return;
  }

  el.innerHTML = slice.map((r, i) => {
    const hot = isHot(r);
    return `
    <div class="repo-row ${hot ? "repo-hot" : ""}" data-id="${r.id}">
      <div class="rank">${start + i + 1}</div>
      <div class="repo-main">
        <a class="repo-name" href="${escapeHtml(r.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${escapeHtml(r.full_name)}</a>
        ${hot ? '<span class="hot-badge">🔥 高增长</span>' : ""}
        <p class="repo-desc">${escapeHtml(r.description || "（无描述）")}</p>
        <div class="repo-meta">
          ${r.language ? `<span class="lang">${escapeHtml(r.language)}</span>` : ""}
          <span class="muted">收录 ${timeAgo(r.first_seen_at)}</span>
        </div>
      </div>
      <div class="repo-spark">${sparkline(r.spark)}</div>
      <div class="repo-star">★ ${fmt(r.stars)}</div>
      <div class="repo-growth">${growthCell(r)}</div>
    </div>`;
  }).join("");

  el.querySelectorAll(".repo-row").forEach((row) => {
    row.addEventListener("click", () => openDetail(Number(row.dataset.id)));
  });

  renderPagination();
}

function renderPagination() {
  const el = $("pagination");
  const total = viewRepos().length;
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  if (total === 0 || pages <= 1) { el.innerHTML = ""; return; }
  el.innerHTML = `
    <button class="btn btn-secondary" id="pg-prev" ${state.page <= 1 ? "disabled" : ""}>上一页</button>
    <span class="pg-info">第 ${state.page} / ${pages} 页</span>
    <button class="btn btn-secondary" id="pg-next" ${state.page >= pages ? "disabled" : ""}>下一页</button>
  `;
  $("pg-prev")?.addEventListener("click", () => { state.page = Math.max(1, state.page - 1); renderRepos(); });
  $("pg-next")?.addEventListener("click", () => { state.page = Math.min(pages, state.page + 1); renderRepos(); });
}

async function loadSettings() {
  const s = await fetchJson("/api/settings");
  state.minStars = s.minStars;
  state.minGrowth = s.minGrowth;
  $("min-stars").value = s.minStars;
  $("min-growth").value = s.minGrowth;
}

async function loadRepos() {
  const qs = new URLSearchParams({
    minStars: state.minStars,
    minGrowth: state.minGrowth,
    language: state.language,
    sort: state.sort,
    window: state.window,
  });
  const data = await fetchJson(`/api/repos?${qs}`);
  languages = data.languages || [];
  populateLanguages();
  allRepos = data.repos;
  state.page = 1;
  renderRepos();
}

async function loadStats() {
  renderStats(await fetchJson("/api/stats"));
}

async function loadAll() {
  try {
    await Promise.all([loadSettings(), loadRepos(), loadStats()]);
  } catch (e) {
    showError(e.message);
  }
}

async function applyFilter() {
  state.minStars = Number($("min-stars").value) || 0;
  state.minGrowth = Number($("min-growth").value) || 0;
  try {
    await fetchJson("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minStars: state.minStars, minGrowth: state.minGrowth }),
    });
    setStatus("已应用筛选", "ok");
    await loadRepos();
  } catch (e) {
    showError(e.message);
  }
}

async function doRefresh() {
  const btn = $("refresh");
  btn.disabled = true;
  setStatus("正在抓取 GitHub，请稍候…", "loading");
  try {
    const r = await fetchJson("/api/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    setStatus(`抓取完成：更新 ${r.upserted} 个项目`, "ok");
    await Promise.all([loadRepos(), loadStats()]);
  } catch (e) {
    showError(e.message);
  } finally {
    btn.disabled = false;
  }
}

function syncTodayBanner() {
  $("today").classList.toggle("active", state.todayOnly);
  const banner = $("today-banner");
  if (state.todayOnly) {
    const n = viewRepos().filter((r) => r.growth !== null && r.growth > 0).length;
    banner.textContent = `🔥 今日新增榜：仅显示今日获星的项目（增速 > 0），共 ${n} 个`;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

async function toggleToday() {
  state.todayOnly = !state.todayOnly;
  if (state.todayOnly) {
    state.window = "day";
    state.sort = "growth";
    $("window").value = "day";
    $("sort").value = "growth";
  }
  try {
    await loadRepos();
    syncTodayBanner();
  } catch (e) {
    showError(e.message);
  }
}

function exportCsv() {
  const list = viewRepos();
  const header = ["排名", "仓库", "链接", "星数", "增速", "窗口", "语言", "描述", "收录时间"];
  const rows = list.map((r, i) => [
    i + 1, r.full_name, r.url || "", r.stars ?? "", r.growth ?? "", r.growthLabel || "",
    r.language || "", (r.description || "").replace(/\s+/g, " "), r.first_seen_at || "",
  ]);
  const csv = "\uFEFF" + [header, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `github-stars-${state.window}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus(`已导出 ${list.length} 行 CSV`, "ok");
}

function historyChart(history, w = 560, h = 170) {
  if (!history || history.length < 2) {
    return `<p class="muted">快照不足，继续积累后可查看趋势（当前 ${history ? history.length : 0} 个快照）。</p>`;
  }
  const vals = history.map((p) => p.stars);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const padL = 8, padR = 8, padT = 12, padB = 24;
  const iw = w - padL - padR;
  const ih = h - padT - padB;
  const step = iw / (vals.length - 1);
  const xy = vals.map((v, i) => [
    (padL + i * step).toFixed(1),
    (padT + ih * (1 - (v - min) / range)).toFixed(1),
  ]);
  const line = xy.map((p) => p.join(",")).join(" ");
  const area = `${padL},${padT + ih} ${line} ${padL + iw},${padT + ih}`;
  const xLabels = [0, Math.floor((vals.length - 1) / 2), vals.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  return `
    <svg width="${w}" height="${h}" class="history-chart" role="img">
      <polygon points="${area}" fill="currentColor" fill-opacity="0.08"/>
      <polyline points="${line}" fill="none" stroke="currentColor" stroke-width="2"/>
      ${vals.map((_, i) => `<circle cx="${xy[i][0]}" cy="${xy[i][1]}" r="3" class="pt"/>`).join("")}
      ${xLabels.map((idx) => `<text x="${xy[idx][0]}" y="${h - 6}" text-anchor="middle" class="axis">${escapeHtml(history[idx].captured_at.slice(0, 10))}</text>`).join("")}
      <text x="${padL}" y="${padT - 2}" class="axis">${fmt(max)}</text>
      <text x="${padL}" y="${padT + ih}" class="axis">${fmt(min)}</text>
    </svg>`;
}

async function openDetail(id) {
  try {
    const data = await fetchJson(`/api/repos/${id}/history`);
    const r = data.repo;
    const history = data.history;
    $("detail-body").innerHTML = `
      <div class="detail-head">
        <a class="repo-name" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.full_name)}</a>
        <span class="detail-stars">★ ${fmt(r.stars)}</span>
      </div>
      ${r.description ? `<p class="detail-desc">${escapeHtml(r.description)}</p>` : ""}
      <div class="detail-meta">
        ${r.language ? `<span class="lang">${escapeHtml(r.language)}</span>` : ""}
        <span class="muted">收录 ${timeAgo(r.first_seen_at)}</span>
        ${r.gh_created_at ? `<span class="muted">GitHub 始建于 ${escapeHtml(r.gh_created_at.slice(0, 10))}</span>` : ""}
        ${r.homepage ? `<a class="link" href="${escapeHtml(r.homepage)}" target="_blank" rel="noopener">主页</a>` : ""}
      </div>
      <div class="detail-chart">
        <div class="detail-chart-title">星标历史</div>
        ${historyChart(history)}
      </div>`;
    $("detail-overlay").classList.remove("hidden");
  } catch (e) {
    showError(e.message);
  }
}

function closeDetail() {
  $("detail-overlay").classList.add("hidden");
  $("detail-body").innerHTML = "";
}

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = "status " + (kind || "");
}

function showError(msg) {
  const el = $("error");
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 6000);
}

$("apply").addEventListener("click", applyFilter);
$("min-stars").addEventListener("keydown", (e) => e.key === "Enter" && applyFilter());
$("min-growth").addEventListener("keydown", (e) => e.key === "Enter" && applyFilter());
$("language").addEventListener("change", (e) => { state.language = e.target.value; loadRepos().catch((er) => showError(er.message)); });
$("sort").addEventListener("change", (e) => { state.sort = e.target.value; loadRepos().catch((er) => showError(er.message)); });
$("window").addEventListener("change", (e) => { state.window = e.target.value; loadRepos().catch((er) => showError(er.message)); });
$("today").addEventListener("click", toggleToday);
$("export").addEventListener("click", exportCsv);
$("highlight").addEventListener("input", () => { state.highlightThreshold = Number($("highlight").value) || 0; renderRepos(); });
$("pin-hot").addEventListener("change", (e) => { state.pinHot = e.target.checked; renderRepos(); });
$("refresh").addEventListener("click", doRefresh);
$("detail-close").addEventListener("click", closeDetail);
$("detail-overlay").addEventListener("click", (e) => { if (e.target === $("detail-overlay")) closeDetail(); });

loadAll();
