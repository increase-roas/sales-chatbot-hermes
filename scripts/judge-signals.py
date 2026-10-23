"""Buyer-signal scorer (Alex 2026-10-15): grade a reply on the signals mined from real closed vs lost Dynamite threads.

Usage:
  python3 scripts/judge-signals.py score <rows.json|jsonl> <out.jsonl> [judge_model]
  python3 scripts/judge-signals.py auc   <scored.jsonl> <positive_label> <negative_label> [<rows> = only rows whose reply is not in the mined corpus]

rows: {"id", "context": [{"role": "user"|"assistant", "text"}], "reply", "label"} (same as judge-sales.py).

Per reply the judge names the lead's latest signal (buyer-signals.py SIGNALS), then scores:
  engagement 1-5  will the lead text back? (closed leads sent a median 13 texts before the sale, lost leads 2,
                  and 64% of lost threads died with the rep's text unanswered). Weighted heaviest.
  recognized      the reply answers / acknowledges that signal instead of ignoring it.
  next_step 1-5   moves to the next step the way the closing reps did (timing -> lock a date, scope -> confirm and
                  add, mockup -> quote, payment -> link, objection -> hold value, address missing -> ask it).
  human 1-5       sounds like a real person texting.
score = 0.45*engagement + 0.25*next_step + 0.15*human + 0.15*(5 if recognized else 1), on 1-5.
"""

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fw import request  # noqa: E402

BASE = Path.home() / "Documents/LIGHTS SALES/sft-build-20261014"
EFFORT = json.loads((Path(__file__).resolve().parent.parent / "config/spend.json").read_text())["judge_reasoning_effort"]  # low: same scores, far fewer billed thinking tokens
DEFAULT_JUDGE = "accounts/fireworks/models/kimi-k3"
WEIGHTS = {"engagement": 0.45, "next_step": 0.25, "human": 0.15, "recognized": 0.15}

PROMPT = """You grade one text a Dynamite Lights rep (Michigan holiday lights) sent to a lead. You learned what works from
126 closed and 89 lost real threads:
- Engagement decides deals. Closed leads kept texting (median 13 texts before the sale); lost leads sent 2, and most lost
  threads died with the rep's text left unanswered. A great text is easy and fun to answer: one short, specific question
  or a choice, warm, personal. A dead-end text ("let me know!", "have a great day", a wall of info) kills threads.
- Signals that predict a close (closed vs lost thread rate): {top}
- Signals seen in lost threads: {lost}
- What closing reps did next, real examples:
{examples}
This season: the goal is a yes to a free quote and the lead's address (we build the mockup ourselves); rooflines are the
core; no wreaths; never ask for a house photo unless the lead said the mockup was wrong; stop selling once approved.

Conversation so far (oldest first):
{history}

The rep's text to grade:
{reply}

First name the lead's most recent signal from: {signals} (or "none").
Then score:
- engagement (1-5): 5 = the lead will almost surely text back (easy, specific, personal question). 1 = dead end.
- recognized (bool): the text clearly responds to that signal (true if signal is none and the text fits the moment).
- next_step (1-5): 5 = moves to the next step the way the closing reps did, one easy step. 1 = stalls, ignores, invents
  prices/dates/promises, or breaks this season's rules.
- human (1-5): 5 = a real person texting from a phone. 1 = stiff, corporate, ChatGPT-sounding.
Reply with only JSON: {{"signal":"...","engagement":n,"recognized":bool,"next_step":n,"human":n,"reason":"<15 words"}}"""


def load_signals():
    d = json.loads((BASE / "eval/buyer-signals/signals.json").read_text())
    top = ", ".join(f"{r['signal']} {r['closed_rate']:.0%} vs {r['not_closed_rate']:.0%}" for r in d["top10"])
    lost = ", ".join(r["signal"] for r in d["lost_markers"])
    ex = "\n".join(f"  [{s}] lead: {e['lead'][:140]!r} -> rep: {e['rep_next'][:140]!r}"
                   for s, es in d["examples"].items() for e in es[:2] if e["rep_next"].strip())
    names = ", ".join(r["signal"] for r in d["all_signals"])
    return top, lost, ex, names


def history_text(context):
    return "\n".join(f"{'Lead' if m['role'] == 'user' else 'Rep'}: {m['text']}" for m in context[-8:]) or "(this is the first text)"


def clean(v):
    """Allowlisted verdict: 1-5 integers and a real boolean, or None. The judge never sets id or label."""
    out = {"signal": str(v.get("signal", ""))[:40], "reason": str(v.get("reason", ""))[:200]}
    for k in ("engagement", "next_step", "human"):
        x = v.get(k)
        if isinstance(x, bool) or not isinstance(x, (int, float)) or not 1 <= x <= 5:
            return None
        out[k] = float(x)
    if not isinstance(v.get("recognized"), bool):
        return None
    out["recognized"] = v["recognized"]
    return out


def composite(v):
    try:
        return round(WEIGHTS["engagement"] * float(v["engagement"]) + WEIGHTS["next_step"] * float(v["next_step"])
                     + WEIGHTS["human"] * float(v["human"]) + WEIGHTS["recognized"] * (5 if v["recognized"] else 1), 3)
    except (KeyError, TypeError, ValueError):
        return None


def judge(args):
    row, model, ctx = args
    top, lost, ex, names = ctx
    prompt = PROMPT.format(top=top, lost=lost, examples=ex, history=history_text(row.get("context", [])), reply=row["reply"], signals=names)
    body = {"model": model, "temperature": 0, "max_tokens": 3000, "reasoning_effort": EFFORT, "messages": [{"role": "user", "content": prompt}]}
    out = {}
    for _ in range(3):
        try:
            out = request("POST", "https://api.fireworks.ai/inference/v1/chat/completions", json.dumps(body).encode())
        except Exception:  # noqa: BLE001 - flaky network read; retry
            continue
        text = (out.get("choices") or [{}])[0].get("message", {}).get("content") or ""
        try:
            v = clean(json.loads(text[text.index("{"): text.rindex("}") + 1]))
            if v is None:
                continue
            return {**v, "score": composite(v), "usage": out.get("usage"), "id": row["id"], "label": row.get("label", "")}
        except ValueError:
            continue
    return {"id": row["id"], "label": row.get("label", ""), "error": "unparsable", "usage": out.get("usage")}


def load(path):
    p = Path(path)
    if p.suffix == ".json":
        d = json.loads(p.read_text())
        return d["won"] + d["lost"] if isinstance(d, dict) else d
    return [json.loads(line) for line in p.read_text().splitlines() if line.strip()]


def auc(pos, neg):
    """Probability a random positive outranks a random negative (ties count half)."""
    if not pos or not neg:
        return None
    wins = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
    return round(wins / (len(pos) * len(neg)), 3)


def corpus_replies():
    """Every rep text in the mined corpus (the rubric's source), to measure AUC on rows the rubric never saw."""
    corpus = json.loads((BASE / "eval/buyer-signals/corpus.json").read_text())
    return {m["body"].strip() for c in corpus for m in c["messages"] if m["direction"] == "outbound"}


def report(path, pos_label, neg_label, source=None):
    rows = [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]
    if source:
        seen = corpus_replies()
        reply = {r["id"]: r["reply"].strip() for r in load(source)}
        rows = [r for r in rows if reply.get(r["id"]) not in seen]
    ok = [r for r in rows if r.get("score") is not None]
    out = {"rows": len(rows), "scored": len(ok)}
    for k in ("score", "engagement", "next_step", "human"):
        pos = [float(r[k]) for r in ok if r["label"] == pos_label]
        neg = [float(r[k]) for r in ok if r["label"] == neg_label]
        out[k] = {"auc": auc(pos, neg), f"mean_{pos_label}": round(sum(pos) / max(1, len(pos)), 3), f"mean_{neg_label}": round(sum(neg) / max(1, len(neg)), 3)}
    pos = [r for r in ok if r["label"] == pos_label]
    neg = [r for r in ok if r["label"] == neg_label]
    out["recognized_rate"] = {pos_label: round(sum(bool(r["recognized"]) for r in pos) / max(1, len(pos)), 3),
                              neg_label: round(sum(bool(r["recognized"]) for r in neg) / max(1, len(neg)), 3)}
    return out


def main():
    if sys.argv[1] == "auc":
        print(json.dumps(report(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5] if len(sys.argv) > 5 else None), indent=2))
        return
    rows = load(sys.argv[2])
    model = sys.argv[4] if len(sys.argv) > 4 else DEFAULT_JUDGE
    ctx = load_signals()
    with ThreadPoolExecutor(8) as pool:
        out = list(pool.map(judge, [(r, model, ctx) for r in rows]))
    with open(sys.argv[3], "w") as f:
        for o in out:
            f.write(json.dumps(o) + "\n")
    print(json.dumps({"rows": len(out), "scored": sum(o.get("score") is not None for o in out)}))


if __name__ == "__main__":
    main()
