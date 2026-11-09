import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "codex_update", Path(__file__).resolve().parents[1] / "dev/codex_update.py"
)
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)


class RetainedBuildChecks(unittest.TestCase):
    def test_dry_run_uses_the_selected_app(self):
        app = Path("builds/example/Codex.app")
        with patch.object(update, "mod_cli", return_value=subprocess.CompletedProcess([], 0, "", "")) as cli:
            self.assertTrue(update.dry_run(app)["ok"])
        cli.assert_called_once_with("dry-run", "--asar", str(app / "Contents/Resources/app.asar"))

    def test_failed_retained_build_prevents_a_green_verdict(self):
        report = {
            "patcher": {"ok": True, "degraded": []},
            "archived_patchers": {"1.0.0": {"ok": False, "error": "unrecognized thread listing"}},
            "runs": {},
        }
        verdict, reasons = update.verdict_for(report)
        self.assertEqual(verdict, "red")
        self.assertTrue(any("retained build 1.0.0" in reason for reason in reasons))


if __name__ == "__main__":
    unittest.main()
