"""Fireworks spend guard (Alex 2026-10-15, after the prepaid balance ran dry). Run before any paid Fireworks work.

Usage: python3 scripts/fw_guard.py            # exit 0 = OK to spend, 2 = blocked (reason printed)
       python3 scripts/fw_guard.py --status   # print today's spend and balance as JSON, never blocks

Blocks when today's (UTC) Fireworks spend has reached config/spend.json fw_daily_cap_usd, or the prepaid balance is under
fw_low_balance_usd. On a low balance it adds one item a day to Alex's queue (alex_queue.py; the Director pushes it to
his decision page). Reads billing with firectl (read-only). Never prints the API key.
Override for one run only when Alex approved the spend: FW_GUARD_OVERRIDE=<reason>.
"""

import datetime
import json
import math
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / "config/spend.json").read_text())
QUEUE = Path.home() / "Alex-Director/scripts/alex_queue.py"


def api_key() -> str:
    if os.environ.get("FIREWORKS_API_KEY"):
        return os.environ["FIREWORKS_API_KEY"]
    return next(l.split("=", 1)[1].strip().strip('"') for l in (ROOT / ".env").read_text().splitlines() if l.startswith("FIREWORKS_API_KEY="))


class BillingError(Exception):
    """Billing could not be read. The message never contains the API key or the command line."""


def firectl(*args: str) -> str:
    try:
        key = api_key()
    except (OSError, StopIteration):
        raise BillingError("no FIREWORKS_API_KEY in the environment or .env") from None
    try:
        run = subprocess.run(["firectl", "-a", os.environ.get("FIREWORKS_ACCOUNT", "abloomster"), "--api-key", key, *args], capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        raise BillingError("firectl timed out") from None  # never re-raise: the exception carries the command (and key)
    except OSError as e:
        raise BillingError(f"firectl could not run ({type(e).__name__})") from None
    out = (run.stdout + run.stderr).replace(key, "[redacted]")
    if run.returncode != 0:
        raise BillingError(f"firectl exit {run.returncode}")
    return out


def finite(value: str) -> float | None:
    try:
        x = float(value)
    except ValueError:
        return None
    return x if math.isfinite(x) and x >= 0 else None


def status() -> dict:
    day = datetime.datetime.now(datetime.timezone.utc).date()
    out = firectl("billing", "get-usage", "--start-time", day.isoformat(), "--end-time", (day + datetime.timedelta(days=1)).isoformat(), "--account-costs-only")
    row = next((l for l in out.splitlines() if l.startswith(day.isoformat())), "").split()
    # Columns: start date, start time, end date, end time, SUBTOTAL, USD, TOTAL, USD, ... -> use TOTAL.
    today = finite(row[6]) if len(row) > 6 else None
    bal = re.search(r"Balance:\s*USD\s*(\S+)", firectl("get", "account", os.environ.get("FIREWORKS_ACCOUNT", "abloomster")))
    return {"day_utc": day.isoformat(), "spent_today_usd": today, "balance_usd": finite(bal.group(1)) if bal else None,
            "daily_cap_usd": CONFIG["fw_daily_cap_usd"], "low_balance_usd": CONFIG["fw_low_balance_usd"]}


def queue_low_balance(s: dict) -> None:
    if not QUEUE.exists():
        return
    qid = f"{CONFIG['low_balance_queue_id_prefix']}-{s['day_utc']}"
    subprocess.run([sys.executable, str(QUEUE), "add", "--id", qid, "--gate", "spend",
                    "--question", f"Fireworks prepaid balance is ${s['balance_usd']:.2f} (under ${s['low_balance_usd']}). Paid bot work is paused. Add credit?",
                    "--recommended", "Add $25", "--pick", "Add $25",
                    "--why", "Keeps the live bot and testing running; the daily cap still limits spend",
                    "--source", "sales-chatbot scripts/fw_guard.py", "--actor", "Alex on fireworks.ai billing",
                    "--impact", "9"], capture_output=True, text=True, timeout=60)


def check() -> tuple[bool, str, dict]:
    try:
        s = status()
    except BillingError as e:
        return False, f"could not read Fireworks billing: {e} (fail closed)", {}
    if s["spent_today_usd"] is None or s["balance_usd"] is None:
        return False, "could not read Fireworks billing (fail closed)", s
    if s["balance_usd"] < s["low_balance_usd"]:
        queue_low_balance(s)
        return False, f"prepaid balance ${s['balance_usd']:.2f} is under ${s['low_balance_usd']}", s
    if s["spent_today_usd"] >= s["daily_cap_usd"]:
        return False, f"today's spend ${s['spent_today_usd']:.2f} reached the ${s['daily_cap_usd']} daily cap", s
    return True, "ok", s


if __name__ == "__main__":
    if "--status" in sys.argv:
        try:
            print(json.dumps(status()))
        except BillingError as e:
            print(json.dumps({"error": str(e)}))
        sys.exit(0)
    if os.environ.get("FW_GUARD_OVERRIDE"):
        print(f"fw_guard: override ({os.environ['FW_GUARD_OVERRIDE'][:80]})")
        sys.exit(0)
    ok, why, s = check()
    print(f"fw_guard: {'OK' if ok else 'BLOCKED'}: {why} | {json.dumps(s)}")
    sys.exit(0 if ok else 2)
