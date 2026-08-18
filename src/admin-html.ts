import type { SlotStatusView } from "./types";

export class UnauthorizedError extends Error {
  constructor() {
    super("管理密钥无效，请重新输入");
    this.name = "UnauthorizedError";
  }
}

export function activeFutureSlots(slots: SlotStatusView[], now: string): SlotStatusView[] {
  const nowMs = Date.parse(now);
  return slots.filter((slot) => slot.active && Date.parse(slot.startsAt) > nowMs);
}

export function createSessionGate() {
  let version = 0;
  return {
    begin() {
      version += 1;
      return version;
    },
    isCurrent(candidate: number) {
      return candidate === version;
    }
  };
}

export function applyIfCurrent(
  gate: { isCurrent(candidate: number): boolean },
  version: number,
  sideEffect: () => void
): boolean {
  if (!gate.isCurrent(version)) return false;
  sideEffect();
  return true;
}

export function healthPresentation(
  health: {
    consecutiveSourceFailures: number;
    lastSuccessAt: string | null;
    lastErrorAt: string | null;
    lastErrorSummary: string | null;
  },
  formatTime: (value: string | null) => string
) {
  const state = health.lastErrorSummary ? "error" : health.consecutiveSourceFailures > 0 ? "warning" : "success";
  return {
    state,
    summary: health.lastSuccessAt ? "上次成功：" + formatTime(health.lastSuccessAt) : "尚未成功读取余票数据。",
    healthSummary: health.consecutiveSourceFailures === 0
      ? "数据源状态：正常"
      : "数据源状态：连续失败 " + health.consecutiveSourceFailures + " 次",
    lastError: health.lastErrorSummary ? "最近错误：" + health.lastErrorSummary : ""
  };
}

export function renderAdminPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>TRAE 余票监测</title>
  <style>
    :root { color-scheme: light dark; --page: #f6f7f9; --surface: #ffffff; --text: #172033; --muted: #526077; --border: #c6ccd6; --primary: #084d9b; --primary-text: #ffffff; --danger: #b42318; --success: #146c43; --warning: #8a4b00; --focus: #9a3b00; }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 0; background: var(--page); color: var(--text); font: 400 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(100%, 42rem); margin: 0 auto; padding: max(1.5rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) max(2rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left)); }
    h1 { margin: 0; font-size: clamp(1.5rem, 6vw, 2rem); line-height: 1.25; }
    h2 { margin: 0 0 .75rem; font-size: 1.125rem; }
    p { margin: .5rem 0 0; }
    .intro { color: var(--muted); }
    .card, fieldset { margin: 1.25rem 0 0; padding: 1rem; border: 1px solid var(--border); border-radius: .75rem; background: var(--surface); }
    fieldset { min-width: 0; }
    legend { padding: 0 .25rem; font-weight: 700; }
    .status { border-left: .3rem solid var(--primary); }
    .status[data-state="error"] { border-left-color: var(--danger); }
    .status[data-state="success"] { border-left-color: var(--success); }
    .status[data-state="warning"] { border-left-color: var(--warning); }
    .form-row, .actions, .slot-list { display: grid; gap: .75rem; }
    .form-row { grid-template-columns: minmax(0, 1fr); }
    label { display: grid; gap: .35rem; font-weight: 600; }
    input, button { min-height: 44px; border-radius: .5rem; font: inherit; }
    input { width: 100%; padding: .55rem .7rem; border: 1px solid #707b8d; background: var(--surface); color: var(--text); }
    button { width: 100%; padding: .55rem .9rem; border: 1px solid var(--primary); background: var(--primary); color: var(--primary-text); font-weight: 700; cursor: pointer; touch-action: manipulation; transition: opacity 160ms ease-out, background-color 160ms ease-out; }
    button:hover { background: #063d7a; }
    button:active { opacity: .82; }
    button.secondary { background: transparent; color: var(--primary); }
    button.danger { border-color: var(--danger); background: transparent; color: var(--danger); }
    button:disabled { cursor: not-allowed; opacity: .48; }
    input:focus-visible, button:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
    .help, .error { color: var(--muted); font-size: .9375rem; }
    .error { min-height: 1.5rem; color: var(--danger); }
    .action-feedback[data-state="error"] { color: var(--danger); }
    .action-feedback[data-state="success"] { color: var(--success); }
    .slot { display: flex; align-items: flex-start; gap: .75rem; min-height: 44px; padding: .55rem 0; border-top: 1px solid var(--border); font-weight: 400; }
    .slot:first-child { border-top: 0; }
    .slot input { width: 1.25rem; height: 1.25rem; min-height: 1.25rem; margin-top: .15rem; accent-color: var(--primary); }
    .slot-detail, .slot-detail strong { display: grid; min-width: 0; gap: .1rem; overflow-wrap: anywhere; }
    .slot-detail small { color: var(--muted); font-size: .9375rem; overflow-wrap: anywhere; }
    @media (min-width: 32rem) { .form-row { grid-template-columns: minmax(0, 1fr) auto; align-items: end; } .form-row button { width: auto; min-width: 8rem; } .actions { grid-template-columns: 1fr 1fr; } .actions .danger { grid-column: 1 / -1; } }
    @media (prefers-color-scheme: dark) { :root { --page: #101722; --surface: #182131; --text: #f3f6fb; --muted: #c3ccda; --border: #68768b; --primary: #76b8ff; --primary-text: #071829; --danger: #ffb4ab; --success: #8de7bd; --warning: #ffca66; --focus: #ffca66; } button:hover { background: #a1cfff; } button.secondary:hover { background: #273e5b; color: #d8e9ff; } button.danger:hover { background: #59231f; color: #ffd1cc; } input { border-color: #aeb9c9; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>TRAE 余票监测</h1>
      <p class="intro">登录后选择要监测的未来活动时段。不会自动预约。</p>
    </header>

    <section class="card status" id="status-banner" aria-labelledby="status-heading" data-state="idle">
      <h2 id="status-heading">监测状态</h2>
      <p id="status-summary" aria-live="polite">请输入管理密钥以加载状态。</p>
      <p id="health-summary" class="help"></p>
      <p id="last-error" class="error" role="alert"></p>
    </section>

    <section class="card" aria-labelledby="login-heading">
      <h2 id="login-heading">管理登录</h2>
      <form id="login-form" novalidate>
        <div class="form-row">
          <label for="admin-token">ADMIN_TOKEN
            <input id="admin-token" name="admin-token" type="password" autocomplete="off" required aria-describedby="token-help token-error">
          </label>
          <button id="login-button" type="submit">登录并加载</button>
        </div>
        <p id="token-help" class="help">密钥仅保存在当前浏览器标签页中。</p>
        <p id="token-error" class="error" role="alert"></p>
      </form>
    </section>

    <section class="card" aria-labelledby="slots-heading">
      <h2 id="slots-heading">关注时段</h2>
      <fieldset id="slots-fieldset" disabled>
        <legend>可监测的未来时段</legend>
        <div id="slot-list" class="slot-list">
          <p class="help">登录后将显示最近一次成功读取到的时段。</p>
        </div>
      </fieldset>
      <div class="actions" aria-label="监测操作">
        <button id="save-button" type="button" disabled>保存关注时段</button>
        <button id="check-button" class="secondary" type="button" disabled>立即检查</button>
        <button id="copy-test-button" class="secondary" type="button" disabled>测试正式文案</button>
        <button id="critical-test-button" class="secondary" type="button" disabled>测试强提醒铃声</button>
        <button id="logout-button" class="danger" type="button" disabled>退出登录</button>
      </div>
      <p id="action-feedback" class="help action-feedback" role="status" aria-live="polite"></p>
    </section>
  </main>
  <script>
    (() => {
      class UnauthorizedError extends Error {
        constructor() {
          super("管理密钥无效，请重新输入");
          this.name = "UnauthorizedError";
        }
      }

      function activeFutureSlots(slots, now) {
        const nowMs = Date.parse(now);
        return slots.filter((slot) => slot.active && Date.parse(slot.startsAt) > nowMs);
      }

      function createSessionGate() {
        let version = 0;
        return {
          begin() {
            version += 1;
            return version;
          },
          isCurrent(candidate) {
            return candidate === version;
          }
        };
      }

      function applyIfCurrent(gate, version, sideEffect) {
        if (!gate.isCurrent(version)) return false;
        sideEffect();
        return true;
      }

      function healthPresentation(health, formatTime) {
        const state = health.lastErrorSummary ? "error" : health.consecutiveSourceFailures > 0 ? "warning" : "success";
        return {
          state,
          summary: health.lastSuccessAt ? "上次成功：" + formatTime(health.lastSuccessAt) : "尚未成功读取余票数据。",
          healthSummary: health.consecutiveSourceFailures === 0
            ? "数据源状态：正常"
            : "数据源状态：连续失败 " + health.consecutiveSourceFailures + " 次",
          lastError: health.lastErrorSummary ? "最近错误：" + health.lastErrorSummary : ""
        };
      }
      const tokenKey = "trae-admin-token";
      const loginForm = document.getElementById("login-form");
      const tokenInput = document.getElementById("admin-token");
      const tokenError = document.getElementById("token-error");
      const statusBanner = document.getElementById("status-banner");
      const statusSummary = document.getElementById("status-summary");
      const healthSummary = document.getElementById("health-summary");
      const lastError = document.getElementById("last-error");
      const fieldset = document.getElementById("slots-fieldset");
      const slotList = document.getElementById("slot-list");
      const loginButton = document.getElementById("login-button");
      const saveButton = document.getElementById("save-button");
      const checkButton = document.getElementById("check-button");
      const copyTestButton = document.getElementById("copy-test-button");
      const criticalTestButton = document.getElementById("critical-test-button");
      const logoutButton = document.getElementById("logout-button");
      const actionFeedback = document.getElementById("action-feedback");
      const actionButtons = [saveButton, checkButton, copyTestButton, criticalTestButton];
      const sessionGate = createSessionGate();
      let authenticated = false;
      let authenticatedBusy = false;

      async function api(path, init = {}) {
        const token = sessionStorage.getItem(tokenKey);
        const headers = new Headers(init.headers || {});
        headers.set("Authorization", "Bearer " + token);
        if (init.body) headers.set("Content-Type", "application/json");
        const response = await fetch(path, { ...init, headers, cache: "no-store" });
        if (response.status === 401) {
          throw new UnauthorizedError();
        }
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "请求失败");
        return data;
      }

      function setMessage(message, state = "idle") {
        statusBanner.dataset.state = state;
        statusSummary.textContent = message;
      }

      function setActionFeedback(message, state = "idle") {
        actionFeedback.dataset.state = state;
        actionFeedback.textContent = message;
      }

      function updateAuthenticatedControls() {
        const enabled = authenticated && !authenticatedBusy;
        fieldset.disabled = !enabled;
        for (const button of actionButtons) button.disabled = !enabled;
        logoutButton.disabled = !authenticated;
        loginButton.disabled = authenticatedBusy;
      }

      function setLoginBusy(busy) {
        loginButton.disabled = busy;
        loginButton.dataset.label = loginButton.dataset.label || loginButton.textContent;
        loginButton.textContent = busy ? "正在验证…" : loginButton.dataset.label;
      }

      function setAuthenticatedBusy(button, busy, label) {
        button.dataset.label = button.dataset.label || button.textContent;
        button.textContent = busy ? label : button.dataset.label;
        updateAuthenticatedControls();
      }

      function formatTime(value) {
        if (!value) return "暂无";
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
      }

      function clearSlots() {
        slotList.replaceChildren();
        const notice = document.createElement("p");
        notice.className = "help";
        notice.textContent = "登录后将显示最近一次成功读取到的时段。";
        slotList.append(notice);
      }

      function resetHealthBanner() {
        setMessage("请输入管理密钥以加载状态。", "idle");
        healthSummary.textContent = "";
        lastError.textContent = "";
      }

      function resetAuthenticatedUi(message, isError = true) {
        sessionGate.begin();
        authenticated = false;
        authenticatedBusy = false;
        sessionStorage.removeItem(tokenKey);
        tokenInput.value = "";
        tokenError.textContent = isError ? message : "";
        resetHealthBanner();
        clearSlots();
        updateAuthenticatedControls();
        setLoginBusy(false);
        setActionFeedback(isError ? "" : message, isError ? "idle" : "success");
      }

      function resetIfCurrent(version, message, isError = true) {
        return applyIfCurrent(sessionGate, version, () => resetAuthenticatedUi(message, isError));
      }

      function renderStatus(data) {
        const presentation = healthPresentation(data.health, formatTime);
        setMessage(presentation.summary, presentation.state);
        healthSummary.textContent = presentation.healthSummary;
        lastError.textContent = presentation.lastError;

        slotList.replaceChildren();
        const candidates = activeFutureSlots(data.slots, data.now);
        if (candidates.length === 0) {
          const notice = document.createElement("p");
          notice.className = "help";
          notice.textContent = "没有可选择的未来活动时段。请先执行一次立即检查。";
          slotList.append(notice);
          return;
        }
        for (const slot of candidates) {
          const label = document.createElement("label");
          label.className = "slot";
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.name = "watched-slot";
          checkbox.value = slot.code;
          checkbox.checked = slot.watched;
          const detail = document.createElement("span");
          detail.className = "slot-detail";
          const title = document.createElement("strong");
          title.textContent = slot.displayTime + "（" + slot.code + "）";
          const meta = document.createElement("small");
          meta.textContent = "状态：" + slot.observedState + "；剩余：" + (slot.remaining === null ? "未知" : slot.remaining) + "；最后检查：" + formatTime(slot.lastCheckedAt);
          detail.append(title, meta);
          label.append(checkbox, detail);
          slotList.append(label);
        }
      }

      async function runAuthenticated(button, label, operation) {
        if (!authenticated || authenticatedBusy) return undefined;
        const version = sessionGate.begin();
        authenticatedBusy = true;
        setAuthenticatedBusy(button, true, label);
        try {
          const data = await operation();
          return sessionGate.isCurrent(version) ? data : undefined;
        } catch (error) {
          if (sessionGate.isCurrent(version)) {
            if (error instanceof UnauthorizedError) {
              resetIfCurrent(version, error.message);
            } else {
              setActionFeedback(error instanceof Error ? error.message : "请求失败，请重试。", "error");
            }
          }
          return undefined;
        } finally {
          if (sessionGate.isCurrent(version)) {
            authenticatedBusy = false;
            setAuthenticatedBusy(button, false, "");
          }
        }
      }

      loginForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        tokenError.textContent = "";
        const token = tokenInput.value.trim();
        if (!token) {
          tokenError.textContent = "请输入管理密钥。";
          tokenInput.focus();
          return;
        }
        const version = sessionGate.begin();
        authenticatedBusy = true;
        updateAuthenticatedControls();
        setLoginBusy(true);
        try {
          const headers = new Headers({ Authorization: "Bearer " + token });
          const response = await fetch("/api/status", { headers, cache: "no-store" });
          if (response.status === 401) {
            throw new UnauthorizedError();
          }
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "请求失败");
          if (!sessionGate.isCurrent(version)) return;
          sessionStorage.setItem(tokenKey, token);
          tokenInput.value = "";
          authenticated = true;
          authenticatedBusy = false;
          renderStatus(data);
          updateAuthenticatedControls();
          setActionFeedback("登录成功，已加载监测状态。", "success");
        } catch (error) {
          if (!sessionGate.isCurrent(version)) return;
          if (error instanceof UnauthorizedError) {
            resetIfCurrent(version, error.message);
          } else {
            const message = error instanceof Error ? error.message : "请求失败，请重试。";
            tokenError.textContent = message;
            setActionFeedback("", "idle");
          }
        } finally {
          if (sessionGate.isCurrent(version)) {
            authenticatedBusy = false;
            updateAuthenticatedControls();
            setLoginBusy(false);
          }
        }
      });

      saveButton.addEventListener("click", async () => {
        const watchedCodes = [...document.querySelectorAll('input[name="watched-slot"]:checked')].map((input) => input.value);
        const data = await runAuthenticated(saveButton, "正在保存…", () => {
          return api("/api/config", { method: "PUT", body: JSON.stringify({ watchedCodes }) });
        });
        if (data) {
          renderStatus(data);
          setActionFeedback("关注时段已保存，并已检查余票。", "success");
        }
      });

      checkButton.addEventListener("click", async () => {
        const data = await runAuthenticated(checkButton, "正在检查…", () => api("/api/check", { method: "POST" }));
        if (data) {
          renderStatus(data);
          setActionFeedback("余票检查已完成。", "success");
        }
      });

      copyTestButton.addEventListener("click", async () => {
        const data = await runAuthenticated(copyTestButton, "正在发送…", () => {
          return api("/api/test-notification", { method: "POST" });
        });
        if (data) {
          setActionFeedback("正式余票文案测试已发送。", "success");
        }
      });

      criticalTestButton.addEventListener("click", async () => {
        const confirmed = globalThis.confirm("将触发最大音量并每 30 秒重复响铃。确认发送强提醒测试吗？");
        if (!confirmed) return;
        const data = await runAuthenticated(criticalTestButton, "正在发送…", () => {
          return api("/api/test-critical-notification", { method: "POST" });
        });
        if (data) {
          setActionFeedback("强提醒铃声测试已发送。", "success");
        }
      });

      logoutButton.addEventListener("click", () => {
        resetAuthenticatedUi("已退出登录。", false);
        tokenInput.focus();
      });

      if (sessionStorage.getItem(tokenKey)) {
        const version = sessionGate.begin();
        authenticatedBusy = true;
        updateAuthenticatedControls();
        setMessage("正在加载监测状态…", "idle");
        api("/api/status").then((data) => {
          if (!sessionGate.isCurrent(version)) return;
          authenticated = true;
          authenticatedBusy = false;
          renderStatus(data);
          updateAuthenticatedControls();
        }).catch((error) => {
          if (!sessionGate.isCurrent(version)) return;
          if (error instanceof UnauthorizedError) {
            resetIfCurrent(version, error.message);
          } else {
            authenticatedBusy = false;
            updateAuthenticatedControls();
            setActionFeedback(error instanceof Error ? error.message : "登录状态加载失败，请重试。", "error");
          }
        });
      }
    })();
  </script>
</body>
</html>`;
}
