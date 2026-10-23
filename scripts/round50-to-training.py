"""Turn Alex's YES/NO ratings from the Dynamite Reply Review page into training data.

Usage: python3 scripts/round50-to-training.py <items.jsonl> <ratings_dir> <out_dir>

<items.jsonl>  the round's items with their real rep reply (eval/round50-items.jsonl; stays on this Mac)
<ratings_dir>  ArtifactData list of collection "ratings" saved with out_dir (one <id>.json per rating)
Writes:
  sft.jsonl  YES replies as chat examples (same shape as build-sft rows, served system prompt)
  dpo.jsonl  NO replies as preference pairs: rejected = the bot reply; chosen = Alex's own better text,
             only when Alex typed a better text on the page (betterText); a NO without one is kept in
             rejected.jsonl (usable to filter or for a KTO-style signal), never paired with a guessed answer
  summary.json  counts, plus YES rate split by photo / humor / variant (what to push or pull back)
Same rule as scripts/export-grades.ts: approve -> SFT, reject -> DPO. Never invents a chosen reply.
"""

import collections
import importlib.util
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("opt", ROOT / "optimize-sft.py")
opt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(opt)


def load_ratings(ratings_dir: Path) -> dict:
    out = {}
    for p in ratings_dir.rglob("*.json"):
        doc = json.loads(p.read_text())
        data = doc.get("data", doc)
        out[doc.get("id", p.stem)] = data
    return out


def main(items_path: Path, ratings_dir: Path, out_dir: Path) -> None:
    items = {r["id"]: r for r in map(json.loads, open(items_path))}
    ratings = load_ratings(ratings_dir)
    prompt = opt.served_prompt()
    out_dir.mkdir(parents=True, exist_ok=True)
    sft, dpo, rejected = [], [], []
    split = collections.defaultdict(lambda: [0, 0])
    for rid, rating in sorted(ratings.items()):
        it = items.get(rid)
        verdict = rating.get("verdict")
        if not it or verdict not in ("yes", "no"):
            continue
        context = [{"role": m["role"], "content": m["text"]} for m in it["context"]]
        base = [{"role": "system", "content": prompt}] + context
        reply = opt.strip_dashes(it["reply"])
        for key in ["photo" if "photo" in it["tags"] else "no photo", "humor" if "humor" in it["tags"] else "no humor", it["variant"]]:
            split[key][0] += verdict == "yes"
            split[key][1] += 1
        if verdict == "yes":
            sft.append({"messages": base + [{"role": "assistant", "content": reply}], "photo": it.get("photoId", "")})
        else:
            better = (rating.get("betterText") or "").strip()
            note = (rating.get("note") or "").strip()
            if better and opt.norm(better) == opt.norm(reply):
                rejected.append({"messages": base + [{"role": "assistant", "content": reply}], "note": note, "skipped": "better text equals the bot reply"})
            elif better:
                dpo.append({
                    "input": {"messages": base},
                    "preferred_output": [{"role": "assistant", "content": opt.strip_dashes(better)}],
                    "non_preferred_output": [{"role": "assistant", "content": reply}],
                    "chosen_source": "alex_better_text",
                    "note": note,
                })
            else:
                rejected.append({"messages": base + [{"role": "assistant", "content": reply}], "note": note})
    with open(out_dir / "sft.jsonl", "w") as f:
        for r in sft:
            f.write(json.dumps({"messages": r["messages"]}, ensure_ascii=False) + "\n")
    with open(out_dir / "dpo.jsonl", "w") as f:
        for r in dpo:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    with open(out_dir / "rejected.jsonl", "w") as f:
        for r in rejected:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    summary = {"rated": len(sft) + len(dpo) + len(rejected), "yes": len(sft), "no": len(dpo) + len(rejected),
               "dpo_pairs": len(dpo), "no_without_better_text": len(rejected),
               "yes_rate_by": {k: f"{y}/{n}" for k, (y, n) in sorted(split.items())}}
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary))


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
