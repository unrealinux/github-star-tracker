/**
 * main.js —— 事件绑定（全部 on()）、loadAll 编排、⌘K 命令面板、启动序列与
 * Service Worker 注册。script 顺序最后，保证所有被引用函数已定义。
 */
/* global $, state, fetchJson, fmt, escapeHtml, setStatus, showError, setApiKey, getApiKey, getSession, setSession,
   loadRepos, renderRepos, loadCustomRepos, closeDetail, loadAlerts, syncTodayBanner,
   toggleToday, exportCsv, loadLanguageTrends, loadRankChanges, loadLeaderboard, loadFullRanking,
   loadSurges, loadExternalMetrics, updateMetricPlaceholder, addCompareRepo,
   renderCompareChips, renderCompareEmpty, loadCompare, loadOverview, loadSignals, runBacktest,
   loadIndices, selectIndex, currentIndexId:writable, loadQueries, selectQuery,
   currentQueryId:writable, editingQueryId:writable, loadQueryGrowth, runReplay, initReplayDefault,
   loadViews, savedViews:writable, currentFilters, applyFilters, frPage:writable, cmpSelection:writable,
   loadSettings, loadStats, enablePush, disablePush, showAuth, submitAuth, loadUsers, logout,
   checkAuth, openDetail */
/* exported cmpSelection */ async function loadAll() {
  await Promise.all([loadSettings(), loadRepos(), loadStats(), loadViews()]);
  loadAlerts();
  syncTodayBanner();
}
// ── 事件绑定 ──
const on = (id, evt, fn) => {
  const el = $(id);
  if (el) el.addEventListener(evt, fn);
};

on("apply", "click", async () => {
  state.minStars = Number($("min-stars").value) || 0;
  state.minGrowth = Number($("min-growth").value) || 0;
  state.keyword = ($("keyword")?.value || "").trim();
  state.page = 1;
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
});
on("min-stars", "keydown", (e) => e.key === "Enter" && $("apply").click());
on("min-growth", "keydown", (e) => e.key === "Enter" && $("apply").click());
on("keyword", "keydown", (e) => e.key === "Enter" && $("apply").click());
on("language", "change", (e) => {
  state.language = e.target.value;
  state.page = 1;
  loadRepos();
});
on("metric", "change", (e) => {
  state.metric = e.target.value;
  state.page = 1;
  // 切到非星标指标时，默认改为按指标值排序更直观
  if (state.metric !== "stars" && state.sort === "stars") {
    state.sort = "metric";
    $("sort").value = "metric";
  }
  loadRepos();
});
on("sort", "change", (e) => {
  state.sort = e.target.value;
  state.page = 1;
  loadRepos();
});
on("window", "change", (e) => {
  state.window = e.target.value;
  state.page = 1;
  loadRepos();
});
on("highlight", "input", (e) => {
  state.highlightThreshold = Number(e.target.value) || 0;
  renderRepos();
});
on("pin-hot", "change", (e) => {
  state.pinHot = e.target.checked;
  renderRepos();
});
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
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
  }
});
on("detail-close", "click", closeDetail);
on("detail-overlay", "click", (e) => {
  if (e.target === $("detail-overlay")) closeDetail();
});
on("theme-toggle", "click", async () => {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "light" ? "dark" : cur === "dark" ? "contrast" : "light";
  document.documentElement.setAttribute("data-theme", next);
  try {
    await fetchJson("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: next }),
    });
  } catch {}
});
on("alert-badge", "click", () => document.querySelector('.tab[data-tab="settings"]')?.click());
on("clear-alerts", "click", async () => {
  await fetchJson("/api/alerts/read", { method: "POST" });
  loadAlerts();
});

on("add-custom-btn", "click", () => {
  $("custom-overlay").classList.remove("hidden");
  $("custom-name").value = "";
  $("custom-note").value = "";
  $("custom-error").classList.add("hidden");
});
on("custom-close", "click", () => $("custom-overlay").classList.add("hidden"));
on("custom-cancel", "click", () => $("custom-overlay").classList.add("hidden"));
on("custom-overlay", "click", (e) => {
  if (e.target === $("custom-overlay")) $("custom-overlay").classList.add("hidden");
});
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
    await fetchJson("/api/custom-repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ full_name: fullName, note }),
    });
    $("custom-overlay").classList.add("hidden");
    loadCustomRepos();
    setStatus(`已添加 ${fullName}，下次抓取时同步追踪`, "ok");
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove("hidden");
  }
});
on("custom-name", "keydown", (e) => e.key === "Enter" && $("custom-add").click());

on("save-settings", "click", async () => {
  try {
    await fetchJson("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        minStars: Number($("set-min-stars").value) || 0,
        minGrowth: Number($("set-min-growth").value) || 0,
        retentionDays: Number($("set-retention").value) || 90,
        alertThreshold: Number($("set-alert-threshold").value) || 50,
        autoPollMinutes: Number($("set-auto-poll").value) || 0,
        searchQuery: $("set-search-query")?.value || "",
        trendingEnabled: Boolean($("set-trending-enabled")?.checked),
        trendingDays: Number($("set-trending-days")?.value) || 30,
        trendingMinStars: Number($("set-trending-min-stars")?.value) || 0,
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
  } catch (e) {
    showError(e.message);
  }
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
    const r = await fetchJson("/api/notify/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, type }),
    });
    setStatus(`测试通知已发送（HTTP ${r.status}）`, "ok");
  } catch (err) {
    showError("发送失败: " + err.message);
  } finally {
    btn.disabled = false;
  }
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
  try {
    await downloadWithAuth("/api/maintenance/export", `github-star-tracker-backup-${stamp}.db`);
  } catch (err) {
    showError(err.message);
  }
});
on("export-json", "click", async () => {
  const stamp = new Date().toISOString().slice(0, 10);
  try {
    await downloadWithAuth("/api/maintenance/export?format=json", `github-star-tracker-export-${stamp}.json`);
  } catch (err) {
    showError(err.message);
  }
});
on("import-json", "change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const mode = confirm("确定 = 合并导入（保留现有数据）\n取消 = 覆盖导入（先清空再导入）")
    ? "merge"
    : "replace";
  try {
    const data = JSON.parse(await file.text());
    const r = await fetchJson("/api/maintenance/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, data }),
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
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
  }
});
on("backfill-btn", "click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  setStatus("正在回填历史（可能需要一会儿）…", "loading");
  try {
    const r = await fetchJson("/api/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "custom", limit: 10 }),
    });
    const inserted = (r.results || []).reduce((a, x) => a + (x.inserted || 0), 0);
    setStatus(`回填完成：${r.count} 个仓库，新增 ${inserted} 个历史点`, "ok");
    await Promise.all([loadStats(), loadCustomRepos()]);
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
  }
});
on("cleanup-btn", "click", async () => {
  try {
    const r = await fetchJson("/api/maintenance/cleanup", { method: "POST" });
    const roll = r.rolledUp ? `，降采样 ${r.rolledUp} 条` : "";
    setStatus(`已清理 ${r.removed} 条过期快照${roll}`, "ok");
    loadStats();
  } catch (e) {
    showError(e.message);
  }
});
on("trend-window", "change", loadLanguageTrends);
on("rank-window", "change", loadRankChanges);
on("lb-limit", "change", loadLeaderboard);
on("lb-basis", "change", loadLeaderboard);
on("lb-metric", "change", loadLeaderboard);
on("fr-prev", "click", () => {
  if (frPage > 1) {
    frPage--;
    loadFullRanking();
  }
});
on("fr-next", "click", () => {
  frPage++;
  loadFullRanking();
});
on("fr-page-size", "change", () => {
  frPage = 1;
  loadFullRanking();
});
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
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
  }
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
on("metric-overlay", "click", (e) => {
  if (e.target === $("metric-overlay")) $("metric-overlay").classList.add("hidden");
});
on("metric-add", "click", async () => {
  const source = $("metric-source").value;
  const key = $("metric-key").value.trim();
  const errEl = $("metric-error");
  if (!key) {
    errEl.textContent = "请输入指标名称";
    errEl.classList.remove("hidden");
    return;
  }
  try {
    const r = await fetchJson("/api/metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, key }),
    });
    $("metric-overlay").classList.add("hidden");
    setStatus(`已添加，当前值 ${fmt(r.value)}`, "ok");
    loadExternalMetrics();
    loadStats();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove("hidden");
  }
});
on("metric-key", "keydown", (e) => e.key === "Enter" && $("metric-add").click());
on("surge-reload", "click", loadSurges);

// ⚖️ 对比
on("cmp-add", "click", () => addCompareRepo($("cmp-input").value));
on("cmp-input", "keydown", (e) => {
  if (e.key === "Enter") addCompareRepo(e.target.value);
});
on("cmp-clear", "click", () => {
  cmpSelection = [];
  renderCompareChips();
  renderCompareEmpty();
});
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
[
  "an-days",
  "an-z",
  "an-min",
  "an-min-stars",
  "rs-max",
  "rs-min",
  "rs-days",
  "ev-days",
  "ev-z",
  "ev-min-repos",
  "ev-min",
].forEach((id) => on(id, "change", loadSignals));

// 🧭 指数与生态
on("idx-add", "click", async () => {
  const name = ($("idx-name").value || "").trim();
  if (!name) return showError("请输入指数名称");
  try {
    const r = await fetchJson("/api/indices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  } catch (e) {
    showError(e.message);
  }
});
on("idx-days", "change", () => currentIndexId && selectIndex(currentIndexId));
on("idx-weight", "change", () => currentIndexId && selectIndex(currentIndexId));

on("q-add", "click", async () => {
  const label = ($("q-label").value || "").trim();
  const query = ($("q-query").value || "").trim();
  if (!label || !query) return showError("请输入名称和搜索语法");
  try {
    const editing = editingQueryId;
    const r = editing
      ? await fetchJson(`/api/queries/${editing}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label, query }),
        })
      : await fetchJson("/api/queries", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label, query }),
        });
    $("q-label").value = "";
    $("q-query").value = "";
    editingQueryId = null;
    $("q-add").textContent = "添加追踪";
    currentQueryId = editing || r.id;
    await loadQueries();
    $("q-status").textContent = editing
      ? "已保存，点「立即刷新成员」重新抓取"
      : "已添加，点「立即刷新成员」抓取";
  } catch (e) {
    showError(e.message);
  }
});
on("q-refresh", "click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  $("q-status").textContent = "正在抓取成员…";
  try {
    const r = await fetchJson("/api/queries/refresh", { method: "POST" });
    $("q-status").textContent = `已刷新 ${r.updated}/${r.queries} 个追踪，共 ${r.members} 个成员`;
    await loadQueries();
  } catch (err) {
    showError(err.message);
    $("q-status").textContent = "";
  } finally {
    btn.disabled = false;
  }
});
on("q-days", "change", () => currentQueryId && selectQuery(currentQueryId));
on("q-weight", "change", () => currentQueryId && selectQuery(currentQueryId));
on("q-growth-basis", "change", () => currentQueryId && loadQueryGrowth(currentQueryId));
on("q-growth-limit", "change", () => currentQueryId && loadQueryGrowth(currentQueryId));

// 💾 保存的视图
on("view-save", "click", async () => {
  const name = ($("view-name").value || "").trim();
  if (!name) return showError("请输入视图名称");
  try {
    savedViews = (
      await fetchJson("/api/views", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, filters: currentFilters() }),
      })
    ).views;
    await loadViews();
    $("view-select").value = name;
    $("view-name").value = "";
    setStatus(`已保存视图「${name}」`, "ok");
  } catch (e) {
    showError(e.message);
  }
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
  } catch (e) {
    showError(e.message);
  }
});
on("replay-go", "click", runReplay);
on("replay-now", "click", () => {
  initReplayDefault();
  $("replay-result").innerHTML = "";
  $("replay-status").textContent = "";
});
on("auth-submit", "click", submitAuth);
on("enable-multiuser-btn", "click", () => showAuth("register"));
on("auth-username", "keydown", (e) => e.key === "Enter" && submitAuth());
on("auth-password", "keydown", (e) => e.key === "Enter" && submitAuth());
on("logout-btn", "click", logout);
on("change-pass-btn", "click", async () => {
  const pw = $("my-new-pass").value || "";
  try {
    await fetchJson("/api/auth/password", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    $("my-new-pass").value = "";
    setStatus("密码已修改，请重新登录", "ok");
    setTimeout(() => {
      setSession("");
      location.reload();
    }, 800);
  } catch (e) {
    showError(e.message);
  }
});
on("add-user-btn", "click", async () => {
  const username = ($("new-user-name").value || "").trim();
  const password = $("new-user-pass").value || "";
  try {
    await fetchJson("/api/auth/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, role: $("new-user-role").value }),
    });
    $("new-user-name").value = "";
    $("new-user-pass").value = "";
    loadUsers();
  } catch (e) {
    showError(e.message);
  }
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
  {
    kind: "动作",
    title: "🔎 打开信号面板",
    run: () => document.querySelector(".tab[data-tab=signals]")?.click(),
  },
];

const paletteTabCommands = () =>
  Array.from(document.querySelectorAll(".tab")).map((t) => ({
    kind: "页面",
    title: t.textContent.trim(),
    run: () => t.click(),
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
  } catch {
    /* 离线时仅保留页面/动作） */
  }
}

function openPalette() {
  $("palette-overlay").classList.remove("hidden");
  const input = $("palette-input");
  input.value = "";
  renderPalette("");
  input.focus();
  loadPaletteRepos().then(() => {
    if (!$("palette-overlay").classList.contains("hidden")) renderPalette(input.value);
  });
}

function closePalette() {
  $("palette-overlay").classList.add("hidden");
}

function renderPalette(q) {
  const query = String(q || "")
    .trim()
    .toLowerCase();
  const all = [...paletteActions(), ...paletteTabCommands(), ...paletteRepoCommands];
  paletteItems = query
    ? all.filter((x) => x.title.toLowerCase().includes(query)).slice(0, 40)
    : [...paletteActions(), ...paletteTabCommands(), ...paletteRepoCommands.slice(0, 12)];
  paletteActive = 0;
  const el = $("palette-list");
  el.innerHTML = paletteItems.length
    ? paletteItems
        .map(
          (x, i) => `<div class="palette-item${i === 0 ? " active" : ""}" data-i="${i}">
        <span class="palette-kind">${escapeHtml(x.kind)}</span>
        <span class="palette-title">${escapeHtml(x.title)}</span>
        ${x.subtitle ? `<span class="palette-sub">${escapeHtml(x.subtitle)}</span>` : ""}
      </div>`,
        )
        .join("")
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
  } catch (e) {
    showError(e.message);
  }
});
on("palette-overlay", "click", (e) => {
  if (e.target === $("palette-overlay")) closePalette();
});
on("palette-input", "input", (e) => renderPalette(e.target.value));
on("palette-input", "keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    movePalette(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    movePalette(-1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    runPaletteItem(paletteActive);
  }
});

// 启动：先确认登录状态，再加载数据
(async () => {
  const ok = await checkAuth();
  if (ok) loadAll();
})();

// PWA：注册 Service Worker（离线可打开界面）
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* 非 https/localhost 时忽略 */
    });
  });
}
