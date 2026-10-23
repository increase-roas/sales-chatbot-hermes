"""Read today's Fireworks billing (read-only) for the spend ledger. Never prints the API key.

Usage: python3 scripts/fw-billing.py [YYYY-MM-DD]   (UTC day; default today)
Prints the raw firectl account-cost table and per-model usage, with a UTC read timestamp.
"""

import datetime
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
key = next(line.split("=", 1)[1].strip().strip('"') for line in (ROOT / ".env").read_text().splitlines() if line.startswith("FIREWORKS_API_KEY="))
day = sys.argv[1] if len(sys.argv) > 1 else datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
end = (datetime.date.fromisoformat(day) + datetime.timedelta(days=1)).isoformat()
print("read_at_utc", datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
for extra in (["--account-costs-only"], ["--usage-type", "all", "--group-by", "model_name"]):
    run = subprocess.run(["firectl", "-a", "abloomster", "--api-key", key, "billing", "get-usage", "--start-time", day, "--end-time", end, *extra],
                         capture_output=True, text=True, timeout=120)
    print((run.stdout + run.stderr).replace(key, "[redacted]"))
