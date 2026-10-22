/**
 * core.js —— 共享命名空间的基础层：全局状态、API 会话（fetchJson）、格式化与提示 helpers。
 * 前端无构建步骤，多个 <script> 顺序加载；依赖顺序：
 *   core → charts → layout → repos → boards → settings → main
 */
/* global showAuth */
/* exported $, state, allRepos, languages, getApiKey, setApiKey, getSession, setSession, fetchJson, fmt, timeAgo, timeUntil, escapeHtml, setStatus, showError, populateLanguages */
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
  totalPages: 1,
  total: 0,
  keyword: "",
  onlyCustom: false,
  onlyFavorite: false,
  metric: "stars",
  activeTab: "repos",
  favPage: 1,
  customPage: 1,
};

let allRepos = [];
let languages = [];

// ── API Key 管理（P0-1）──
const getApiKey = () => localStorage.getItem("gst_api_key") || "";
const setApiKey = (k) =>
  k ? localStorage.setItem("gst_api_key", k) : localStorage.removeItem("gst_api_key");
const getSession = () => localStorage.getItem("gst_session") || "";
const setSession = (t) =>
  t ? localStorage.setItem("gst_session", t) : localStorage.removeItem("gst_session");

let authPrompted = false;
function handleUnauthorized() {
  if (authPrompted) return;
  authPrompted = true;
  const k = prompt("该服务已启用访问控制，请输入 API Key：");
  if (k) {
    setApiKey(k.trim());
    location.reload();
  }
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
  const d = Date.now() - t,
    m = Math.floor(d / 60000);
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
const escapeHtml = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
// CSP 下不可用内联 onclick：仓库名链接用 data-stop，在捕获阶段阻止冒泡到卡片
// （否则点链接会连带触发卡片的 openDetail）
document.addEventListener(
  "click",
  (e) => {
    if (e.target.closest("[data-stop]")) e.stopPropagation();
  },
  true,
);

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
// ── 工具 ──
function populateLanguages() {
  const sel = $("language");
  if (!sel) return;
  sel.innerHTML =
    '<option value="">全部</option>' +
    languages
      .map((l) => `<option value="${escapeHtml(l.language)}">${escapeHtml(l.language)}（${l.c}）</option>`)
      .join("");
  sel.value = state.language;
}
