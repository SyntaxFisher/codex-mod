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
  extractMessageLabels,
  extractProviderIcon,
  injectCodexUpdatesBridge,
  injectOnboardingOverrideBridge,
  injectProfileRestartBridge,
  injectUsageResetsBridge,
  patchProviderHistory,
  switchesAccountsNatively,
  tagAnchorSites,
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

describe("sign-in screen", () => {
  const button = (id, label) =>
    '(0,l.jsx)("button",{className:"flex h-[46px] w-full",type:"button",onClick:()=>$("x"),' +
    `children:(0,l.jsx)(u.A,{id:"${id}",defaultMessage:"${label}"})})`;
  const SIGN_IN =
    'aB1:(function(e,t,n){var l=n("Ab12"),u=n("Cd34");let e7=(0,l.jsxs)("div",{children:[R&&(null!=eV&&eV.length>0?' +
    `(0,l.jsxs)(l.Fragment,{children:[eV.map(f),${button("electron.onboarding.login.browserSession.otherAccount", "Use another account")}]}):` +
    '(0,l.jsxs)("button",{className:"flex h-[48px]",type:"button",onClick:()=>$(),children:[(0,l.jsx)(eY.A,{}),' +
    '(0,l.jsx)(u.A,{id:"electron.onboarding.login.chatgpt.continueToSignIn",defaultMessage:"Continue to sign in"})]})),' +
    'ed?(0,l.jsx)("button",{className:"flex h-[46px]",type:"button",onClick:en,children:ec?' +
    '(0,l.jsx)(u.A,{id:"electron.onboarding.login.apikey.open.welcomeV2",defaultMessage:"Sign in another way"}):' +
    '(0,l.jsx)(u.A,{id:"electron.onboarding.login.apikey.open.explicit.welcomeV2",defaultMessage:"Sign in with an API key"})}):null]})})';

  test("every button of the sign-in stack is tagged, with and without browser sessions", () => {
    const bundle = new Bundle("assets/async/2.js", SIGN_IN);
    assert.deepEqual(tagAnchorSites([bundle]), ["profile-menu"]);
    const tags = [...bundle.text.matchAll(/"data-codex-mod-anchor":"([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(tags, ["sign-in-other-account", "sign-in", "sign-in-alternative"]);
    assert.ok(bundle.text.includes('(0,l.jsx)("button",{"data-codex-mod-anchor":"sign-in-other-account",className:"flex h-[46px]'));
  });

  test("the onboarding override is published through the root scope", () => {
    const host = 'Cd2(e,t,r){var tH=r("Zz9q");function dr(e){tH.O1.dispatchMessage(' +
      '"codex-app-server-restart",{hostId:e,intent:"restart",errorMessage:null})}}';
    const atoms = 'bdDz:(function(e,t,n){var o=n("Nwp9");let d=(0,o.m3)("electron:onboarding-override","auto"),' +
      'c=(0,o.m3)("electron:onboarding-welcome-pending",!1);n.d(t,{},{$T:c,_m:d,pi:c})})';
    const bundles = [new Bundle("assets/async/1.js", `{${host},${atoms}}`)];
    assert.ok(injectProfileRestartBridge(bundles));
    assert.ok(injectOnboardingOverrideBridge(bundles));
    assert.ok(bundles[0].text.includes('let a=r("bdDz")._m;'));
  });

  test("Codex's update check is published through the module its update button uses", () => {
    const host = 'Cd2(e,t,r){var tH=r("Zz9q");function dr(e){tH.O1.dispatchMessage(' +
      '"codex-app-server-restart",{hostId:e,intent:"restart",errorMessage:null})}}';
    const button = 'p4qq(e,t,a){var l=a("GaA7");function v(){return()=>void l.appServices.appUpdates?.installUpdate()}}';
    const bundles = [new Bundle("assets/async/1.js", `{${host},${button}}`)];
    assert.ok(injectProfileRestartBridge(bundles));
    assert.ok(injectCodexUpdatesBridge(bundles));
    assert.ok(bundles[0].text.includes('r?.("GaA7").appServices?.appUpdates;'));
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

  test("labels are read from locale chunks of builds without gzipped catalogs", () => {
    const chunk = (messages) =>
      Buffer.from(`export const __webpack_modules__={MXyc(i){i.exports=JSON.parse('${JSON.stringify(messages)}')}};`);
    const files = new Map([
      ["assets/async/1.js", chunk({ "codex.profileFooter.openProfileMenu": "Profilmenü öffnen", "x.settings": "Einstellungen" })],
      ["assets/async/2.js", chunk({ "codex.profileFooter.openProfileMenu": "Ouvrir le menu", "x.settings": "Paramètres" })],
      ["assets/async/3.js", Buffer.from('(0,u.A)({id:"x.settings",defaultMessage:"Settings"})')],
    ]);
    assert.deepEqual(extractMessageLabels(files, ["x.settings"]), { "x.settings": ["Einstellungen", "Paramètres"] });
    assert.deepEqual(extractAnchorLabels(files)["codex.profileFooter.openProfileMenu"], ["Profilmenü öffnen", "Ouvrir le menu"]);
  });
});

describe("extractProviderIcon", () => {
  const signIn = Buffer.from(
    'let eF=n("x2lX"),eH=n("HOLv");function g(){return(0,l.jsxs)(w.$,{children:[(0,l.jsx)(eH.I,{asset:eF.K,className:"shrink-0"}),' +
      '(0,l.jsx)(u.A,{id:"electron.onboarding.login.gateway.open",defaultMessage:"Gateway or custom provider"})]})}',
  );
  const icons = (body) =>
    Buffer.from(`{},x2lX(e,t,n){let r=(0,n("ESTr").a)({name:"some-icon-16",canvas:{width:16},body:'${body}'})}`);

  test("takes the paths of the icon the gateway sign-in button renders", () => {
    const body = '<path d="M3 13.5h1" fill="currentColor"/> <path d="M4 2h8Z" fill-rule="evenodd" clip-rule="evenodd" fill="currentColor"/>';
    assert.equal(extractProviderIcon(new Map([["a.js", signIn], ["b.js", icons(body)]])), body);
  });

  test("refuses markup other than plain paths", () => {
    for (const body of ['<path d="M0 0" onload="alert(1)"/>', '<path d="M0 0"/><script>alert(1)</script>']) {
      assert.equal(extractProviderIcon(new Map([["a.js", signIn], ["b.js", icons(body)]])), null);
    }
  });

  test("reports a build without the button or its icon", () => {
    assert.equal(extractProviderIcon(new Map([["b.js", icons('<path d="M0 0"/>')]])), null);
    assert.equal(extractProviderIcon(new Map([["a.js", signIn]])), null);
  });
});

describe("native account switch", () => {
  const windowManager = "refreshAccountWindows(e,t){return this.accountWindows.refresh(e,t)}";
  const managers = "suspendForAccountSwitch(){this.accountSwitching=!0}";

  test("is detected when the main process replaces windows and suspends its managers", () => {
    assert.ok(switchesAccountsNatively([Buffer.from(windowManager), Buffer.from("a"), Buffer.from(managers)]));
  });

  test("needs both", () => {
    assert.ok(!switchesAccountsNatively([Buffer.from(windowManager)]));
    assert.ok(!switchesAccountsNatively([Buffer.from(managers)]));
    assert.ok(!switchesAccountsNatively([]));
  });
});
