import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, test } from "node:test";

const require = createRequire(import.meta.url);
const { configuredProviders } = require("../scripts/profile_switcher.cjs");

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
