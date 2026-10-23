"""Mine buyer signals from real Dynamite conversations: closed vs not closed (Alex 2026-10-15).

Usage:
  python3 scripts/buyer-signals.py build  <out_dir>     # corpus from local 2025 export + GHL 2026 won/lost pulls
  python3 scripts/buyer-signals.py label  <out_dir>     # LLM-label every lead message with signals (paid, cheap model)
  python3 scripts/buyer-signals.py report <out_dir>     # lift table, top 10 with anonymized examples, rep moves

Closed = local export buckets with purchase evidence or accepted/booked, plus GHL opportunities marked won.
Not closed = GHL opportunities marked lost. "2025 purchase status unknown" contacts are left out (not losses).
Everything stays on this Mac; examples in the report are redacted with optimize-sft.py's redact().
"""

import collections
import csv
import importlib.util
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from fw import request  # noqa: E402

spec = importlib.util.spec_from_file_location("opt", ROOT / "optimize-sft.py")
opt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(opt)

BASE = Path.home() / "Documents/LIGHTS SALES/sft-build-20261014"
CLOSED_BUCKETS = {"Purchase evidence confirmed — 2025", "Purchase evidence confirmed — 2026; 2025 unknown", "Accepted/booked — payment/install unverified"}
OFF = re.compile(r"garbage|trash|\bbins?\b|can cleaning|sanitation|power ?wash|pressure ?wash|maggot|odor", re.I)
MODEL = "accounts/fireworks/models/qwen3p8-2p4t-a95b"

SIGNALS = {
    "asks_price": "asks what it costs / for a price or quote amount",
    "asks_quote": "asks for a quote or estimate, or says they want one",
    "asks_timing": "asks when install can happen / how soon / dates",
    "gives_address": "shares their address or location details",
    "sends_photo": "sends or offers a photo of their house",
    "mockup_positive": "likes the mockup, design or example photo",
    "mockup_change": "asks to change the mockup/design/scope details",
    "asks_design": "asks about colors, styles, what areas, how it would look",
    "adds_scope": "adds more areas (trees, bushes, garage, more roofline)",
    "asks_process": "asks how it works: install, takedown, storage, timers, ownership",
    "asks_payment": "asks about deposit, payment, invoice, card",
    "price_objection": "says it is too expensive / asks for a discount / budget pushback",
    "delay": "stalls: needs to think, talk to spouse, maybe later, busy",
    "commit": "says yes / let's do it / book it / approves",
    "logistics": "home/not home, gate, dogs, access, scheduling details",
    "reference_past": "mentions last year, a neighbor, a referral, or a past install",
    "comparison": "mentions another company, a competitor quote or DIY",
    "disengage": "not interested, stop, already have someone, too late",
    "short_ack": "just ok/thanks/sounds good with no new info",
}

LABEL_PROMPT = """Label each customer text message from a holiday-lighting sales conversation with ALL signals that apply.
Signals: {signals}
Messages:
{messages}
Reply with only JSON: {{"labels": [[signal, ...], ...]}} with exactly {n} lists, in order. Use [] when none apply."""


def contact_threads_local():
    stage = {}
    with open(BASE / "contact-conversations-279/CONTACT-STAGE-INDEX.csv", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            stage[row["Contact ID"]] = row["Strongest lifecycle evidence bucket"]
    threads = collections.defaultdict(list)
    for line in open(BASE / "contact-conversations-279/MESSAGES.jsonl"):
        m = json.loads(line)
        if m["message_type"] in ("TYPE_SMS", "TYPE_FACEBOOK") and (m.get("body") or "").strip():
            threads[m["contact_id"]].append({"direction": m["direction"], "body": m["body"], "at": m["date_utc"]})
    return {cid: sorted(t, key=lambda x: x["at"]) for cid, t in threads.items() if stage.get(cid) in CLOSED_BUCKETS}


def build(out: Path):
    out.mkdir(parents=True, exist_ok=True)
    closed = {f"local-{k}": v for k, v in contact_threads_local().items()}
    won = json.load(open(BASE / "eval/won-opps/won-threads.json"))
    lost = json.load(open(BASE / "eval/lost-opps/lost-threads.json"))
    local_ids = {k[6:] for k in closed}
    for cid, msgs in won.items():
        if cid not in local_ids and msgs:
            closed[f"ghl-{cid}"] = [{"direction": m["direction"], "body": m["body"], "at": m["at"] or ""} for m in msgs if m.get("body")]
    not_closed = {f"ghl-{cid}": [{"direction": m["direction"], "body": m["body"], "at": m["at"] or ""} for m in msgs if m.get("body")]
                  for cid, msgs in lost.items() if cid not in won and cid not in local_ids and msgs}
    corpus = []
    for label, group in (("closed", closed), ("not_closed", not_closed)):
        for cid, msgs in group.items():
            if OFF.search(" ".join(m["body"] for m in msgs)) and not re.search(r"light|roof|holiday|christmas", " ".join(m["body"] for m in msgs), re.I):
                continue
            if not any(m["direction"] == "inbound" for m in msgs):
                continue
            corpus.append({"id": cid, "outcome": label, "messages": msgs[:80]})
    (out / "corpus.json").write_text(json.dumps(corpus))
    print(json.dumps({"closed": sum(c["outcome"] == "closed" for c in corpus), "not_closed": sum(c["outcome"] == "not_closed" for c in corpus)}))


def label(out: Path):
    corpus = json.loads((out / "corpus.json").read_text())
    jobs = []
    for c in corpus:
        inbound = [i for i, m in enumerate(c["messages"]) if m["direction"] == "inbound"]
        for k in range(0, len(inbound), 15):
            jobs.append((c["id"], inbound[k:k + 15], [c["messages"][i]["body"][:400] for i in inbound[k:k + 15]]))
    sig = "; ".join(f"{k} = {v}" for k, v in SIGNALS.items())

    def one(job):
        cid, idx, texts = job
        msgs = "\n".join(f"{n + 1}. {t.replace(chr(10), ' ')}" for n, t in enumerate(texts))
        body = {"model": MODEL, "temperature": 0, "max_tokens": 4000, "reasoning_effort": "none",
                "messages": [{"role": "user", "content": LABEL_PROMPT.format(signals=sig, messages=msgs, n=len(texts))}]}
        for _ in range(3):
            res = request("POST", "https://api.fireworks.ai/inference/v1/chat/completions", json.dumps(body).encode())
            text = (res.get("choices") or [{}])[0].get("message", {}).get("content") or ""
            try:
                labels = json.loads(text[text.index("{"): text.rindex("}") + 1])["labels"]
                if len(labels) == len(texts):
                    return cid, {str(i): [s for s in lab if s in SIGNALS] for i, lab in zip(idx, labels)}, res.get("usage")
            except (ValueError, KeyError, TypeError):
                continue
        return cid, {}, res.get("usage")

    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(one, jobs))
    labels = collections.defaultdict(dict)
    usage = collections.Counter()
    for cid, lab, u in results:
        labels[cid].update(lab)
        for k, v in (u or {}).items():
            if isinstance(v, int):
                usage[k] += v
    (out / "labels.json").write_text(json.dumps(labels))
    print(json.dumps({"jobs": len(jobs), "labeled_messages": sum(len(v) for v in labels.values()), "usage": dict(usage)}))


def close_dates():
    """Contact id (corpus form) -> UTC close time: local purchase-proof message time, else GHL won lastStatusChangeAt."""
    dates = {}
    with open(BASE / "contact-conversations-279/CONTACT-STAGE-INDEX.csv", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            if row["First linked purchase-proof message UTC"]:
                dates[f"local-{row['Contact ID']}"] = row["First linked purchase-proof message UTC"]
    for page in sorted((BASE / "eval/won-opps").glob("*-won-p*.json")):
        for o in json.loads(page.read_text())["data"]["data"].get("opportunities", []):
            if o.get("contactId") and o.get("lastStatusChangeAt"):
                dates.setdefault(f"ghl-{o['contactId']}", o["lastStatusChangeAt"])
    return dates


def cut_index(c, lab, dates):
    """Index of the first message that is post-sale. Close date first; first 'commit' label as fallback."""
    if c["outcome"] != "closed":
        return 10**9, "lost"
    when = dates.get(c["id"])
    if when:
        key = when.replace(" ", "T")[:19]
        return next((i for i, m in enumerate(c["messages"]) if (m["at"] or "").replace(" ", "T")[:19] >= key), len(c["messages"])), "close_date"
    commits = sorted(int(i) for i, sigs in lab.items() if "commit" in sigs)
    return (commits[0] + 1 if commits else len(c["messages"])), ("commit_label" if commits else "none")


def report(out: Path):
    corpus = {c["id"]: c for c in json.loads((out / "corpus.json").read_text())}
    labels = json.loads((out / "labels.json").read_text())
    names = opt.contact_names(BASE / "contact-conversations-279/CONTACT-STAGE-INDEX.csv")
    n = collections.Counter(c["outcome"] for c in corpus.values())
    has = {"closed": collections.Counter(), "not_closed": collections.Counter()}
    examples = collections.defaultdict(list)
    dates = close_dates()
    cut_how = collections.Counter()
    engagement = collections.defaultdict(list)
    ended = collections.Counter()
    for cid, c in corpus.items():
        lab = labels.get(cid, {})
        seen = set()
        # Only what buyers said BEFORE the sale closed (CRM/Jobber close date); later texts are post-sale.
        cutoff, how = cut_index(c, lab, dates)
        cut_how[how] += 1
        pre = c["messages"][:cutoff]
        engagement[c["outcome"]].append(sum(m["direction"] == "inbound" for m in pre))
        last_in = [lab.get(str(i), []) for i, m in enumerate(pre) if m["direction"] == "inbound"]
        if c["outcome"] == "not_closed":
            ended["said_no" if (last_in and "disengage" in last_in[-1]) else "went_quiet_after_rep" if pre[-1]["direction"] == "outbound" else "lead_had_last_word"] += 1
        for i_str, sigs in lab.items():
            i = int(i_str)
            if i >= cutoff:
                continue
            for s in sigs:
                seen.add(s)
                if c["outcome"] == "closed" and len(examples[s]) < 40:
                    nxt = next((m["body"] for m in c["messages"][i + 1:min(i + 4, cutoff)] if m["direction"] == "outbound"), "")
                    examples[s].append({"lead": opt.redact(c["messages"][i]["body"][:240], names), "rep_next": opt.redact(nxt[:240], names)})
        for s in seen:
            has[c["outcome"]][s] += 1
    rows = []
    for s in SIGNALS:
        pc = has["closed"][s] / max(1, n["closed"])
        pl = has["not_closed"][s] / max(1, n["not_closed"])
        lift = (pc + 0.01) / (pl + 0.01)
        rows.append({"signal": s, "meaning": SIGNALS[s], "closed_rate": round(pc, 3), "not_closed_rate": round(pl, 3), "lift": round(lift, 2),
                     "closed_threads": has["closed"][s], "not_closed_threads": has["not_closed"][s]})
    rows.sort(key=lambda r: -r["lift"])
    top = [r for r in rows if r["closed_threads"] >= 8][:10]
    lost_common = sorted(rows, key=lambda r: r["lift"])[:5]
    lead_msgs = {o: sorted(v) for o, v in engagement.items()}
    result = {"threads": dict(n), "cutoff_source": dict(cut_how), "median_lead_messages_pre_close": {o: v[len(v) // 2] for o, v in lead_msgs.items()},
              "lost_endings": dict(ended), "all_signals": rows, "top10": top, "lost_markers": lost_common,
              "examples": {r["signal"]: [e for e in examples[r["signal"]] if e["lead"].strip()][:3] for r in top}}
    (out / "signals.json").write_text(json.dumps(result, indent=2, ensure_ascii=False))
    print(json.dumps({"threads": dict(n), "cutoff_source": dict(cut_how), "median_pre_close": result["median_lead_messages_pre_close"], "lost_endings": dict(ended), "top10": [(r["signal"], r["lift"], r["closed_rate"], r["not_closed_rate"]) for r in top],
                      "lost_markers": [(r["signal"], r["lift"]) for r in lost_common]}, ensure_ascii=False))


if __name__ == "__main__":
    {"build": build, "label": label, "report": report}[sys.argv[1]](Path(sys.argv[2]))
