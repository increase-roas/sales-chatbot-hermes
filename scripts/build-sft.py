"""Build Fireworks SFT JSONL from the Dynamite Lights GHL export.

Usage: python3 scripts/build-sft.py <export_dir> <out_dir>

<export_dir> holds MESSAGES.jsonl and CONTACT-STAGE-INDEX.csv (contact-conversations-279).
Writes train.jsonl / val.jsonl / holdout.jsonl plus *.map.jsonl lineage files. The map
files carry source IDs and must never be uploaded.
"""

import collections
import csv
import hashlib
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sft_patterns import OLD_BRAND, REP_NAMES  # noqa: E402

SYSTEM_PROMPT = (
    "You are a sales rep for Dynamite Lights, texting a Michigan homeowner about professional "
    "holiday lighting (install, take-down, storage). Reply like a real person: short, warm, specific, "
    "one question at a time. Never state a price, discount, deposit or install date unless it was "
    "already given to you in this conversation; instead ask for the next quote detail (address, "
    "photo of the front of the house, which areas they want lit). When they are ready, move them "
    "to the next step."
)

# Positive outcomes only. The 153 "2025 purchase status unknown" contacts are
# absence of proof, not losses, and are not labeled or trained. CRM-SOLD-only
# (purchase unverified) stays out too.
INCLUDED_BUCKETS = {
    "Purchase evidence confirmed — 2025",
    "Purchase evidence confirmed — 2026; 2025 unknown",
    "Accepted/booked — payment/install unverified",
}
BOOKED_BUCKET = "Accepted/booked — payment/install unverified"
TEXT_TYPES = {"TYPE_SMS", "TYPE_FACEBOOK"}
CALL_TYPES = {"TYPE_CALL", "TYPE_CUSTOM_CALL"}
MAX_TURNS = 12
MAX_TARGET_CHARS = 600
TEMPLATE_MIN_CONTACTS = 3

FAKE_NAMES = [
    "Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Avery", "Quinn", "Parker",
    "Reese", "Drew", "Hayden", "Rowan", "Skyler", "Emerson", "Finley", "Logan", "Sawyer", "Blake",
]

PHONE = re.compile(r"(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)")
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
URL = re.compile(r"(?:https?://|www\.)\S+", re.I)
STREET = re.compile(
    r"\b\d{2,6}\s+(?:[NSEW]\.?\s+)?(?:[A-Z][a-z]+\s+){1,3}"
    r"(?:St|Street|Rd|Road|Ave|Avenue|Dr|Drive|Ln|Lane|Ct|Court|Blvd|Way|Cir|Circle|Pl|Place|Trl|Trail|Pkwy|Hwy)\b\.?",
)
ZIP = re.compile(r"\b4[89]\d{3}\b")
PRICE = re.compile(r"\$\s?\d|\b\d{2,5}(?:\.\d{2})?\s?(?:dollars|bucks)\b", re.I)
SIGNATURE = re.compile(r"^\s*-\s*\w+,\s*Owner of .*$", re.M)

OFF_TOPIC = re.compile(r"garbage|trash|\bbins?\b|can cleaning|odor|maggot|sanitation|power ?wash|pressure ?wash", re.I)
REP_PERSONA = "Sam"
STAFF_ALT = "|".join(re.escape(name) for name in REP_NAMES)
SELF_ID = re.compile(rf"\b(?:this is|it'?s|i'?m|i am)\s+(?:{STAFF_ALT})\b", re.I)
COMPANY_ID = re.compile(
    r"\b(?:with|from)\s+(?:(?:natural|national|nigro|nigra|mattress)\s+sanitation"
    r"|dynamite(?:\s+lights)?|christmas light company)\b",
    re.I,
)
MACHINE = re.compile(
    r"at the tone|record your message|stay on the line|leave (?:a |your )?message|press \d",
    re.I,
)
MIXED_SPEAKERS = re.compile(
    r"\b(?:doing good|i['’]?m doing|i am doing|yes hi|what(?:'|’)?s your name|\byeah\b)\b",
    re.I,
)
REP_CONTINUATION = re.compile(
    r"^(?:how are you|how you doing|i was just|i just|i['’]?m just|i am just|"
    r"we(?:'re| are| will| can)|so[, ]|just calling|i did|i wanted|i apologize)\b",
    re.I,
)
CUSTOMER_REPLY = re.compile(
    r"^(?:doing good|i['’]?m |i am |good|yes|yeah|no|okay|ok|oh|thanks|thank)\b",
    re.I,
)
CUSTOMER_TURN = re.compile(
    r"^(?:yes(?:[,.]?\s+hi\b.{0,40})?|yeah|yep|hello\??|hi[.!?]?|hey[.!?]?|"
    r"who(?:'s| is) (?:this|that)\??|where are you calling from\??|"
    r"okay|ok|good morning|good evening|speaking)[.!?]*$",
    re.I,
)
GREETING_NAME = re.compile(
    r"\b(Hi|Hey|Hello|Thanks|Thank you|Morning|Good morning|Good afternoon|Good evening|Sorry|Apologize for the late reply|delay)(,?\s+)([A-Z][a-z]{2,})\b"
)
NOT_NAMES = {
    "There", "Again", "Team", "Everyone", "All", "Sir", "Maam", "Man", "Just", "Again", "Good", "Thanks",
    "Thank", "The", "This", "That", "Dynamite", "Sam", "Got", "Yes", "Okay", "Great", "Happy", "Merry",
    "Hope", "Its", "It", "We", "You", "Your", "Our", "For", "And", "Friend", "Neighbor",
}
COMMON_WORDS = {
    "holiday", "lights", "lighting", "home", "house", "christmas", "white", "warm", "thanks", "thank",
    "great", "perfect", "sounds", "good", "okay", "will", "have", "what", "that", "this", "there", "with",
    "your", "when", "just", "like", "know", "time", "front", "back", "green", "star", "street", "rose",
    "may", "june", "april", "grace", "hope", "joy", "faith", "mary", "bill", "will", "page", "king",
}


def split_for(contact_id: str) -> str:
    """One contact, one split. Contacts do not share a customer phone, so this is household-disjoint."""
    bucket = int(hashlib.sha256(contact_id.encode()).hexdigest(), 16) % 10
    return "holdout" if bucket == 0 else "val" if bucket == 1 else "train"


def stamp_seconds(stamp: str) -> float:
    try:
        clock, ms = stamp.replace(".", ",").split(",")
        hours, minutes, seconds = clock.split(":")
        return int(hours) * 3600 + int(minutes) * 60 + int(seconds) + int(ms) / 1000
    except (AttributeError, ValueError):
        return 0.0


def shift_iso(date_utc: str, seconds: float) -> str:
    try:
        dt = datetime.fromisoformat(date_utc.replace("Z", "+00:00")) + timedelta(seconds=max(0.0, seconds))
    except ValueError:
        return date_utc
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def is_rep_segment(text: str) -> bool:
    """True when this whisper segment is the rep speaking, not both sides of the call."""
    text = text.strip()
    if not (40 <= len(text) <= 220):
        return False
    if MACHINE.search(text) or MIXED_SPEAKERS.search(text):
        return False
    if len(re.findall(r"\b(?:hi|hey|hello)\b", text, re.I)) >= 3:
        return False
    if len(re.findall(r"\bthis is\b", text, re.I)) > 1:
        return False
    if re.search(r"\bmy name is\b|\bmiss\b|\byep\b|\byes\b", text, re.I):
        return False
    return bool(SELF_ID.search(text) or COMPANY_ID.search(text))


def rep_call_messages(message: dict) -> list[dict]:
    """Rep utterances that can be training targets. Unlabeled two-party audio is skipped."""
    if message.get("direction") != "outbound" or message.get("message_type") not in CALL_TYPES:
        return []
    segments = (message.get("call_content") or {}).get("transcript_segments") or []
    if not segments:
        return []
    synthetic = []
    seen = 0
    for index, segment in enumerate(segments):
        text = (segment.get("text") or "").strip()
        if not is_rep_segment(text):
            continue
        nxt = (segments[index + 1].get("text") or "").strip() if index + 1 < len(segments) else ""
        if nxt and MACHINE.search(nxt):
            continue
        parts = [text]
        if (
            nxt
            and REP_CONTINUATION.search(nxt)
            and not CUSTOMER_REPLY.search(nxt)
            and not MIXED_SPEAKERS.search(nxt)
            and not MACHINE.search(nxt)
            and len(nxt) < 300
            and len(text) + len(nxt) < 500
        ):
            parts.append(nxt)
        prev = (segments[index - 1].get("text") or "").strip() if index else ""
        start = stamp_seconds(segment.get("start") or "")
        if prev and len(prev) <= 80 and CUSTOMER_TURN.match(prev) and not MACHINE.search(prev):
            prev_start = stamp_seconds(segments[index - 1].get("start") or "")
            synthetic.append({
                "lead_name": message.get("lead_name", ""),
                "contact_id": message["contact_id"],
                "conversation_id": message.get("conversation_id"),
                "message_id": f"{message['message_id']}#u{seen}",
                "date_utc": shift_iso(message["date_utc"], prev_start),
                "direction": "inbound",
                "message_type": "TYPE_CALL_TURN",
                "body": prev,
                "channel": "call",
            })
        synthetic.append({
            "lead_name": message.get("lead_name", ""),
            "contact_id": message["contact_id"],
            "conversation_id": message.get("conversation_id"),
            "message_id": f"{message['message_id']}#r{seen}",
            "date_utc": shift_iso(message["date_utc"], start),
            "direction": "outbound",
            "message_type": "TYPE_CALL_TURN",
            "body": " ".join(parts),
            "channel": "call",
        })
        seen += 1
    return synthetic


def off_topic(raw: str) -> bool:
    """Old brand mentions are a rename, not the garbage-can business."""
    return bool(OFF_TOPIC.search(OLD_BRAND.sub(" ", raw)))


def scrub(text: str, names: dict[str, str], known_first: set[str], known_last: set[str], known_handles: set[str]) -> str:
    text = SIGNATURE.sub("", text)
    text = OLD_BRAND.sub("Dynamite Lights", text)
    text = re.sub(r"(?:Dynamite Lights[\s,]*){2,}", "Dynamite Lights ", text)
    text = URL.sub("[link]", text)
    text = EMAIL.sub("[email]", text)
    text = PHONE.sub("[phone]", text)
    text = STREET.sub("[address]", text)
    text = ZIP.sub("[zip]", text)
    fake = next((v for v in names.values() if v), FAKE_NAMES[0])
    for real, sub in names.items():
        text = re.sub(rf"\b{re.escape(real)}\b", sub, text, flags=re.I)
    for handle in known_handles:
        text = re.sub(rf"\b{re.escape(handle)}\b", "", text, flags=re.I)
    for rep in REP_NAMES:
        text = re.sub(rf"\b{re.escape(rep)}\b", REP_PERSONA, text, flags=re.I)
    text = GREETING_NAME.sub(lambda m: m.group(0) if m.group(3) in NOT_NAMES or m.group(3) in FAKE_NAMES else f"{m.group(1)}{m.group(2)}{fake}", text)

    def known(m: re.Match) -> str:
        word = m.group(0)
        if word in FAKE_NAMES or word == REP_PERSONA:
            return word
        low = word.lower()
        if low in known_last:
            return ""
        if low in known_first:
            return fake
        return word

    text = re.sub(r"\b[A-Z][a-z]{2,}\b", known, text)
    skip_lower = {n.lower() for n in FAKE_NAMES} | {REP_PERSONA.lower()}
    for low in known_first:
        if low in skip_lower or len(low) < 3:
            continue
        text = re.sub(rf"\b{re.escape(low)}s?\b", fake, text, flags=re.I)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def known_names(stage_csv: Path) -> tuple[set[str], set[str]]:
    first, last = set(), set()
    with open(stage_csv, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            parts = [p.lower() for p in re.split(r"[\s/]+", row["Contact name"]) if len(p) >= 3 and p.isalpha()]
            if parts:
                first.add(parts[0])
                last.update(parts[1:])
    staff = {n.lower() for n in REP_NAMES}
    first -= COMMON_WORDS | staff
    last -= COMMON_WORDS | first | staff
    return first, last


def name_tokens(raw: str) -> list[str]:
    tokens = []
    for part in re.split(r"[\s/]+", raw or ""):
        if len(part) >= 3 and re.search(r"[A-Za-z]", part) and part not in tokens:
            tokens.append(part)
    return tokens


def name_map(lead_name: str, contact_name: str, contact_id: str) -> dict[str, str]:
    tokens = name_tokens(contact_name)
    for part in name_tokens(lead_name):
        if part not in tokens:
            tokens.append(part)
    alpha = [p for p in tokens if p.isalpha()]
    handles = [p for p in tokens if not p.isalpha()]
    if not alpha and not handles:
        return {}
    fake = FAKE_NAMES[int(hashlib.sha256(contact_id.encode()).hexdigest(), 16) % len(FAKE_NAMES)]
    mapping = {}
    if alpha:
        mapping[alpha[0]] = fake
        for extra in alpha[1:]:
            mapping.setdefault(extra, "")
    for handle in handles:
        mapping[handle] = ""
    return mapping


def main(export_dir: Path, out_dir: Path) -> None:
    stage = {}
    contact_names = {}
    with open(export_dir / "CONTACT-STAGE-INDEX.csv", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            stage[row["Contact ID"]] = row["Strongest lifecycle evidence bucket"]
            contact_names[row["Contact ID"]] = row["Contact name"]
    included = {cid for cid, bucket in stage.items() if bucket in INCLUDED_BUCKETS}
    booked = {cid for cid, bucket in stage.items() if bucket == BOOKED_BUCKET}
    known_first, known_last = known_names(export_dir / "CONTACT-STAGE-INDEX.csv")

    by_contact = collections.defaultdict(list)
    call_utterances = 0
    known_handles = set()
    with open(export_dir / "MESSAGES.jsonl") as f:
        for line in f:
            m = json.loads(line)
            if m["contact_id"] not in included:
                continue
            for part in name_tokens(m.get("lead_name") or ""):
                if any(ch.isdigit() for ch in part):
                    known_handles.add(part)
            if m["message_type"] in TEXT_TYPES and (m.get("body") or "").strip():
                m["channel"] = "text"
                by_contact[m["contact_id"]].append(m)
            else:
                spoken = rep_call_messages(m)
                call_utterances += sum("#r" in item["message_id"] for item in spoken)
                by_contact[m["contact_id"]].extend(spoken)

    outbound_seen = collections.defaultdict(set)
    for cid, msgs in by_contact.items():
        for m in msgs:
            if m["direction"] == "outbound":
                outbound_seen[m["body"].strip()].add(cid)
    templates = {body for body, cids in outbound_seen.items() if len(cids) >= TEMPLATE_MIN_CONTACTS}

    out_dir.mkdir(parents=True, exist_ok=True)
    files = {s: open(out_dir / f"{s}.jsonl", "w") for s in ("train", "val", "holdout")}
    maps = {s: open(out_dir / f"{s}.map.jsonl", "w") for s in ("train", "val", "holdout")}
    stats = collections.Counter()
    households = {s: set() for s in ("train", "val", "holdout")}
    booked_households = {s: set() for s in ("train", "val", "holdout")}

    for cid, msgs in sorted(by_contact.items()):
        msgs.sort(key=lambda m: m["date_utc"])
        names = name_map(msgs[0].get("lead_name", ""), contact_names.get(cid, ""), cid)
        turns = []
        for m in msgs:
            role = "user" if m["direction"] == "inbound" else "assistant"
            raw = m["body"].strip()
            text = scrub(raw, names, known_first, known_last, known_handles)
            if not text:
                continue
            entry = {
                "role": role,
                "text": text,
                "raw": raw,
                "id": m["message_id"],
                "ts": m["date_utc"],
                "channel": m.get("channel") or "text",
            }
            if turns and turns[-1]["role"] == role and turns[-1].get("channel") == entry["channel"]:
                turns[-1]["text"] += "\n" + text
                turns[-1]["raw"] += "\n" + raw
                turns[-1]["ids"].append(m["message_id"])
            else:
                entry["ids"] = [m["message_id"]]
                turns.append(entry)

        split = split_for(cid)
        for i, turn in enumerate(turns):
            if turn["role"] != "assistant" or i == 0 or turns[i - 1]["role"] != "user":
                continue
            stats["candidates"] += 1
            if any(part.strip() in templates for part in turn["raw"].split("\n")):
                stats["drop_template"] += 1
                continue
            if PRICE.search(turn["raw"]):
                stats["drop_price"] += 1
                continue
            if URL.search(turn["raw"]) or len(turn["text"]) > MAX_TARGET_CHARS:
                stats["drop_link_or_long"] += 1
                continue
            window = turns[max(0, i - MAX_TURNS + 1): i + 1]
            off = [j for j, t in enumerate(window) if off_topic(t["raw"])]
            if off and (off[-1] >= len(window) - 2):
                stats["drop_off_topic"] += 1
                continue
            if off:
                window = window[off[-1] + 1:]
                stats["trimmed_off_topic_history"] += 1
            messages = [{"role": "system", "content": SYSTEM_PROMPT}]
            for t in window[:-1]:
                msg = {"role": t["role"], "content": PRICE.sub("[price]", t["text"]) if t["role"] == "assistant" else t["text"]}
                if t["role"] == "assistant":
                    msg["weight"] = 0
                messages.append(msg)
            messages.append({"role": "assistant", "content": turn["text"], "weight": 1})
            line = json.dumps({"messages": messages}, ensure_ascii=False)
            files[split].write(line + "\n")
            from_call = any("#r" in mid for mid in turn["ids"])
            maps[split].write(json.dumps({
                "contact_id": cid,
                "target_message_ids": turn["ids"],
                "target_timestamp": turn["ts"],
                "split": split,
                "outcome_category": stage[cid],
                "channel": "call" if from_call else "text",
                "line_sha256": hashlib.sha256(line.encode()).hexdigest(),
                "human_reviewed": False,
            }) + "\n")
            stats[f"kept_{split}"] += 1
            if from_call:
                stats[f"kept_call_{split}"] += 1
            households[split].add(cid)
            if cid in booked:
                stats[f"kept_booked_{split}"] += 1
                booked_households[split].add(cid)

    for f in [*files.values(), *maps.values()]:
        f.close()
    stats["included_contacts"] = len(included)
    stats["booked_contacts"] = len(booked)
    stats["unknown_contacts_excluded"] = sum(1 for bucket in stage.values() if bucket == "2025 purchase status unknown")
    stats["contacts_with_text"] = len(by_contact)
    stats["call_rep_utterances"] = call_utterances
    stats["template_bodies"] = len(templates)
    for split_name, cids in households.items():
        stats[f"households_{split_name}"] = len(cids)
        stats[f"booked_households_{split_name}"] = len(booked_households[split_name])
    print(json.dumps(dict(stats), indent=2))


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
