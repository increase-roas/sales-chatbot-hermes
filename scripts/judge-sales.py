"""Alex's rubric (2026-10-15): score a reply on SOUNDS HUMAN and GOOD AT SALES. Not "professional quality".

Usage: python3 scripts/judge-sales.py <rows.json|jsonl> <out.jsonl> [judge_model]
rows: {"id", "context": [{"role": "user"|"assistant", "text"}], "reply"} (a .json with {"won": [...], "lost": [...]}
also works; each row keeps its "label").

human 1-5: casual, short, contractions, sounds like a real person texting, no ChatGPT tells (filler, lists,
  formal sign-offs, dashes), natural light humor when it fits.
sales 1-5: moves toward a YES to a holiday-lights quote, gets the address if missing, pushes rooflines,
  handles objections (price, timing, "thinking about it") without caving or inventing, keeps momentum.
Hard-rule flags (this season): wreath_upsell, photo_ask (asks the lead for a photo when the mockup isn't
  disputed), missed_address (customer is in but the reply doesn't ask for a missing address).
"""

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fw import request  # noqa: E402

EFFORT = json.loads((Path(__file__).resolve().parent.parent / "config/spend.json").read_text())["judge_reasoning_effort"]  # low: same scores, far fewer billed thinking tokens
DEFAULT_JUDGE = "accounts/fireworks/models/kimi-k3"
PROMPT = """You are Dynamite Lights' sales manager in Michigan grading one text a rep sent to a lead about holiday lights.
This season's playbook: the only goal is a YES to a free holiday-lights quote, then the lead's address (we build a
mockup of their house ourselves). Rooflines are the core offer. We do NOT do wreaths this season. Never ask the lead
for a photo of their house unless they said our mockup was wrong. Once a quote is approved we stop texting.

Conversation so far (oldest first):
{history}

The rep's text to grade:
{reply}

Score:
- human (1-5): 5 = reads like a real person texting from their phone (casual, short, contractions, maybe lowercase,
  natural humor when it fits). 1 = stiff, salesy-corporate, ChatGPT-sounding (filler like "I'd be happy to",
  lists, formal sign-offs, long-winded, dashes).
- sales (1-5): 5 = clearly moves this lead toward a yes on the quote and/or gets the address, pushes the roofline,
  handles any objection well, keeps momentum with one easy next step. 1 = stalls, ignores what they said, gives up,
  confuses them, or invents prices, dates or promises.
- wreath_upsell: true if the text offers or upsells wreaths/garland.
- photo_ask: true if it asks the lead for a photo of their house and they did NOT say the mockup was wrong.
- missed_address: true if the lead is interested, we don't have their address yet, and the text doesn't ask for it.
Reply with only JSON: {{"human":n,"sales":n,"wreath_upsell":bool,"photo_ask":bool,"missed_address":bool,"reason":"<15 words"}}"""


def history_text(context):
    return "\n".join(f"{'Lead' if m['role'] == 'user' else 'Rep'}: {m['text']}" for m in context[-8:]) or "(this is the first text)"


def judge(args):
    row, model = args
    body = {"model": model, "temperature": 0, "max_tokens": 3000, "reasoning_effort": EFFORT,
            "messages": [{"role": "user", "content": PROMPT.format(history=history_text(row.get("context", [])), reply=row["reply"])}]}
    for _ in range(3):
        out = request("POST", "https://api.fireworks.ai/inference/v1/chat/completions", json.dumps(body).encode())
        text = (out.get("choices") or [{}])[0].get("message", {}).get("content") or ""
        try:
            verdict = json.loads(text[text.index("{"): text.rindex("}") + 1])
            return {"id": row["id"], "label": row.get("label", ""), **verdict, "usage": out.get("usage")}
        except ValueError:
            continue
    return {"id": row["id"], "label": row.get("label", ""), "error": "unparsable"}


def load(path):
    p = Path(path)
    if p.suffix == ".json":
        d = json.loads(p.read_text())
        return d["won"] + d["lost"] if isinstance(d, dict) else d
    return [json.loads(line) for line in p.read_text().splitlines() if line.strip()]


def main():
    rows = load(sys.argv[1])
    model = sys.argv[3] if len(sys.argv) > 3 else DEFAULT_JUDGE
    with ThreadPoolExecutor(8) as pool:
        out = list(pool.map(judge, [(r, model) for r in rows]))
    with open(sys.argv[2], "w") as f:
        for o in out:
            f.write(json.dumps(o) + "\n")
    print(json.dumps({"rows": len(out), "scored": sum("human" in o for o in out)}))


if __name__ == "__main__":
    main()
