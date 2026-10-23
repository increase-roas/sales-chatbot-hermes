"""Audit and optimize a built Dynamite Lights SFT set (train/val/holdout + *.map.jsonl).

Usage:
  python3 scripts/optimize-sft.py audit <dir> <CONTACT-STAGE-INDEX.csv> [--json out.json]
  python3 scripts/optimize-sft.py build <in_dir> <out_dir> <CONTACT-STAGE-INDEX.csv>
  python3 scripts/optimize-sft.py table <audit-before.json> <audit-after.json>   (markdown table)
  python3 scripts/optimize-sft.py build <in_dir> <out_dir> <csv> --style   (v3: served prompt, no dashes, no stiff replies)
  python3 scripts/optimize-sft.py style <holdout_dir> <gen.jsonl> <gen_holdout_map.jsonl> [judge.jsonl] [--guard]
  python3 scripts/optimize-sft.py selftest                                  (dash cases shared with guard.ts)

`build` never writes into <in_dir>. Reports carry counts only, never message text,
so they are safe to share. The *.map.jsonl lineage files stay on this Mac.

What `build` changes (see reviews/dataset-audit-20261015.md for why):
  1. Repairs "[price]50"-style redaction fragments left in history.
  2. Redacts residual PII in history (phones, emails, URLs, street addresses,
     known contact names, rep names) and drops rows whose TARGET has any.
  3. Unweights train targets that match a val/holdout target exactly, by (last user
     turn, target) pair, or as a near-duplicate (5-char shingle Jaccard >= 0.8), and exact duplicate rows inside each split.
  4. Caps any one normalized target text at MAX_SAME_TARGET rows per split.
  5. Turns low-information targets ("ok", "thank you!", emoji) into weight 0
     context instead of training targets; rows left with no target are dropped.
  6. Merges a contact's overlapping prefix rows in train into one multi-target
     conversation (Fireworks per-message weight 0/1), so shared history is
     trained once instead of up to 10 times. val/holdout stay one target per row
     so per-reply evaluation is unchanged.
  7. Unweights later within-train near-duplicate targets and removes eval rows
     whose reply appears verbatim in train or in the other eval split.
"""

import collections
import csv
import hashlib
import json
import re
import statistics
import sys
from pathlib import Path

SPLITS = ("train", "val", "holdout")
MAX_SAME_TARGET = 3
MIN_TARGET_WORDS = 3

PHONE = re.compile(r"(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)")
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
URL = re.compile(r"(?:https?://|www\.)\S+", re.I)
STREET = re.compile(
    r"\b\d{2,6}\s+(?:[NSEW]\.?\s+)?(?:[A-Z][a-z]+\s+){1,3}"
    r"(?:St|Street|Rd|Road|Ave|Avenue|Dr|Drive|Ln|Lane|Ct|Court|Blvd|Way|Cir|Circle|Pl|Place|Trl|Trail|Pkwy|Hwy)\b\.?"
)
STREET_CI = re.compile(
    r"\b\d{2,6}\s+(?:[nsew]\.?\s+)?(?:[a-z]+\s+){1,3}"
    r"(?:st|street|rd|road|ave|avenue|dr|drive|ln|lane|ct|court|blvd|way|cir|circle|pl|place|trl|trail|pkwy|hwy)\b",
    re.I,
)
NOT_STREET = re.compile(r"\b(?:each|per|for|and)\b", re.I)
# Lowercase words that collide with contact surnames but are ordinary English here.
NAME_CI_ALLOW = {"rush", "bush", "cane", "com", "trust"}
SECRET = re.compile(
    r"\b(?:sk-[A-Za-z0-9_-]{16,}|fw_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}"
    r"|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})"
    r"|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|passcode|api[_ ]?key|secret|token)\s*[:=]\s*\S{4,}"
    r"|\b(?:\d[ -]?){13,16}\b",
    re.I,
)
PRICE_TARGET = re.compile(r"\$\s?\d|\b\d{2,5}(?:\.\d{2})?\s?(?:dollars|bucks)\b", re.I)
PRICE_FRAGMENT = re.compile(r"\[price\][\d,]*(?:\.\d+)?k?", re.I)
REP_NAMES = (
    "Eddie", "Eddy", "Kevin", "Manny", "Chris", "Chirs", "Josh", "Brenden", "Brendan", "Brennan",
    "Brandon", "Bernard", "Bernie", "Ralph", "Eric", "Sarah",
)
REP_NAME = re.compile(rf"\b(?:{'|'.join(REP_NAMES)})\b", re.I)
NAME_ALLOW = {"Street", "Green", "Rose", "King", "Page", "Grace", "Hope", "Mary", "Bill", "Will", "Star", "June",
              "April", "Joy", "Faith", "May", "Sam", "Dynamite", "Christmas", "Holiday", "White", "Light", "Lights",
              "Thank", "Thanks", "Good", "Great", "Perfect", "Sounds", "Hello", "Happy", "Merry", "Front", "Back",
              "Warm", "Just", "Okay", "Sure", "Yes", "Hope", "Have", "Will", "This", "That", "What", "When", "With"}
# Stand-in names build-sft.py already swapped in for customers; not real PII.
FAKE_NAMES = {"Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Avery", "Quinn", "Parker",
              "Reese", "Drew", "Hayden", "Rowan", "Skyler", "Emerson", "Finley", "Logan", "Sawyer", "Blake"}
TOPICS = {
    "quote_details": re.compile(r"address|photo|picture|pic\b|front of (?:the|your) house|which areas|roofline|measure", re.I),
    "scheduling": re.compile(r"\b(?:schedule|install(?:ation)?|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|time|date|call you)\b", re.I),
    "price_objection": re.compile(r"budget|expensive|price|cost|afford|cheaper|discount|deal", re.I),
    "design_colors": re.compile(r"colou?r|warm white|multi|red|green|blue|tree|bush|greenery|wreath|garland", re.I),
    "service_issue": re.compile(r"not (?:on|working)|out\b|broke|fix|plug|timer|take ?down|remove|storage", re.I),
    "payment_contract": re.compile(r"invoice|deposit|pay|contract|sign|card|check\b", re.I),
}
LOW_INFO = re.compile(r"^[\W_]*(?:ok(?:ay)?|k|thanks?(?: you)?(?: so much)?|ty|yes|yep|no|sure|perfect|great|awesome|sounds good|will do|got it|you too|np|no problem)[\W_]*$", re.I)


ROOT = Path(__file__).resolve().parent.parent
DASH_CASES = ROOT / "tests" / "dash-cases.json"
SERVED_PROMPT_FILE = ROOT / "src" / "mastra" / "agents" / "sales-agent.ts"


DASHES = "\u2012\u2013\u2014\u2015\u2e3a\u2e3b\ufe58\ufe63\uff0d"


def strip_dashes(text: str) -> str:
    """Python twin of stripDashes in src/mastra/guard.ts; both pass tests/dash-cases.json."""
    out = []
    for line in text.split("\n"):
        line = re.sub(rf"(\d)\s*[{DASHES}]\s*(\d)", r"\1-\2", line)
        line = re.sub(rf"^\s*(?:[-{DASHES}]+|\u2022)\s*", "", line)
        line = re.sub(rf"\s*(?:[{DASHES}]+|\s-{{1,2}}|-{{2,}})\s*$", "", line)
        line = re.sub(rf"\s*(?:[{DASHES}]+|\s-{{1,2}}(?=\s)|-{{2,}}|(?<=\S)-\s|\s-(?=\S))\s*", ", ", line)
        line = re.sub(r"([,.!?;:])\s*,\s*", r"\1 ", line)
        line = re.sub(r"\s+([,.!?])", r"\1", line)
        line = re.sub(r"^,\s*", "", line)
        out.append(line.rstrip())
    return "\n".join(out)


def served_prompt() -> str:
    src = SERVED_PROMPT_FILE.read_text()
    m = re.search(r"export const SALES_INSTRUCTIONS = `(.*?)`", src, re.S)
    if not m:
        raise SystemExit("SALES_INSTRUCTIONS not found in sales-agent.ts")
    return m.group(1)


DASH_PUNCT = re.compile(rf"[{DASHES}]|\s-{{1,2}}\s|^\s*-\s|\s-{{1,2}}$|-{{2,}}|(?<=\S)-\s|\s-(?=\S)", re.M)
# Fixed "sounds like ChatGPT" checklist. Changing it changes every score; add, don't edit.
GPT_MARKERS = {
    "dash_punctuation": DASH_PUNCT,
    "happy_to_help": re.compile(r"\b(?:i'?d be (?:happy|glad|delighted) to|happy to help|i'?d love to help)\b", re.I),
    "list_lines": re.compile(r"^\s*(?:[-*\u2022]|\d+[.)])\s+\S", re.M),
    "markdown": re.compile(r"\*\*|^#{1,6}\s", re.M),
    "filler_opener": re.compile(r"^(?:great question|absolutely|certainly|of course)\b", re.I),
    "dont_hesitate": re.compile(r"don'?t hesitate|feel free to|let me know if you have any (?:other |further )?questions", re.I),
    "formal_opener_closer": re.compile(r"thank you for reaching out|i hope this (?:message )?finds you|kind(?:ly| regards)|best regards|sincerely|at your earliest convenience", re.I),
    "semicolon": re.compile(r";"),
    "title_case": None,
}
# Light humor markers (Alex 2026-10-15: "should have humor too"). The judge check is scripts/judge-humor.py.
HUMOR = re.compile(r"\b(lol|haha|ladder|frozen|freez|frostbite|cold fingers|snow|shovel|neighbou?rs?|jealous|winter|brr)\b|\U0001F602|\U0001F976|\u26c4", re.I)
STIFF = re.compile(
    r"thank you for reaching out|i hope this (?:message )?finds you|kind(?:ly| regards)|best regards|sincerely|"
    r"at your earliest convenience|don'?t hesitate|please feel free|i would be (?:happy|glad|delighted)|"
    r"we appreciate your (?:business|patience|interest)|should you have any|please be advised|dear\b",
    re.I,
)


def gpt_markers(text: str) -> list:
    hits = [k for k, p in GPT_MARKERS.items() if p is not None and p.search(text)]
    words = re.findall(r"[A-Za-z][A-Za-z']*", text)
    if len(words) >= 5 and sum(w[0].isupper() for w in words) / len(words) >= 0.6:
        hits.append("title_case")
    return hits


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", "", text.lower())).strip()


def toks(text: str) -> int:
    return max(1, round(len(text) / 4))  # chars/4 estimate; no Qwen tokenizer installed here


def load(d: Path, split: str):
    rows = [json.loads(line) for line in open(d / f"{split}.jsonl")]
    maps = [json.loads(line) for line in open(d / f"{split}.map.jsonl")]
    return rows, maps


def contact_names(stage_csv: Path) -> set:
    names = set()
    with open(stage_csv, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            names.update(p for p in re.split(r"[\s/,.]+", row["Contact name"]) if len(p) >= 3 and p.isalpha())
    return {n.capitalize() for n in names} - NAME_ALLOW - FAKE_NAMES


def pii_hits(text: str, names: set) -> collections.Counter:
    hits = collections.Counter()
    for label, pat in (("phone", PHONE), ("email", EMAIL), ("url", URL), ("street", STREET), ("rep_name", REP_NAME)):
        hits[label] += len(pat.findall(text))
    hits["contact_name"] += sum(1 for w in re.findall(r"\b[A-Z][a-z]{2,}\b", text) if w in names)
    hits["price_fragment"] += len(re.findall(r"\[price\]\d", text))
    hits["secret_or_card_pattern"] += len(SECRET.findall(text))
    hits.update(pii_candidates(text, names))
    return +hits


def pii_candidates(text: str, names: set) -> collections.Counter:
    """Looser, case-insensitive screen. Candidates for local review, not proven PII."""
    c = collections.Counter()
    lower = {n.lower() for n in names}
    c["name_candidate_ci"] += sum(1 for w in re.findall(r"\b[a-z]{3,}\b", text.lower()) if w in lower and w not in NAME_CI_ALLOW)
    c["street_candidate_ci"] += sum(1 for x in STREET_CI.findall(text) if not NOT_STREET.search(x))
    return +c


def targets(row):
    return [m for m in row["messages"] if m["role"] == "assistant" and m.get("weight", 1) == 1]


def last_user_before(msgs, idx):
    for j in range(idx - 1, -1, -1):
        if msgs[j]["role"] == "user":
            return msgs[j]["content"]
    return ""


def shingles(text: str, k: int = 5) -> set:
    t = norm(text)
    return {t[i:i + k] for i in range(max(1, len(t) - k + 1))}


def near_pairs(texts) -> int:
    items = [shingles(t) for t in texts if len(t.split()) >= 5]
    n = 0
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            a, b = items[i], items[j]
            if len(a & b) / len(a | b) >= 0.8:
                n += 1
    return n


def audit(d: Path, stage_csv: Path) -> dict:
    names = contact_names(stage_csv)
    report = {"dir": str(d), "splits": {}}
    target_sets = {}
    contact_sets = {}
    for split in SPLITS:
        rows, maps = load(d, split)
        s = collections.Counter()
        pii = collections.Counter()
        pii_target = collections.Counter()
        cand = collections.Counter()
        sys_prompts = collections.Counter()
        tgt_len, row_tok, n_msgs = [], [], []
        target_texts = collections.Counter()
        pair_texts = collections.Counter()
        topics = collections.Counter()
        low_info = 0
        for row in rows:
            msgs = row["messages"]
            s["rows"] += 1
            if set(row) - {"messages", "weight"}:
                s["schema_bad_root_keys"] += 1
            roles = [m["role"] for m in msgs]
            if "system" in roles[1:]:
                s["schema_system_not_first"] += 1
            if any(set(m) - {"role", "content", "weight"} for m in msgs):
                s["schema_bad_message_keys"] += 1
            if any(m["role"] != "assistant" and "weight" in m for m in msgs):
                s["schema_weight_on_non_assistant"] += 1
            if any(not (m["content"] or "").strip() for m in msgs):
                s["schema_empty_content"] += 1
            convo = [r for r in roles if r != "system"]
            if any(a == b for a, b in zip(convo, convo[1:])):
                s["multiturn_non_alternating"] += 1
            if convo and convo[0] != "user":
                s["multiturn_starts_with_assistant"] += 1
            if roles[0] == "system":
                sys_prompts[hashlib.sha256(msgs[0]["content"].encode()).hexdigest()[:12]] += 1
            n_msgs.append(len(convo))
            row_tok.append(sum(toks(m["content"]) for m in msgs))
            for i, m in enumerate(msgs):
                h = pii_hits(m["content"], names)
                pii.update(h)
                cand.update(pii_candidates(m["content"], names))
                if m["role"] == "assistant" and m.get("weight", 1) == 1:
                    pii_target.update(h)
                    s["targets"] += 1
                    tgt_len.append(toks(m["content"]))
                    target_texts[norm(m["content"])] += 1
                    pair_texts[(norm(last_user_before(msgs, i)), norm(m["content"]))] += 1
                    if LOW_INFO.match(m["content"].strip()) or len(m["content"].split()) < MIN_TARGET_WORDS:
                        low_info += 1
                    ctx = last_user_before(msgs, i) + " " + m["content"]
                    hit = [t for t, p in TOPICS.items() if p.search(ctx)]
                    topics.update(hit or ["other"])
        # prefix overlap: rows whose history is a strict prefix of another row of the same contact
        by_contact = collections.defaultdict(list)
        for row, mp in zip(rows, maps):
            by_contact[mp["contact_id"]].append(row)
        overlap = 0
        for crs in by_contact.values():
            keys = [tuple(m["content"] for m in r["messages"]) for r in crs]
            for a in keys:
                if any(len(b) > len(a) and b[:len(a) - 1] == a[:-1] for b in keys):
                    overlap += 1
        dup_rows = sum(c - 1 for c in collections.Counter(json.dumps(r, sort_keys=True) for r in rows).values() if c > 1)
        dup_targets = sum(c - 1 for c in target_texts.values() if c > 1)
        top_target_share = max(target_texts.values()) / max(1, s["targets"])
        q = statistics.quantiles(tgt_len, n=100) if len(tgt_len) > 2 else [0] * 99
        rq = statistics.quantiles(row_tok, n=100) if len(row_tok) > 2 else [0] * 99
        report["splits"][split] = {
            **s,
            "contacts": len(by_contact),
            "system_prompt_variants": len(sys_prompts),
            "rows_without_system": s["rows"] - sum(sys_prompts.values()),
            "exact_duplicate_rows": dup_rows,
            "duplicate_target_texts": dup_targets,
            "duplicate_user_target_pairs": sum(c - 1 for c in pair_texts.values() if c > 1),
            "top_single_target_share": round(top_target_share, 4),
            "rows_sharing_prefix_with_longer_row": overlap,
            "low_info_targets": low_info,
            "pii_hits_all_messages": dict(pii),
            "pii_hits_in_targets": dict(pii_target),
            "pii_candidates_case_insensitive_all_messages": dict(cand),
            "near_duplicate_target_pairs_within_split_jaccard_ge_0.8": near_pairs(list(target_texts)),
            "target_tokens_p50_p95_p99_max": [q[49], q[94], q[98], max(tgt_len or [0])],
            "row_tokens_p50_p95_max": [rq[49], rq[94], max(row_tok or [0])],
            "row_tokens_total_est": sum(row_tok),
            "target_length_outliers_gt_p99": sum(1 for x in tgt_len if x > q[98]),
            "turns_per_row_hist": dict(sorted(collections.Counter(n_msgs).items())),
            "topics": dict(topics.most_common()),
            "outcome_category": dict(collections.Counter(m["outcome_category"] for m in maps)),
        }
        target_sets[split] = target_texts
        contact_sets[split] = set(by_contact)
    leak = {}
    for other in ("val", "holdout"):
        shared = set(target_sets["train"]) & set(target_sets[other])
        leak[f"train_{other}_shared_target_texts"] = len(shared)
        leak[f"train_{other}_shared_targets_ge5_words"] = sum(1 for t in shared if len(t.split()) >= 5)
        leak[f"train_{other}_shared_contacts"] = len(contact_sets["train"] & contact_sets[other])
        tr = [shingles(t) for t in target_sets["train"] if len(t.split()) >= 5]
        near = 0
        for t in target_sets[other]:
            if len(t.split()) < 5 or t in target_sets["train"]:
                continue
            sh = shingles(t)
            if any(len(sh & x) / len(sh | x) >= 0.8 for x in tr):
                near += 1
        leak[f"{other}_targets_near_dup_of_train_jaccard_ge_0.8"] = near
    contexts = {}
    for split in SPLITS:
        rows, _ = load(d, split)
        contexts[split] = "\n".join(norm(m["content"]) for r in rows for m in r["messages"] if m["role"] != "system")
    for a_split, b_split in (("train", "val"), ("train", "holdout"), ("val", "holdout"), ("holdout", "val")):
        long_targets = [t for t in target_sets[b_split] if len(t.split()) >= 5]
        leak[f"{b_split}_targets_ge5_words_found_anywhere_in_{a_split}_context"] = sum(1 for t in long_targets if t in contexts[a_split])
    leak["val_holdout_shared_contacts"] = len(contact_sets["val"] & contact_sets["holdout"])
    leak["val_holdout_shared_target_texts"] = len(set(target_sets["val"]) & set(target_sets["holdout"]))
    report["leakage"] = leak
    return report


def redact(text: str, names: set) -> str:
    text = PRICE_FRAGMENT.sub("[price]", text)
    text = EMAIL.sub("[email]", text)
    text = URL.sub("[link]", text)
    text = PHONE.sub("[phone]", text)
    text = STREET.sub("[address]", text)
    text = STREET_CI.sub(lambda m: m.group(0) if NOT_STREET.search(m.group(0)) else "[address]", text)
    text = SECRET.sub("[redacted]", text)
    text = REP_NAME.sub("Sam", text)
    lower = {n.lower() for n in names} - NAME_CI_ALLOW
    return re.sub(r"\b[A-Za-z]{3,}\b", lambda m: "[name]" if m.group(0).lower() in lower and (m.group(0) in names or m.group(0).islower()) else m.group(0), text)


def clean_row(row, names, stats):
    msgs = [dict(m) for m in row["messages"]]
    for m in msgs:
        is_target = m["role"] == "assistant" and m.get("weight", 1) == 1
        if is_target:
            if pii_hits(m["content"], names) or PRICE_TARGET.search(m["content"]):
                m["weight"] = 0
                stats["target_unweighted_pii_or_price"] += 1
            elif LOW_INFO.match(m["content"].strip()) or len(m["content"].split()) < MIN_TARGET_WORDS:
                m["weight"] = 0
                stats["target_unweighted_low_info"] += 1
        new = redact(m["content"], names)
        if new != m["content"]:
            stats["history_messages_redacted"] += 1
            m["content"] = new
    return {"messages": msgs}


def merge_prefixes(rows, maps):
    """Fold a contact's rows into the longest row whose history starts with them."""
    out = []
    by_contact = collections.defaultdict(list)
    for row, mp in zip(rows, maps):
        by_contact[mp["contact_id"]].append((row, mp))
    for cid in by_contact:
        items = sorted(by_contact[cid], key=lambda x: (x[1]["target_timestamp"], len(x[0]["messages"])))
        cur, cur_map = None, None
        for row, mp in items:
            msgs = row["messages"]
            if cur is not None and len(msgs) > len(cur) and all(
                a["role"] == b["role"] and a["content"] == b["content"] for a, b in zip(cur, msgs)
            ):
                merged = [dict(m) for m in msgs]
                for i, m in enumerate(cur):
                    if m["role"] == "assistant":
                        merged[i]["weight"] = max(m.get("weight", 0), merged[i].get("weight", 0))
                cur = merged
                cur_map["target_message_ids"] = cur_map["target_message_ids"] + mp["target_message_ids"]
                cur_map["merged_rows"] += 1
                continue
            if cur is not None:
                out.append((cur, cur_map))
            cur = [dict(m) for m in msgs]
            cur_map = {**mp, "merged_rows": 1}
        if cur is not None:
            out.append((cur, cur_map))
    return [({"messages": r}, m) for r, m in out]


# Buyer signals (scripts/buyer-signals.py, close-date cut, 2026-10-15): closed leads kept texting (median 13 texts
# before the sale) and lost ones sent 2, mostly going quiet after the rep's text. Replies to a buying signal that
# close the conversation down instead of asking the next easy question teach the wrong move: weight 0.
BUY_SIGNAL = re.compile(
    r"\bwhen\b.*\b(install|come|start|put|available)|how soon|before (thanksgiving|christmas)|garage|bushes|trees?\b|"
    r"looks (great|good|awesome)|love (it|the)|deposit|payment|invoice|take ?down|timer|storage|last year|neighbor|how much|quote",
    re.I,
)
DEAD_END = re.compile(r"^(ok(ay)?|sounds good|perfect|great|awesome|thanks?|thank you)[.! ]*$|let me know|have a (great|good|nice)|talk soon|no problem", re.I)


def dead_end_reply(text: str) -> bool:
    return "?" not in text and bool(DEAD_END.search(text.strip()))


def apply_style(rows_maps, stats):
    prompt = served_prompt()
    out = []
    for row, mp in rows_maps:
        msgs = [dict(m) for m in row["messages"]]
        if msgs and msgs[0]["role"] == "system":
            msgs[0]["content"] = prompt
        for m in msgs:
            if m["role"] != "assistant":
                continue
            if DASH_PUNCT.search(m["content"]):
                stats["assistant_dashes_normalized"] += 1
            m["content"] = strip_dashes(m["content"])
            if m.get("weight", 1) == 1 and STIFF.search(m["content"]):
                m["weight"] = 0
                stats["target_unweighted_stiff"] += 1
        for i, m in enumerate(msgs):
            if m["role"] != "assistant" or m.get("weight", 1) != 1:
                continue
            lead = last_user_before(msgs, i)
            if lead and BUY_SIGNAL.search(lead):
                if dead_end_reply(m["content"]):
                    m["weight"] = 0
                    stats["target_unweighted_dead_end_after_signal"] += 1
                else:
                    stats["target_kept_signal_reply"] += 1
        row = {"messages": msgs}
        if targets(row):
            out.append((row, mp))
        else:
            stats["drop_no_target_left"] += 1
    return out


def build(in_dir: Path, out_dir: Path, stage_csv: Path, style: bool = False) -> dict:
    if out_dir.resolve() == in_dir.resolve():
        raise SystemExit("refusing to write into the source directory")
    names = contact_names(stage_csv)
    stats = {s: collections.Counter() for s in SPLITS}
    data = {}
    for split in SPLITS:
        rows, maps = load(in_dir, split)
        kept, seen_rows, per_target = [], set(), collections.Counter()
        for row, mp in zip(rows, maps):
            st = stats[split]
            st["in_rows"] += 1
            row = clean_row(row, names, st)
            key = json.dumps(row, sort_keys=True)
            if key in seen_rows:
                st["drop_exact_duplicate"] += 1
                continue
            seen_rows.add(key)
            tg = targets(row)
            if tg and per_target[norm(tg[-1]["content"])] >= MAX_SAME_TARGET:
                tg[-1]["weight"] = 0
                st["target_unweighted_over_cap"] += 1
                tg = targets(row)
            if tg:
                per_target[norm(tg[-1]["content"])] += 1
            if not tg:
                st["drop_no_target_left"] += 1
                continue
            kept.append((row, mp))
        data[split] = kept
    eval_targets = {norm(m["content"]) for s in ("val", "holdout") for r, _ in data[s] for m in targets(r)}
    eval_pairs = set()
    for s in ("val", "holdout"):
        for r, _ in data[s]:
            msgs = r["messages"]
            for i, m in enumerate(msgs):
                if m["role"] == "assistant" and m.get("weight", 1) == 1:
                    eval_pairs.add((norm(last_user_before(msgs, i)), norm(m["content"])))
    eval_shingles = [shingles(t) for t in eval_targets if len(t.split()) >= 5]

    def near_eval(t):
        if len(t.split()) < 5:
            return False
        sh = shingles(t)
        return any(len(sh & x) / len(sh | x) >= 0.8 for x in eval_shingles)

    train = []
    for r, mp in data["train"]:
        msgs = r["messages"]
        for i, m in enumerate(msgs):
            if m["role"] == "assistant" and m.get("weight", 1) == 1:
                t = norm(m["content"])
                if (t in eval_targets and len(t.split()) >= MIN_TARGET_WORDS) or (norm(last_user_before(msgs, i)), t) in eval_pairs or near_eval(t):
                    m["weight"] = 0
                    stats["train"]["target_unweighted_eval_leak"] += 1
        if targets(r):
            train.append((r, mp))
        else:
            stats["train"]["drop_no_target_left"] += 1
    # Within-train near-duplicates: keep the first, unweight later ones.
    kept_sh = []
    for r, _ in train:
        for m in targets(r):
            t = norm(m["content"])
            if len(t.split()) < 5:
                continue
            sh = shingles(t)
            if any(len(sh & x) / len(sh | x) >= 0.8 for x in kept_sh):
                m["weight"] = 0
                stats["train"]["target_unweighted_near_duplicate"] += 1
            else:
                kept_sh.append(sh)
    train = [(r, mp) for r, mp in train if targets(r)]
    # Eval purity: an eval reply that appears verbatim anywhere in train (any
    # message, any weight) or in the other eval split is removed from eval.
    train_ctx = "\n".join(norm(m["content"]) for r, _ in train for m in r["messages"] if m["role"] != "system")
    val_ctx = "\n".join(norm(m["content"]) for r, _ in data["val"] for m in r["messages"] if m["role"] != "system")
    hold_t = {norm(m["content"]) for r, _ in data["holdout"] for m in targets(r)}
    for split, other_ctx in (("val", None), ("holdout", val_ctx)):
        keep = []
        for r, mp in data[split]:
            t = norm(targets(r)[-1]["content"])
            exposed = len(t.split()) >= 5 and (t in train_ctx or (other_ctx and t in other_ctx))
            if exposed or (split == "val" and t in hold_t):
                stats[split]["drop_eval_exposed"] += 1
                continue
            keep.append((r, mp))
        data[split] = keep
    if style:
        train = apply_style(train, stats["train"])
        for split in ("val", "holdout"):
            data[split] = apply_style(data[split], stats[split])
    before = len(train)
    data["train"] = merge_prefixes([r for r, _ in train], [m for _, m in train])
    stats["train"]["merged_prefix_rows_folded"] = before - len(data["train"])
    out_dir.mkdir(parents=True, exist_ok=True)
    for split in SPLITS:
        with open(out_dir / f"{split}.jsonl", "w") as f, open(out_dir / f"{split}.map.jsonl", "w") as fm:
            for r, mp in data[split]:
                line = json.dumps(r, ensure_ascii=False)
                f.write(line + "\n")
                fm.write(json.dumps({**mp, "line_sha256": hashlib.sha256(line.encode()).hexdigest()}) + "\n")
        stats[split]["out_rows"] = len(data[split])
    return {s: dict(c) for s, c in stats.items()}


def table(a: dict, b: dict) -> str:
    lines = ["| Split | Metric | Before | After |", "|---|---|---|---|"]
    skip = {"topics", "outcome_category", "turns_per_row_hist"}
    for split in SPLITS:
        for k, v in a["splits"][split].items():
            if k in skip:
                continue
            lines.append(f"| {split} | {k} | {json.dumps(v, ensure_ascii=False)} | {json.dumps(b['splits'][split].get(k), ensure_ascii=False)} |")
    for k in sorted(set(a["leakage"]) | set(b["leakage"])):
        lines.append(f"| all | {k} | {a['leakage'].get(k)} | {b['leakage'].get(k)} |")
    return "\n".join(lines)


def style_report(holdout_dir: Path, gen_path: Path, gen_map: Path, judge_path, guard: bool) -> dict:
    """Score saved generations on the rows of <holdout_dir>/holdout.jsonl, matched by target message IDs."""
    hold = load(holdout_dir, "holdout")
    keep = {tuple(mp["target_message_ids"]): r for r, mp in zip(*hold)}
    gen_ids = [tuple(json.loads(line)["target_message_ids"]) for line in open(gen_map)]
    gens = {int(g["i"]): g["reply"] for g in map(json.loads, open(gen_path))}
    judged = {int(j["i"]): j for j in map(json.loads, open(judge_path))} if judge_path else {}
    rows = []
    for i, ids in enumerate(gen_ids):
        if ids in keep and i in gens:
            reply = strip_dashes(gens[i]) if guard else gens[i]
            human = keep[ids]["messages"][-1]["content"]
            rows.append((reply, human, judged.get(i)))
    marker_counts = collections.Counter()
    with_marker = 0
    for reply, _, _ in rows:
        hits = gpt_markers(reply)
        marker_counts.update(hits)
        with_marker += bool(hits)
    n = len(rows)
    lens = [len(r) for r, _, _ in rows]
    hl = [len(h) for _, h, _ in rows]
    js = [j for _, _, j in rows if j and isinstance(j.get("overall"), (int, float))]
    return {
        "gen": gen_path.name, "guard_applied": guard, "rows_scored": n,
        "dash_rate": round(sum(bool(DASH_PUNCT.search(r)) for r, _, _ in rows) / max(1, n), 4),
        "gpt_marker_rate": round(with_marker / max(1, n), 4),
        "gpt_markers": dict(marker_counts.most_common()),
        "humor_marker_rate": round(sum(bool(HUMOR.search(r)) for r, _, _ in rows) / max(1, n), 4),
        "median_chars": statistics.median(lens) if lens else None,
        "human_median_chars": statistics.median(hl) if hl else None,
        "length_ratio_vs_human": round(statistics.median(lens) / statistics.median(hl), 2) if lens else None,
        "judge_rows": len(js),
        "judge_overall_mean": round(statistics.mean(j["overall"] for j in js), 3) if js else None,
        "judge_tone_mean": round(statistics.mean(j["tone"] for j in js), 3) if js else None,
    }


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "audit":
        rep = audit(Path(sys.argv[2]), Path(sys.argv[3]))
        if "--json" in sys.argv:
            Path(sys.argv[sys.argv.index("--json") + 1]).write_text(json.dumps(rep, indent=2))
        print(json.dumps(rep, indent=2))
    elif cmd == "build":
        print(json.dumps(build(Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]), "--style" in sys.argv), indent=2))
    elif cmd == "style":
        args = [a for a in sys.argv[2:] if not a.startswith("--")]
        judge = Path(args[3]) if len(args) > 3 else None
        print(json.dumps(style_report(Path(args[0]), Path(args[1]), Path(args[2]), judge, "--guard" in sys.argv), indent=2))
    elif cmd == "selftest":
        cases = json.loads(DASH_CASES.read_text())
        bad = [(a, strip_dashes(a), b) for a, b in cases if strip_dashes(a) != b]
        print(json.dumps({"cases": len(cases), "failures": bad}, ensure_ascii=False))
        sys.exit(1 if bad else 0)
    elif cmd == "table":
        print(table(json.loads(Path(sys.argv[2]).read_text()), json.loads(Path(sys.argv[3]).read_text())))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
