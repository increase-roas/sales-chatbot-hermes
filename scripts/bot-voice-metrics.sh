#!/bin/zsh
# Rebuild the bot-voice evidence: dataset v3 (style), audit, and style scores on saved
# holdout generations. Free: no inference calls. Usage: scripts/bot-voice-metrics.sh <v3_dir_name>
set -euo pipefail
cd "$(dirname "$0")/.."
B="$HOME/Documents/LIGHTS SALES/sft-build-20261014"; C="$B/contact-conversations-279/CONTACT-STAGE-INDEX.csv"
E="$B/eval"; H="$B/opt-r2-20261015"; V="$B/$1"; R=reviews/bot-voice-20261015; T="${TMPDIR:-/tmp}/bot-voice"
mkdir -p "$R" "$T"
[[ -e "$V" ]] && { echo "refusing to overwrite $V"; exit 1; }
python3 scripts/optimize-sft.py build "$B/out" "$V" "$C" --style > "$R/build-stats-v3.json"
python3 scripts/optimize-sft.py audit "$V" "$C" --json "$R/audit-v3.json" > /dev/null
shasum -a 256 "$V"/*.jsonl > "$R/v3-sha256.txt"
python3 -c "
import json,sys
for i,l in enumerate(open(sys.argv[1])): print(json.dumps({'i':i,'reply':json.loads(l)['messages'][-1]['content']}))" "$B/out/holdout.jsonl" > "$T/gen-human.jsonl"
{
  python3 scripts/optimize-sft.py style "$H" "$T/gen-human.jsonl" "$B/out/holdout.map.jsonl" "$E/judge-human.jsonl"
  python3 scripts/optimize-sft.py style "$H" "$E/gen-tuned27b.jsonl" "$B/out/holdout.map.jsonl" "$E/judge-tuned27b.jsonl"
  python3 scripts/optimize-sft.py style "$H" "$E/gen-lookup5.jsonl" "$B/v2/holdout.map.jsonl" "$E/judge-lookup5.jsonl"
  python3 scripts/optimize-sft.py style "$H" "$E/gen-prod-v2.jsonl" "$B/v2/holdout.map.jsonl" "$E/judge-prod-v2.jsonl"
  python3 scripts/optimize-sft.py style "$H" "$E/gen-lookup5.jsonl" "$B/v2/holdout.map.jsonl" "$E/judge-lookup5.jsonl" --guard
  python3 scripts/optimize-sft.py style "$H" "$E/gen-tuned27b.jsonl" "$B/out/holdout.map.jsonl" "$E/judge-tuned27b.jsonl" --guard
} | python3 -c "
import json,sys
txt=sys.stdin.read(); dec=json.JSONDecoder(); i=0; out=[]
while txt[i:].strip():
    t=txt[i:].lstrip(); o,n=dec.raw_decode(t); out.append(o); i=len(txt)-len(t)+n
json.dump(out,open(sys.argv[1],'w'),indent=2)" "$R/style-baseline.json"
python3 - "$B" "$1" "$R/dataset-style-v2-vs-v3.json" <<'PY'
import collections, importlib.util, json, statistics, sys
spec = importlib.util.spec_from_file_location("o", "scripts/optimize-sft.py"); o = importlib.util.module_from_spec(spec); spec.loader.exec_module(o)
res = {}
for name in ("opt-r2-20261015", sys.argv[2]):
    for sp in ("train", "val", "holdout"):
        t = [m["content"] for l in open(f"{sys.argv[1]}/{name}/{sp}.jsonl") for m in json.loads(l)["messages"] if m["role"] == "assistant" and m.get("weight", 1) == 1]
        res[f"{name}/{sp}"] = {"targets": len(t), "dash_rate": round(sum(bool(o.DASH_PUNCT.search(x)) for x in t) / len(t), 4),
            "gpt_marker_rate": round(sum(bool(o.gpt_markers(x)) for x in t) / len(t), 4), "stiff_rate": round(sum(bool(o.STIFF.search(x)) for x in t) / len(t), 4),
            "median_chars": statistics.median(len(x) for x in t), "markers": dict(collections.Counter(h for x in t for h in o.gpt_markers(x)))}
json.dump(res, open(sys.argv[3], "w"), indent=2)
PY
echo done
