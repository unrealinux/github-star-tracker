/**
 * layout.js —— Tab 切换（roving tabindex 方向键导航）与弹层焦点陷阱
 * （Tab 循环 / Esc 关闭 / 背景 inert / 焦点还原）。
 * 首次进入某 tab 时触发对应内容页的首屏加载（函数由后续文件提供）。
 */
/* global $, state, loadFavorites, loadCustomRepos, loadLanguageTrends, loadRankChanges, loadLeaderboard,
   loadFullRanking, loadSurges, initReplayDefault, initCompare, loadOverview, loadSignals, initIndices,
   loadExternalMetrics, loadSettings, closePalette */
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => {
      t.classList.remove("active");
      t.setAttribute("aria-selected", "false");
    });
    document.querySelectorAll(".tab-content").forEach((c) => {
      c.classList.remove("active");
      c.classList.add("hidden");
    });
    tab.classList.add("active");
    tab.setAttribute("aria-selected", "true");
    setTabIndexes();
    state.activeTab = tab.dataset.tab;
    const target = $(`tab-${state.activeTab}`);
    if (target) {
      target.classList.remove("hidden");
      target.classList.add("active");
    }
    if (state.activeTab === "favorites") loadFavorites();
    else if (state.activeTab === "custom") loadCustomRepos();
    else if (state.activeTab === "language-trend") loadLanguageTrends();
    else if (state.activeTab === "rank") loadRankChanges();
    else if (state.activeTab === "leaderboard") {
      loadLeaderboard();
      loadFullRanking();
    } else if (state.activeTab === "surge") {
      loadSurges();
      initReplayDefault();
    } else if (state.activeTab === "compare") initCompare();
    else if (state.activeTab === "overview") loadOverview();
    else if (state.activeTab === "signals") loadSignals();
    else if (state.activeTab === "indices") initIndices();
    else if (state.activeTab === "external") loadExternalMetrics();
    else if (state.activeTab === "settings") loadSettings();
  });
});

// ── 键盘可达性：Tab 方向键 + 弹层焦点陷阱 ──────────────────────────
// 1) 标签页：roving tabindex，方向键 / Home / End 切换并激活
const tabEls = [...document.querySelectorAll(".tab")];
const setTabIndexes = () => {
  for (const t of tabEls) t.tabIndex = t.classList.contains("active") ? 0 : -1;
};
setTabIndexes();
tabEls.forEach((tab, i) => {
  tab.addEventListener("keydown", (e) => {
    let target;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") target = tabEls[(i + 1) % tabEls.length];
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
      target = tabEls[(i - 1 + tabEls.length) % tabEls.length];
    else if (e.key === "Home") target = tabEls[0];
    else if (e.key === "End") target = tabEls[tabEls.length - 1];
    else return;
    e.preventDefault();
    target.focus();
    target.click();
  });
});

// 2) 弹层：Tab 在层内循环、Esc 关闭（登录层除外）、背景 inert、关闭后还原焦点
const OVERLAY_IDS = ["detail-overlay", "custom-overlay", "metric-overlay", "palette-overlay", "auth-overlay"];
const overlayById = (id) => document.getElementById(id);
const visibleOverlay = () =>
  OVERLAY_IDS.map(overlayById)
    .filter((el) => el && !el.classList.contains("hidden"))
    .pop() || null;
const overlayFocusables = (root) => {
  const sel =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return [...root.querySelectorAll(sel)].filter((el) => el.getClientRects().length > 0);
};

let currentOverlay = null;
let lastFocusedOutside = null;

document.addEventListener("focusin", (e) => {
  if (!(e.target instanceof Element) || !e.target.closest(".overlay")) lastFocusedOutside = e.target;
});

function syncOverlays() {
  const next = visibleOverlay();

  // 背景 inert：弹层打开时，非当前弹层的一切都不可聚焦（含其它隐藏弹层）
  for (const child of document.body.children) {
    if (child.tagName === "SCRIPT") continue;
    const isOverlay = child.classList?.contains("overlay");
    child.inert = isOverlay ? child !== next : Boolean(next);
  }

  if (next && next !== currentOverlay) {
    if (!next.hasAttribute("tabindex")) next.setAttribute("tabindex", "-1");
    (overlayFocusables(next)[0] || next).focus();
  } else if (!next && currentOverlay) {
    if (lastFocusedOutside && document.contains(lastFocusedOutside)) lastFocusedOutside.focus?.();
  }
  currentOverlay = next;
}

const overlayObserver = new MutationObserver(syncOverlays);
for (const id of OVERLAY_IDS) {
  const el = overlayById(id);
  if (el) overlayObserver.observe(el, { attributes: true, attributeFilter: ["class"] });
}

document.addEventListener("keydown", (e) => {
  const active = visibleOverlay();
  if (!active) return;

  if (e.key === "Escape") {
    if (active.id === "auth-overlay") return; // 登录弹层不因 Esc 关闭
    e.preventDefault();
    const closer = active.querySelector(".detail-close");
    if (closer) closer.click();
    else if (active.id === "palette-overlay") closePalette();
    return;
  }
  if (e.key !== "Tab") return;

  const f = overlayFocusables(active);
  if (!f.length) {
    e.preventDefault();
    active.focus();
    return;
  }
  const first = f[0];
  const last = f[f.length - 1];
  const idx = f.indexOf(document.activeElement);
  if (e.shiftKey && idx <= 0) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (idx === -1 || idx === f.length - 1)) {
    e.preventDefault();
    first.focus();
  }
});
