// Builds the patched renderer bundles the host serves over the DevTools
// protocol. The installed application is never modified: the bundles are
// read from app.asar through its header and patched into a cache directory.
// The only bundle write left is restoring an app.asar that a release before
// 2.0.0 patched in place.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sourceRelease } from "./installation.mjs";

const PATCHER_FILE = fileURLToPath(import.meta.url);

export const DEFAULT_ASAR_CANDIDATES = [
  "/Applications/ChatGPT.app/Contents/Resources/app.asar",
  "/Applications/Codex.app/Contents/Resources/app.asar",
];

export function defaultAsar() {
  return DEFAULT_ASAR_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? DEFAULT_ASAR_CANDIDATES[0];
}

export function log(message, { error = false } = {}) {
  (error ? process.stderr : process.stdout).write(`[codex-desktop-patch] ${message}\n`);
}

// Releases before 2.0.0 patched app.asar in place and kept the pristine
// archive under the backup directory, recording which backup that was in the
// state file.
export const LEGACY_PATCH_ENTRY = "codex-profile-switcher.cjs";

// Do not retry a failed match at every suffix of large embedded strings.
const IDENT = String.raw`(?<![A-Za-z0-9_$])[A-Za-z_$][A-Za-z0-9_$]*`;
// A dotted reference such as `x.O1`, the shape module imports take.
const MEMBER = String.raw`${IDENT}(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*`;

// Codex renders from rspack chunks: ES modules under webview/assets whose
// `__webpack_modules__` object maps module ids to factories `(e,t,n){...}`,
// the third parameter being `__webpack_require__`. Modules shared by several
// entry points are duplicated across chunks, so every copy of a site is
// patched.
export const RENDERER_ROOT = "webview";
export const RENDERER_ASSETS = "webview/assets";
const MODULE_HEADER_RE =
  /[{,]"?([A-Za-z0-9_$]+)"?\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{/g;

// `null` lists the threads of the active provider only, `[]` those of every
// provider.
const ALL_PROVIDER_NULL_RE = /modelProviders:null/g;
const RECENT_PROVIDER_WIDE_RE =
  /modelProviders:\[\],archived:!1,[^;]{0,200}?sendRequest\((["`])thread\/list\1,[^;]{0,120}source:(["`])recent_threads\2/;
const ARCHIVED_PROVIDER_WIDE_RE =
  /listArchivedThreads\(\)\{return this\.listAllThreads\(\{modelProviders:\[\],archived:!0\}\)\}/;

// The app-server restart the root error boundary dispatches, at module scope
// of a module every window loads at startup. The bridges that need other
// modules are published next to it.
export const PROFILE_RESTART_DISPATCH_RE = new RegExp(
  String.raw`function ${IDENT}\((${IDENT})\)\{(${MEMBER})\.dispatchMessage\(` +
    String.raw`"codex-app-server-restart",\{hostId:\1,intent:"restart",errorMessage:null\}\)\}`,
);
const REQUIRE_BRIDGE = "globalThis.__codexRequire??=";

// The desktop host runs the app-server managers and hands each window an RPC
// client per execution host, kept in a scope atom keyed by host id. The
// window resets an entry to this shape when its connection drops.
const APP_SERVER_CLIENT_SITE_RE = new RegExp(
  String.raw`\.set\((${IDENT})\.(${IDENT}),${IDENT},\{status:${IDENT},client:null\}\)`,
);

// The usage-reset modal as the rate-limit banner opens it. The bridge opens it
// through the same opener and modal modules with the window's root scope.
export const USAGE_RESETS_MODAL_RE = new RegExp(
  String.raw`\(0,(${IDENT})\.(${IDENT})\)\(${IDENT},(${IDENT})\.(${IDENT}),\{initialAvailableCount:` +
    String.raw`${IDENT}\.rate_limit_reset_credits\?\.available_count\?\?0,isRateLimitReached:!0,`,
);

// Both the usage fetch and the usage stream hand each parsed response to the
// rate-limit banner updater, so the bridge sits at the top of that function.
const USAGE_SNAPSHOT_SITE_RE = new RegExp(
  String.raw`(function ${IDENT}\(${IDENT},(${IDENT})\)\{)(?=let (${IDENT})=\2\.account_id\|\|\2\.user_id;` +
    String.raw`if\(null==\3\)return;let ${IDENT}=\2\.rate_limit_upsell)`,
  "g",
);

// The window's root scope, read by the error boundary that wraps every
// route. The usage resets bridge opens its modal through that scope.
export const ROOT_SCOPE_SITE_RE = new RegExp(
  String.raw`(function ${IDENT}\(${IDENT}\)\{let (?:${IDENT},)*${IDENT}=\(0,${IDENT}\.c\)\(\d+\),` +
    String.raw`\{children:${IDENT}\}=${IDENT},(${IDENT})=)(\(0,${IDENT}\.${IDENT}\)\(${IDENT}\.${IDENT}\))` +
    String.raw`(?=,.{0,600}?\2\.get\(${IDENT}\.${IDENT}\)\.forEach\(${IDENT}\))`,
  "g",
);

// react-intl's provider render, the one place every translated label passes
// through. Publishing the live intl object lets the host resolve labels by
// message id instead of matching English text.
const INTL_PROVIDER_SITE_RE = /(\{value:)this\.state\.intl(\}(?=.{0,200}displayName="IntlProvider"))/gs;

// The buttons the host attaches to, tagged so the switcher finds them by the
// attribute rather than by their translated label. Each entry names the
// message id rendered by the button and a pattern for the JSX call to tag;
// `before` patterns take the last match ahead of the id, the others the
// first match after it.
const ANCHOR_ATTRIBUTE = "data-codex-mod-anchor";
export const FOOTER_LABEL_RE = new RegExp(
  String.raw`(${IDENT})\?${IDENT}\.formatMessage\(\{id:"codex\.profileFooter\.openProfileMenu"`,
);
const FOOTER_BUTTON_RE = new RegExp(
  String.raw`\(0,${IDENT}\.jsxs?\)\((?:"button"|${IDENT}),\{(?=[^{}]{0,400}"aria-label":${IDENT},)`,
);
const SIGN_IN_BUTTON_RE = new RegExp(String.raw`\(0,${IDENT}\.jsxs\)\("button",\{`);
const SIGN_IN_ALTERNATIVE_BUTTON_RE = new RegExp(String.raw`\(0,${IDENT}\.jsx\)\("button",\{`);

// The message ids behind the buttons the host attaches to. Their labels are
// collected from every locale chunk Codex ships, so the switcher recognizes
// the buttons in any UI language even while a page runs the stock bundles.
const ANCHOR_MESSAGE_IDS = [
  "codex.profileFooter.openProfileMenu",
  "electron.onboarding.login.chatgpt.continueToSignIn",
  "electron.onboarding.login.apikey.open.welcomeV2",
];
export const LOCALE_MARKER = `"${ANCHOR_MESSAGE_IDS[0]}":"`;
const ANCHOR_LABELS_FILE = "anchor-labels.json";

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globalPattern(pattern) {
  return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
}

// Matches of `pattern` that start at or after `start` and end by `end`, the
// way Python's `pattern.finditer(text, start, end)` scans.
function* matchesBetween(text, pattern, start, end) {
  const scan = globalPattern(pattern);
  const bounded = text.slice(0, end);
  scan.lastIndex = start;
  for (let match = scan.exec(bounded); match != null; match = scan.exec(bounded)) {
    yield match;
    if (match[0].length === 0) {
      scan.lastIndex += 1;
    }
  }
}

function replaceCounting(text, pattern, replacement) {
  let count = 0;
  const replaced = text.replace(globalPattern(pattern), (...args) => {
    count += 1;
    const groups = args.slice(1, args.findIndex((value) => typeof value === "number"));
    return replacement.replace(/\$(\d)/g, (_, index) => groups[Number(index) - 1] ?? "");
  });
  return { text: replaced, count };
}

/** Read-only view of an Electron archive through its header.
 *
 * Reading the few files the mod needs straight from the archive avoids
 * extracting hundreds of megabytes for every cache build. */
export class Asar {
  constructor(file) {
    this.path = file;
    const handle = fs.openSync(file, "r");
    try {
      const sizes = Buffer.alloc(8);
      fs.readSync(handle, sizes, 0, 8, 0);
      const pickleSize = sizes.readUInt32LE(4);
      const pickle = Buffer.alloc(pickleSize);
      fs.readSync(handle, pickle, 0, pickleSize, 8);
      const headerLength = pickle.readUInt32LE(4);
      this.headerJson = pickle.subarray(8, 8 + headerLength);
      this.header = JSON.parse(this.headerJson.toString("utf8"));
      this.dataStart = 8 + pickleSize;
    } finally {
      fs.closeSync(handle);
    }
  }

  /** Electron's integrity check compares this hash, so it identifies the build. */
  get headerSha256() {
    return createHash("sha256").update(this.headerJson).digest("hex");
  }

  entry(archivePath) {
    let node = this.header;
    for (const part of archivePath.split("/")) {
      node = node.files?.[part];
      if (node == null) {
        return null;
      }
    }
    return node;
  }

  /** Whether a file of that name exists anywhere in the archive. */
  contains(fileName) {
    const walk = (node) => {
      const children = node.files ?? {};
      return Object.hasOwn(children, fileName) || Object.values(children).some(walk);
    };
    return walk(this.header);
  }

  #readAt(handle, entry) {
    const data = Buffer.alloc(entry.size);
    fs.readSync(handle, data, 0, entry.size, this.dataStart + Number(entry.offset));
    return data;
  }

  read(archivePath) {
    const entry = this.entry(archivePath);
    if (entry == null || entry.offset == null) {
      throw new Error(`${archivePath} is not packed into ${this.path}`);
    }
    const handle = fs.openSync(this.path, "r");
    try {
      return this.#readAt(handle, entry);
    } finally {
      fs.closeSync(handle);
    }
  }

  /** The packed files below an archive directory, by path below `relativeTo`. */
  tree(directory, suffix, relativeTo) {
    const found = [];
    const walk = (node, prefix) => {
      for (const name of Object.keys(node.files ?? {}).sort()) {
        const child = node.files[name];
        const childPath = `${prefix}/${name}`;
        if (child.files != null) {
          walk(child, childPath);
        } else if (name.endsWith(suffix) && child.offset != null) {
          found.push([childPath, child]);
        }
      }
    };
    walk(this.entry(directory) ?? {}, directory);
    found.sort((a, b) => Number(a[1].offset) - Number(b[1].offset));
    const files = new Map();
    const handle = fs.openSync(this.path, "r");
    try {
      for (const [childPath, child] of found) {
        const prefix = `${relativeTo}/`;
        const name = childPath.startsWith(prefix) ? childPath.slice(prefix.length) : childPath;
        files.set(name, this.#readAt(handle, child));
      }
    } finally {
      fs.closeSync(handle);
    }
    return files;
  }

  packageVersion() {
    try {
      const version = JSON.parse(this.read("package.json").toString("utf8")).version;
      return typeof version === "string" ? version : null;
    } catch {
      return null;
    }
  }
}

/** A renderer chunk held in memory while the patches run over it.
 *
 * `name` is its path below the renderer root, the path the window requests
 * it by. */
export class Bundle {
  constructor(name, text) {
    this.name = name;
    this.original = text;
    this.text = text;
    this.headers = null;
  }

  get changed() {
    return this.text !== this.original;
  }

  get isLocale() {
    return this.original.includes(LOCALE_MARKER);
  }

  /** Start offset and `__webpack_require__` parameter of each module factory. */
  moduleHeaders() {
    if (this.headers == null) {
      this.headers = [...this.text.matchAll(MODULE_HEADER_RE)].map((match) => [match.index, match[4]]);
    }
    return this.headers;
  }

  /** Module headers before `index`, nearest first. */
  enclosingModules(index) {
    return this.moduleHeaders()
      .filter(([start]) => start < index)
      .reverse()
      .slice(0, 3);
  }

  #requireModule(index) {
    return this.enclosingModules(index).find(([start, require]) =>
      this.text.slice(start, index).includes(`${require}("`),
    );
  }

  /** The `__webpack_require__` parameter of the module enclosing `index`. */
  requireName(index) {
    return this.#requireModule(index)?.[1] ?? null;
  }

  /** The module id that `variable` imports in the module enclosing `index`. */
  importId(index, variable) {
    const module = this.#requireModule(index);
    if (module == null) {
      return null;
    }
    const [start, require] = module;
    const match = new RegExp(
      String.raw`(?<![\w$])${escapeRegExp(variable)}=${escapeRegExp(require)}\("([^"]+)"\)`,
    ).exec(this.text.slice(start, index));
    return match?.[1] ?? null;
  }

  invalidate() {
    this.headers = null;
  }
}

/** The non-locale chunks containing `needle`. */
function codeBundles(bundles, needle) {
  return bundles.filter((bundle) => bundle.text.includes(needle) && !bundle.isLocale);
}

/** List recent and archived threads across providers; report whether both took. */
export function patchProviderHistory(bundles) {
  let recentProviderWide = false;
  let archivedProviderWide = false;
  for (const bundle of codeBundles(bundles, "modelProviders:")) {
    bundle.text = bundle.text.replace(ALL_PROVIDER_NULL_RE, "modelProviders:[]");
    recentProviderWide ||= RECENT_PROVIDER_WIDE_RE.test(bundle.text);
    archivedProviderWide ||= ARCHIVED_PROVIDER_WIDE_RE.test(bundle.text);
  }
  return recentProviderWide && archivedProviderWide;
}

/** Expose the app-server restart so a provider switch needs no relaunch.
 *
 * Publishes `__webpack_require__` alongside, from the same startup module,
 * for the bridges that open modules by id. */
export function injectProfileRestartBridge(bundles) {
  for (const bundle of codeBundles(bundles, '"codex-app-server-restart"')) {
    const match = PROFILE_RESTART_DISPATCH_RE.exec(bundle.text);
    if (match == null) {
      continue;
    }
    const require = bundle.requireName(match.index);
    if (require == null) {
      continue;
    }
    const bridge = match[2];
    const end = match.index + match[0].length;
    const injection =
      `;${REQUIRE_BRIDGE}${require};` +
      "globalThis.__codexProfileRestart=()=>{" +
      `${bridge}.dispatchMessage("codex-app-server-restart",` +
      '{hostId:"local",intent:"restart"});return!0};';
    bundle.text = bundle.text.slice(0, end) + injection + bundle.text.slice(end);
    bundle.invalidate();
    return true;
  }
  return false;
}

/** The chunk publishing `__webpack_require__`, where module bridges go. */
function requireBridgeHost(bundles) {
  return bundles.find((bundle) => bundle.text.includes(REQUIRE_BRIDGE)) ?? null;
}

/** Insert `injection` right after the require publication. */
function addModuleBridge(host, injection) {
  const marker = host.text.indexOf(REQUIRE_BRIDGE);
  const insertAt = host.text.indexOf(";", marker) + 1;
  host.text = host.text.slice(0, insertAt) + injection + host.text.slice(insertAt);
  host.invalidate();
}

/** Expose the window's app-server client per host so the mod can read and start threads.
 *
 * Runs after the restart bridge, whose module publishes the require function,
 * and after the root scope capture. */
export function injectAppServerClientBridge(bundles) {
  const host = requireBridgeHost(bundles);
  if (host == null) {
    return false;
  }
  for (const bundle of codeBundles(bundles, "client:null}")) {
    const match = APP_SERVER_CLIENT_SITE_RE.exec(bundle.text);
    if (match == null) {
      continue;
    }
    const atom = bundle.importId(match.index, match[1]);
    if (atom == null) {
      continue;
    }
    addModuleBridge(
      host,
      "globalThis.__codexAppServerClient=e=>{let t=globalThis.__codexScope," +
        "r=globalThis.__codexRequire;return t==null||r==null?null:" +
        `t.get(r(${JSON.stringify(atom)}).${match[2]},e)?.client?.rpc??null};`,
    );
    return true;
  }
  return false;
}

/** Expose the usage-reset modal opener so the sidebar pill can call it.
 *
 * Runs after the restart bridge, whose module publishes the require function
 * this bridge opens the modules with, and after the root scope capture. */
export function injectUsageResetsBridge(bundles) {
  const host = requireBridgeHost(bundles);
  if (host == null) {
    return false;
  }
  for (const bundle of codeBundles(bundles, "rate_limit_reset_credits?.available_count")) {
    const match = USAGE_RESETS_MODAL_RE.exec(bundle.text);
    if (match == null) {
      continue;
    }
    const opener = bundle.importId(match.index, match[1]);
    const modal = bundle.importId(match.index, match[3]);
    if (opener == null || modal == null) {
      continue;
    }
    addModuleBridge(
      host,
      "globalThis.__codexOpenUsageResets=e=>{let t=globalThis.__codexScope," +
        "r=globalThis.__codexRequire;if(t==null||r==null)return;" +
        `(0,r(${JSON.stringify(opener)}).${match[2]})(t,r(${JSON.stringify(modal)}).${match[4]},` +
        "{defaultResetCreditsOpen:!0,initialAvailableCount:e??0,isRateLimitReached:!1})};",
    );
    return true;
  }
  return false;
}

function substituteEach(bundles, needle, pattern, replacement) {
  let injected = false;
  for (const bundle of codeBundles(bundles, needle)) {
    const { text, count } = replaceCounting(bundle.text, pattern, replacement);
    if (count) {
      bundle.text = text;
      bundle.invalidate();
      injected = true;
    }
  }
  return injected;
}

/** Report each usage response the app receives for its own display. */
export function injectRateLimitStatusBridge(bundles) {
  return substituteEach(
    bundles,
    ".rate_limit_upsell",
    USAGE_SNAPSHOT_SITE_RE,
    "$1globalThis.__codexReportRateLimits?.($2);",
  );
}

/** Publish the window's root scope for the usage resets bridge. */
export function captureRootScope(bundles) {
  return substituteEach(bundles, ".forEach(", ROOT_SCOPE_SITE_RE, "$1(globalThis.__codexScope=$3)");
}

/** Publish the live react-intl object so labels resolve by message id. */
export function injectIntlBridge(bundles) {
  return substituteEach(
    bundles,
    'displayName="IntlProvider"',
    INTL_PROVIDER_SITE_RE,
    "$1(globalThis.__codexIntl=this.state.intl)$2",
  );
}

/** Add the anchor attribute to the JSX props object opening at `index`. */
function tagCall(text, index, value) {
  const brace = text.indexOf("{", index);
  return `${text.slice(0, brace + 1)}"${ANCHOR_ATTRIBUTE}":${value},${text.slice(brace + 1)}`;
}

function tagAfter(text, start, pattern, value, window) {
  const first = matchesBetween(text, pattern, start, start + window).next().value;
  return first == null ? null : tagCall(text, first.index, value);
}

function tagBefore(text, end, pattern, value, window) {
  const matches = [...matchesBetween(text, pattern, Math.max(0, end - window), end)];
  return matches.length === 0 ? null : tagCall(text, matches.at(-1).index, value);
}

/** Tag the buttons the host attaches to; return the anchors that were not found. */
export function tagAnchorSites(bundles) {
  const found = new Set();
  const apply = (name, tagged, bundle) => {
    if (tagged != null) {
      bundle.text = tagged;
      bundle.invalidate();
      found.add(name);
    }
  };
  for (const bundle of bundles) {
    if (bundle.isLocale) {
      continue;
    }
    let text = bundle.text;
    const footerId = text.indexOf('id:"codex.profileFooter.openProfileMenu"');
    const footer =
      footerId >= 0
        ? matchesBetween(text, FOOTER_LABEL_RE, Math.max(0, footerId - 300), footerId + 80).next().value
        : null;
    if (footer != null) {
      const condition = footer[1];
      apply(
        "profile-menu",
        tagAfter(
          text,
          footer.index + footer[0].length,
          FOOTER_BUTTON_RE,
          `${condition}?"profile-menu":"settings"`,
          6000,
        ),
        bundle,
      );
      text = bundle.text;
    }
    const signIn = text.indexOf('id:"electron.onboarding.login.chatgpt.continueToSignIn"');
    if (signIn >= 0) {
      apply("sign-in", tagBefore(text, signIn, SIGN_IN_BUTTON_RE, '"sign-in"', 800), bundle);
      text = bundle.text;
    }
    const alternative = text.indexOf('id:"electron.onboarding.login.apikey.open.explicit.welcomeV2"');
    if (alternative >= 0) {
      apply(
        "sign-in-alternative",
        tagBefore(text, alternative, SIGN_IN_ALTERNATIVE_BUTTON_RE, '"sign-in-alternative"', 800),
        bundle,
      );
    }
  }
  return ["profile-menu", "sign-in", "sign-in-alternative"].filter((name) => !found.has(name));
}

/** The translated labels of every anchor, across the locale chunks. */
function extractAnchorLabels(files) {
  const labels = Object.fromEntries(ANCHOR_MESSAGE_IDS.map((id) => [id, []]));
  const marker = Buffer.from(LOCALE_MARKER);
  for (const data of files.values()) {
    if (!data.includes(marker)) {
      continue;
    }
    const text = data.toString("utf8");
    for (const [messageId, collected] of Object.entries(labels)) {
      const match = new RegExp(String.raw`"${escapeRegExp(messageId)}":("(?:[^"\\]|\\.)*")`).exec(text);
      if (match == null) {
        continue;
      }
      const label = JSON.parse(match[1]);
      if (!collected.includes(label)) {
        collected.push(label);
      }
    }
  }
  return labels;
}

function writeAnchorLabels(archive, files, cacheDir) {
  const labels = extractAnchorLabels(files);
  if (!Object.values(labels).some((list) => list.length > 0)) {
    log("no locale chunks found; the switcher matches the English labels only");
    return;
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, ANCHOR_LABELS_FILE),
    `${JSON.stringify({ asar_header_sha256: archive.headerSha256, labels }, null, 2)}\n`,
  );
}

/** Identifies the patches a cache was built with, uncommitted edits included. */
function patcherSha256() {
  return createHash("sha256").update(fs.readFileSync(PATCHER_FILE)).digest("hex");
}

function checkJavaScript(bundle, name) {
  // The chunks are ES modules; Node only parses a file as one by extension.
  const module = `${bundle}.check.mjs`;
  fs.copyFileSync(bundle, module);
  let result;
  try {
    result = spawnSync(process.execPath, ["--check", module], { encoding: "utf8" });
  } finally {
    fs.rmSync(module, { force: true });
  }
  if (result.status !== 0) {
    // Node echoes the offending source line, which for a minified bundle is
    // the whole file; keep the location and the error itself.
    const lines = (result.stderr || result.stdout).split("\n").filter((line) => line.trim());
    const location = lines[0]?.startsWith(`${module}:`) ? lines[0].slice(module.length + 1) : (lines[0] ?? "");
    const error = [...lines].reverse().find((line) => line.includes("Error")) ?? "";
    throw new Error(`JavaScript syntax check failed for ${name} at line ${location}: ${error}`);
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Write the patched renderer bundles for `asar` into `cacheDir`.
 *
 * Only bundles the patches change are written; the manifest names them
 * together with the archive header hash and patcher source they belong to,
 * so a cache built from the same pair is reused. */
export function buildRendererCache(asar, cacheDir) {
  const archive = new Asar(asar);
  if (archive.contains(LEGACY_PATCH_ENTRY)) {
    throw new Error(`${asar} is patched by an earlier release; install Codex Mod again to restore it`);
  }
  const manifestPath = path.join(cacheDir, "manifest.json");
  const release = sourceRelease();
  const source = {
    patcher_head: release.head,
    version: release.version ?? "0.0.0",
    describe: release.describe,
  };
  const previous = readJson(manifestPath);
  if (
    previous != null &&
    typeof previous === "object" &&
    previous.asar_header_sha256 === archive.headerSha256 &&
    previous.patcher_sha256 === patcherSha256() &&
    Array.isArray(previous.files) &&
    previous.files.every((name) => fs.statSync(path.join(cacheDir, name), { throwIfNoEntry: false })?.isFile()) &&
    fs.existsSync(path.join(cacheDir, ANCHOR_LABELS_FILE))
  ) {
    // A release that leaves the patcher alone reuses the bundles but still
    // names itself in the manifest, which the settings page shows.
    if (previous.version !== source.version || previous.describe !== source.describe) {
      fs.writeFileSync(manifestPath, `${JSON.stringify({ ...previous, ...source }, null, 2)}\n`);
    }
    log(`renderer cache is current: ${cacheDir}`);
    return;
  }

  let files = archive.tree(RENDERER_ASSETS, ".js", RENDERER_ROOT);
  if (files.size === 0) {
    throw new Error("no Codex renderer chunks were found");
  }
  // Written before the patches so the labels are there for a Codex build the
  // patches do not match, when the host serves the stock bundles.
  writeAnchorLabels(archive, files, cacheDir);
  const localeMarker = Buffer.from(LOCALE_MARKER);
  const bundles = [...files]
    .filter(([, data]) => !data.includes(localeMarker))
    .map(([name, data]) => new Bundle(name, data.toString("utf8")));
  files = null;
  if (!patchProviderHistory(bundles)) {
    throw new Error("provider-wide recent and archived thread listing was not detected");
  }
  // The host relaunches Codex and hides the resets pill when these bridges
  // are missing, so a changed Codex build degrades instead of failing.
  if (!injectProfileRestartBridge(bundles)) {
    log("profile restart bridge not found; provider switches relaunch Codex");
  }
  if (!injectRateLimitStatusBridge(bundles)) {
    log("rate limit status bridge not found; usage refreshes from the poll only");
  }
  // The module bridges open their modules through the require function the
  // restart bridge publishes, with the root scope captured here.
  if (!captureRootScope(bundles)) {
    log("root scope not found; the resets pill stays hidden and chats are not locked");
  }
  if (!injectAppServerClientBridge(bundles)) {
    log("app-server client bridge not found; chats of other profiles are not locked");
  }
  if (!injectUsageResetsBridge(bundles)) {
    log("usage resets bridge not found; the resets pill stays hidden");
  }
  // Without the tags the switcher matches labels resolved through the intl
  // bridge, and without that bridge it falls back to the English labels.
  for (const name of tagAnchorSites(bundles)) {
    log(`anchor ${name} not found; the switcher matches its label instead`);
  }
  if (!injectIntlBridge(bundles)) {
    log("intl bridge not found; labels only match in English");
  }
  const changed = bundles.filter((bundle) => bundle.changed);
  // The host reloads a page that runs the stock bundles when it attaches; the
  // marker tells it which pages already run the patched ones.
  for (const bundle of changed) {
    bundle.text += "\n;globalThis.__codexModBundles=!0;\n";
  }

  // The patched bundles are staged next to the cache and syntax-checked
  // before they replace it, so a failed check leaves the previous cache in
  // place.
  fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(cacheDir), ".codex-mod-renderer-staging-"));
  try {
    for (const bundle of changed) {
      const staged = path.join(staging, bundle.name);
      fs.mkdirSync(path.dirname(staged), { recursive: true });
      fs.writeFileSync(staged, bundle.text);
      checkJavaScript(staged, bundle.name);
    }
    fs.mkdirSync(cacheDir, { recursive: true });
    for (const entry of fs.readdirSync(cacheDir)) {
      if (entry.endsWith(".js")) {
        fs.rmSync(path.join(cacheDir, entry), { force: true });
      }
    }
    fs.rmSync(path.join(cacheDir, "assets"), { recursive: true, force: true });
    for (const bundle of changed) {
      const target = path.join(cacheDir, bundle.name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(path.join(staging, bundle.name), target);
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  const manifest = {
    asar,
    asar_header_sha256: archive.headerSha256,
    ...source,
    patcher_sha256: patcherSha256(),
    files: changed.map((bundle) => bundle.name).sort(),
    built_at: Date.now() / 1000,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`renderer cache: ${changed.length} patched bundle(s) in ${cacheDir}`);
}

/** Validate the patches against `asar` without writing outside a temporary directory. */
export function dryRun(asar) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-desktop-dry-run-"));
  try {
    buildRendererCache(asar, path.join(directory, "cache"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  log("dry run complete; no files changed");
}

function legacyState(codexHome) {
  return {
    backupDir: path.join(codexHome, "backups/codex-app-asar"),
    statePath: path.join(codexHome, ".codex-mod-state.json"),
  };
}

/** The pristine backup of the installed Codex build, if one is known. */
function findOriginalBackup(archive, codexHome) {
  const { backupDir, statePath } = legacyState(codexHome);
  const recorded = readJson(statePath)?.original_backup;
  if (typeof recorded === "string" && fs.statSync(recorded, { throwIfNoEntry: false })?.isFile()) {
    return recorded;
  }
  // Installs that predate the record are matched by Codex version instead.
  const currentVersion = archive.packageVersion();
  if (currentVersion == null || !fs.existsSync(backupDir)) {
    return null;
  }
  const backups = fs
    .readdirSync(backupDir)
    .filter((name) => name.startsWith("app.asar.") && name.endsWith(".bak"))
    .map((name) => path.join(backupDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const backup of backups) {
    let candidate;
    try {
      candidate = new Asar(backup);
    } catch {
      continue;
    }
    if (!candidate.contains(LEGACY_PATCH_ENTRY) && candidate.packageVersion() === currentVersion) {
      return backup;
    }
  }
  return null;
}

/** Replace `target` atomically with what `write` puts into a sibling file. */
function replaceFile(target, write) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.codex-desktop-patch-${process.pid}.tmp`);
  try {
    write(temporary);
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function plutil(...args) {
  const result = spawnSync("/usr/bin/plutil", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`plutil ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

/** Point the bundle's ElectronAsarIntegrity entry back at the restored archive.
 *
 * Codex ships with Electron's EnableEmbeddedAsarIntegrityValidation fuse on,
 * so an Info.plist hash that does not match the archive header aborts the app
 * during startup. */
function syncAsarIntegrity(asar) {
  const bundle = path.dirname(path.dirname(path.dirname(asar)));
  const plist = path.join(bundle, "Contents/Info.plist");
  if (!bundle.endsWith(".app") || !fs.existsSync(plist)) {
    return;
  }
  const binary = fs.readFileSync(plist).subarray(0, 6).toString("latin1") === "bplist";
  const info = JSON.parse(plutil("-convert", "json", "-o", "-", plist));
  const entry = info.ElectronAsarIntegrity?.[path.relative(path.join(bundle, "Contents"), asar)];
  const digest = new Asar(asar).headerSha256;
  if (entry == null || typeof entry !== "object" || entry.hash === digest) {
    return;
  }
  entry.algorithm = "SHA256";
  entry.hash = digest;
  replaceFile(plist, (temporary) => {
    fs.writeFileSync(temporary, JSON.stringify(info));
    plutil("-convert", binary ? "binary1" : "xml1", temporary);
    fs.chmodSync(temporary, fs.statSync(plist).mode & 0o7777);
  });
}

/** Put back the pristine app.asar if an earlier release patched it in place.
 *
 * This is the only write into the application bundle left in the mod and
 * therefore the only step that needs App Management. */
export function restorePatchedAsar(asar, codexHome) {
  const archive = new Asar(asar);
  if (!archive.contains(LEGACY_PATCH_ENTRY)) {
    return;
  }
  const backup = findOriginalBackup(archive, codexHome);
  if (backup == null) {
    throw new Error(
      `${asar} was patched by an earlier release and no pristine backup was found; reinstall Codex to restore it`,
    );
  }
  try {
    replaceFile(asar, (temporary) => fs.copyFileSync(backup, temporary));
    syncAsarIntegrity(asar);
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      throw new Error(
        `cannot restore ${asar}: grant App Management to the terminal application under ` +
          "System Settings > Privacy & Security, then run the command again",
      );
    }
    throw error;
  }
  log(`restored original ASAR from ${backup}`);
}
