import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { gzipSync } from "node:zlib";

import {
  Bundle,
  FOOTER_LABEL_RE,
  PROFILE_RESTART_DISPATCH_RE,
  ROOT_SCOPE_SITE_RE,
  USAGE_RESETS_MODAL_RE,
  captureRootScope,
  extractAnchorLabels,
  injectProfileRestartBridge,
  injectUsageResetsBridge,
  patchProviderHistory,
} from "../scripts/patcher.mjs";

describe("provider history", () => {
  function history(quote) {
    return new Bundle("assets/app.js",
      'async listRecentThreads(){let p={modelProviders:null,archived:!1,originators:o},r=' +
      `this.client.sendRequest(${quote}thread/list${quote},p,{source:${quote}recent_threads${quote}})}` +
      'async listArchivedThreads(){return this.listAllThreads({modelProviders:null,archived:!0})}');
  }

  for (const quote of ['"', '`']) {
    test(`recent and archived requests accept ${quote} strings`, () => {
      const bundle = history(quote);
      assert.ok(patchProviderHistory([bundle]));
      assert.ok(!bundle.text.includes("modelProviders:null"));
      assert.equal((bundle.text.match(/modelProviders:\[\]/g) ?? []).length, 2);
      assert.ok(patchProviderHistory([bundle]));
    });
  }

  test("recent requests through a listThreads callback are recognized", () => {
    const bundle = new Bundle("assets/app.js",
      'async function ii(e,t,{originators:n}){let s={sortKey:t,modelProviders:null,archived:!1,originators:n},' +
      'o=await e(s,{source:"recent_threads"});return o}' +
      'async listArchivedThreads(){return this.listAllThreads({modelProviders:null,archived:!0})}');
    assert.ok(patchProviderHistory([bundle]));
    assert.ok(!bundle.text.includes("modelProviders:null"));
  });

  test("both request paths must be recognized", () => {
    const bundle = history('"');
    bundle.text = bundle.text.replace("listArchivedThreads", "unknownMethod");
    assert.equal(patchProviderHistory([bundle]), false);
  });
});

describe("matching", () => {
  test("a large embedded string does not match identifier suffixes", () => {
    const text = "A".repeat(100_000);
    for (const pattern of [FOOTER_LABEL_RE, USAGE_RESETS_MODAL_RE, PROFILE_RESTART_DISPATCH_RE, ROOT_SCOPE_SITE_RE]) {
      assert.equal(new RegExp(pattern.source).exec(text), null, pattern.source);
    }
  });

  test("the footer and usage patterns still match", () => {
    assert.notEqual(FOOTER_LABEL_RE.exec('x?a.formatMessage({id:"codex.profileFooter.openProfileMenu"'), null);
    assert.notEqual(
      USAGE_RESETS_MODAL_RE.exec(
        "(0,p.qf)(s,x.w,{initialAvailableCount:u.rate_limit_reset_credits?.available_count??0,isRateLimitReached:!0,",
      ),
      null,
    );
  });
});

describe("bundles", () => {
  const CHUNK =
    'export const __webpack_modules__={aB1(e,t,n){var p=n("X6Vn"),x=n("jn9r");' +
    "function o(){(0,p.qf)(s,x.w,{initialAvailableCount:u.rate_limit_reset_credits" +
    "?.available_count??0,isRateLimitReached:!0,a:1})}}," +
    'Cd2(e,t,r){var tH=r("Zz9q");function dr(e){tH.O1.dispatchMessage(' +
    '"codex-app-server-restart",{hostId:e,intent:"restart",errorMessage:null})}}};';

  test("imports resolve within the enclosing module", () => {
    const bundle = new Bundle("assets/async/1.js", CHUNK);
    const site = CHUNK.indexOf("(0,p.qf)");
    assert.equal(bundle.importId(site, "p"), "X6Vn");
    assert.equal(bundle.importId(site, "x"), "jn9r");
    const restart = CHUNK.indexOf("function dr");
    assert.equal(bundle.requireName(restart), "r");
    assert.equal(bundle.importId(restart, "p"), null);
  });

  test("bridges open modules through the published require", () => {
    const scope = "function E(e){let t=(0,c.c)(4),{children:n}=e,o=(0,a.gh)(j.u),l=1;o.get(nt.Dj).forEach(dr)}";
    const bundles = [new Bundle("assets/async/1.js", CHUNK + scope)];
    assert.ok(injectProfileRestartBridge(bundles));
    assert.ok(captureRootScope(bundles));
    assert.ok(injectUsageResetsBridge(bundles));
    const { text } = bundles[0];
    assert.ok(text.includes("globalThis.__codexRequire??=r;"));
    assert.ok(text.includes('(0,r("X6Vn").qf)(t,r("jn9r").w,'));
    assert.ok(text.includes("globalThis.__codexScope=(0,a.gh)(j.u)"));
  });

  test("module factories written as function properties are recognized", () => {
    const chunk = CHUNK.replace("aB1(e,t,n){", "aB1:(function(e,t,n){").replace("Cd2(e,t,r){", "Cd2:(function(e,t,r){");
    const bundle = new Bundle("assets/async/1.js", chunk);
    assert.equal(bundle.importId(chunk.indexOf("(0,p.qf)"), "p"), "X6Vn");
    assert.equal(bundle.requireName(chunk.indexOf("function dr")), "r");
  });
});

describe("locale catalogs", () => {
  const gzipJson = (value) => gzipSync(Buffer.from(JSON.stringify(value)));

  test("labels are read by message id from every locale", () => {
    const keys = ["other.message", "codex.profileFooter.openProfileMenu"];
    const files = new Map([
      ["assets/locales/keys.ab12.json.codex-gzip", gzipJson(keys)],
      ["assets/locales/de-DE.keys.ab12.0f0f.json.codex-gzip", gzipJson(["Andere", "Profilmenü öffnen"])],
      ["assets/locales/es-419.keys.ab12.1e1e.json.codex-gzip", gzipJson(["Otro", "Abrir menú de perfil"])],
      ["assets/locales/fr-FR.keys.cd34.2d2d.json.codex-gzip", gzipJson(["Autre", "Ouvrir"])],
    ]);
    const labels = extractAnchorLabels(files);
    assert.deepEqual(labels["codex.profileFooter.openProfileMenu"], ["Profilmenü öffnen", "Abrir menú de perfil"]);
    assert.deepEqual(labels["electron.onboarding.login.chatgpt.continueToSignIn"], []);
  });
});
