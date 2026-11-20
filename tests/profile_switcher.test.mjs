import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, test } from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { configuredProviders, documentStartScript } = require("../scripts/profile_switcher.cjs");

describe("configuredProviders", () => {
  test("each custom provider carries its name and the host of its base URL", () => {
    const config = [
      'model_provider = "gateway"',
      "",
      "[model_providers.gateway]",
      'name = "Gateway"',
      'base_url = "https://gateway.example.com:8443/v1"',
      "",
      "[model_providers.local]",
      'base_url = "not a url"',
      "",
      "[model_providers.bare]",
      'name = "Bare"',
    ].join("\n");
    assert.deepEqual(configuredProviders(config), [
      { provider: "openai", label: "OpenAI" },
      { provider: "gateway", label: "Gateway", host: "gateway.example.com:8443" },
      { provider: "local", label: "local", host: null },
      { provider: "bare", label: "Bare", host: null },
    ]);
  });
});

describe("documentStartScript", () => {
  // A window just after it reloads: the new document has no body yet, and
  // the parser adds it later.
  function reloadingWindow() {
    const observers = [];
    const document = { body: null };
    const window = {
      document,
      location: { protocol: "app:" },
      MutationObserver: class {
        constructor(callback) {
          this.callback = callback;
        }
        observe() {
          observers.push(this);
        }
        disconnect() {
          observers.splice(observers.indexOf(this), 1);
        }
      },
      ran: [],
    };
    window.top = window;
    window.window = window;
    window.parseBody = () => {
      document.body = {};
      for (const observer of [...observers]) observer.callback([], observer);
    };
    return vm.createContext(window);
  }

  test("the scripts wait for the body and then run once each", () => {
    const window = reloadingWindow();
    vm.runInContext(documentStartScript(["ran.push(document.body != null)", "ran.push('second')"]), window);
    assert.deepEqual(window.ran, []);
    window.parseBody();
    window.parseBody();
    assert.deepEqual([...window.ran], [true, "second"]);
  });

  test("a script that fails leaves the others", () => {
    const window = reloadingWindow();
    window.parseBody();
    vm.runInContext(documentStartScript(["missing()", "ran.push('after')"]), Object.assign(window, { console: { error() {} } }));
    assert.deepEqual([...window.ran], ["after"]);
  });
});
