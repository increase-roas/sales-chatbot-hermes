"""Fireworks spend guard fails closed and never leaks the key (Codex review of PR #2)."""
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import fw_guard  # noqa: E402
import fw  # noqa: E402

import datetime  # noqa: E402

# Rows dated with the same UTC "today" the guard computes, so the tests pass on any date.
_TODAY = datetime.datetime.now(datetime.timezone.utc).date()
ROW = f"{_TODAY} 00:00:00  {_TODAY + datetime.timedelta(days=1)} 00:00:00  " + "{s} USD  {t} USD  {t} USD  0.00 USD\n"


def fake(stdout, code=0):
    return mock.Mock(returncode=code, stdout=stdout, stderr="")


class Guard(unittest.TestCase):
    def setUp(self):
        os.environ["FIREWORKS_API_KEY"] = "fw_secret_test_key"

    def run_check(self, side):
        with mock.patch.object(fw_guard.subprocess, "run", side_effect=side), mock.patch.object(fw_guard, "queue_low_balance"):
            return fw_guard.check()

    def test_timeout_fails_closed_without_key(self):
        def boom(cmd, **_):
            raise subprocess.TimeoutExpired(cmd=cmd, timeout=1)
        ok, why, _ = self.run_check(boom)
        self.assertFalse(ok)
        self.assertNotIn("fw_secret_test_key", why)

    def test_nonzero_exit_fails_closed(self):
        ok, _, _ = self.run_check(lambda *a, **k: fake(ROW.format(s="0.00", t="0.00") + "Balance: USD 99", code=1))
        self.assertFalse(ok)

    def test_nan_fails_closed(self):
        ok, _, _ = self.run_check(lambda *a, **k: fake(ROW.format(s="NaN", t="NaN") + "Balance: USD NaN"))
        self.assertFalse(ok)

    def test_cap_and_low_balance(self):
        rows = [fake(ROW.format(s="1.00", t="12.00")), fake("Balance: USD 50")]
        self.assertFalse(self.run_check(lambda *a, **k: rows.pop(0))[0])  # TOTAL 12 >= cap 10
        rows = [fake(ROW.format(s="1.00", t="1.00")), fake("Balance: USD 5")]
        self.assertFalse(self.run_check(lambda *a, **k: rows.pop(0))[0])  # balance under 15
        rows = [fake(ROW.format(s="1.00", t="1.00")), fake("Balance: USD 50")]
        self.assertTrue(self.run_check(lambda *a, **k: rows.pop(0))[0])

    def test_every_paid_post_is_guarded_reads_and_datasets_are_not(self):
        fw._GUARD_OK_AT = 0.0
        with mock.patch.object(fw_guard, "check", return_value=(False, "test block", {})), mock.patch.object(fw.urllib.request, "urlopen") as net:
            for url in ("https://api.fireworks.ai/v1/accounts/x/dpoJobs", "https://api.fireworks.ai/inference/v1/chat/completions"):
                with self.assertRaises(SystemExit):
                    fw.request("POST", url, b"{}")
            net.side_effect = RuntimeError("network")
            with self.assertRaises(RuntimeError):
                fw.request("GET", "https://api.fireworks.ai/v1/accounts/x/models")
            with self.assertRaises(RuntimeError):
                fw.request("POST", "https://api.fireworks.ai/v1/accounts/x/datasets", b"{}")


if __name__ == "__main__":
    unittest.main()
