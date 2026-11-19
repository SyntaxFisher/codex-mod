#!/usr/bin/env node
// The Office account bridge: a stdio MCP server Codex runs in place of
// ChatGPT's Codex Document Control connector, which drives the ChatGPT
// add-ins for Excel, PowerPoint, Word and Google Sheets. The connector only
// shows the documents of the ChatGPT login signed into the add-in, so with
// the connector Codex reaches a document only while that same login is
// active. The bridge asks the connector under every login Codex Mod has
// saved, remembers which login owns each document session, and sends that
// session's commands under its owner, so the add-ins work under any account
// or custom provider.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { DOCUMENT_CONTROL_CONNECTOR } from "./installation.mjs";

const require = createRequire(import.meta.url);
const mod = require("./profile_switcher.cjs");

const APPS_URL = process.env.CODEX_MOD_APPS_URL || "https://chatgpt.com/backend-api/wham/apps";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
// Codex's own OAuth client; saved logins were issued to it.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_MARGIN_MS = 2 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 15000;
// A command waits until the add-in has run it, which can take a while for a
// large range or script.
const UPSTREAM_TIMEOUT_MS = 180000;
const LOCK_WAIT_MS = 20000;
const MCP_PROTOCOL_VERSION = "2025-06-18";

const SURFACES = ["excel", "powerpoint", "sheets", "word"];
const SURFACE_HINT =
  "Use `excel` for Excel workbooks, `powerpoint` for PowerPoint presentations, `word` for Word documents, or `sheets` for Google Sheets spreadsheets.";

// The connector's own tool contract, which the excel-live-control skill refers
// to by these names. Arguments are passed on unchanged.
export const TOOLS = [
  {
    name: "list_document_sessions",
    description:
      "List the user's currently connected Codex document sessions and the surface-specific tools each session supports. Call this before executing a document-control command so you can choose the intended `executor_session_id` and `supported_tools[].name`.",
    inputSchema: {
      type: "object",
      properties: {
        surface: {
          anyOf: [{ type: "string", enum: SURFACES }, { type: "null" }],
          default: null,
          description: `Optional document surface filter. ${SURFACE_HINT} Omit to list connected Codex document sessions across all supported surfaces.`,
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_document_tool_schemas",
    description:
      "Fetch the concrete input schemas for tools supported by a selected Codex document session before constructing `execute_document_command.args`. First call `list_document_sessions`, then pass the exact `surface`, selected `supported_tools[].name` as `tool_name`, and `version` values from that session's `supported_tools` records.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          description:
            "Exact tool schema lookup keys from Codex document session discovery, keyed by `surface`, `supported_tools[].name` passed as `tool_name`, and `version`.",
          items: {
            type: "object",
            properties: {
              surface: { type: "string", enum: SURFACES, description: `Document surface. ${SURFACE_HINT}` },
              tool_name: {
                type: "string",
                maxLength: 128,
                description: "Exact `supported_tools[].name` copied from the selected session.",
              },
              version: {
                type: "string",
                maxLength: 64,
                description: "Exact `supported_tools[].version` copied from the selected session.",
              },
            },
            required: ["surface", "tool_name", "version"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "execute_document_command",
    description:
      "Execute one supported surface-specific tool against a connected Codex document session. First call `list_document_sessions` to choose the intended `executor_session_id` and `supported_tools[].name`, then call `get_document_tool_schemas` for the selected `surface`, that `supported_tools[].name` as `tool_name`, and `version` before constructing `args`. `idempotency_key` must be a caller-stable key that you reuse verbatim only when retrying the same logical document-control command; use a new key for a different command.",
    inputSchema: {
      type: "object",
      properties: {
        executor_session_id: {
          type: "string",
          description:
            "Exact `executor_session_id` copied from the selected Codex document session returned by `list_document_sessions`.",
        },
        idempotency_key: {
          type: "string",
          minLength: 1,
          maxLength: 512,
          description:
            "Caller-stable idempotency key for this logical document-control command. Reuse the exact same key only for retries of the same command.",
        },
        tool_name: {
          type: "string",
          description: "Exact selected session `supported_tools[].name` copied from `list_document_sessions`.",
        },
        args: {
          type: "object",
          additionalProperties: {},
          description:
            "JSON object of arguments matching the selected tool's `input_schema` from `get_document_tool_schemas`.",
        },
      },
      required: ["executor_session_id", "idempotency_key", "tool_name", "args"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
];

// The connector's description, which tells the model when to reach for it.
const INSTRUCTIONS =
  "Use Codex Document Control to find connected document sessions of the ChatGPT add-ins for Excel, PowerPoint, Word and Google Sheets, inspect the tools supported by a selected session, and execute one supported tool against that session. Call `list_document_sessions` first to choose the intended connected session, call `get_document_tool_schemas` before constructing tool arguments, then call `execute_document_command` with a caller-stable `idempotency_key`. Use this only for connected Codex document control; do not use it for general spreadsheet, presentation, or document tasks without a connected document session.";

const textResult = (text, extra = {}) => ({ content: [{ type: "text", text }], ...extra });
const errorResult = (text) => textResult(text, { isError: true });
const messageOf = (error) => String(error?.message ?? error);

function sessionLine(executor, login) {
  const tools = (executor.supported_tools ?? []).map((tool) => `${tool.name}@${tool.version}`).join(", ");
  return (
    `- ${executor.document_title} (${executor.surface}, ${executor.document_id}, ` +
    `executor_session_id=${executor.executor_session_id}, status=${executor.status}; tools: ${tools}) ` +
    `signed in as ${login.label}`
  );
}

/**
 * The routing, apart from logins and the network: `loadLogins()` returns the
 * saved logins, `callTool(login, name, args)` one connector tool's result
 * under a login.
 */
export function createBridge({ loadLogins, callTool }) {
  const owners = new Map();
  let preferred = null;

  async function listSessions(args) {
    const logins = loadLogins();
    if (logins.length === 0) {
      return errorResult(
        "No ChatGPT login is saved in Codex Mod. Sign in with the ChatGPT account the add-in uses, then try again.",
      );
    }
    const answers = await Promise.all(
      logins.map((login) =>
        callTool(login, "list_document_sessions", args).then(
          (result) => ({ login, result }),
          (error) => ({ login, error: messageOf(error) }),
        ),
      ),
    );
    const executors = [];
    const lines = [];
    const checked = [];
    const failed = [];
    for (const { login, result, error } of answers) {
      if (error != null || result?.isError) {
        failed.push(`${login.label} (${error ?? result?.content?.[0]?.text ?? "unknown error"})`);
        continue;
      }
      checked.push(login.label);
      for (const executor of result?.structuredContent?.executors ?? []) {
        owners.set(executor.executor_session_id, login.id);
        executors.push(executor);
        lines.push(sessionLine(executor, login));
      }
    }
    if (executors.length > 0) {
      preferred = owners.get(executors[0].executor_session_id);
      const text = [
        "Connected Codex document sessions:",
        ...lines,
        "Copy the exact `surface`, `supported_tools[].name`, and `supported_tools[].version` for the selected session into `get_document_tool_schemas`.",
      ].join("\n");
      return textResult(text, { structuredContent: { executors } });
    }
    const parts = ["No connected Codex document sessions were found."];
    if (checked.length > 0) {
      parts.push(
        `Checked the ChatGPT logins saved in Codex Mod: ${checked.join(", ")}. ` +
          "The ChatGPT add-in must be signed in with one of them; add another account through Codex Mod's account switcher if it uses a different one.",
      );
    }
    if (failed.length > 0) {
      parts.push(`Could not check: ${failed.join("; ")}.`);
    }
    return textResult(parts.join(" "), { structuredContent: { executors }, isError: checked.length === 0 });
  }

  function loginsByPreference() {
    const logins = loadLogins();
    const rank = (login) => (login.id === preferred ? 0 : login.active ? 1 : 2);
    return logins.sort((left, right) => rank(left) - rank(right));
  }

  // Schemas belong to the surface and tool version, not to a session, so any
  // login that reaches the connector can answer.
  async function toolSchemas(args) {
    const failures = [];
    for (const login of loginsByPreference()) {
      try {
        const result = await callTool(login, "get_document_tool_schemas", args);
        if (!result?.isError) {
          return result;
        }
        failures.push(result?.content?.[0]?.text ?? "unknown error");
      } catch (error) {
        failures.push(messageOf(error));
      }
    }
    return errorResult(`Could not fetch the tool schemas: ${failures.join("; ") || "no ChatGPT login is saved"}.`);
  }

  async function executeCommand(args) {
    const sessionId = args?.executor_session_id;
    if (!owners.has(sessionId)) {
      await listSessions({});
    }
    const ownerId = owners.get(sessionId);
    const owner = loadLogins().find((login) => login.id === ownerId);
    if (owner == null) {
      return errorResult(
        `No connected document session has executor_session_id ${sessionId}. Call list_document_sessions and use a session it returns.`,
      );
    }
    preferred = owner.id;
    return callTool(owner, "execute_document_command", args);
  }

  const handlers = {
    list_document_sessions: listSessions,
    get_document_tool_schemas: toolSchemas,
    execute_document_command: executeCommand,
  };

  return {
    async call(name, args) {
      const handler = handlers[name];
      if (handler == null) {
        return errorResult(`Unknown tool ${name}.`);
      }
      try {
        return await handler(args ?? {});
      } catch (error) {
        return errorResult(messageOf(error));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Codex's live control switch

// Codex's Computer Use settings turn live control of Excel, PowerPoint and
// Word off by disabling the connector in config.toml, and the bridge stands in
// for the connector, so it follows that switch.
export function liveControlDisabled(configText) {
  const header = new RegExp(
    `^[ \\t]*\\[[ \\t]*apps[ \\t]*\\.[ \\t]*"?${DOCUMENT_CONTROL_CONNECTOR}"?[ \\t]*\\][ \\t]*(?:#.*)?$`,
    "m",
  );
  const match = header.exec(configText);
  if (match == null) {
    return false;
  }
  const rest = configText.slice(match.index + match[0].length);
  const end = rest.search(/^[ \t]*\[/m);
  return /^[ \t]*enabled[ \t]*=[ \t]*false\b/m.test(end < 0 ? rest : rest.slice(0, end));
}

function liveControlTurnedOff() {
  try {
    return liveControlDisabled(fs.readFileSync(path.join(mod.codexHome(), "config.toml"), "utf8"));
  } catch {
    return false;
  }
}

const TURNED_OFF =
  "Live control of Microsoft Excel, PowerPoint and Word is turned off in Codex's Computer Use settings.";

// ---------------------------------------------------------------------------
// Logins

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function tokenExpiresAt(token) {
  try {
    const claims = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
    return Number(claims.exp) * 1000;
  } catch {
    return 0;
  }
}

const isFresh = (auth) => tokenExpiresAt(auth?.tokens?.access_token) - Date.now() > TOKEN_MARGIN_MS;

function credentialsOf(auth) {
  return { token: auth.tokens.access_token, workspaceId: auth.tokens.account_id };
}

function activeLoginId() {
  return mod.accountFromAuthJson(readJson(mod.authFilePath()))?.accountId ?? null;
}

/** The active login first, then every other person saved in the account store. */
export function savedLogins() {
  const logins = [];
  const seen = new Set();
  const add = (auth, file, active) => {
    const account = mod.accountFromAuthJson(auth);
    if (account == null || seen.has(account.accountId)) {
      return;
    }
    seen.add(account.accountId);
    logins.push({ id: account.accountId, label: account.email ?? account.label, active, file });
  };
  add(readJson(mod.authFilePath()), mod.authFilePath(), true);
  let names = [];
  try {
    names = fs.readdirSync(mod.accountsDir()).filter((name) => name.endsWith(".json"));
  } catch {
    // No saved logins besides the active one.
  }
  for (const name of names.sort()) {
    const file = path.join(mod.accountsDir(), name);
    add(readJson(file), file, false);
  }
  return logins;
}

class LoginError extends Error {}

async function withTimeout(ms, action) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await action(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// Codex refreshes the active login itself, under its own lock, and keeps the
// result in memory; a refresh from here would leave it holding a used refresh
// token. An app-server of our own lets Codex do it.
function refreshActiveLogin() {
  const cli = mod.codexBinary();
  if (cli == null) {
    return Promise.reject(new LoginError("the active login has expired"));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cli, ["-c", 'model_provider="openai"', "app-server"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    const finish = (error) => {
      clearTimeout(timer);
      child.kill();
      error == null ? resolve() : reject(error);
    };
    const timer = setTimeout(() => finish(new LoginError("refreshing the active login timed out")), REFRESH_TIMEOUT_MS);
    child.on("error", (error) => finish(error));
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 2) {
          finish(message.result?.authToken ? null : new LoginError("the active login has expired"));
        }
      }
    });
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "codex-mod-office", version: "1" } } });
    send({ method: "initialized" });
    send({ id: 2, method: "getAuthStatus", params: { includeToken: true, refreshToken: true } });
  });
}

async function acquireAccountLock() {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const release = mod.tryAcquireAccountLock();
    if (release != null) {
      return release;
    }
    if (Date.now() > deadline) {
      throw new LoginError("another process holds the saved logins");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// `rejectedToken` is an access token the server refused, which needs
// replacing even before it expires.
async function refreshSavedLogin(login, rejectedToken) {
  const release = await acquireAccountLock();
  try {
    if (activeLoginId() === login.id) {
      return activeCredentials(rejectedToken != null);
    }
    const auth = readJson(login.file);
    if (auth?.tokens?.refresh_token == null) {
      throw new LoginError("the saved login is unreadable");
    }
    if (isFresh(auth) && auth.tokens.access_token !== rejectedToken) {
      return credentialsOf(auth);
    }
    const response = await withTimeout(REFRESH_TIMEOUT_MS, (signal) =>
      fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: auth.tokens.refresh_token,
          scope: "openid profile email",
        }),
        signal,
      }),
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new LoginError("the saved login has expired; switch to it once in Codex to sign in again");
    }
    for (const key of ["id_token", "access_token", "refresh_token"]) {
      if (typeof body[key] === "string") {
        auth.tokens[key] = body[key];
      }
    }
    auth.last_refresh = new Date().toISOString();
    mod.writeFileAtomic(login.file, `${JSON.stringify(auth, null, 2)}\n`, 0o600);
    return credentialsOf(auth);
  } finally {
    release();
  }
}

async function activeCredentials(forceRefresh = false) {
  let auth = readJson(mod.authFilePath());
  if (forceRefresh || !isFresh(auth)) {
    await refreshActiveLogin();
    auth = readJson(mod.authFilePath());
  }
  if (auth?.tokens?.access_token == null) {
    throw new LoginError("the active login is unreadable");
  }
  return credentialsOf(auth);
}

async function credentialsFor(login, rejectedToken) {
  if (activeLoginId() === login.id) {
    return activeCredentials(rejectedToken != null);
  }
  const auth = readJson(login.file);
  if (rejectedToken == null && isFresh(auth)) {
    return credentialsOf(auth);
  }
  return refreshSavedLogin(login, rejectedToken);
}

// ---------------------------------------------------------------------------
// The connector, reached through Codex's apps MCP endpoint

class UpstreamError extends Error {
  constructor(status, text) {
    super(`ChatGPT answered ${status}: ${String(text).slice(0, 200)}`);
    this.status = status;
  }
}

function parseRpcBody(text, contentType, id) {
  if (!contentType?.includes("text/event-stream")) {
    return text ? JSON.parse(text) : null;
  }
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data === "") {
      continue;
    }
    const message = JSON.parse(data);
    if (id == null || message.id === id) {
      return message;
    }
  }
  return null;
}

class AppsSession {
  #login;
  #sessionId = null;
  #toolNames = null;
  #nextId = 1;

  constructor(login) {
    this.#login = login;
  }

  async #post(credentials, method, params, { notification = false } = {}) {
    const id = notification ? undefined : this.#nextId++;
    const headers = {
      Authorization: `Bearer ${credentials.token}`,
      "ChatGPT-Account-Id": credentials.workspaceId,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.#sessionId != null) {
      headers["mcp-session-id"] = this.#sessionId;
    }
    const response = await withTimeout(UPSTREAM_TIMEOUT_MS, (signal) =>
      fetch(APPS_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params }),
        signal,
      }),
    );
    this.#sessionId = response.headers.get("mcp-session-id") ?? this.#sessionId;
    const text = await response.text();
    if (!response.ok) {
      throw new UpstreamError(response.status, text);
    }
    if (notification) {
      return null;
    }
    const message = parseRpcBody(text, response.headers.get("content-type"), id);
    if (message?.error != null) {
      throw new Error(message.error.message ?? JSON.stringify(message.error));
    }
    return message?.result ?? null;
  }

  async #open(credentials) {
    this.#sessionId = null;
    await this.#post(credentials, "initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "codex-mod-office", version: "1" },
    });
    await this.#post(credentials, "notifications/initialized", {}, { notification: true });
    const names = new Map();
    let cursor;
    do {
      const page = await this.#post(credentials, "tools/list", cursor == null ? {} : { cursor });
      for (const tool of page?.tools ?? []) {
        if (tool?._meta?.connector_id !== DOCUMENT_CONTROL_CONNECTOR) {
          continue;
        }
        const base = TOOLS.find((known) => tool.name.endsWith(known.name));
        if (base != null) {
          names.set(base.name, tool.name);
        }
      }
      cursor = page?.nextCursor;
    } while (cursor);
    if (names.size === 0) {
      throw new Error("this login has no access to ChatGPT's document control");
    }
    this.#toolNames = names;
  }

  async call(name, args) {
    let rejectedToken;
    for (let attempt = 0; ; attempt += 1) {
      const credentials = await credentialsFor(this.#login, rejectedToken);
      try {
        if (this.#toolNames == null) {
          await this.#open(credentials);
        }
        return await this.#post(credentials, "tools/call", { name: this.#toolNames.get(name), arguments: args });
      } catch (error) {
        // An expired token or an MCP session the server dropped heals with a
        // new token or session; anything else is the answer.
        const retryable = error instanceof UpstreamError && (error.status === 401 || error.status === 404);
        if (!retryable || attempt > 0) {
          throw error;
        }
        rejectedToken = error.status === 401 ? credentials.token : undefined;
        this.#toolNames = null;
      }
    }
  }
}

function networkBridge() {
  const sessions = new Map();
  return createBridge({
    loadLogins: savedLogins,
    callTool(login, name, args) {
      if (!sessions.has(login.id)) {
        sessions.set(login.id, new AppsSession(login));
      }
      return sessions.get(login.id).call(name, args);
    },
  });
}

// ---------------------------------------------------------------------------
// MCP over stdio

function serve() {
  const bridge = networkBridge();
  const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const handle = async (message) => {
    const { id, method, params } = message;
    if (id == null) {
      return;
    }
    switch (method) {
      case "initialize":
        send({
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "codex-mod-office", version: "1" },
            instructions: INSTRUCTIONS,
          },
        });
        return;
      case "ping":
        send({ id, result: {} });
        return;
      case "tools/list":
        send({ id, result: { tools: liveControlTurnedOff() ? [] : TOOLS } });
        return;
      case "tools/call":
        send({
          id,
          result: liveControlTurnedOff() ? errorResult(TURNED_OFF) : await bridge.call(params?.name, params?.arguments),
        });
        return;
      default:
        send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  };
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    handle(message).catch((error) => send({ id: message.id, error: { code: -32603, message: messageOf(error) } }));
  });
}

const HELP = `Usage: office_bridge.mjs [--list [surface] | --help]

The Office account bridge of Codex Mod. Without arguments it runs as the
stdio MCP server that Codex starts in place of ChatGPT's Codex Document
Control connector. It routes the ChatGPT add-ins for Excel, PowerPoint, Word
and Google Sheets through whichever saved ChatGPT login the add-in is signed
in with.

  --list [surface]  print the connected document sessions of every saved
                    login (surface: excel, powerpoint, word or sheets)
  --help            show this help

CODEX_HOME selects the Codex home whose logins are used.`;

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }
  if (argv[0] === "--list") {
    const result = await networkBridge().call("list_document_sessions", argv[1] ? { surface: argv[1] } : {});
    console.log(result.content[0].text);
    // Kept-alive connections to ChatGPT would hold the process open.
    process.exit(result.isError ? 1 : 0);
  }
  if (argv.length > 0) {
    console.error(HELP);
    process.exitCode = 2;
    return;
  }
  serve();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
