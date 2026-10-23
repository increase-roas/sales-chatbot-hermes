"""Pick the best of several SMS drafts without seeing the real rep's reply.

Usage:
  python3 scripts/bestof.py <holdout.jsonl> <results_dir> <label> <model_id>
"""

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from eval import chat, history_text, load, strip_weights  # noqa: E402

PICK = """You choose which text Dynamite Lights should send. You do not see the real reply.

Conversation (most recent last):
{history}

Candidates:
{cands}

Prefer the candidate that answers the last message, sounds like a short human text, asks for an address or photo only when that detail is still missing, and does not invent a price, date, or discount.
Reply with only the candidate number.
"""


def drafts(model: str, messages: list[dict], n: int) -> list[str]:
    out = []
    for _ in range(n):
        text = chat(model, messages, 80, 0.9, "none")
        text = " ".join(text.split())
        if text and text not in out and not text.lower().startswith("the customer") and "the user" not in text.lower()[:40]:
            out.append(text)
    return out or ["I'll check with the team and get back to you."]


def pick(model: str, history: str, options: list[str]) -> str:
    if len(options) == 1:
        return options[0]
    cands = "\n".join(f"{i}. {t}" for i, t in enumerate(options, 1))
    raw = chat(model, [{"role": "user", "content": PICK.format(history=history, cands=cands)}], 20, 0.0, "none")
    digit = next((ch for ch in raw if ch.isdigit()), "1")
    idx = min(max(int(digit) - 1, 0), len(options) - 1)
    return options[idx]


def main() -> None:
    holdout, results, label, model = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], sys.argv[4]
    judge_model = sys.argv[5] if len(sys.argv) > 5 else "accounts/fireworks/models/kimi-k3"
    rows = load(holdout)
    results.mkdir(parents=True, exist_ok=True)

    def one(i_row):
        i, row = i_row
        messages = strip_weights(row["messages"][:-1])
        options = drafts(model, messages, 4)
        reply = pick(judge_model, history_text(messages), options)
        return {"i": i, "label": label, "model": model, "reasoning": "bestof4", "reply": reply, "n": len(options)}

    with ThreadPoolExecutor(4) as pool:
        out = list(pool.map(one, enumerate(rows)))
    with open(results / f"gen-{label}.jsonl", "w") as f:
        for r in out:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"picked {len(out)} replies for {label}")


if __name__ == "__main__":
    main()
