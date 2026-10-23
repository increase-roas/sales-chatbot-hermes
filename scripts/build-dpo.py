"""Build chosen/rejected DPO pairs from graded sales-bot drafts.

Usage:
  python3 scripts/build-dpo.py [grades.jsonl] [out.jsonl]

Defaults:
  grades  ~/Documents/LIGHTS SALES/sft-build-20261014/grades.jsonl
  out     ~/Documents/LIGHTS SALES/sft-build-20261014/dpo/pairs.jsonl

Each grades line is one draft:
  status: approved | edited | rejected
  messages: chat context so far (optional)
  draft: what the bot wrote
  revision: what the rep wrote instead (edited, or a rejected draft that has a replacement)

edited -> chosen is the revision, rejected is the draft.
rejected -> a pair only when a revision is present. A bare rejection is not a pair.
approved -> not a pair. Nothing was rejected.

If the grades file is missing, write an empty pair file, print pairs=0, and exit 0.
This script never invents grades.
"""

import json
import sys
from pathlib import Path

DEFAULT_GRADES = Path.home() / "Documents/LIGHTS SALES/sft-build-20261014/grades.jsonl"
DEFAULT_OUT = Path.home() / "Documents/LIGHTS SALES/sft-build-20261014/dpo/pairs.jsonl"

STATUS_KEYS = ("status", "grade", "verdict", "label")
DRAFT_KEYS = ("draft", "rejected", "model", "model_output", "completion")
REVISION_KEYS = ("revision", "edited", "chosen", "final", "human", "rewrite")
CONTEXT_KEYS = ("messages", "prompt", "context")


def first(row: dict, keys: tuple[str, ...]):
    for key in keys:
        if key in row and row[key] not in (None, ""):
            return row[key]
    return None


def normalize_status(value) -> str:
    text = str(value or "").strip().lower()
    if text in {"approved", "approve", "approval"}:
        return "approved"
    if text in {"edited", "edit", "revised"}:
        return "edited"
    if text in {"rejected", "reject", "rejection"}:
        return "rejected"
    return ""


def context_messages(value) -> list[dict]:
    if not value:
        return []
    if isinstance(value, str):
        return [{"role": "user", "content": value}]
    if not isinstance(value, list):
        return []
    messages = []
    for item in value:
        if isinstance(item, str):
            messages.append({"role": "user", "content": item})
        elif isinstance(item, dict) and item.get("role") in {"system", "user", "assistant"} and str(item.get("content") or "").strip():
            messages.append({"role": item["role"], "content": str(item["content"])})
    if messages and messages[-1]["role"] == "assistant":
        messages = messages[:-1]
    return messages


def pair_from(row: dict) -> dict | None:
    status = normalize_status(first(row, STATUS_KEYS))
    draft = first(row, DRAFT_KEYS)
    revision = first(row, REVISION_KEYS)
    if status == "approved":
        return None
    if status not in {"edited", "rejected"}:
        return None
    if not isinstance(draft, str) or not draft.strip():
        return None
    if not isinstance(revision, str) or not revision.strip():
        return None
    if draft.strip() == revision.strip():
        return None
    return {
        "messages": context_messages(first(row, CONTEXT_KEYS)),
        "chosen": {"role": "assistant", "content": revision.strip()},
        "rejected": {"role": "assistant", "content": draft.strip()},
    }


def write_empty(out_path: Path, grades_path: Path, reason: str) -> int:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("")
    print(json.dumps({
        "pairs": 0,
        "grades_file": str(grades_path),
        "out": str(out_path),
        "status": reason,
    }, indent=2))
    return 0


def main(grades_path: Path, out_path: Path) -> int:
    if not grades_path.is_file():
        return write_empty(out_path, grades_path, "grades file not found")

    counts = {"approved_not_paired": 0, "paired": 0, "skipped_no_revision": 0, "skipped_bad": 0}
    lines = []
    for raw in grades_path.read_text(encoding="utf-8").splitlines():
        if not raw.strip():
            continue
        try:
            row = json.loads(raw)
        except json.JSONDecodeError:
            counts["skipped_bad"] += 1
            continue
        if not isinstance(row, dict):
            counts["skipped_bad"] += 1
            continue
        status = normalize_status(first(row, STATUS_KEYS))
        if status == "approved":
            counts["approved_not_paired"] += 1
            continue
        built = pair_from(row)
        if built is None:
            if status in {"edited", "rejected"}:
                counts["skipped_no_revision"] += 1
            else:
                counts["skipped_bad"] += 1
            continue
        lines.append(json.dumps(built, ensure_ascii=False))
        counts["paired"] += 1

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("".join(line + "\n" for line in lines))
    print(json.dumps({
        "pairs": counts["paired"],
        "grades_file": str(grades_path),
        "out": str(out_path),
        "approved_not_paired": counts["approved_not_paired"],
        "skipped_no_revision": counts["skipped_no_revision"],
        "skipped_bad": counts["skipped_bad"],
    }, indent=2))
    return 0


if __name__ == "__main__":
    grades = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_GRADES
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_OUT
    sys.exit(main(grades, out))
