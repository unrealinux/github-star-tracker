/**
 * settings.js —— 设置页与头部状态：统计面板渲染、设置加载、告警预览、
 * Web Push 订阅、多用户登录 / 账号 / 用户管理。
 */
/* global $, state, fetchJson, fmt, timeAgo, timeUntil, escapeHtml, getApiKey, getSession, setSession, showError, loadAll */
/* exported renderStats, loadStats, loadSettings, loadAlerts, refreshPushStatus, enablePush, disablePush, checkAuth, showAuth, submitAuth, logout, loadUsers */
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
    ok: { text: "Token ✅", cls: "ok", title: "token 已校验可用" },
    invalid: {
      text: "Token 失效·已回退匿名",
      cls: "warn",
      title: "GitHub 返回 401，已自动改用匿名请求（配额较低）。请更换 GITHUB_TOKEN 或 GH_TOKEN",
    },
    none: { text: "匿名模式", cls: "warn", title: "未配置 GITHUB_TOKEN / GH_TOKEN，搜索配额仅约 10 次/分钟" },
    unknown: { text: "Token 待验证", cls: "warn", title: "已配置 token，尚未校验" },
  };
  const tv = TOKEN_VIEW[tokenState] || TOKEN_VIEW.none;
  $("token-status").textContent = tv.text;
  $("token-status").className = "token-status " + tv.cls;
  $("token-status").title = tv.title;
  const q = stats.quota || { used: 0, limit: 60, pct: 0 };
  $("quota-badge").textContent = `配额: ${q.used}/${q.limit} (${q.pct}%)`;
  $("quota-badge").style.color = q.pct >= 90 ? "var(--red)" : q.pct >= 70 ? "var(--orange)" : "var(--text-2)";
  const gq = stats.githubQuota;
  if (gq?.search)
    $("quota-badge").title =
      `GitHub 搜索配额剩余 ${gq.search.remaining}/${gq.search.limit}（低于保护下限时自动刷新会跳过）`;
}

// ── 加载 ──
let webhookTypesLoaded = false;
async function loadWebhookTypes() {
  const sel = $("set-webhook-type");
  if (!sel || webhookTypesLoaded) return;
  try {
    const { types } = await fetchJson("/api/webhook-types");
    const labels = {
      generic: "通用 JSON",
      slack: "Slack",
      discord: "Discord",
      telegram: "Telegram",
      feishu: "飞书",
      dingtalk: "钉钉",
      ntfy: "ntfy",
      bark: "Bark",
      serverchan: "Server酱",
    };
    sel.innerHTML = (types || [])
      .map((t) => `<option value="${t}">${escapeHtml(labels[t] || t)}</option>`)
      .join("");
    webhookTypesLoaded = true;
  } catch {
    /* 保留下拉框现状 */
  }
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
    if ($("set-trending-enabled")) $("set-trending-enabled").checked = s.trendingEnabled !== false;
    if ($("set-trending-days")) $("set-trending-days").value = s.trendingDays ?? 30;
    if ($("set-trending-min-stars")) $("set-trending-min-stars").value = s.trendingMinStars ?? 50;
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
    if ($("api-key-status"))
      $("api-key-status").textContent = s.authEnabled ? "（服务端已启用认证）" : "（服务端未启用认证）";
    if (s.theme) document.documentElement.setAttribute("data-theme", s.theme);
  } catch (e) {
    console.error("loadSettings:", e);
  }
}
async function loadStats() {
  try {
    renderStats(await fetchJson("/api/stats"));
  } catch (e) {
    console.error("loadStats:", e);
  }
}
// ── 告警 ──
async function loadAlerts() {
  try {
    const { unread, recent } = await fetchJson("/api/alerts");
    const badge = $("alert-badge");
    if (unread > 0) {
      badge.classList.remove("hidden");
      $("alert-count").textContent = unread;
    } else badge.classList.add("hidden");

    const el = $("alerts-preview");
    if (el) {
      el.innerHTML =
        recent.length === 0
          ? '<p class="muted">暂无告警。当仓库 24h 内新增星数达到阈值时会在此显示。</p>'
          : recent
              .map((a) => {
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
              })
              .join("");
    }
  } catch (e) {
    console.error("loadAlerts:", e);
  }
}
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
  } catch {
    el.textContent = "";
  }
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
    const sub =
      existing ||
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      }));
    const json = sub.toJSON();
    await fetchJson("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      await sub.unsubscribe();
    }
    el.textContent = "已取消订阅";
    refreshPushStatus();
  } catch (e) {
    showError(e.message);
  }
}
// ── 👤 多用户：登录 / 账号 / 用户管理 ──
let authMode = "login";
let authStatus = { hasUsers: false, canRegister: true, user: null };

async function checkAuth() {
  try {
    authStatus = await (
      await fetch("/api/auth/status", { headers: getSession() ? { "X-Session": getSession() } : {} })
    ).json();
  } catch {
    authStatus = { hasUsers: false, canRegister: true, user: null };
  }
  const who = $("account-who");
  if (who) {
    who.textContent = authStatus.user
      ? `当前登录：${authStatus.user.username}（${authStatus.user.role === "admin" ? "管理员" : "成员"}）`
      : authStatus.hasUsers
        ? "未登录"
        : "单用户模式（未启用登录）";
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
  if (authStatus.hasUsers && !authStatus.user) {
    showAuth("login");
    return false;
  }
  return true;
}

function showAuth(mode) {
  authMode = mode;
  $("auth-overlay").classList.remove("hidden");
  $("auth-title").textContent = mode === "register" ? "创建管理员账号" : "登录";
  $("auth-hint").textContent =
    mode === "register"
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
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  } catch {
    /* ignore */
  }
  setSession("");
  location.reload();
}

async function loadUsers() {
  const el = $("user-list");
  if (!el) return;
  try {
    const { users } = await fetchJson("/api/auth/users");
    el.innerHTML = users.length
      ? users
          .map(
            (u) => `<div class="entity-row">
          <span class="entity-name">${escapeHtml(u.username)}</span>
          <span class="entity-spec">${u.role === "admin" ? "管理员" : "成员"} · 创建于 ${timeAgo(u.created_at)}</span>
          <button class="btn btn-sm btn-danger del-user" data-id="${u.id}" data-name="${escapeHtml(u.username)}">删除</button>
        </div>`,
          )
          .join("")
      : '<div class="empty"><p>暂无用户</p></div>';
    el.querySelectorAll(".del-user").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm(`确定删除用户「${b.dataset.name}」？其个人数据将保留但不再可访问。`)) return;
        try {
          await fetchJson(`/api/auth/users/${b.dataset.id}`, { method: "DELETE" });
          loadUsers();
        } catch (e) {
          showError(e.message);
        }
      }),
    );
  } catch {
    el.innerHTML = "";
  }
}
