"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const OPENAI_PROVIDER = "openai";

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function activeProvider(configText) {
  const header = topLevelHeader(configText);
  const match = header.match(/^\s*model_provider\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m);
  return match?.[1] || OPENAI_PROVIDER;
}

function topLevelHeader(configText) {
  const firstSection = configText.search(/^\s*\[/m);
  return firstSection === -1 ? configText : configText.slice(0, firstSection);
}

function rewriteModelProvider(configText, provider) {
  const firstSection = configText.search(/^\s*\[/m);
  const header = firstSection === -1 ? configText : configText.slice(0, firstSection);
  const body = firstSection === -1 ? "" : configText.slice(firstSection);
  const replacement = `model_provider = "${provider}"`;
  const activeLine = /^\s*model_provider\s*=.*$/m;
  const commentedLine = /^\s*#\s*model_provider\s*=.*$/m;

  if (activeLine.test(header)) {
    return header.replace(activeLine, replacement) + body;
  }
  if (commentedLine.test(header)) {
    return header.replace(commentedLine, replacement) + body;
  }

  const modelLine = /^(\s*model\s*=.*(?:\r?\n|$))/m;
  if (modelLine.test(header)) {
    return header.replace(modelLine, `$1${replacement}\n`) + body;
  }
  return `${replacement}\n${configText}`;
}

function configuredProviders(configText) {
  const providers = [{ provider: OPENAI_PROVIDER, label: "OpenAI" }];
  const sectionPattern = /^\s*\[model_providers\.([A-Za-z0-9_-]+)\]\s*$/gm;
  const matches = [...configText.matchAll(sectionPattern)];
  for (const [index, match] of matches.entries()) {
    const provider = match[1];
    if (provider === OPENAI_PROVIDER) {
      continue;
    }
    const sectionStart = match.index + match[0].length;
    const sectionEnd = matches[index + 1]?.index ?? configText.length;
    const section = configText.slice(sectionStart, sectionEnd);
    const name = section.match(/^\s*name\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m)?.[1];
    providers.push({ provider, label: name?.trim() || provider });
  }
  return providers;
}

const BUDGET_POLL_INTERVAL_MS = 10000;
const BUDGET_FETCH_TIMEOUT_MS = 5000;

function providerSection(configText, provider) {
  const sectionPattern = /^\s*\[model_providers\.([A-Za-z0-9_-]+)\]\s*$/gm;
  for (const match of configText.matchAll(sectionPattern)) {
    if (match[1] !== provider) {
      continue;
    }
    const rest = configText.slice(match.index + match[0].length);
    const nextHeader = rest.search(/^\s*\[/m);
    return nextHeader === -1 ? rest : rest.slice(0, nextHeader);
  }
  return null;
}

function providerBudgetSource(configText, provider) {
  if (provider === OPENAI_PROVIDER) {
    return null;
  }
  const section = providerSection(configText, provider);
  if (section == null) {
    return null;
  }
  const baseUrl = section.match(/^\s*base_url\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m)?.[1];
  const envKey = section.match(/^\s*env_key\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m)?.[1];
  const apiKey = envKey ? process.env[envKey] : null;
  if (!baseUrl || !apiKey) {
    return null;
  }
  // LiteLLM serves key metadata at the proxy root, not under /v1.
  const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  return { url: `${root}/key/info`, apiKey };
}

async function fetchBudget(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BUDGET_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(source.url, {
      headers: { Authorization: `Bearer ${source.apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const body = await response.json();
    const info = body?.info ?? body;
    const spend = Number(info?.spend);
    const maxBudget = Number(info?.max_budget);
    if (!Number.isFinite(spend) || !Number.isFinite(maxBudget) || maxBudget <= 0) {
      return null;
    }
    return {
      spend,
      maxBudget,
      resetAt: typeof info?.budget_reset_at === "string" ? info.budget_reset_at : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function writeProvider(provider) {
  const configPath = path.join(codexHome(), "config.toml");
  const configText = fs.readFileSync(configPath, "utf8");
  if (!configuredProviders(configText).some((option) => option.provider === provider)) {
    throw new Error(`config.toml does not define model provider ${provider}.`);
  }

  const updated = rewriteModelProvider(configText, provider);
  if (updated === configText) {
    return false;
  }

  const stat = fs.statSync(configPath);
  const backupPath = `${configPath}.bak.before-profile-switcher`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(configPath, backupPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backupPath, stat.mode);
  }

  const temporaryPath = `${configPath}.profile-switcher-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, updated, { encoding: "utf8", mode: stat.mode });
    fs.renameSync(temporaryPath, configPath);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }
  }
  return true;
}

async function restartCodexHost(BrowserWindow) {
  const windows = BrowserWindow.getAllWindows().filter(
    (window) => !window.isDestroyed() && !window.webContents.isDestroyed(),
  );
  for (const window of windows) {
    try {
      const restarted = await window.webContents.executeJavaScript(
        "globalThis.__codexProfileRestart ? globalThis.__codexProfileRestart() : false",
      );
      if (restarted === true) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

async function reloadCodexWindows(BrowserWindow) {
  await new Promise((resolve) => setTimeout(resolve, 750));
  const windows = BrowserWindow.getAllWindows().filter(
    (window) => !window.isDestroyed() && !window.webContents.isDestroyed(),
  );
  if (windows.length === 0) {
    return false;
  }

  let reloaded = false;
  for (const window of windows) {
    try {
      window.webContents.reload();
      reloaded = true;
    } catch {
      continue;
    }
  }
  return reloaded;
}

function relaunchApplication(app) {
  try {
    app.relaunch({ execPath: process.execPath, args: process.argv.slice(1) });
  } catch {
    // The detached macOS launcher below is the fallback.
  }

  const currentPid = String(process.pid);
  const fallback = spawn(
    "/bin/sh",
    [
      "-c",
      `while /bin/kill -0 ${currentPid} 2>/dev/null; do /bin/sleep 0.1; done; exec /usr/bin/open -b com.openai.codex`,
    ],
    { detached: true, stdio: "ignore" },
  );
  fallback.unref();
  app.exit(0);
}

function sidebarProfileScript(provider, providers) {
  function installSidebarProfileSwitcher(initialProvider, initialProviders) {
    const containerId = "codex-profile-switcher";
    const menuId = "codex-profile-switcher-menu";
    const styleId = "codex-profile-switcher-style";
    const requestPrefix = "__codex_profile_switch__:";
    const activeProviderStorageKey = "__codex_active_provider";
    const buttonStyleStorageKey = "__codex_profile_switcher_button_style";
    const existingController = globalThis.__codexProfileSidebarController;
    if (existingController != null) {
      existingController.setProviders(initialProviders);
      existingController.setProvider(initialProvider);
      existingController.ensure();
      return true;
    }

    let currentProvider = initialProvider;
    let providerOptions = initialProviders;

    function persistProvider() {
      try {
        localStorage.setItem(activeProviderStorageKey, currentProvider);
      } catch {
        return;
      }
    }

    function providerLabel(value) {
      return providerOptions.find((option) => option.provider === value)?.label || value;
    }

    function closeMenu() {
      const menu = document.getElementById(menuId);
      if (menu != null) {
        menu.hidden = true;
      }
      document
        .querySelector(`#${containerId} > button`)
        ?.setAttribute("aria-expanded", "false");
    }

    function renderProvider() {
      const button = document.querySelector(`#${containerId} > button`);
      if (button != null) {
        button.setAttribute(
          "aria-label",
          `Codex profile: ${providerLabel(currentProvider)}. Switch profile`,
        );
      }

      document.querySelectorAll(`#${menuId} [data-provider]`).forEach((option) => {
        const selected = option.dataset.provider === currentProvider;
        option.setAttribute("aria-selected", String(selected));
        const label = option.querySelector("[data-provider-label]");
        const labelText = providerLabel(option.dataset.provider);
        if (label != null && label.textContent !== labelText) {
          label.textContent = labelText;
        }
        const check = option.querySelector("[data-check]");
        if (check != null) {
          check.hidden = !selected;
        }
      });
    }

    function selectProvider(provider) {
      if (!providerOptions.some((option) => option.provider === provider)) {
        return;
      }
      const previousProvider = currentProvider;
      currentProvider = provider;
      renderProvider();
      closeMenu();
      try {
        if (globalThis.__codexProfileRequest?.(provider) !== true) {
          currentProvider = previousProvider;
          renderProvider();
        }
      } catch {
        currentProvider = previousProvider;
        renderProvider();
      }
    }

    function ensureStyle() {
      if (document.getElementById(styleId) != null) {
        return;
      }
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        #${containerId} { display: flex; flex: none; }
        #${containerId} [data-switch-icon] {
          fill: none;
          stroke: currentColor;
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-width: 1.7;
        }
        #${menuId} {
          backdrop-filter: blur(var(--blur-sm, 8px));
          background: color-mix(in oklab, var(--color-token-dropdown-background, #2f2f2f) 90%, transparent);
          border-radius: var(--radius-xl, 12px);
          box-shadow: 0 0 0 0.5px var(--color-token-border, rgba(127, 127, 127, 0.28)),
            var(--shadow-xl, 0px 8px 16px -4px rgba(0, 0, 0, 0.12));
          color: var(--color-token-foreground, #f2f2f2);
          display: flex;
          flex-direction: column;
          min-width: 196px;
          padding: 4px;
          position: fixed;
          user-select: none;
          z-index: 2147483647;
        }
        #${menuId}[hidden] { display: none; }
        #${menuId} button {
          align-items: center;
          background: transparent;
          border: 0;
          border-radius: var(--radius-lg, 10px);
          color: inherit;
          cursor: var(--cursor-interaction, default);
          display: flex;
          font: inherit;
          font-size: 0.8125rem;
          gap: 6px;
          line-height: 1.25rem;
          padding: var(--padding-row-y, 5px) var(--padding-row-x, 8px);
          text-align: left;
          width: 100%;
        }
        #${menuId} button:hover,
        #${menuId} button:focus-visible {
          background: var(--color-token-list-hover-background, rgba(127, 127, 127, 0.14));
          outline: none;
        }
        #${menuId} [data-check] {
          align-items: center;
          display: flex;
          flex: none;
          height: 16px;
          justify-content: center;
          margin-left: auto;
          order: 2;
          text-align: center;
          width: 16px;
        }
        #${menuId} [data-check] svg {
          fill: none;
          height: 14px;
          stroke: currentColor;
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-width: 2;
          width: 14px;
        }
      `;
      document.head.append(style);
    }

    function isHelpButton(button) {
      const label = button?.getAttribute("aria-label");
      return label === "Open help menu" || label === "Open Codex docs";
    }

    function findFooterAnchorButton() {
      const labelled = [
        ...document.querySelectorAll(
          'button[aria-label="Open help menu"], button[aria-label="Open Codex docs"]',
        ),
      ].find((button) => button.getClientRects().length > 0);
      if (labelled != null) {
        return labelled;
      }

      return [...document.querySelectorAll("button")]
        .filter((button) => {
          if (button.closest(`#${containerId}`) != null) {
            return false;
          }
          const rect = button.getBoundingClientRect();
          return (
            rect.width > 0 &&
            rect.width <= 72 &&
            rect.left < Math.min(480, window.innerWidth * 0.4) &&
            rect.bottom > window.innerHeight - 80
          );
        })
        .sort(
          (left, right) =>
            right.getBoundingClientRect().right - left.getBoundingClientRect().right,
        )[0];
    }

    function buildMenu(button) {
      document.getElementById(menuId)?.remove();
      const menu = document.createElement("div");
      menu.id = menuId;
      menu.hidden = true;
      menu.setAttribute("role", "listbox");
      menu.setAttribute("aria-label", "Codex profile");

      for (const { provider, label } of providerOptions) {
        const option = document.createElement("button");
        option.type = "button";
        option.dataset.provider = provider;
        option.setAttribute("role", "option");
        const check = document.createElement("span");
        check.dataset.check = "";
        check.hidden = true;
        const checkIcon = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "svg",
        );
        checkIcon.setAttribute("viewBox", "0 0 16 16");
        checkIcon.setAttribute("aria-hidden", "true");
        const checkPath = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "path",
        );
        checkPath.setAttribute("d", "m3.25 8.25 3 3 6.5-6.5");
        checkIcon.append(checkPath);
        check.append(checkIcon);
        const text = document.createElement("span");
        text.dataset.providerLabel = "";
        text.textContent = label;
        option.append(check, text);
        option.addEventListener("click", (event) => {
          event.stopPropagation();
          selectProvider(provider);
        });
        menu.append(option);
      }

      document.body.append(menu);
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const opening = menu.hidden;
        closeMenu();
        if (!opening) {
          return;
        }
        const rect = button.getBoundingClientRect();
        menu.hidden = false;
        menu.style.left = `${Math.min(
          Math.max(8, rect.left),
          window.innerWidth - menu.offsetWidth - 8,
        )}px`;
        menu.style.top = `${Math.max(8, rect.top - menu.offsetHeight - 6)}px`;
        button.setAttribute("aria-expanded", "true");
      });
    }

    function resolveAnchorStyle(anchorButton) {
      const anchorStyle = {
        button: anchorButton.getAttribute("class"),
        icon: anchorButton.querySelector("svg")?.getAttribute("class") ?? null,
      };
      if (isHelpButton(anchorButton)) {
        try {
          localStorage.setItem(buttonStyleStorageKey, JSON.stringify(anchorStyle));
        } catch {
          // Keep the in-memory style even when persistence fails.
        }
        return anchorStyle;
      }
      try {
        const cached = localStorage.getItem(buttonStyleStorageKey);
        if (cached != null) {
          return JSON.parse(cached);
        }
      } catch {
        // Fall back to the anchor's own style below.
      }
      return anchorStyle;
    }

    function applyAnchorStyle(button, anchorStyle) {
      if (
        anchorStyle.button != null &&
        button.getAttribute("class") !== anchorStyle.button
      ) {
        button.setAttribute("class", anchorStyle.button);
      }
      const icon = button.querySelector("[data-switch-icon]");
      if (
        icon != null &&
        anchorStyle.icon != null &&
        icon.getAttribute("class") !== anchorStyle.icon
      ) {
        icon.setAttribute("class", anchorStyle.icon);
      }
    }

    function ensureSwitcher() {
      const anchorButton = findFooterAnchorButton();
      if (anchorButton == null) {
        return;
      }
      ensureStyle();

      let footerRow = anchorButton.parentElement;
      while (footerRow != null && !footerRow.classList.contains("h-toolbar")) {
        footerRow = footerRow.parentElement;
      }
      if (footerRow == null) {
        return;
      }

      const anchorStyle = resolveAnchorStyle(anchorButton);
      const current = document.getElementById(containerId);
      if (current?.parentElement === footerRow) {
        const currentButton = current.querySelector("button");
        if (currentButton != null) {
          applyAnchorStyle(currentButton, anchorStyle);
        }
        renderProvider();
        return;
      }
      current?.remove();

      let anchorSlot = anchorButton;
      while (anchorSlot.parentElement !== footerRow && anchorSlot.parentElement != null) {
        anchorSlot = anchorSlot.parentElement;
      }
      const container = document.createElement("div");
      container.id = containerId;
      const button = anchorButton.cloneNode(true);
      for (const attribute of ["id", "aria-label", "aria-controls", "aria-describedby", "data-state"]) {
        button.removeAttribute(attribute);
      }
      button.setAttribute("aria-haspopup", "listbox");
      button.setAttribute("aria-expanded", "false");
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.dataset.switchIcon = "";
      icon.setAttribute("viewBox", "0 0 20 20");
      icon.setAttribute("aria-hidden", "true");
      icon.setAttribute("width", "16");
      icon.setAttribute("height", "16");
      for (const pathData of ["M3.5 6.25h10.75", "m11.5 3 3 3.25-3 3.25", "M16.5 13.75H5.75", "m8.5 17-3-3.25 3-3.25"]) {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", pathData);
        icon.append(path);
      }
      button.replaceChildren(icon);
      applyAnchorStyle(button, anchorStyle);
      container.append(button);
      footerRow.insertBefore(container, anchorSlot);
      buildMenu(button);
      renderProvider();
    }

    const controller = {
      ensure: ensureSwitcher,
      setProvider(provider) {
        if (providerOptions.some((option) => option.provider === provider)) {
          currentProvider = provider;
          persistProvider();
          renderProvider();
        }
      },
      setProviders(providers) {
        if (!Array.isArray(providers) || providers.length === 0) {
          return;
        }
        providerOptions = providers;
      },
    };
    globalThis.__codexProfileSidebarController = controller;
    globalThis.__codexSetActiveProfile = controller.setProvider;
    globalThis.__codexProfileRequest = (provider) => {
      if (!providerOptions.some((option) => option.provider === provider)) {
        return false;
      }
      console.info(`${requestPrefix}${provider}`);
      return true;
    };

    document.addEventListener(
      "pointerdown",
      (event) => {
        const target = event.target instanceof Node ? event.target : null;
        if (
          target != null &&
          (document.getElementById(containerId)?.contains(target) === true ||
            document.getElementById(menuId)?.contains(target) === true)
        ) {
          return;
        }
        closeMenu();
      },
      true,
    );
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    });
    window.addEventListener("resize", closeMenu);
    persistProvider();
    ensureSwitcher();
    const fastAttach = setInterval(() => {
      if (document.getElementById(containerId) != null) {
        clearInterval(fastAttach);
        return;
      }
      ensureSwitcher();
    }, 100);
    setInterval(ensureSwitcher, 1500);
    return true;
  }

  return `(${installSidebarProfileSwitcher.toString()})(${JSON.stringify(provider)},${JSON.stringify(providers)})`;
}

function sidebarBudgetScript(payload) {
  function installSidebarBudget(initialPayload) {
    const boxId = "codex-budget-status";
    const styleId = "codex-budget-status-style";
    const existingController = globalThis.__codexBudgetController;
    if (existingController != null) {
      existingController.update(initialPayload);
      return true;
    }

    let currentPayload = initialPayload;

    function ensureStyle() {
      if (document.getElementById(styleId) != null) {
        return;
      }
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        #${boxId} {
          border-bottom: 1px solid var(--color-token-border, rgba(127, 127, 127, 0.28));
          color: var(--color-token-foreground, inherit);
          display: flex;
          flex: none;
          flex-direction: column;
          font-size: 0.8125rem;
          gap: 2px;
          line-height: 1.25rem;
          padding: 4px 10px 6px;
          user-select: none;
        }
        #${boxId} [data-budget-bar-row] {
          align-items: center;
          display: flex;
          gap: 8px;
        }
        #${boxId} [data-budget-bar] {
          background: color-mix(in oklab, currentColor 16%, transparent);
          border-radius: 4px;
          flex: 1 1 auto;
          height: 8px;
          min-width: 32px;
          overflow: hidden;
        }
        #${boxId} [data-budget-fill] {
          border-radius: 4px;
          height: 100%;
          transition: width 0.3s ease;
        }
        #${boxId} [data-budget-percent] { flex: none; }
        #${boxId} [data-budget-amount-row] {
          display: flex;
          gap: 4px;
          justify-content: space-between;
          overflow: hidden;
          white-space: nowrap;
        }
        #${boxId} [data-budget-reset] {
          color: color-mix(in oklab, currentColor 62%, transparent);
        }
      `;
      document.head.append(style);
    }

    function findFooterRow() {
      const switcher = document.getElementById("codex-profile-switcher");
      if (switcher?.parentElement != null) {
        return switcher.parentElement;
      }
      const helpButton = [
        ...document.querySelectorAll(
          'button[aria-label="Open help menu"], button[aria-label="Open Codex docs"]',
        ),
      ].find((button) => button.getClientRects().length > 0);
      let row = helpButton?.parentElement ?? null;
      while (row != null && !row.classList.contains("h-toolbar")) {
        row = row.parentElement;
      }
      return row;
    }

    function formatReset(iso) {
      const resetEpoch = Date.parse(iso);
      if (Number.isNaN(resetEpoch)) {
        return null;
      }
      const delta = Math.max(0, resetEpoch - Date.now());
      const days = Math.floor(delta / 86400000);
      const hours = Math.floor((delta % 86400000) / 3600000);
      return `${days}d ${hours}h`;
    }

    function render() {
      if (currentPayload == null) {
        document.getElementById(boxId)?.remove();
        return;
      }
      const footerRow = findFooterRow();
      if (footerRow?.parentElement == null) {
        return;
      }
      ensureStyle();

      let box = document.getElementById(boxId);
      if (box == null || box.nextElementSibling !== footerRow) {
        box?.remove();
        box = document.createElement("div");
        box.id = boxId;
        const barRow = document.createElement("div");
        barRow.dataset.budgetBarRow = "";
        const bar = document.createElement("div");
        bar.dataset.budgetBar = "";
        const fill = document.createElement("div");
        fill.dataset.budgetFill = "";
        bar.append(fill);
        const percent = document.createElement("span");
        percent.dataset.budgetPercent = "";
        barRow.append(bar, percent);
        const amountRow = document.createElement("div");
        amountRow.dataset.budgetAmountRow = "";
        const amounts = document.createElement("span");
        amounts.dataset.budgetAmounts = "";
        const reset = document.createElement("span");
        reset.dataset.budgetReset = "";
        amountRow.append(amounts, reset);
        box.append(barRow, amountRow);
        footerRow.parentElement.insertBefore(box, footerRow);
      }

      const percentage = Math.min(
        100,
        Math.max(0, (currentPayload.spend / currentPayload.maxBudget) * 100),
      );
      const color =
        percentage >= 90 ? "#d64545" : percentage >= 70 ? "#df8f3d" : "#4d9e6f";
      const fill = box.querySelector("[data-budget-fill]");
      fill.style.width = `${percentage}%`;
      fill.style.background = color;
      box.querySelector("[data-budget-percent]").textContent =
        `${Math.round(percentage)}%`;
      const formatAmount = (value) =>
        Number.isInteger(value) ? `${value}$` : `${value.toFixed(2)}$`;
      box.querySelector("[data-budget-amounts]").textContent =
        `${currentPayload.spend.toFixed(2)}$ / ${formatAmount(currentPayload.maxBudget)}`;
      const resetFormatted =
        currentPayload.resetAt != null ? formatReset(currentPayload.resetAt) : null;
      const resetElement = box.querySelector("[data-budget-reset]");
      resetElement.textContent =
        resetFormatted == null ? "" : `resets in ${resetFormatted}`;
      const amountRow = box.querySelector("[data-budget-amount-row]");
      if (resetElement.textContent !== "" && amountRow.scrollWidth > amountRow.clientWidth) {
        resetElement.textContent = "";
      }
    }

    const controller = {
      ensure: render,
      update(payload) {
        currentPayload = payload;
        render();
      },
    };
    globalThis.__codexBudgetController = controller;
    globalThis.__codexBudgetUpdate = controller.update;
    render();
    setInterval(render, 1500);
    return true;
  }

  return `(${installSidebarBudget.toString()})(${JSON.stringify(payload)})`;
}

function installBudgetStatus(app, BrowserWindow) {
  let payload = null;
  let lastProvider = null;
  let polling = false;

  function broadcast() {
    const source = sidebarBudgetScript(payload);
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.executeJavaScript(source).catch(() => {});
      }
    }
  }

  async function poll() {
    if (polling) {
      return;
    }
    polling = true;
    try {
      let provider = OPENAI_PROVIDER;
      let source = null;
      try {
        const configText = fs.readFileSync(
          path.join(codexHome(), "config.toml"),
          "utf8",
        );
        provider = activeProvider(configText);
        source = providerBudgetSource(configText, provider);
      } catch {
        source = null;
      }

      if (source == null) {
        payload = null;
      } else {
        const fetched = await fetchBudget(source);
        if (fetched != null) {
          payload = fetched;
        } else if (provider !== lastProvider) {
          // Hide until the new provider answers; keep the last value on
          // transient failures of the same provider.
          payload = null;
        }
      }
      lastProvider = provider;
      broadcast();
    } finally {
      polling = false;
    }
  }

  app.on("browser-window-created", (_event, window) => {
    window.webContents.on("did-finish-load", () => {
      broadcast();
      void poll();
    });
  });
  app.whenReady().then(() => {
    void poll();
    setInterval(() => void poll(), BUDGET_POLL_INTERVAL_MS);
  });
}

function activeProviderSyncScript(provider) {
  const serialized = JSON.stringify(provider);
  return `try{localStorage.setItem("__codex_active_provider",${serialized})}catch{}`;
}

async function updateSidebarProvider(BrowserWindow, provider) {
  const source =
    `${activeProviderSyncScript(provider)};` +
    `globalThis.__codexSetActiveProfile?.(${JSON.stringify(provider)})`;
  await Promise.allSettled(
    BrowserWindow.getAllWindows()
      .filter((window) => !window.isDestroyed() && !window.webContents.isDestroyed())
      .map((window) => window.webContents.executeJavaScript(source)),
  );
}

function installSidebarSwitcher(
  app,
  BrowserWindow,
  getProvider,
  getProviders,
  switchProvider,
) {
  const attached = new WeakSet();
  const requestPrefix = "__codex_profile_switch__:";
  const attach = (window) => {
    if (window.isDestroyed() || attached.has(window)) {
      return;
    }
    attached.add(window);
    window.webContents.on("console-message", (_event, detailsOrLevel, message) => {
      const consoleMessage =
        typeof detailsOrLevel === "object" ? detailsOrLevel.message : message;
      if (typeof consoleMessage !== "string" || !consoleMessage.startsWith(requestPrefix)) {
        return;
      }
      const provider = consoleMessage.slice(requestPrefix.length);
      if (getProviders().some((option) => option.provider === provider)) {
        void switchProvider(provider);
      }
    });
    let renderTimer = null;
    const syncProvider = () => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents
          .executeJavaScript(activeProviderSyncScript(getProvider()))
          .catch(() => {});
      }
    };
    const render = () => {
      syncProvider();
      clearTimeout(renderTimer);
      renderTimer = setTimeout(() => {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents
            .executeJavaScript(sidebarProfileScript(getProvider(), getProviders()))
            .catch(() => {});
        }
      }, 100);
    };
    window.webContents.on("did-finish-load", render);
    if (!window.webContents.isLoadingMainFrame()) {
      render();
    }
  };

  app.on("browser-window-created", (_event, window) => attach(window));
  app.whenReady().then(() => BrowserWindow.getAllWindows().forEach(attach));
}

function install() {
  const { app, BrowserWindow, dialog } = require("electron");

  let currentProvider = OPENAI_PROVIDER;
  let providerOptions = [{ provider: OPENAI_PROVIDER, label: "OpenAI" }];
  try {
    const configPath = path.join(codexHome(), "config.toml");
    const configText = fs.readFileSync(configPath, "utf8");
    currentProvider = activeProvider(configText);
    providerOptions = configuredProviders(configText);
  } catch {
    currentProvider = OPENAI_PROVIDER;
  }

  async function switchProvider(nextProvider) {
    try {
      if (!writeProvider(nextProvider)) {
        return;
      }
      currentProvider = nextProvider;
      const configPath = path.join(codexHome(), "config.toml");
      providerOptions = configuredProviders(fs.readFileSync(configPath, "utf8"));
      await updateSidebarProvider(BrowserWindow, nextProvider);
      const restarted = await restartCodexHost(BrowserWindow);
      if (!restarted || !(await reloadCodexWindows(BrowserWindow))) {
        relaunchApplication(app);
      }
    } catch (error) {
      dialog.showErrorBox(
        "Could not switch Codex profile",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  globalThis.__codexProfileSwitch = switchProvider;
  installBudgetStatus(app, BrowserWindow);
  installSidebarSwitcher(
    app,
    BrowserWindow,
    () => currentProvider,
    () => providerOptions,
    switchProvider,
  );
}

module.exports = {
  activeProvider,
  configuredProviders,
  install,
  reloadCodexWindows,
  restartCodexHost,
  rewriteModelProvider,
};
