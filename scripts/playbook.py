"""Reverse engineer the reps' sales playbook from closed-deal SFT rows.

Usage:
  python3 scripts/playbook.py label <sft_dir> <out_dir> [model_id]   # model labels every rep reply
  python3 scripts/playbook.py report <out_dir>                        # counts -> playbook.md

<sft_dir> holds train/val/holdout .jsonl + .map.jsonl from build-sft.py (already scrubbed).
Only closed or booked deals are in that data, so this shows what winners did, not what losers did.
"""

import collections
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from eval import chat  # noqa: E402

DEFAULT_MODEL = "accounts/fireworks/models/qwen3p8-2p4t-a95b"
BATCH = 25

CUSTOMER = [
    "new_inquiry", "gave_address", "sent_photo", "asked_price", "asked_date_or_availability",
    "asked_service_question", "price_objection", "stalling_or_thinking", "needs_partner_ok",
    "accepted_or_ready", "paid_or_booked", "logistics_after_booking", "small_talk_or_thanks", "other",
]
REP = [
    "greet_and_qualify", "ask_address", "ask_photo", "ask_design_or_areas", "send_quote",
    "explain_value_or_service", "handle_objection", "offer_discount_or_deal", "follow_up_nudge",
    "propose_date", "ask_for_commitment", "send_payment_or_deposit", "confirm_booking",
    "logistics", "thanks_or_rapport", "other",
]

PROMPT = """Label each sales text exchange for a holiday-lighting company.
For each item, pick ONE customer label for the customer's last message and ONE rep label for the rep reply.

Customer labels: {customer}
Rep labels: {rep}

Return only a JSON array, one object per item, in order: [{{"i": 0, "customer": "...", "rep": "..."}}, ...]

Items:
{items}
"""


def load_rows(sft_dir: Path) -> list[dict]:
    rows = []
    for split in ("train", "val", "holdout"):
        lines = (sft_dir / f"{split}.jsonl").read_text().splitlines()
        maps = (sft_dir / f"{split}.map.jsonl").read_text().splitlines()
        for line, meta in zip(lines, maps):
            msgs = json.loads(line)["messages"]
            m = json.loads(meta)
            last_user = next((x["content"] for x in reversed(msgs[:-1]) if x["role"] == "user"), "")
            rows.append({
                "contact_id": m["contact_id"],
                "ts": m["target_timestamp"],
                "channel": m.get("channel", "text"),
                "outcome": m["outcome_category"],
                "customer": last_user[-400:],
                "rep": msgs[-1]["content"],
            })
    rows.sort(key=lambda r: (r["contact_id"], r["ts"]))
    return rows


def label_batch(model: str, batch: list[dict]) -> list[dict]:
    items = "\n".join(
        f"{i}. CUSTOMER: {json.dumps(r['customer'][-300:])}\n   REP: {json.dumps(r['rep'][:400])}" for i, r in enumerate(batch)
    )
    prompt = PROMPT.format(customer=", ".join(CUSTOMER), rep=", ".join(REP), items=items)
    for _ in range(3):
        raw = chat(model, [{"role": "user", "content": prompt}], 4000, 0.0, "none")
        match = re.search(r"\[.*\]", raw or "", re.S)
        try:
            labels = json.loads(match.group(0)) if match else []
        except json.JSONDecodeError:
            continue
        by_i = {x.get("i"): x for x in labels if isinstance(x, dict)}
        if len(by_i) >= len(batch) * 0.9:
            return [{
                **r,
                "customer_label": by_i.get(i, {}).get("customer") if by_i.get(i, {}).get("customer") in CUSTOMER else "other",
                "rep_label": by_i.get(i, {}).get("rep") if by_i.get(i, {}).get("rep") in REP else "other",
            } for i, r in enumerate(batch)]
    return [{**r, "customer_label": "unlabeled", "rep_label": "unlabeled"} for r in batch]


def label(sft_dir: Path, out_dir: Path, model: str) -> None:
    rows = load_rows(sft_dir)
    batches = [rows[i:i + BATCH] for i in range(0, len(rows), BATCH)]
    with ThreadPoolExecutor(6) as pool:
        done = [r for chunk in pool.map(lambda b: label_batch(model, b), batches) for r in chunk]
    out_dir.mkdir(parents=True, exist_ok=True)
    with open(out_dir / "labeled.jsonl", "w") as f:
        for r in done:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(json.dumps({"rows": len(done), "unlabeled": sum(r["rep_label"] == "unlabeled" for r in done)}))


def report(out_dir: Path) -> None:
    rows = [json.loads(x) for x in (out_dir / "labeled.jsonl").read_text().splitlines()]
    rows = [r for r in rows if r["rep_label"] != "unlabeled"]
    contacts = collections.defaultdict(list)
    for r in rows:
        contacts[r["contact_id"]].append(r)

    rep_counts = collections.Counter(r["rep_label"] for r in rows)
    cust_counts = collections.Counter(r["customer_label"] for r in rows)

    # Typical order: median position (0..1) of each move inside its deal.
    positions = collections.defaultdict(list)
    for msgs in contacts.values():
        n = max(len(msgs) - 1, 1)
        for k, r in enumerate(msgs):
            positions[r["rep_label"]].append(k / n)
    order = sorted(positions, key=lambda lab: sorted(positions[lab])[len(positions[lab]) // 2])

    # What reps reply to each customer situation.
    response = collections.defaultdict(collections.Counter)
    for r in rows:
        response[r["customer_label"]][r["rep_label"]] += 1

    # Progress: after this rep move, how often is the customer's NEXT message a step forward.
    forward = {"gave_address", "sent_photo", "accepted_or_ready", "paid_or_booked", "logistics_after_booking"}
    moved = collections.defaultdict(lambda: [0, 0])
    for msgs in contacts.values():
        for a, b in zip(msgs, msgs[1:]):
            moved[a["rep_label"]][1] += 1
            moved[a["rep_label"]][0] += b["customer_label"] in forward

    lengths = sorted(len(r["rep"]) for r in rows)
    lines = [
        "# How Dynamite reps actually sell (closed deals only)",
        "",
        f"{len(rows)} rep replies across {len(contacts)} closed or booked deals. Median rep text: {lengths[len(lengths) // 2]} characters.",
        "Limit: only winning deals are in this data, so it shows what winners did, not what losers did differently.",
        "",
        "## The order reps follow",
        "",
        "| Step | Move | Times used |",
        "|---|---|---|",
    ]
    lines += [f"| {i} | {lab} | {rep_counts[lab]} |" for i, lab in enumerate(order, 1) if rep_counts[lab] >= 5]
    lines += ["", "## What customers say", "", "| Customer message | Count |", "|---|---|"]
    lines += [f"| {lab} | {n} |" for lab, n in cust_counts.most_common()]
    lines += ["", "## What reps say back (top 3 replies per situation)", "", "| Customer says | Rep does |", "|---|---|"]
    for lab, _ in cust_counts.most_common():
        top = ", ".join(f"{k} ({v})" for k, v in response[lab].most_common(3))
        lines.append(f"| {lab} | {top} |")
    lines += ["", "## Which rep moves get the customer to take the next step", "",
              "| Rep move | Next customer message moves forward | Sample |", "|---|---|---|"]
    for lab, (hit, total) in sorted(moved.items(), key=lambda kv: -kv[1][0] / max(kv[1][1], 1)):
        if total >= 10:
            lines.append(f"| {lab} | {hit / total:.0%} | {total} |")
    lines += ["", "## Objection handlers (real rep replies)", ""]
    for lab in ("price_objection", "stalling_or_thinking", "needs_partner_ok"):
        examples = [r for r in rows if r["customer_label"] == lab][:6]
        lines.append(f"### {lab} ({cust_counts[lab]})")
        for r in examples:
            lines.append(f"- Customer: {r['customer'].strip()[-160:]!r}\n  - Rep: {r['rep'].strip()[:240]!r}")
        lines.append("")
    lines += ["## Most-used exact rep texts (approved-answer candidates)", ""]
    for text, n in collections.Counter(r["rep"].strip() for r in rows).most_common(15):
        if n >= 2:
            lines.append(f"- ({n}x) {text[:200]!r}")
    (out_dir / "playbook.md").write_text("\n".join(lines) + "\n")
    print(f"wrote {out_dir / 'playbook.md'}")


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "label":
        label(Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4] if len(sys.argv) > 4 else DEFAULT_MODEL)
    elif cmd == "report":
        report(Path(sys.argv[2]))
