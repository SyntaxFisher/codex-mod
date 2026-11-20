#!/usr/bin/env node
// Drives a running Codex over the DevTools protocol through a fixed set of
// scenarios, checks every feature the mod injects, and records the run.
//
//   node dev/verify.mjs --mode mod|stock --port 48123 --out DIR
//
// Writes DIR/<mode>.json, a screenshot per scenario step and DIR/<mode>.mp4.
// The scenarios only open menus and pages; they never click an account row,
// "Add account" or anything else that changes a login or a setting. The
// sign-in screen is shown through Codex's onboarding override, which leaves
// the login alone and is restored at the end of the scenario.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { defaultAsar, messageLabels } from "../scripts/patcher.mjs";

const { values: args } = parseArgs({
  options: {
    mode: { type: "string" },
    name: { type: "string" },
    port: { type: "string" },
    out: { type: "string" },
    asar: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (args.help) {
  process.stdout.write(
    "usage: node dev/verify.mjs [--mode mod|stock] [--name NAME] [--port 48123] [--out DIR] [--asar PATH]\n\n" +
      "Drives a running Codex through the verification scenarios and writes DIR/<name>.json,\n" +
      "screenshots and DIR/<name>.mp4; the name defaults to the mode. Labels are matched in\n" +
      "every language of the Codex build at PATH (default: the installed Codex).\n",
  );
  process.exit(0);
}
const MODE = args.mode ?? "mod";
const NAME = args.name ?? MODE;
const PORT = Number(args.port ?? 48123);
const OUT = path.resolve(args.out ?? ".");
const FRAME_INTERVAL_MS = 125;
// Long enough to catch an update offer that closes by itself.
const NOTICE_PERSISTS_MS = 10000;
// Versions of the cards this run shows: a page keeps a closed card closed, so
// a run that follows another in the same page needs cards of its own.
const RUN_ID = Date.now();
// Codex's own buttons are found by tags or structure where they have them,
// otherwise by their label in any language the build ships, so a run works
// whatever language Codex shows.
const LABELS = messageLabels(path.resolve(args.asar ?? defaultAsar()), [
  "codex.profileFooter.openProfileMenu",
  "codex.profileDropdown.settingsPage",
]);
const PROFILE_BUTTON_LABELS = LABELS["codex.profileFooter.openProfileMenu"];
const SETTINGS_LABELS = LABELS["codex.profileDropdown.settingsPage"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Page {
  #socket;
  #nextId = 1;
  #pending = new Map();
  events = [];

  /** Connects to the main window once `ready` holds there.
   *
   * The window's first page target can be replaced shortly after launch, for
   * example when the host reloads it, and a session on the replaced target
   * never answers; a page that does not answer is dropped for the current
   * target. Without a ready page in time, returns the last one connected. */
  static async open(port, ready, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let page = null;
    while (Date.now() < deadline) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const target = targets.find((t) => t.type === "page" && /\/index\.html$/.test(t.url));
        if (target != null) {
          page?.close();
          page = new Page();
          await page.#connect(target.webSocketDebuggerUrl);
          const result = await page.call("Runtime.evaluate", { expression: ready, returnByValue: true }, 3000);
          if (result.result?.value === true) return page;
        }
      } catch {
        // Codex is still starting.
      }
      await sleep(1000);
    }
    if (page != null) return page;
    throw new Error(`no Codex window on DevTools port ${port}`);
  }

  async #connect(url) {
    this.#socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      this.#socket.addEventListener("open", resolve, { once: true });
      this.#socket.addEventListener("error", reject, { once: true });
    });
    this.#socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id != null) {
        this.#pending.get(message.id)?.(message);
        this.#pending.delete(message.id);
      } else {
        this.events.push(message);
      }
    });
  }

  call(method, params = {}, timeoutMs = 10000) {
    const id = this.#nextId++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, (message) => {
        clearTimeout(timer);
        message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result);
      });
    });
  }

  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails != null) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  }

  close() {
    this.#socket.close();
  }
}

// Page-side helpers, installed once per run. Everything they return is
// structural (counts, flags, rectangles), never account names or e-mails.
const HELPERS = `
globalThis.__verify = {
  visible(element) {
    if (element == null || element.hidden) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
  },
  rect(element) {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  },
  overlaps(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  },
  // Whether the element's centre is drawn by the element itself, not by
  // something stacked on top of it.
  uncovered(element) {
    const r = element.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return hit != null && (element === hit || element.contains(hit));
  },
  profileButton() {
    return document.querySelector('[data-codex-mod-anchor="profile-menu"]') ??
      [...document.querySelectorAll("button")].find((b) => ${JSON.stringify(PROFILE_BUTTON_LABELS)}.includes(b.getAttribute("aria-label"))) ?? null;
  },
  menus() {
    return [...document.querySelectorAll("[data-radix-menu-content]")].filter((m) => this.visible(m));
  },
  header() {
    return this.menus()[0]?.querySelector('[role="menuitem"]') ?? null;
  },
  modCard() {
    const card = document.getElementById("codex-profile-switcher-menu");
    return this.visible(card) ? card : null;
  },
  center(element) {
    if (element == null) return null;
    element.scrollIntoView({ block: "nearest" });
    const r = element.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  },
  cursor(x, y) {
    let dot = document.getElementById("codex-verify-cursor");
    if (dot == null) {
      dot = document.createElement("div");
      dot.id = "codex-verify-cursor";
      Object.assign(dot.style, {
        position: "fixed", width: "18px", height: "18px", marginLeft: "-9px", marginTop: "-9px",
        borderRadius: "50%", background: "rgba(255,59,48,0.55)", border: "2px solid #fff",
        pointerEvents: "none", zIndex: "2147483647",
      });
      document.documentElement.append(dot);
    }
    dot.style.left = x + "px";
    dot.style.top = y + "px";
  },
  removeCursor() {
    document.getElementById("codex-verify-cursor")?.remove();
  },
};
true`;

class Run {
  checks = [];
  steps = [];
  frames = [];
  #recording = false;

  constructor(page) {
    this.page = page;
  }

  check(id, ok, severity, detail = {}) {
    this.checks.push({ id, ok: Boolean(ok), severity, detail });
  }

  async startRecording(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.#recording = true;
    this.recorder = (async () => {
      while (this.#recording) {
        const started = Date.now();
        try {
          const shot = await this.page.call("Page.captureScreenshot", { format: "jpeg", quality: 92 });
          const file = path.join(dir, `${String(this.frames.length).padStart(5, "0")}.jpg`);
          fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
          this.frames.push(file);
        } catch {
          // A frame lost while the page navigates is skipped.
        }
        await sleep(Math.max(0, FRAME_INTERVAL_MS - (Date.now() - started)));
      }
    })();
  }

  async stopRecording() {
    this.#recording = false;
    await this.recorder;
  }

  async screenshot(name) {
    const shot = await this.page.call("Page.captureScreenshot", { format: "png" });
    const file = path.join(OUT, `${NAME}-${name}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    this.steps.push({ step: name, screenshot: path.basename(file) });
  }

  async move(point) {
    const [x, y] = point;
    await this.page.evaluate(`__verify.cursor(${x}, ${y})`);
    await this.page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  async click(point) {
    await this.move(point);
    await sleep(250);
    const [x, y] = point;
    await this.page.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.page.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async wheel(point, deltaY) {
    const [x, y] = point;
    await this.page.call("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
  }

  // Wheels the settings navigation until the entry the selector names is in
  // view; Codex resets programmatic scrolling of that list.
  async revealInSettingsNav(selector) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const step = await this.page.evaluate(`(() => {
        const list = document.querySelector("[data-settings-nav-scroll-container]");
        const entry = document.querySelector(${JSON.stringify(selector)});
        if (list == null || entry == null) return null;
        const bounds = list.getBoundingClientRect();
        const rect = entry.getBoundingClientRect();
        const delta = rect.bottom > bounds.bottom ? rect.bottom - bounds.bottom + 12 : rect.top < bounds.top ? rect.top - bounds.top - 12 : 0;
        return { delta, at: [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2] };
      })()`);
      if (step == null || step.delta === 0) return step != null;
      await this.wheel(step.at, step.delta);
      await sleep(500);
    }
    return false;
  }

  async escape() {
    for (const type of ["keyDown", "keyUp"]) {
      await this.page.call("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    }
  }

  async waitFor(expression, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.page.evaluate(expression).catch(() => false)) {
        return true;
      }
      await sleep(150);
    }
    return false;
  }
}

async function probeInjection(run) {
  const state = await run.page.evaluate(`(() => {
    const fn = (value) => typeof value === "function";
    const usage = document.getElementById("codex-budget-status");
    const anchors = document.querySelectorAll('[data-codex-mod-anchor="profile-menu"]').length;
    return {
      bundles: globalThis.__codexModBundles === true,
      build: typeof globalThis.__codexModBuild === "string",
      require: fn(globalThis.__codexRequire),
      scope: globalThis.__codexScope != null,
      intl: globalThis.__codexIntl?.messages != null && typeof globalThis.__codexIntl.messages === "object",
      profileRestart: fn(globalThis.__codexProfileRestart),
      appServerClient: fn(globalThis.__codexAppServerClient),
      usageResets: fn(globalThis.__codexOpenUsageResets),
      codexUpdates: fn(globalThis.__codexCheckForCodexUpdates),
      onboardingOverride: fn(globalThis.__codexOnboardingOverride),
      rateLimitReport: fn(globalThis.__codexReportRateLimits),
      sidebarController: globalThis.__codexProfileSidebarController != null,
      budgetController: globalThis.__codexBudgetController != null,
      threadGuard: globalThis.__codexThreadGuardController != null,
      versionController: globalThis.__codexVersionController != null,
      modal: fn(globalThis.__codexShowModal),
      notices: fn(globalThis.__codexModNotices?.pill) && fn(globalThis.__codexModNotices?.update),
      taggedProfileAnchor: anchors > 0,
      profileButton: __verify.profileButton() != null,
      usageVisible: __verify.visible(usage),
      usageUncovered: usage != null && __verify.visible(usage) && __verify.uncovered(usage),
      usageHasValues: usage != null && /\\d+%/.test(usage.innerText),
    };
  })()`);
  const required = ["bundles", "build", "sidebarController", "budgetController", "threadGuard", "versionController", "modal", "notices", "profileButton", "usageVisible", "usageHasValues"];
  const degraded = ["require", "scope", "intl", "profileRestart", "appServerClient", "usageResets", "codexUpdates", "onboardingOverride", "rateLimitReport", "taggedProfileAnchor", "usageUncovered"];
  for (const key of required) run.check(`inject.${key}`, state[key], "required");
  for (const key of degraded) run.check(`inject.${key}`, state[key], "degraded");
  return state;
}

async function scenarioProfileMenu(run) {
  const button = await run.page.evaluate("__verify.center(__verify.profileButton())");
  run.check("ui.profileButton", button != null, "required");
  if (button == null) return {};
  await run.click(button);
  const opened = await run.waitFor("__verify.menus().length > 0");
  run.check("ui.profileMenuOpens", opened, "required");
  await sleep(400);
  await run.screenshot("1-profile-menu");
  const header = await run.page.evaluate(`(() => {
    const h = __verify.header();
    if (h == null) return null;
    return {
      nativeSubmenu: h.getAttribute("aria-haspopup") === "menu",
      disabled: h.getAttribute("aria-disabled") === "true" || h.hasAttribute("data-disabled"),
      modToggle: h.hasAttribute("data-profile-toggle"),
      chevrons: h.querySelectorAll("[data-profile-switch]").length,
      // Under a custom profile the header takes the shape of the profile's
      // row in the switcher: its icon, and the host below the name.
      customProfile: (globalThis.__codexProfileSidebarController?.getProvider() ?? "openai") !== "openai",
      profileRow: (() => {
        const row = h.querySelector("[data-profile-header-row]");
        return __verify.visible(row) && row.querySelector("[data-leading-icon-slot] [data-provider-icon]") != null &&
          row.querySelectorAll(".truncate").length >= 2;
      })(),
      center: __verify.center(h),
    };
  })()`);
  run.check("ui.headerRow", header != null, "required");
  if (header == null) return {};

  await run.move(header.center);
  await sleep(1200);
  await run.screenshot("2-header-hover");
  const hover = await run.page.evaluate(`(() => {
    const menus = __verify.menus();
    const card = __verify.modCard();
    return {
      menus: menus.length,
      modCard: card != null,
      cardOverlapsNative: card != null && menus.slice(1).some((m) => __verify.overlaps(__verify.rect(m), __verify.rect(card))),
    };
  })()`);

  await run.click(header.center);
  await sleep(900);
  await run.screenshot("3-header-click");
  const click = await run.page.evaluate(`(() => {
    const menus = __verify.menus();
    const card = __verify.modCard();
    const section = document.querySelector("[data-codex-accounts-section]");
    const rows = card ?? (__verify.visible(section) ? section : null);
    return {
      menus: menus.length,
      modCard: card != null,
      modCardUncovered: card != null && __verify.uncovered(card),
      nativeSection: __verify.visible(section),
      accountRows: rows == null ? 0 : rows.querySelectorAll('[role="option"], [role="menuitem"], button').length,
      // Each saved account shows a picture that loaded or Codex's initials avatar.
      brokenAvatars: rows == null ? 0 : [...rows.querySelectorAll("[data-account]")].filter((row) => {
        const avatar = row.querySelector("[data-leading-icon-slot] > *");
        return avatar == null || (avatar.tagName === "IMG" && !(avatar.complete && avatar.naturalWidth > 0));
      }).length,
      // Avatars in the header and the account rows are drawn as circles.
      nonRoundAvatars: [menus[0]?.querySelector('[role="menuitem"]'), ...(rows == null ? [] : rows.querySelectorAll("[data-account]"))]
        .map((row) => row?.querySelector("[data-leading-icon-slot] > .rounded-full"))
        .filter((avatar) => {
          if (avatar == null) return false;
          const r = avatar.getBoundingClientRect();
          return Math.abs(r.width - r.height) > 0.5;
        }).length,
      cardOverlapsNative: card != null && menus.slice(1).some((m) => __verify.overlaps(__verify.rect(m), __verify.rect(card))),
      // Profile rows take the account rows' shape: an icon in the picture
      // slot and a second line, at the same height.
      profileRows: rows == null ? 0 : rows.querySelectorAll("[data-provider]").length,
      unlikeProfileRows: (() => {
        if (rows == null) return 0;
        const accountRow = rows.querySelector("[data-account]");
        const height = accountRow?.getBoundingClientRect().height ?? null;
        return [...rows.querySelectorAll("[data-provider]")].filter((row) =>
          row.querySelector("[data-leading-icon-slot] [data-provider-icon]") == null ||
          row.querySelectorAll(".truncate").length < 2 ||
          (height != null && Math.abs(row.getBoundingClientRect().height - height) > 1),
        ).length;
      })(),
    };
  })()`);

  if (MODE === "mod") {
    run.check("ui.singleChevron", header.chevrons <= 1, "required", { chevrons: header.chevrons });
    run.check("ui.switcherOpens", click.modCard || click.nativeSection, "required", {
      via: click.modCard ? "mod-card" : click.nativeSection ? "codex-submenu" : "none",
    });
    run.check("ui.switcherHasRows", click.accountRows > 0, "required", { rows: click.accountRows });
    run.check("ui.accountAvatarsRender", click.brokenAvatars === 0, "required", { broken: click.brokenAvatars });
    run.check("ui.accountAvatarsRound", click.nonRoundAvatars === 0, "required", { nonRound: click.nonRoundAvatars });
    if (click.profileRows > 0) {
      run.check("ui.profileRowsMatchAccounts", click.unlikeProfileRows === 0, "required", { unlike: click.unlikeProfileRows });
    }
    run.check("ui.noCollisionOnHover", !(hover.modCard && hover.menus > 1) && !hover.cardOverlapsNative, "required", hover);
    run.check("ui.noCollisionOnClick", !(click.modCard && click.menus > 1) && !click.cardOverlapsNative, "required", click);
    run.check("ui.switcherUncovered", !click.modCard || click.modCardUncovered, "required");
    if (header.customProfile) {
      run.check("ui.headerShowsProfile", header.profileRow, "required");
    }
    run.check("ui.headerRoleKnown", header.modToggle || header.nativeSubmenu, "required", {
      nativeSubmenu: header.nativeSubmenu,
      modToggle: header.modToggle,
    });
  }
  await run.escape();
  await sleep(300);
  await run.escape();
  await sleep(500);
  return { header: { ...header, center: undefined }, hover, click };
}

async function scenarioModal(run) {
  if (MODE !== "mod") return null;
  const shown = await run.page.evaluate(`(() => {
    if (typeof globalThis.__codexShowModal !== "function") return false;
    void globalThis.__codexShowModal({ message: "Codex Mod self-test", detail: "This dialog closes by itself.", buttons: ["OK"] });
    return true;
  })()`);
  const visible = shown && (await run.waitFor('[...document.querySelectorAll(".codex-mod-modal")].some((m) => __verify.visible(m))', 3000));
  if (visible) await run.screenshot("4-modal");
  await run.page.evaluate("globalThis.__codexDismissModals?.(), true");
  run.check("ui.modalRenders", visible, "required");
  await sleep(400);
  return { visible };
}

// The update notices: a pill and a release card with a summary too long for
// its two lines, stacked in the window's top right corner above every pane.
// The release card closes by itself after a countdown.
async function scenarioNotices(run) {
  if (MODE !== "mod") return null;
  const shown = await run.page.evaluate(`(() => {
    const notices = globalThis.__codexModNotices;
    if (notices == null) return false;
    notices.pill("Codex Mod self-test", { spinner: true });
    notices.update({
      version: "0.0.0",
      summary: "A self-test of the update notice whose summary runs on far longer than the two lines the card gives it, " +
        "so it has to end in an ellipsis right before the link that opens the release notes.",
      ms: 60000,
    });
    return true;
  })()`);
  const visible = shown && (await run.waitFor('[...document.querySelectorAll(".codex-mod-notice")].filter((n) => __verify.visible(n)).length === 1', 3000));
  await sleep(400);
  const layout = await run.page.evaluate(`(() => {
    const card = document.querySelector(".codex-mod-update .codex-mod-notice-card");
    const summary = card?.querySelector(".codex-mod-notice-summary");
    if (card == null || summary == null) return null;
    const rect = __verify.rect(card);
    const lineHeight = parseFloat(getComputedStyle(summary).lineHeight) || 16;
    return {
      topRight: Math.abs(innerWidth - (rect.x + rect.width) - 16) <= 2 && rect.y < 120,
      uncovered: __verify.uncovered(card),
      lines: Math.round(summary.getBoundingClientRect().height / lineHeight),
      cut: /… Read more$/.test(summary.textContent),
      pillReplaced: document.querySelectorAll(".codex-mod-pill[data-open='true']").length === 0,
    };
  })()`);
  if (visible) await run.screenshot("6-notices");
  await run.page.evaluate('document.querySelector(".codex-mod-update .codex-mod-notice-close")?.click(), true');
  const closed = await run.waitFor('document.querySelector(".codex-mod-notice") == null', 3000);
  // The release card counts down and closes by itself; the cursor is moved
  // off it first, since hovering pauses the countdown.
  await run.move([20, 20]);
  await run.page.evaluate('globalThis.__codexModNotices.update({ version: "0.0.0", summary: "Closes by itself.", ms: 1500 }), true');
  const autoCloses = await run.waitFor('document.querySelector(".codex-mod-update") == null', 5000);
  run.check("ui.noticeRenders", visible, "required");
  run.check("ui.noticeTopRight", layout?.topRight && layout?.uncovered, "required", layout ?? {});
  run.check("ui.noticeSummaryFits", layout?.lines <= 2 && layout?.cut, "required", layout ?? {});
  run.check("ui.noticeReplacesPill", layout?.pillReplaced, "required");
  run.check("ui.noticeCloses", closed, "required");
  run.check("ui.noticeAutoCloses", autoCloses, "required");
  const offers = await scenarioUpdateOffers(run);
  return { visible, layout, closed, autoCloses, offers };
}

// The card that offers an installed update through its Apply now button, and
// the one that says a release needs a newer Codex with a button for Codex's
// own update check, stacked in the top right corner. Each button sits under
// the card's text, flush with it, and neither card links to release notes. Neither
// button is clicked: on a release install they would apply a real update or
// open Codex's updater.
async function scenarioUpdateOffers(run) {
  const shown = await run.page.evaluate(`(() => {
    const notices = globalThis.__codexModNotices;
    if (typeof notices?.ready !== "function" || typeof notices?.incompatible !== "function") return false;
    notices.ready({ version: "0.0.${RUN_ID}" });
    notices.incompatible({ version: "0.1.${RUN_ID}", codex: "0.0.0", minimum: null });
    return true;
  })()`);
  const visible = shown && (await run.waitFor('[...document.querySelectorAll(".codex-mod-ready, .codex-mod-incompatible")].filter((n) => __verify.visible(n)).length === 2', 3000));
  await sleep(400);
  const layout = await run.page.evaluate(`(() => {
    const ready = document.querySelector(".codex-mod-ready .codex-mod-notice-card");
    const incompatible = document.querySelector(".codex-mod-incompatible .codex-mod-notice-card");
    if (ready == null || incompatible == null) return null;
    const below = (button, card) => {
      if (button == null) return false;
      const b = __verify.rect(button);
      const t = __verify.rect(card.querySelector(".codex-mod-notice-text > div"));
      return b.y >= t.y + t.height && Math.abs(b.x - t.x) <= 1 && __verify.uncovered(button);
    };
    const apply = ready.querySelector(".codex-mod-notice-button");
    const update = incompatible.querySelector(".codex-mod-notice-button");
    return {
      applyButton: apply?.textContent === "Apply now" && below(apply, ready),
      updateButton: typeof globalThis.__codexCheckForCodexUpdates === "function" ? update?.textContent === "Update Codex" && below(update, incompatible) : update == null,
      noNotes: ready.querySelector(".codex-mod-notice-more") == null && incompatible.querySelector(".codex-mod-notice-more") == null,
      uncovered: __verify.uncovered(ready) && __verify.uncovered(incompatible),
      stacked: !__verify.overlaps(__verify.rect(ready), __verify.rect(incompatible)),
    };
  })()`);
  if (visible) await run.screenshot("6b-update-offers");
  await sleep(NOTICE_PERSISTS_MS);
  const persists = await run.page.evaluate('[...document.querySelectorAll(".codex-mod-ready[data-open=\'true\'], .codex-mod-incompatible[data-open=\'true\']")].length === 2');
  await run.page.evaluate('document.querySelectorAll(".codex-mod-ready .codex-mod-notice-close, .codex-mod-incompatible .codex-mod-notice-close").forEach((b) => b.click()), true');
  const closed = await run.waitFor('document.querySelector(".codex-mod-ready, .codex-mod-incompatible") == null', 3000);
  run.check("ui.updateOffersRender", visible, "required");
  run.check("ui.updateApplyButton", layout?.applyButton, "required", layout ?? {});
  run.check("ui.updateCodexButton", layout?.updateButton, "required", layout ?? {});
  run.check("ui.updateOffersLayout", layout?.uncovered && layout?.stacked && layout?.noNotes, "required", layout ?? {});
  run.check("ui.updateOffersPersist", persists, "required");
  run.check("ui.updateOffersClose", closed, "required");
  return { visible, layout, persists, closed };
}

// The heading and the section list of a settings page: Codex's own when
// `page` is null, else the one inside `page`. The mod's page has to match
// Codex's, whether settings open in a dialog or as a page of their own.
const SETTINGS_PAGE_GEOMETRY = `((page) => {
  const ours = document.getElementById("codex-mod-settings-page");
  const inside = (node) => (page == null ? node.closest("nav") == null && (ours == null || !ours.contains(node)) : page.contains(node));
  const lists = [...document.querySelectorAll("[class*='settings-section-gap']")].filter((node) => inside(node) && __verify.visible(node));
  const list = page == null ? lists[0] : document.getElementById("codex-mod-version")?.closest("[class*='settings-section-gap']");
  const heading = [...document.querySelectorAll("h1")].find((h1) => inside(h1) && __verify.visible(h1) && __verify.uncovered(h1));
  if (heading == null || list == null) return null;
  const h = heading.getBoundingClientRect();
  const l = list.getBoundingClientRect();
  // Lists in the mod's page beside its own, such as a copy of Codex's page.
  const foreign = page == null ? 0 : lists.filter((node) => !node.contains(list)).length;
  return { headingX: h.left, headingY: h.top, headingHeight: h.height, listX: l.left, listWidth: l.width, foreign };
})`;

async function scenarioSettings(run) {
  const button = await run.page.evaluate("__verify.center(__verify.profileButton())");
  if (button == null) return null;
  await run.click(button);
  await run.waitFor("__verify.menus().length > 0");
  await sleep(300);
  const item = await run.page.evaluate(`(() => {
    const items = [...(__verify.menus()[0]?.querySelectorAll('[role="menuitem"]') ?? [])];
    const labels = ${JSON.stringify(SETTINGS_LABELS)};
    const settings = items.find((i) => labels.some((label) => i.textContent.trim().startsWith(label)));
    return __verify.center(settings ?? null);
  })()`);
  run.check("ui.settingsItem", item != null, "degraded");
  if (item == null) {
    await run.escape();
    return null;
  }
  await run.click(item);
  const opened = await run.waitFor('document.querySelector("nav.sidebar-navigation") != null', 5000);
  run.check("ui.settingsOpens", opened, "degraded");
  let section = null;
  if (MODE === "mod") {
    await run.waitFor(`${SETTINGS_PAGE_GEOMETRY}(null) != null`, 5000);
    const codexGeometry = await run.page.evaluate(`${SETTINGS_PAGE_GEOMETRY}(null)`);
    // The mod's own entry at the end of the settings navigation opens its
    // page in place of Codex's, and any other entry brings Codex's back.
    const entry = await run.waitFor('document.getElementById("codex-mod-settings-nav") != null', 5000);
    run.check("ui.settingsNavEntry", entry, "required");
    if (entry && (await run.revealInSettingsNav("#codex-mod-settings-nav"))) {
      await run.click(await run.page.evaluate('__verify.center(document.getElementById("codex-mod-settings-nav"))'));
      await run.waitFor('document.getElementById("codex-mod-version") != null', 3000);
      await sleep(400);
      section = await run.page.evaluate(`(() => {
        const s = document.getElementById("codex-mod-version");
        const page = document.getElementById("codex-mod-settings-page");
        const nav = document.getElementById("codex-mod-settings-nav");
        const codexCurrent = [...document.querySelectorAll("nav.sidebar-navigation button")]
          .filter((b) => b !== nav && b.getAttribute("aria-current") === "page").length;
        return {
          present: s != null,
          visible: __verify.visible(s),
          onlyPageShown: page != null && [...page.parentElement.children].filter((c) => __verify.visible(c)).length === 1,
          navActive: nav?.getAttribute("aria-current") === "page" && codexCurrent === 0,
          layout: (() => {
            const ours = ${SETTINGS_PAGE_GEOMETRY}(page);
            const codex = ${JSON.stringify(codexGeometry)};
            const near = (a, b) => a != null && b != null && Math.abs(a - b) <= 2;
            return ours != null && codex != null &&
              ours.foreign === 0 && ["headingX", "headingY", "headingHeight", "listX", "listWidth"].every((key) => near(ours[key], codex[key]))
              ? true : { ours, codex };
          })(),
          officeBridge: (() => {
            const row = s?.querySelector("[data-codex-mod-office-bridge]");
            const toggle = row?.querySelector("button[role=switch]");
            return __verify.visible(row) && ["true", "false"].includes(toggle?.getAttribute("aria-checked"));
          })(),
        };
      })()`);
      await run.screenshot("5-settings");
      if (await run.revealInSettingsNav('[data-settings-panel-slug="general-settings"]')) {
        await run.click(await run.page.evaluate("__verify.center(document.querySelector('[data-settings-panel-slug=\"general-settings\"]'))"));
      }
      section.restores = await run.waitFor('document.getElementById("codex-mod-settings-page") == null && [...document.querySelectorAll("h1")].some((h) => __verify.visible(h) && h.closest("nav") == null)', 3000);
    }
    run.check("ui.settingsSection", section?.present && section?.visible && section?.onlyPageShown, "required", section ?? {});
    run.check("ui.settingsLayout", section?.layout === true, "required", section?.layout ?? {});
    run.check("ui.settingsNavActive", section?.navActive, "required", section ?? {});
    run.check("ui.settingsNavRestores", section?.restores, "required", section ?? {});
    run.check("ui.settingsOfficeBridge", section?.officeBridge, "required", section ?? {});
  } else {
    await sleep(500);
    await run.screenshot("5-settings");
  }
  // Settings open in a dialog that Escape closes, or on older builds as a
  // page that Codex's back button in the toolbar leaves, so the next
  // scenario starts where this one did.
  await run.escape();
  let left = await run.waitFor('document.querySelector("nav.sidebar-navigation") == null', 3000);
  if (!left && (await run.page.evaluate('document.querySelector("nav.sidebar-navigation")?.closest("[role=dialog]") == null'))) {
    const back = await run.page.evaluate(`(() => {
      const buttons = [...document.querySelectorAll("button")].filter((b) => {
        const r = b.getBoundingClientRect();
        return __verify.visible(b) && !b.disabled && r.width > 0 && r.bottom <= 44 && b.querySelector("svg") != null &&
          b.textContent.trim() === "" && b.closest('[aria-hidden="true"]') == null && __verify.uncovered(b);
      });
      buttons.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      return __verify.center(buttons[0] ?? null);
    })()`);
    if (back != null) {
      await run.click(back);
      left = await run.waitFor('document.querySelector("nav.sidebar-navigation") == null', 3000);
    }
  }
  run.check("ui.settingsCloses", left, "degraded");
  return section;
}

// The saved accounts and profiles lead the sign-in screen's column of
// choices, once as Codex shows it here and once with the browser sessions
// Codex offers when it finds ChatGPT logins in the default browser. Those
// sessions are simulated through Codex's own query cache and experiment
// layer, which leaves the browser alone; the saved logins replace them.
// Every card and the pill also work on the sign-in screen, which has no
// toolbar: the stack sits in the corner with the same gap at the top as at
// the right, keeps clear of the sign-in buttons, and its buttons take clicks.
// They are removed without being clicked, which would apply a real update or
// open Codex's updater.
async function signInNotices(run) {
  const shown = await run.page.evaluate(`(() => {
    const notices = globalThis.__codexModNotices;
    if (notices == null) return false;
    notices.update({ version: "0.0.2", summary: "A summary long enough to take both lines of the card before it is cut at a word and ends in the link.", ms: 60000 });
    notices.ready({ version: "0.2.${RUN_ID}" });
    notices.incompatible({ version: "0.3.${RUN_ID}", codex: "0.0.0", minimum: "0.0.1" });
    notices.pill("Codex Mod", { ms: 60000 });
    return true;
  })()`);
  if (!shown) return null;
  await run.waitFor('[...document.querySelectorAll(".codex-mod-notice")].filter((n) => n.dataset.open === "true" && __verify.visible(n)).length === 4', 3000);
  await sleep(400);
  const result = await run.page.evaluate(`(() => {
    const stack = document.querySelector(".codex-mod-notices");
    const nodes = [...document.querySelectorAll(".codex-mod-update, .codex-mod-ready, .codex-mod-incompatible, .codex-mod-pill")];
    const anchors = [...document.querySelectorAll('[data-codex-mod-anchor^="sign-in"], #codex-login-accounts')].filter((n) => __verify.visible(n));
    const r = stack?.getBoundingClientRect();
    const clickable = [...stack.querySelectorAll("button")].every((b) => __verify.uncovered(b));
    const clear = nodes.every((n) => anchors.every((a) => !__verify.overlaps(__verify.rect(n), __verify.rect(a))));
    const corner = r != null && Math.abs(r.top - (innerWidth - r.right)) <= 1;
    const visible = nodes.length === 4 && nodes.every((n) => __verify.visible(n));
    return visible && clickable && clear && corner ? true : { visible, clickable, clear, corner, top: r?.top, right: r && innerWidth - r.right };
  })()`);
  await run.screenshot("9-sign-in-notices");
  await run.page.evaluate('document.querySelectorAll(".codex-mod-notice").forEach((n) => n.remove()), true');
  return result;
}

// The panel sits first in the column, as wide as the sign-in buttons, with
// every row visible and drawn by itself, and Codex's own button after it.
const SIGN_IN_PANEL_STATE = `(() => {
  const panel = document.getElementById("codex-login-accounts");
  const alternative = document.querySelector('[data-codex-mod-anchor="sign-in-alternative"]');
  if (!__verify.visible(panel) || alternative == null) return null;
  const rows = [...panel.querySelectorAll("[data-account], [data-provider]")];
  const next = [...panel.parentElement.children].find((n) => n !== panel && __verify.visible(n));
  return {
    rows: rows.length,
    rowsVisible: rows.length > 0 && rows.every((row) => __verify.visible(row) && __verify.uncovered(row)),
    first: panel.parentElement.firstElementChild === panel,
    aboveButtons: next != null && panel.getBoundingClientRect().bottom <= next.getBoundingClientRect().top,
    sameWidth: Math.abs(panel.getBoundingClientRect().width - alternative.getBoundingClientRect().width) <= 1,
    profilesWithIcon: [...panel.querySelectorAll("[data-provider]")].every((row) => row.querySelector("[data-provider-icon]") != null),
  };
})()`;

const signInPanelOk = (state) =>
  state != null && state.rowsVisible && state.first && state.aboveButtons && state.sameWidth && state.profilesWithIcon;

// Makes Codex show browser sessions: its lookup is enabled through the
// experiment layer that carries it, and the lookup's answers are put into
// the query cache before Codex asks the browser. Returns a function that
// undoes both, or null when Codex's internals are not where expected.
const SIMULATE_BROWSER_SESSIONS = `(() => {
  const surface = document.querySelector("[data-desktop-login-surface]");
  const key = surface == null ? null : Object.keys(surface).find((k) => k.startsWith("__reactFiber"));
  let fiber = key == null ? null : surface[key], client = null;
  while (fiber != null && client == null) {
    if (typeof fiber.memoizedProps?.client?.getQueryData === "function") client = fiber.memoizedProps.client;
    fiber = fiber.return;
  }
  const statsig = globalThis.__STATSIG__?.firstInstance;
  if (client == null || typeof statsig?.getLayer !== "function") return false;
  const getLayer = statsig.getLayer;
  statsig.getLayer = function (name, options) {
    const layer = getLayer.call(this, name, options);
    const value = layer?.__value;
    if (value == null || !("experience" in value) || !("list_all_accounts" in value)) return layer;
    const get = layer.get.bind(layer);
    return { ...layer, __value: { ...value, experience: "browser_lookup" }, get: (k, d) => (k === "experience" ? "browser_lookup" : get(k, d)) };
  };
  const keys = [["chatgpt-browser-session-lookup-eligibility"], ["chatgpt-browser-session-profiles", true], ["chatgpt-browser-session-profiles", false]];
  const previous = keys.map((k) => client.getQueryState(k) == null ? undefined : client.getQueryData(k));
  const profiles = [{ email: "verify@example.com", name: "Verify Session", avatarUrl: null }];
  client.setQueryData(keys[0], { arm64: true, browserHasVisibleWindow: true, browserIsRunning: true, eligible: true, macOS: true, supportedPlatform: true });
  client.setQueryData(keys[1], profiles);
  client.setQueryData(keys[2], profiles);
  globalThis.__codexVerifyUndoBrowserSessions = () => {
    statsig.getLayer = getLayer;
    keys.forEach((k, i) => previous[i] === undefined ? client.removeQueries({ queryKey: k, exact: true }) : client.setQueryData(k, previous[i]));
  };
  return true;
})()`;

async function scenarioSignIn(run) {
  if (MODE !== "mod") return null;
  const previous = await run.page.evaluate("globalThis.__codexOnboardingOverride?.() ?? null");
  run.check("ui.signInOverride", previous != null, "degraded");
  if (previous == null) return null;
  const restoreScreen = `globalThis.__codexOnboardingOverride(${previous === "auto" ? "undefined" : JSON.stringify(previous)}), true`;
  const result = {};
  let simulated = false;
  try {
    await run.page.evaluate('globalThis.__codexOnboardingOverride("login"), true');
    result.screen = await run.waitFor('document.querySelector(\'[data-codex-mod-anchor^="sign-in"]\') != null && __verify.profileButton() == null', 10000);
    run.check("ui.signInScreen", result.screen, "degraded");
    if (!result.screen) return result;
    await run.waitFor(`(${signInPanelOk.toString()})(${SIGN_IN_PANEL_STATE})`, 5000);
    result.panel = await run.page.evaluate(SIGN_IN_PANEL_STATE);
    await run.screenshot("7-sign-in");
    run.check("ui.signInAccounts", signInPanelOk(result.panel), "required", result.panel ?? {});

    // Codex renders the sessions from the cache once the screen mounts again.
    simulated = await run.page.evaluate(SIMULATE_BROWSER_SESSIONS);
    run.check("ui.signInBrowserSessionsSimulated", simulated, "degraded");
    if (simulated) {
      await run.page.evaluate(`${restoreScreen}`);
      await run.waitFor("__verify.profileButton() != null", 10000);
      await run.page.evaluate('globalThis.__codexOnboardingOverride("login"), true');
      result.sessionScreen = await run.waitFor('document.querySelector(\'[data-codex-mod-anchor="sign-in-other-account"]\') != null', 10000);
      run.check("ui.signInBrowserSessionsShown", result.sessionScreen, "degraded");
      if (result.sessionScreen) {
        await run.waitFor(`(${signInPanelOk.toString()})(${SIGN_IN_PANEL_STATE})`, 5000);
        result.sessionPanel = await run.page.evaluate(`(() => {
          const state = ${SIGN_IN_PANEL_STATE};
          const other = document.querySelector('[data-codex-mod-anchor="sign-in-other-account"]');
          const before = [];
          for (let n = other?.previousElementSibling; n != null && n.id !== "codex-login-accounts"; n = n.previousElementSibling) before.push(n);
          return state == null ? null : { ...state, replaced: before.length, sessionsHidden: before.length > 0 && before.every((n) => !__verify.visible(n)) };
        })()`);
        await run.screenshot("8-sign-in-browser-sessions");
        run.check("ui.signInReplacesBrowserSessions", signInPanelOk(result.sessionPanel) && result.sessionPanel.sessionsHidden, "required", result.sessionPanel ?? {});
      }
    }
    result.notices = await signInNotices(run);
    run.check("ui.signInNotices", result.notices === true, "required", result.notices ?? {});
  } finally {
    if (simulated) await run.page.evaluate("globalThis.__codexVerifyUndoBrowserSessions?.(), true");
    await run.page.evaluate(restoreScreen);
    result.restored = await run.waitFor("__verify.profileButton() != null", 10000);
    run.check("ui.signInRestores", result.restored, "required");
  }
  return result;
}

function encodeVideo(frames, file) {
  if (frames.length === 0) return false;
  const result = spawnSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-framerate", String(1000 / FRAME_INTERVAL_MS), "-i", path.join(path.dirname(frames[0]), "%05d.jpg"),
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", "-c:v", "libx264", "-crf", "18", "-movflags", "+faststart", file],
    { encoding: "utf8" },
  );
  return result.status === 0;
}

// The report is meant to be safe to quote anywhere: whatever slipped into a
// detail string loses e-mails, the home path, the user and the host name.
function scrub(value) {
  const replacements = [
    [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>"],
    [new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "~"],
    [new RegExp(`\\b${os.userInfo().username}\\b`, "g"), "<user>"],
    [new RegExp(`\\b${os.hostname().split(".")[0]}\\b`, "gi"), "<host>"],
  ];
  return JSON.parse(
    JSON.stringify(value),
    (key, item) => (typeof item === "string" ? replacements.reduce((text, [pattern, to]) => text.replace(pattern, to), item) : item),
  );
}

// Only the sign-in scenario sets the persisted onboarding override to
// "login". Found before a run, it is left from a run that stopped before
// restoring it and would keep Codex on the sign-in screen.
const RESET_LEFT_SIGN_IN = 'globalThis.__codexOnboardingOverride?.() === "login" && globalThis.__codexOnboardingOverride(undefined)';

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const readyExpression =
    MODE === "mod"
      ? `(${RESET_LEFT_SIGN_IN}, globalThis.__codexModBundles === true && document.getElementById('codex-budget-status') != null)`
      : "document.querySelector('button') != null";
  const page = await Page.open(PORT, readyExpression, 90000);
  await page.call("Runtime.enable");
  await page.call("Page.enable");
  await page.call("Page.bringToFront");
  const run = new Run(page);
  // Codex can stay on its loading screen for over a minute after a launch
  // or reload before the window and the mod's controls are in place.
  const ready = await run.waitFor(readyExpression, 60000);
  run.check("app.ready", ready, "required");
  await page.evaluate(HELPERS);
  const startEvents = page.events.length;
  const frameDir = path.join(OUT, `${NAME}-frames`);
  await run.startRecording(frameDir);
  const result = { mode: MODE, name: NAME, scenarios: {} };
  try {
    await sleep(1500);
    await run.screenshot("0-home");
    if (MODE === "mod") result.injection = await probeInjection(run);
    result.scenarios.profileMenu = await scenarioProfileMenu(run);
    result.scenarios.modal = await scenarioModal(run);
    result.scenarios.settings = await scenarioSettings(run);
    result.scenarios.notices = await scenarioNotices(run);
    result.scenarios.signIn = await scenarioSignIn(run);
    await sleep(1000);
  } catch (error) {
    run.check("run.completed", false, "required", { error: String(error?.message ?? error) });
  } finally {
    await run.stopRecording();
    await page.evaluate("__verify.removeCursor(), true").catch(() => {});
  }
  const errors = page.events
    .slice(startEvents)
    .filter((e) => e.method === "Runtime.exceptionThrown" || (e.method === "Runtime.consoleAPICalled" && e.params.type === "error"))
    .map((e) => e.params.exceptionDetails?.exception?.description ?? e.params.args?.map((a) => a.value ?? a.description).join(" ") ?? "")
    .map((text) => String(text).slice(0, 400));
  const modErrors = errors.filter((text) => /__codex|codex-mod|codex-profile|codex-budget/i.test(text));
  if (MODE === "mod") run.check("console.noModErrors", modErrors.length === 0, "degraded", { errors: modErrors });
  result.consoleErrors = errors.slice(0, 20);
  result.checks = run.checks;
  result.steps = run.steps;
  result.video = encodeVideo(run.frames, path.join(OUT, `${NAME}.mp4`)) ? `${NAME}.mp4` : null;
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.writeFileSync(path.join(OUT, `${NAME}.json`), JSON.stringify(scrub(result), null, 2) + "\n");
  page.close();
  const failed = run.checks.filter((c) => !c.ok);
  console.log(JSON.stringify({ mode: MODE, name: NAME, checks: run.checks.length, failed: failed.map((c) => `${c.severity}:${c.id}`) }));
}

// Pending DevTools timers would otherwise keep the process alive after the
// report is written.
main().then(
  () => process.exit(0),
  (error) => {
    console.error(String(error?.stack ?? error));
    process.exit(1);
  },
);
