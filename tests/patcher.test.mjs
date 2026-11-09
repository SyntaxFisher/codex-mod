import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  Bundle,
  FOOTER_LABEL_RE,
  PROFILE_RESTART_DISPATCH_RE,
  ROOT_SCOPE_SITE_RE,
  USAGE_RESETS_MODAL_RE,
  captureRootScope,
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
});
