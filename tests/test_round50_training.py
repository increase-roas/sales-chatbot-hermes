"""Fixture test for scripts/round50-to-training.py: YES, NO with a rewrite, NO without one, NO with an identical rewrite.

Run: python3 -m unittest tests/test_round50_training.py
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class Round50Training(unittest.TestCase):
    def test_fixtures(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            ctx = [{"role": "user", "text": "what does warm white look like?"}]
            items = [
                {"id": f"r0{i}", "context": ctx, "reply": f"bot reply {i}", "tags": [], "variant": "default", "photoId": "", "realRepReply": "rep"}
                for i in range(1, 5)
            ]
            (tmp / "items.jsonl").write_text("\n".join(json.dumps(x) for x in items) + "\n")
            ratings = tmp / "export" / "ratings"
            ratings.mkdir(parents=True)
            fixtures = {
                "r01": {"verdict": "yes"},
                "r02": {"verdict": "no", "note": "too stiff", "betterText": "yep, soft warm glow, want the bushes too?"},
                "r03": {"verdict": "no", "note": "This sounds robotic"},
                "r04": {"verdict": "no", "betterText": "bot reply 4"},
            }
            for k, v in fixtures.items():
                (ratings / f"{k}.json").write_text(json.dumps(v))
            run = subprocess.run([sys.executable, str(ROOT / "scripts" / "round50-to-training.py"), str(tmp / "items.jsonl"), str(tmp / "export"), str(tmp / "out")],
                                 capture_output=True, text=True, check=True)
            summary = json.loads(run.stdout.strip().splitlines()[-1])
            self.assertEqual((summary["yes"], summary["dpo_pairs"], summary["no_without_better_text"]), (1, 1, 2))
            sft = [json.loads(l) for l in (tmp / "out" / "sft.jsonl").read_text().splitlines()]
            dpo = [json.loads(l) for l in (tmp / "out" / "dpo.jsonl").read_text().splitlines()]
            rejected = [json.loads(l) for l in (tmp / "out" / "rejected.jsonl").read_text().splitlines()]
            self.assertEqual(sft[0]["messages"][-1]["content"], "bot reply 1")
            self.assertEqual(dpo[0]["preferred_output"][0]["content"], "yep, soft warm glow, want the bushes too?")
            self.assertEqual(dpo[0]["non_preferred_output"][0]["content"], "bot reply 2")
            self.assertTrue(all(r["messages"][-1]["content"] != "This sounds robotic" for r in rejected))
            self.assertIn("skipped", rejected[-1])


if __name__ == "__main__":
    unittest.main()
