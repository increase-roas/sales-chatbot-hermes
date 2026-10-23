"""When do leads reply? Grounds the follow-up cadence in real threads (Alex 2026-10-15: $300k in 30 days, faster follow-ups).

Usage: python3 scripts/followup-timing.py   (reads eval/buyer-signals corpus + labels, threads cut at the close date)
"""
import datetime as dt
import importlib.util
import json
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("bs", Path(__file__).resolve().parent / "buyer-signals.py")
bs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bs)
B = bs.BASE / "eval/buyer-signals"


def parse(s):
    if not s:
        return None
    return dt.datetime.fromisoformat(s.replace(" ", "T")[:19]).replace(tzinfo=dt.timezone.utc)


def pct(v, ps=(25, 50, 75, 90)):
    v = sorted(v)
    return {f"p{p}": round(v[min(len(v) - 1, int(len(v) * p / 100))], 1) for p in ps} if v else {}


def main():
    corpus = json.loads((B / "corpus.json").read_text())
    labels = json.loads((B / "labels.json").read_text())
    dates = bs.close_dates()
    gaps = {"closed": [], "not_closed": []}
    revive = []  # closed threads: hours since the lead last texted, when a 2nd+ unanswered rep text got a reply
    for c in corpus:
        cut, _ = bs.cut_index(c, labels.get(c["id"], {}), dates)
        last_out = last_in = None
        outs_since_in = 0
        for x in c["messages"][:cut]:
            t = parse(x["at"])
            if not t:
                continue
            if x["direction"] == "outbound":
                last_out = t
                outs_since_in += 1
                continue
            if last_out and (last_in is None or last_out > last_in):
                gaps[c["outcome"]].append((t - last_out).total_seconds() / 3600)
                if outs_since_in >= 2 and last_in and c["outcome"] == "closed":
                    revive.append((t - last_in).total_seconds() / 3600)
            last_in = t
            outs_since_in = 0
    closed = gaps["closed"]
    out = {
        "lead_reply_hours_after_rep_text": {k: {"n": len(v), **pct(v)} for k, v in gaps.items()},
        "closed_share_replied_within_h": {h: round(sum(g <= h for g in closed) / max(1, len(closed)), 2) for h in (1, 3, 24, 72)},
        "closed_revived_by_followup": {"n": len(revive), **pct(revive)},
    }
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    sys.exit(main())
