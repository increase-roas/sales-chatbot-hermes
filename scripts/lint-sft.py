"""Pre-upload gate for SFT files built by build-sft.py.

Usage: python3 scripts/lint-sft.py <out_dir> <CONTACT-STAGE-INDEX.csv>
Exits 1 on any schema, privacy, policy or split-integrity failure.
"""

import collections
import csv
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sft_patterns import OLD_BRAND, REP_NAME  # noqa: E402

PHONE = re.compile(r"(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)")
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
URL = re.compile(r"(?:https?://|www\.)\S+", re.I)
STREET = re.compile(r"\b\d{2,6}\s+(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Rd|Road|Ave|Avenue|Dr|Drive|Ln|Lane|Ct|Court|Blvd|Way)\b")
PRICE = re.compile(r"\$\s?\d")
OFF_TOPIC = re.compile(r"garbage|trash|can cleaning|maggot|sanitation", re.I)
ALLOWED_NAME_WORDS = {"Street", "Green", "Rose", "King", "Page", "Grace", "Hope", "Mary", "Bill", "Will"}


def main(out_dir: Path, stage_csv: Path) -> int:
    names = set()
    with open(stage_csv, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            names.update(p for p in re.split(r"[\s/]+", row["Contact name"]) if len(p) >= 4 and p.isalpha())
    names -= ALLOWED_NAME_WORDS

    errors = collections.Counter()
    contacts = {}
    tokens = 0
    for split in ("train", "val", "holdout"):
        rows = [json.loads(line) for line in open(out_dir / f"{split}.jsonl")]
        maps = [json.loads(line) for line in open(out_dir / f"{split}.map.jsonl")]
        if len(rows) != len(maps):
            errors["map_count_mismatch"] += 1
        contacts[split] = {m["contact_id"] for m in maps}
        for row in rows:
            if set(row) != {"messages"}:
                errors["root_keys"] += 1
            msgs = row["messages"]
            for i, m in enumerate(msgs):
                content = m["content"]
                tokens += len(content) / 4
                if not set(m) <= {"role", "content", "weight"}:
                    errors["message_keys"] += 1
                if m["role"] == "system" and i != 0:
                    errors["system_not_first"] += 1
                if m["role"] in ("system", "user") and "weight" in m:
                    errors["weight_on_non_assistant"] += 1
                if not content.strip():
                    errors["empty_content"] += 1
                for label, pattern in (("phone", PHONE), ("email", EMAIL), ("url", URL), ("street", STREET), ("off_topic", OFF_TOPIC), ("rep_name", REP_NAME), ("old_brand", OLD_BRAND)):
                    if pattern.search(content):
                        errors[label] += 1
                if any(w in names for w in re.findall(r"\b[A-Z][a-z]{3,}\b", content)):
                    errors["contact_name"] += 1
            if msgs[-1]["role"] != "assistant" or msgs[-1].get("weight") != 1:
                errors["bad_target"] += 1
            if any(m["role"] == "assistant" and m.get("weight") != 0 for m in msgs[1:-1]):
                errors["history_weight"] += 1
            if PRICE.search(msgs[-1]["content"]):
                errors["price_in_target"] += 1

    overlap = (contacts["train"] & contacts["val"]) | (contacts["train"] & contacts["holdout"]) | (contacts["val"] & contacts["holdout"])
    if overlap:
        errors["household_overlap"] += len(overlap)

    print(json.dumps({
        "rows": {s: sum(1 for _ in open(out_dir / f"{s}.jsonl")) for s in contacts},
        "contacts": {s: len(c) for s, c in contacts.items()},
        "approx_tokens": int(tokens),
        "errors": dict(errors),
    }, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1]), Path(sys.argv[2])))
