"""Humor check for bot replies (adds to eval.py's tone/progress/safety/overall judge).

Usage: python3 scripts/judge-humor.py <gen.jsonl> <out.jsonl> [judge_model]

Scores each reply: humor 0 (none), 1 (light and natural), 2 (forced or try-hard), plus whether any
joke lands on the customer (at_customer) or came when they were upset or talking money (bad_timing).
Alex, 2026-10-15: "should have humor too". Good humor = 1 with no at_customer and no bad_timing.
"""

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fw import request  # noqa: E402

DEFAULT_JUDGE = "accounts/fireworks/models/kimi-k3"
PROMPT = """You check one text from a holiday-lighting sales rep in Michigan to a homeowner.

Customer's last message:
{customer}

Rep's text:
{reply}

Answer only JSON: {{"humor": 0|1|2, "at_customer": true|false, "bad_timing": true|false}}
humor: 0 = no humor, 1 = light, natural humor a real person would use, 2 = forced, corny or try-hard.
at_customer: the joke is at the customer's expense.
bad_timing: there is a joke while the customer is upset, complaining or talking about money."""


def judge_one(args):
    g, customer, model = args
    body = {"model": model, "messages": [{"role": "user", "content": PROMPT.format(customer=customer, reply=g["reply"])}],
            "max_tokens": 2000, "temperature": 0}
    out = request("POST", "https://api.fireworks.ai/inference/v1/chat/completions", json.dumps(body).encode())
    text = (out.get("choices") or [{}])[0].get("message", {}).get("content") or ""
    try:
        verdict = json.loads(text[text.index("{"): text.rindex("}") + 1])
    except ValueError:
        verdict = {"error": text[:200]}
    return {"i": g["i"], **verdict, "usage": out.get("usage")}


def main():
    gen, out_path = Path(sys.argv[1]), Path(sys.argv[2])
    model = sys.argv[3] if len(sys.argv) > 3 else DEFAULT_JUDGE
    rows = [json.loads(line) for line in open(gen)]
    contexts = [r.get("customer", "") for r in rows]
    with ThreadPoolExecutor(8) as pool:
        out = list(pool.map(judge_one, [(r, c, model) for r, c in zip(rows, contexts)]))
    with open(out_path, "w") as f:
        for o in out:
            f.write(json.dumps(o) + "\n")
    ok = [o for o in out if "humor" in o]
    good = sum(1 for o in ok if o["humor"] == 1 and not o["at_customer"] and not o["bad_timing"])
    print(json.dumps({"rows": len(out), "scored": len(ok), "light_good": good,
                      "forced": sum(o["humor"] == 2 for o in ok), "at_customer": sum(bool(o["at_customer"]) for o in ok),
                      "bad_timing": sum(bool(o["bad_timing"]) for o in ok)}))


if __name__ == "__main__":
    main()
