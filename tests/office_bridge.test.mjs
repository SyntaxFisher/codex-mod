import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { OFFICE_MCP_SERVER, cliWrapperScript } from "../scripts/installation.mjs";
import { TOOLS, createBridge, liveControlDisabled } from "../scripts/office_bridge.mjs";

const require = createRequire(import.meta.url);
const mod = require("../scripts/profile_switcher.cjs");

const work = { id: "work", label: "work@example.com", active: false };
const home = { id: "home", label: "home@example.com", active: true };

function executor(id, title) {
  return {
    executor_session_id: id,
    surface: "excel",
    document_id: `doc-${id}`,
    document_title: title,
    status: "connected",
    supported_tools: [{ name: "write_range", version: "1" }],
  };
}

/** A connector that shows each login only its own sessions. */
function fakeConnector(sessionsByLogin, calls = []) {
  return async (login, name, args) => {
    calls.push({ login: login.id, name, args });
    if (name === "list_document_sessions") {
      return { content: [{ type: "text", text: "" }], structuredContent: { executors: sessionsByLogin[login.id] ?? [] } };
    }
    if (name === "execute_document_command") {
      const owned = (sessionsByLogin[login.id] ?? []).some((s) => s.executor_session_id === args.executor_session_id);
      return owned
        ? { content: [{ type: "text", text: "ok" }], structuredContent: { ok: true } }
        : { content: [{ type: "text", text: "Invalid URL (POST /arc/internal/commands)" }], isError: true };
    }
    return { content: [{ type: "text", text: "schemas" }], structuredContent: { tool_schemas: [] } };
  };
}

describe("routing", () => {
  test("sessions from every login are listed together", async () => {
    const bridge = createBridge({
      loadLogins: () => [home, work],
      callTool: fakeConnector({ work: [executor("w1", "Budget.xlsx")], home: [executor("h1", "Deck.pptx")] }),
    });
    const result = await bridge.call("list_document_sessions", {});
    assert.deepEqual(
      result.structuredContent.executors.map((e) => e.executor_session_id),
      ["h1", "w1"],
    );
    assert.match(result.content[0].text, /Budget\.xlsx .* signed in as work@example\.com/);
    assert.ok(!result.isError);
  });

  test("a command goes to the login that owns its session", async () => {
    const calls = [];
    const bridge = createBridge({
      loadLogins: () => [home, work],
      callTool: fakeConnector({ work: [executor("w1", "Budget.xlsx")] }, calls),
    });
    await bridge.call("list_document_sessions", {});
    const result = await bridge.call("execute_document_command", {
      executor_session_id: "w1",
      idempotency_key: "k",
      tool_name: "write_range",
      args: {},
    });
    assert.ok(!result.isError);
    assert.deepEqual(
      calls.filter((c) => c.name === "execute_document_command").map((c) => c.login),
      ["work"],
    );
  });

  test("a command for a session not listed yet looks the session up first", async () => {
    const calls = [];
    const bridge = createBridge({
      loadLogins: () => [home, work],
      callTool: fakeConnector({ work: [executor("w1", "Budget.xlsx")] }, calls),
    });
    const result = await bridge.call("execute_document_command", {
      executor_session_id: "w1",
      idempotency_key: "k",
      tool_name: "write_range",
      args: {},
    });
    assert.ok(!result.isError);
    assert.deepEqual(calls.map((c) => c.name), [
      "list_document_sessions",
      "list_document_sessions",
      "execute_document_command",
    ]);
  });

  test("an unknown session is an error and nothing is executed", async () => {
    const calls = [];
    const bridge = createBridge({ loadLogins: () => [home, work], callTool: fakeConnector({}, calls) });
    const result = await bridge.call("execute_document_command", { executor_session_id: "gone", args: {} });
    assert.ok(result.isError);
    assert.ok(!calls.some((c) => c.name === "execute_document_command"));
  });

  test("schemas come from the login that owns the latest session", async () => {
    const calls = [];
    const bridge = createBridge({
      loadLogins: () => [home, work],
      callTool: fakeConnector({ work: [executor("w1", "Budget.xlsx")] }, calls),
    });
    await bridge.call("list_document_sessions", {});
    await bridge.call("get_document_tool_schemas", { items: [] });
    assert.equal(calls.at(-1).login, "work");
  });

  test("an empty list names the logins it checked and those it could not", async () => {
    const bridge = createBridge({
      loadLogins: () => [home, work],
      callTool: async (login, name) => {
        if (login.id === "work") throw new Error("the saved login has expired");
        return { content: [], structuredContent: { executors: [] } };
      },
    });
    const result = await bridge.call("list_document_sessions", {});
    assert.match(result.content[0].text, /Checked .*home@example\.com/);
    assert.match(result.content[0].text, /Could not check: work@example\.com \(the saved login has expired\)/);
    assert.ok(!result.isError);
  });

  test("the bridge offers the connector's three tools", () => {
    assert.deepEqual(
      TOOLS.map((tool) => tool.name),
      ["list_document_sessions", "get_document_tool_schemas", "execute_document_command"],
    );
  });
});

describe("Codex's live control switch", () => {
  test("a disabled connector table turns the bridge off", () => {
    const config = 'model = "x"\n\n[apps.connector_openai_codex_document_control]\nenabled = false\n\n[mcp_servers.a]\ncommand = "a"\n';
    assert.ok(liveControlDisabled(config));
    assert.ok(liveControlDisabled('[apps."connector_openai_codex_document_control"]\nenabled = false\n'));
  });

  test("an enabled, missing or other app's table leaves it on", () => {
    assert.ok(!liveControlDisabled('[apps.connector_openai_codex_document_control]\nenabled = true\n'));
    assert.ok(!liveControlDisabled('model = "x"\n'));
    assert.ok(!liveControlDisabled('[apps.connector_openai_codex_document_control]\n\n[apps.other]\nenabled = false\n'));
  });
});

describe("CLI wrapper", () => {
  // Runs the wrapper with a CLI that prints the arguments it was given.
  function run(options, args) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mod-wrapper-"));
    const cli = path.join(directory, "fake cli's codex");
    fs.writeFileSync(cli, '#!/bin/sh\nfor arg in "$@"; do printf "%s\\n" "$arg"; done\n', { mode: 0o755 });
    const wrapper = path.join(directory, "wrapper");
    fs.writeFileSync(wrapper, cliWrapperScript({ cli, ...options }), { mode: 0o755 });
    const result = spawnSync(wrapper, args, { encoding: "utf8" });
    fs.rmSync(directory, { recursive: true, force: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trimEnd().split("\n");
  }

  const officeBridge = { node: "/node", script: "/scripts/office_bridge.mjs", codexHome: "/home/.codex" };

  test("Codex's app-server gets the bridge and loses the connector", () => {
    const args = run({ officeBridge }, ["-c", "features.x=true", "app-server", "--analytics-default-enabled"]);
    assert.ok(args.includes(`mcp_servers.${OFFICE_MCP_SERVER}.command="/node"`));
    assert.ok(args.includes(`mcp_servers.${OFFICE_MCP_SERVER}.args=["/scripts/office_bridge.mjs"]`));
    assert.ok(args.includes("apps.connector_openai_codex_document_control.default_tools_enabled=false"));
    assert.deepEqual(args.slice(-4), ["-c", "features.x=true", "app-server", "--analytics-default-enabled"]);
  });

  test("other commands reach the CLI unchanged", () => {
    assert.deepEqual(run({ officeBridge }, ["exec-server", "--remote", "x"]), ["exec-server", "--remote", "x"]);
  });

  test("without settings the wrapper only passes through", () => {
    assert.deepEqual(run({}, ["app-server"]), ["app-server"]);
  });
});

describe("account lock", () => {
  test("only one holder at a time, and a stale lock is taken over", () => {
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mod-lock-"));
    try {
      const release = mod.tryAcquireAccountLock();
      assert.equal(typeof release, "function");
      assert.equal(mod.tryAcquireAccountLock(), null);
      release();
      const again = mod.tryAcquireAccountLock();
      assert.equal(typeof again, "function");
      const old = new Date(Date.now() - 60000);
      fs.utimesSync(path.join(mod.accountsDir(), ".lock"), old, old);
      assert.equal(mod.tryAcquireAccountLock(), null);
      assert.equal(typeof mod.tryAcquireAccountLock(), "function");
    } finally {
      fs.rmSync(process.env.CODEX_HOME, { recursive: true, force: true });
      if (previous == null) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });
});
