#!/usr/bin/env node
// Drives a running Codex over the DevTools protocol through a fixed set of
// scenarios, checks every feature the mod injects, and records the run.
//
//   node dev/verify.mjs --mode mod|stock --port 48123 --out DIR
//
// Writes DIR/<mode>.json, a screenshot per scenario step and DIR/<mode>.mp4.
// The scenarios only open menus and pages; they never click an account row,
// "Add account" or anything else that changes a login or a setting.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ""), all[index + 1]]] : pairs), []),
);
const MODE = args.mode ?? "mod";
const PORT = Number(args.port ?? 48123);
const OUT = path.resolve(args.out ?? ".");
const FRAME_INTERVAL_MS = 125;
const PROFILE_BUTTON_LABEL = "Open profile menu";
const SETTINGS_LABEL = "Settings";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Page {
  #socket;
  #nextId = 1;
  #pending = new Map();
  events = [];

  static async open(port) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const target = targets.find((t) => t.type === "page" && /\/index\.html$/.test(t.url));
        if (target != null) {
          const page = new Page();
          await page.#connect(target.webSocketDebuggerUrl);
          return page;
        }
      } catch {
        // Codex is still starting.
      }
      await sleep(1000);
    }
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
      [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === ${JSON.stringify(PROFILE_BUTTON_LABEL)}) ?? null;
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
    const file = path.join(OUT, `${MODE}-${name}.png`);
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
      rateLimitReport: fn(globalThis.__codexReportRateLimits),
      sidebarController: globalThis.__codexProfileSidebarController != null,
      budgetController: globalThis.__codexBudgetController != null,
      threadGuard: globalThis.__codexThreadGuardController != null,
      versionController: globalThis.__codexVersionController != null,
      modal: fn(globalThis.__codexShowModal),
      taggedProfileAnchor: anchors > 0,
      profileButton: __verify.profileButton() != null,
      usageVisible: __verify.visible(usage),
      usageUncovered: usage != null && __verify.visible(usage) && __verify.uncovered(usage),
      usageHasValues: usage != null && /\\d+%/.test(usage.innerText),
    };
  })()`);
  const required = ["bundles", "build", "sidebarController", "budgetController", "threadGuard", "versionController", "modal", "profileButton", "usageVisible", "usageHasValues"];
  const degraded = ["require", "scope", "intl", "profileRestart", "appServerClient", "usageResets", "rateLimitReport", "taggedProfileAnchor", "usageUncovered"];
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
    run.check("ui.noCollisionOnHover", !(hover.modCard && hover.menus > 1) && !hover.cardOverlapsNative, "required", hover);
    run.check("ui.noCollisionOnClick", !(click.modCard && click.menus > 1) && !click.cardOverlapsNative, "required", click);
    run.check("ui.switcherUncovered", !click.modCard || click.modCardUncovered, "required");
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

async function scenarioSettings(run) {
  const button = await run.page.evaluate("__verify.center(__verify.profileButton())");
  if (button == null) return null;
  await run.click(button);
  await run.waitFor("__verify.menus().length > 0");
  await sleep(300);
  const item = await run.page.evaluate(`(() => {
    const items = [...(__verify.menus()[0]?.querySelectorAll('[role="menuitem"]') ?? [])];
    const settings = items.find((i) => i.textContent.trim().startsWith(${JSON.stringify(SETTINGS_LABEL)}));
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
  await run.waitFor('document.getElementById("codex-mod-version") != null', 5000);
  const section = await run.page.evaluate(`(() => {
    const s = document.getElementById("codex-mod-version");
    if (s != null) s.scrollIntoView({ block: "center" });
    return { present: s != null, visible: __verify.visible(s) };
  })()`);
  await sleep(500);
  await run.screenshot("5-settings");
  if (MODE === "mod") {
    run.check("ui.settingsSection", section.present && section.visible, "required", section);
  }
  // Leave settings through the rail's Home button so the next run starts home.
  await run.page.evaluate(`(() => {
    [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Home")?.click();
    return true;
  })()`);
  await run.waitFor('document.querySelector("nav.sidebar-navigation") == null', 5000);
  return section;
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

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const page = await Page.open(PORT);
  await page.call("Runtime.enable");
  await page.call("Page.enable");
  await page.call("Page.bringToFront");
  const run = new Run(page);
  const ready = await run.waitFor(
    MODE === "mod" ? "globalThis.__codexModBundles === true && document.getElementById('codex-budget-status') != null" : "document.querySelector('button') != null",
    90000,
  );
  run.check("app.ready", ready, "required");
  await page.evaluate(HELPERS);
  const startEvents = page.events.length;
  const frameDir = path.join(OUT, `${MODE}-frames`);
  await run.startRecording(frameDir);
  const result = { mode: MODE, scenarios: {} };
  try {
    await sleep(1500);
    await run.screenshot("0-home");
    if (MODE === "mod") result.injection = await probeInjection(run);
    result.scenarios.profileMenu = await scenarioProfileMenu(run);
    result.scenarios.modal = await scenarioModal(run);
    result.scenarios.settings = await scenarioSettings(run);
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
  result.video = encodeVideo(run.frames, path.join(OUT, `${MODE}.mp4`)) ? `${MODE}.mp4` : null;
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.writeFileSync(path.join(OUT, `${MODE}.json`), JSON.stringify(scrub(result), null, 2) + "\n");
  page.close();
  const failed = run.checks.filter((c) => !c.ok);
  console.log(JSON.stringify({ mode: MODE, checks: run.checks.length, failed: failed.map((c) => `${c.severity}:${c.id}`) }));
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
