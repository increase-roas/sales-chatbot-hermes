"""Score candidate models on the SFT holdout with an LLM judge.

Usage:
  python3 scripts/eval.py generate <holdout.jsonl> <results_dir> <label> <model_id> [reasoning_effort|-] [system.txt|-] [revise.txt|-] [max_tokens=4000|-] [temperature=0.3|-] [examples.json]
  python3 scripts/eval.py judge <holdout.jsonl> <results_dir> <label> [judge_model]
  python3 scripts/eval.py summary <results_dir>

label "human" scores the real rep reply (no generation needed).
"""

import http.client
import json
import re
import statistics
import sys
import time
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fw import request  # noqa: E402

CHAT_URL = "https://api.fireworks.ai/inference/v1/chat/completions"
DEFAULT_JUDGE = "accounts/fireworks/models/kimi-k3"
PRICE = re.compile(r"\$\s?\d")
JUDGE_PROMPT = """You grade replies from a sales rep texting a homeowner for Dynamite Lights, a Michigan holiday-lighting installer.

Conversation so far (most recent last):
{history}

REFERENCE: the reply a real Dynamite rep actually sent here (this customer went on to buy):
{reference}

CANDIDATE reply to grade:
{candidate}

Score the CANDIDATE from 1 (poor) to 5 (excellent) on each:
- tone: sounds like a real, warm, human rep texting; brief; one question at a time; no robotic or salesy filler.
- progress: responds to what the customer just said and moves toward the next step (quote details, booking, confirmation).
- safety: never invents a price, discount, deposit, date, availability or policy not already stated in the conversation. 5 = nothing invented.
- overall: how glad Dynamite's owner would be to have sent this exact text.
The candidate does not need to match the reference; the reference only shows what worked.
Reply with only JSON: {{"tone":n,"progress":n,"safety":n,"overall":n,"reason":"<15 words"}}"""


def load(path: Path) -> list[dict]:
    return [json.loads(line) for line in open(path)]


def strip_weights(messages: list[dict]) -> list[dict]:
    return [{"role": m["role"], "content": m["content"]} for m in messages]


def chat(model: str, messages: list[dict], max_tokens: int, temperature: float, reasoning: str | None = None) -> str:
    body = {"model": model, "messages": messages, "max_tokens": max_tokens, "temperature": temperature}
    if reasoning:
        body["reasoning_effort"] = reasoning
    for attempt in range(4):
        try:
            out = request("POST", CHAT_URL, json.dumps(body).encode())
        except (ConnectionError, TimeoutError, http.client.HTTPException, urllib.error.URLError):
            time.sleep(2 ** attempt * 3)
            continue
        if "choices" in out:
            text = out["choices"][0]["message"].get("content") or ""
            return re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
        if out.get("http_error") in (429, 500, 502, 503, 504):
            time.sleep(2 ** attempt * 3)
            continue
        raise RuntimeError(f"{model}: {out}")
    raise RuntimeError(f"{model}: retries exhausted")


def with_system(messages: list[dict], prompt: str | None) -> list[dict]:
    msgs = strip_weights(messages)
    if not prompt:
        return msgs
    if msgs and msgs[0]["role"] == "system":
        msgs[0] = {"role": "system", "content": prompt}
    else:
        msgs.insert(0, {"role": "system", "content": prompt})
    return msgs


def generate(
    holdout: Path,
    results: Path,
    label: str,
    model: str,
    reasoning: str | None,
    system_prompt: str | None = None,
    revise_prompt: str | None = None,
    max_tokens: int = 4000,
    temperature: float = 0.3,
    examples: dict[str, str] | None = None,
) -> None:
    rows = load(holdout)
    results.mkdir(parents=True, exist_ok=True)

    def one(i_row):
        i, row = i_row
        context = with_system(row["messages"][:-1], system_prompt)
        block = (examples or {}).get(str(i), "")
        if block and context and context[0]["role"] == "system":
            context[0] = {"role": "system", "content": f"{context[0]['content']}\n\n{block}"}
        reply = chat(model, context, max_tokens, temperature, reasoning)
        if revise_prompt:
            history = history_text(context)
            revise = (
                f"{revise_prompt}\n\nThread:\n{history}\n\nDraft:\n{reply or '(empty)'}\n\n"
                "Return only the SMS to send."
            )
            reply = chat(model, [{"role": "user", "content": revise}], 200, 0.2, reasoning)
        return {"i": i, "label": label, "model": model, "reasoning": reasoning,
                "max_tokens": max_tokens, "temperature": temperature, "reply": reply}

    with ThreadPoolExecutor(6) as pool:
        out = list(pool.map(one, enumerate(rows)))
    with open(results / f"gen-{label}.jsonl", "w") as f:
        for r in out:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"generated {len(out)} replies for {label}")


def history_text(messages: list[dict]) -> str:
    turns = [m for m in messages if m["role"] != "system"][-8:]
    return "\n".join(f"{'CUSTOMER' if m['role'] == 'user' else 'REP'}: {m['content']}" for m in turns)


def judge(holdout: Path, results: Path, label: str, judge_model: str) -> None:
    rows = load(holdout)
    if label == "human":
        gens = [{"i": i, "label": "human", "model": "real rep", "reply": r["messages"][-1]["content"]} for i, r in enumerate(rows)]
    else:
        gens = load(results / f"gen-{label}.jsonl")

    def one(g):
        row = rows[g["i"]]
        context = row["messages"][:-1]
        prompt = JUDGE_PROMPT.format(
            history=history_text(context),
            reference=row["messages"][-1]["content"],
            candidate=g["reply"] or "(empty reply)",
        )
        raw = chat(judge_model, [{"role": "user", "content": prompt}], 4000, 0.0)
        match = re.search(r"\{.*\}", raw, re.S)
        scores = json.loads(match.group(0)) if match else {"parse_error": raw[:200]}
        context_has_price = any(PRICE.search(m["content"]) or "[price]" in m["content"] for m in context)
        return {
            **g,
            **scores,
            "invented_price": bool(PRICE.search(g["reply"])) and not context_has_price,
            "chars": len(g["reply"]),
        }

    with ThreadPoolExecutor(6) as pool:
        out = list(pool.map(one, gens))
    with open(results / f"judge-{label}.jsonl", "w") as f:
        for r in out:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"judged {len(out)} replies for {label}")


def summary(results: Path) -> None:
    print(f"{'label':<14}{'n':>4}{'overall':>9}{'tone':>7}{'progress':>10}{'safety':>8}{'inv_price':>11}{'med_chars':>11}")
    for path in sorted(results.glob("judge-*.jsonl")):
        rows = [r for r in load(path) if "overall" in r]
        if not rows:
            continue
        mean = lambda k: statistics.mean(float(r[k]) for r in rows)
        print(
            f"{rows[0]['label']:<14}{len(rows):>4}{mean('overall'):>9.2f}{mean('tone'):>7.2f}{mean('progress'):>10.2f}"
            f"{mean('safety'):>8.2f}{sum(r['invented_price'] for r in rows):>11}{int(statistics.median(r['chars'] for r in rows)):>11}"
        )


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "generate":
        system = Path(sys.argv[7]).read_text() if len(sys.argv) > 7 and sys.argv[7] != "-" else None
        revise = Path(sys.argv[8]).read_text() if len(sys.argv) > 8 and sys.argv[8] != "-" else None
        reasoning = sys.argv[6] if len(sys.argv) > 6 and sys.argv[6] != "-" else None
        max_tokens = int(sys.argv[9]) if len(sys.argv) > 9 and sys.argv[9] != "-" else 4000
        temperature = float(sys.argv[10]) if len(sys.argv) > 10 and sys.argv[10] != "-" else 0.3
        examples = json.loads(Path(sys.argv[11]).read_text()) if len(sys.argv) > 11 and sys.argv[11] != "-" else None
        generate(Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4], sys.argv[5], reasoning, system, revise, max_tokens, temperature, examples)
    elif cmd == "judge":
        judge(Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4], sys.argv[5] if len(sys.argv) > 5 else DEFAULT_JUDGE)
    elif cmd == "summary":
        summary(Path(sys.argv[2]))
    else:
        raise SystemExit(__doc__)
