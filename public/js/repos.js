/**
 * repos.js —— 仓库列表视图：加载/渲染/分页、详情弹窗、收藏与自定义仓库、
 * 导出 CSV、今日榜切换、保存的筛选视图。
 */
/* global $, state, allRepos:writable, languages:writable, fetchJson, fmt, escapeHtml, timeAgo,
   setStatus, showError, sparkline, populateLanguages, dailyPoints, lineChart, bindCharts,
   predictionBlock, compactNum, loadStats */
/* exported languages, loadRepos, openDetail, closeDetail, loadFavorites, loadCustomRepos, syncTodayBanner, toggleToday, exportCsv, loadViews, currentFilters, applyFilters */
async function loadRepos() {
  try {
    const qs = new URLSearchParams({
      minStars: state.minStars,
      minGrowth: state.minGrowth,
      language: state.language,
      sort: state.sort,
      window: state.window,
      page: state.page,
      pageSize: state.pageSize,
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
// ── 仓库列表 ──
function growthCell(r) {
  const avg =
    r.avgDailyGrowth != null
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
    el.innerHTML =
      '<div class="empty"><p>没有符合条件的项目</p><p class="muted">可降低筛选阈值，或点击「立即更新数据」。</p></div>';
    renderPagination();
    return;
  }

  const start = (state.page - 1) * state.pageSize;
  el.innerHTML = list
    .map(
      (r, i) => `
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
    </div>`,
    )
    .join("");

  el.querySelectorAll(".repo-row").forEach((row) => {
    row.addEventListener("click", () => openDetail(Number(row.dataset.id)));
  });
  renderPagination();
}

function renderPagination() {
  const el = $("pagination");
  const pages = state.totalPages;
  if (state.total === 0 || pages <= 1) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <button class="btn btn-secondary" id="pg-prev" ${state.page <= 1 ? "disabled" : ""}>上一页</button>
    <span class="pg-info">第 ${state.page} / ${pages} 页（共 ${state.total} 个）</span>
    <button class="btn btn-secondary" id="pg-next" ${state.page >= pages ? "disabled" : ""}>下一页</button>`;
  $("pg-prev")?.addEventListener("click", () => {
    state.page--;
    loadRepos();
  });
  $("pg-next")?.addEventListener("click", () => {
    state.page++;
    loadRepos();
  });
}

// ── 详情 ──
async function openDetail(id) {
  try {
    const data = await fetchJson(
      `/api/repos/${id}/history?metric=${encodeURIComponent(state.metric || "stars")}`,
    );
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
      if (pts.length < 2) {
        $("hist-chart").innerHTML = '<p class="muted">快照不足，继续积累后可查看趋势。</p>';
        return;
      }
      $("hist-chart").innerHTML = lineChart({
        series: [{ name: data.metricLabel || "指标", color: "var(--accent)", points: pts }],
        logScale: $("hist-log").checked,
        markers:
          data.metric === "stars"
            ? (data.events || []).map((e) => ({
                x: String(e.date).slice(0, 10),
                label: e.type === "milestone" ? e.label : "",
                message: e.message,
                color: e.type === "milestone" ? "#f59e0b" : e.type === "drop" ? "var(--red)" : "var(--green)",
              }))
            : [],
      });
      bindCharts($("hist-chart"));
    };
    $("hist-controls")
      .querySelectorAll("button[data-range]")
      .forEach((b) =>
        b.addEventListener("click", () => {
          histRange = b.dataset.range;
          $("hist-controls")
            .querySelectorAll("button[data-range]")
            .forEach((x) => (x.className = `btn btn-sm ${x === b ? "btn-primary" : "btn-secondary"}`));
          drawHistory();
        }),
      );
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
    } catch {
      /* 忽略 */
    }

    $("repo-threshold-save").addEventListener("click", async () => {
      const raw = $("repo-threshold").value.trim();
      try {
        const res = await fetchJson(`/api/repos/${r.id}/alert`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threshold: raw === "" ? null : Number(raw) }),
        });
        $("repo-threshold-hint").textContent =
          res.threshold == null ? "已恢复全局阈值" : `已设为 ${res.threshold}`;
      } catch (err) {
        showError(err.message);
      }
    });

    $("bf-btn").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "回填中…";
      try {
        const res = await fetchJson(`/api/repos/${r.id}/backfill`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
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
      const sim = await fetchJson(`/api/repos/${r.id}/similar?limit=6`);
      $("similar-block").innerHTML = sim.similar.length
        ? sim.similar
            .map(
              (x) => `<div class="similar-item" data-id="${x.id}">
            <span class="repo-name">${escapeHtml(x.full_name)}</span>
            <span class="lang">${escapeHtml(x.reason)}</span>
            <span class="muted">★ ${fmt(x.stars)}</span>
          </div>`,
            )
            .join("")
        : '<p class="muted" style="font-size:12px">暂无相似项目</p>';
      $("similar-block")
        .querySelectorAll(".similar-item")
        .forEach((el) => el.addEventListener("click", () => openDetail(Number(el.dataset.id))));
    } catch {
      $("similar-block").innerHTML = "";
    }

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
      ]
        .filter(Boolean)
        .join("");
      const rel = e.latestRelease
        ? `<div class="release-line">🏷 最新版本 <a class="link" href="${escapeHtml(e.latestRelease.url)}" target="_blank" rel="noopener">${escapeHtml(e.latestRelease.name || e.latestRelease.tag)}</a>${e.latestRelease.published_at ? ` · ${timeAgo(e.latestRelease.published_at)}` : ""}${e.latestRelease.prerelease ? ' <span class="muted">(预发布)</span>' : ""}</div>`
        : '<div class="muted" style="font-size:12px">暂无 release</div>';
      $("enrich-block").innerHTML =
        `${chips ? `<div class="topic-row">${chips}</div>` : ""}<div class="fact-row">${facts}</div>${rel}`;
    } catch (err) {
      $("enrich-block").innerHTML =
        `<p class="muted" style="font-size:12px">获取失败：${escapeHtml(err.message)}</p>`;
    }
  } catch (e) {
    showError(e.message);
  }
}

function closeDetail() {
  $("detail-overlay").classList.add("hidden");
  $("detail-body").innerHTML = "";
}

// ── 收藏（分页）──
async function loadFavorites() {
  try {
    const data = await fetchJson(`/api/favorites?page=${state.favPage}&pageSize=50`);
    const repos = data.repos || [];
    const el = $("fav-list");
    $("fav-count").textContent = `${data.total} 个收藏`;
    if (repos.length === 0) {
      el.innerHTML =
        '<div class="empty"><p>还没有收藏任何仓库</p><p class="muted">点击仓库行查看详情，在弹窗中点「☆ 收藏」</p></div>';
      $("fav-pagination").innerHTML = "";
      return;
    }
    el.innerHTML = repos
      .map(
        (r) => `
      <div class="repo-row" data-id="${r.id}">
        <div class="rank">⭐</div>
        <div class="repo-main">
          <a class="repo-name" href="${escapeHtml(r.url)}" target="_blank" rel="noopener" data-stop="1">${escapeHtml(r.full_name)}</a>
          <p class="repo-desc">${escapeHtml(r.description || "（无描述）")}</p>
          <div class="repo-meta"><span class="muted">收藏于 ${timeAgo(r.added_at)}</span></div>
        </div>
        <div class="repo-star">★ ${fmt(r.stars)}</div>
        <button class="btn btn-sm btn-danger unfav-btn" data-id="${r.id}">移除</button>
      </div>`,
      )
      .join("");
    el.querySelectorAll(".unfav-btn").forEach((btn) =>
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await fetchJson(`/api/favorites/${btn.dataset.id}/toggle`, { method: "POST" });
        loadFavorites();
        loadStats();
      }),
    );
    el.querySelectorAll(".repo-row").forEach((row) =>
      row.addEventListener("click", () => openDetail(Number(row.dataset.id))),
    );
    renderPager("fav-pagination", data, (p) => {
      state.favPage = p;
      loadFavorites();
    });
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
      el.innerHTML =
        '<div class="empty"><p>还没有添加自定义仓库</p><p class="muted">点击右上角「+ 添加仓库」开始追踪</p></div>';
      $("custom-pagination").innerHTML = "";
      return;
    }
    el.innerHTML = repos
      .map(
        (r) => `
      <div class="custom-item">
        <span class="ci-name">${escapeHtml(r.full_name)}</span>
        ${r.stale ? `<span class="ci-stale" title="${escapeHtml(r.last_error || "")}${r.stale_since ? " · 自 " + escapeHtml(String(r.stale_since).slice(0, 10)) : ""}">⚠️ 已失效</span>` : ""}
        ${r.user_note ? `<span class="ci-note">${escapeHtml(r.user_note)}</span>` : ""}
        <span class="ci-added">${timeAgo(r.added_at)}</span>
        <button class="btn btn-sm btn-danger del-custom" data-name="${escapeHtml(r.full_name)}">删除</button>
      </div>`,
      )
      .join("");
    el.querySelectorAll(".del-custom").forEach((btn) =>
      btn.addEventListener("click", async () => {
        await fetchJson(`/api/custom-repos/${encodeURIComponent(btn.dataset.name)}`, { method: "DELETE" });
        loadCustomRepos();
      }),
    );
    renderPager("custom-pagination", data, (p) => {
      state.customPage = p;
      loadCustomRepos();
    });
  } catch (e) {
    $("custom-list").innerHTML = `<div class="empty"><p>加载失败: ${escapeHtml(e.message)}</p></div>`;
  }
}

function renderPager(elId, data, onPage) {
  const el = $(elId);
  if (!el) return;
  if (!data || data.totalPages <= 1) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <button class="btn btn-secondary" id="${elId}-prev" ${data.page <= 1 ? "disabled" : ""}>上一页</button>
    <span class="pg-info">第 ${data.page} / ${data.totalPages} 页（共 ${data.total} 个）</span>
    <button class="btn btn-secondary" id="${elId}-next" ${data.page >= data.totalPages ? "disabled" : ""}>下一页</button>`;
  $(`${elId}-prev`)?.addEventListener("click", () => onPage(data.page - 1));
  $(`${elId}-next`)?.addEventListener("click", () => onPage(data.page + 1));
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
  if (state.todayOnly) {
    state.window = "day";
    state.sort = "growth";
    $("window").value = "day";
    $("sort").value = "growth";
  }
  await loadRepos();
  syncTodayBanner();
}

function exportCsv() {
  if (allRepos.length === 0) return setStatus("没有可导出的数据", "warn");
  const header = ["排名", "仓库", "链接", "星数", "增速", "窗口", "语言", "描述", "收录时间"];
  const rows = allRepos.map((r, i) => [
    (state.page - 1) * state.pageSize + i + 1,
    r.full_name,
    r.url || "",
    r.stars ?? "",
    r.growth ?? "",
    r.growthLabel || "",
    r.language || "",
    (r.description || "").replace(/\s+/g, " "),
    r.first_seen_at || "",
  ]);
  const csv =
    "\uFEFF" +
    [header, ...rows].map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  a.download = `github-stars-${state.window}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus(`已导出当前页 ${allRepos.length} 行 CSV`, "ok");
}
// ── 💾 保存的筛选视图（C5）──
let savedViews = [];

async function loadViews() {
  try {
    savedViews = (await fetchJson("/api/views")).views || [];
  } catch {
    savedViews = [];
  }
  const sel = $("view-select");
  if (!sel) return;
  sel.innerHTML =
    '<option value="">— 保存的视图 —</option>' +
    savedViews.map((v) => `<option value="${escapeHtml(v.name)}">${escapeHtml(v.name)}</option>`).join("");
}

function currentFilters() {
  return {
    minStars: state.minStars,
    minGrowth: state.minGrowth,
    language: state.language,
    sort: state.sort,
    window: state.window,
    metric: state.metric,
    keyword: state.keyword,
    todayOnly: state.todayOnly,
    onlyCustom: state.onlyCustom,
    onlyFavorite: state.onlyFavorite,
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
