import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import patch_codex as patch


class MatchingTests(unittest.TestCase):
    def test_large_embedded_string_does_not_match_identifier_suffixes(self):
        text = 'A' * 100_000
        for pattern in (patch.FOOTER_LABEL_RE, patch.HELP_LABEL_RE,
                        patch.USAGE_RESETS_MODAL_RE, patch.USAGE_RESETS_SITE_RE):
            with self.subTest(pattern=pattern.pattern):
                self.assertIsNone(pattern.search(text))

    def test_footer_and_usage_patterns_still_match(self):
        self.assertIsNotNone(patch.FOOTER_LABEL_RE.search(
            'x?a.formatMessage({id:`codex.profileFooter.openProfileMenu`'))
        self.assertIsNotNone(patch.USAGE_RESETS_MODAL_RE.search(
            'f(s,M,{initialAvailableCount:u.rate_limit_reset_credits'
            '?.available_count??0,isRateLimitReached:!0,'))


if __name__ == '__main__':
    unittest.main()
