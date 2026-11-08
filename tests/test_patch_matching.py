import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import patch_codex as patch


class MatchingTests(unittest.TestCase):
    def test_large_embedded_string_does_not_match_identifier_suffixes(self):
        text = 'A' * 100_000
        for pattern in (patch.FOOTER_LABEL_RE, patch.USAGE_RESETS_MODAL_RE,
                        patch.PROFILE_RESTART_DISPATCH_RE, patch.ROOT_SCOPE_SITE_RE):
            with self.subTest(pattern=pattern.pattern):
                self.assertIsNone(pattern.search(text))

    def test_footer_and_usage_patterns_still_match(self):
        self.assertIsNotNone(patch.FOOTER_LABEL_RE.search(
            'x?a.formatMessage({id:"codex.profileFooter.openProfileMenu"'))
        self.assertIsNotNone(patch.USAGE_RESETS_MODAL_RE.search(
            '(0,p.qf)(s,x.w,{initialAvailableCount:u.rate_limit_reset_credits'
            '?.available_count??0,isRateLimitReached:!0,'))


class BundleTests(unittest.TestCase):
    CHUNK = (
        'export const __webpack_modules__={aB1(e,t,n){var p=n("X6Vn"),x=n("jn9r");'
        'function o(){(0,p.qf)(s,x.w,{initialAvailableCount:u.rate_limit_reset_credits'
        '?.available_count??0,isRateLimitReached:!0,a:1})}},'
        'Cd2(e,t,r){var tH=r("Zz9q");function dr(e){tH.O1.dispatchMessage('
        '"codex-app-server-restart",{hostId:e,intent:"restart",errorMessage:null})}}};'
    )

    def test_imports_resolve_within_the_enclosing_module(self):
        bundle = patch.Bundle('assets/async/1.js', self.CHUNK)
        site = self.CHUNK.index('(0,p.qf)')
        self.assertEqual(bundle.import_id(site, 'p'), 'X6Vn')
        self.assertEqual(bundle.import_id(site, 'x'), 'jn9r')
        restart = self.CHUNK.index('function dr')
        self.assertEqual(bundle.require_name(restart), 'r')
        self.assertIsNone(bundle.import_id(restart, 'p'))

    def test_bridges_open_modules_through_the_published_require(self):
        scope = 'function E(e){let t=(0,c.c)(4),{children:n}=e,o=(0,a.gh)(j.u),l=1;o.get(nt.Dj).forEach(dr)}'
        bundles = [patch.Bundle('assets/async/1.js', self.CHUNK + scope)]
        self.assertTrue(patch.inject_profile_restart_bridge(bundles))
        self.assertTrue(patch.capture_root_scope(bundles))
        self.assertTrue(patch.inject_usage_resets_bridge(bundles))
        text = bundles[0].text
        self.assertIn('globalThis.__codexRequire??=r;', text)
        self.assertIn('(0,r("X6Vn").qf)(t,r("jn9r").w,', text)
        self.assertIn('globalThis.__codexScope=(0,a.gh)(j.u)', text)


if __name__ == '__main__':
    unittest.main()
