"""Generate holdout replies the way production does: same prompt, same four tools, stub tool answers.

Usage: python3 scripts/eval-tools.py <holdout.jsonl> <out.jsonl> <system.txt> [model] [max_tokens] [temperature]

Production (src/mastra/agents/sales-agent.ts) gives the model lookupProspect, quotePrice,
proposeDate and bookInstall. Without them the model emits a tool call and no text, which
scores as an empty reply. The stubs answer like a brand-new deal: no GHL contact found, and
price, date and booking denied. That matches production for a NEW deal state.
Each output line also records token usage, so the run's cost can be totalled.
"""

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fw import request  # noqa: E402

CHAT_URL = "https://api.fireworks.ai/inference/v1/chat/completions"
NOTE = {"type": "object", "properties": {"note": {"type": "string", "description": "Why you are asking. Do not put a price or date here."}}}
TOOLS = [
    {"type": "function", "function": {"name": "lookupProspect", "description": "Read a prospect's GoHighLevel contact and opportunity. Returns an empty result when lookup is unavailable. Does not write to GoHighLevel.",
     "parameters": {"type": "object", "properties": {"phone": {"type": "string", "description": "Prospect's phone number, e.g. +15551234567"}}, "required": ["phone"]}}},
    {"type": "function", "function": {"name": "quotePrice", "description": "Ask whether a price may be repeated. Denied unless the deal is CONFIRMED or ESTIMATE_SENT. Never invent a dollar amount.", "parameters": NOTE}},
    {"type": "function", "function": {"name": "proposeDate", "description": "Ask whether an install date may be repeated. Denied unless the deal is ESTIMATE_SENT. Never invent a date.", "parameters": NOTE}},
    {"type": "function", "function": {"name": "bookInstall", "description": "Ask whether booking is allowed. Denied unless the deal is ESTIMATE_SENT. This does not book anything.", "parameters": NOTE}},
]
STUBS = {
    "lookupProspect": {"found": False, "name": "", "stage": "", "notes": ["No contact found."], "opportunities": []},
    "quotePrice": {"allowed": False, "state": "NEW", "reason": "No estimate has been sent yet."},
    "proposeDate": {"allowed": False, "state": "NEW", "reason": "No estimate has been sent yet."},
    "bookInstall": {"allowed": False, "state": "NEW", "reason": "No estimate has been sent yet."},
}
MAX_ROUNDS = 4


def call(body):
    for _ in range(4):
        out = request("POST", CHAT_URL, json.dumps(body).encode())
        if "choices" in out:
            return out
    raise RuntimeError(str(out)[:300])


def one(args):
    i, row, prompt, model, max_tokens, temperature = args
    msgs = [{"role": m["role"], "content": m["content"]} for m in row["messages"][:-1]]
    msgs[0] = {"role": "system", "content": prompt}
    usage = {"prompt_tokens": 0, "completion_tokens": 0}
    tools_called = []
    for _ in range(MAX_ROUNDS):
        out = call({"model": model, "messages": msgs, "tools": TOOLS, "max_tokens": max_tokens, "temperature": temperature})
        for k in usage:
            usage[k] += out.get("usage", {}).get(k, 0)
        m = out["choices"][0]["message"]
        calls = m.get("tool_calls") or []
        if not calls:
            return {"i": i, "label": "served-v3-tools", "model": model, "reply": (m.get("content") or "").strip(),
                    "tools_called": tools_called, "usage": usage}
        msgs.append({"role": "assistant", "content": m.get("content") or "", "tool_calls": calls})
        for c in calls:
            name = c["function"]["name"]
            tools_called.append(name)
            msgs.append({"role": "tool", "tool_call_id": c["id"], "content": json.dumps(STUBS.get(name, {"error": "unknown tool"}))})
    return {"i": i, "label": "served-v3-tools", "model": model, "reply": "", "tools_called": tools_called, "usage": usage, "note": "tool rounds exhausted"}


def main():
    holdout, out_path, system = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]).read_text()
    model = sys.argv[4] if len(sys.argv) > 4 else "accounts/fireworks/models/qwen3p8-2p4t-a95b"
    max_tokens = int(sys.argv[5]) if len(sys.argv) > 5 else 4000
    temperature = float(sys.argv[6]) if len(sys.argv) > 6 else 0.3
    rows = [json.loads(line) for line in open(holdout)]
    with ThreadPoolExecutor(8) as pool:
        out = list(pool.map(one, [(i, r, system, model, max_tokens, temperature) for i, r in enumerate(rows)]))
    with open(out_path, "w") as f:
        for o in out:
            f.write(json.dumps(o, ensure_ascii=False) + "\n")
    print(json.dumps({"rows": len(out), "empty": sum(not o["reply"] for o in out),
                      "prompt_tokens": sum(o["usage"]["prompt_tokens"] for o in out),
                      "completion_tokens": sum(o["usage"]["completion_tokens"] for o in out)}))


if __name__ == "__main__":
    main()
