"""Minimal Fireworks REST helper that reads FIREWORKS_API_KEY from .env and never prints it.

Usage:
  python3 scripts/fw.py get <path>
  python3 scripts/fw.py post <path> '<json body>'
  python3 scripts/fw.py upload <dataset_id> <file.jsonl>
  python3 scripts/fw.py chat '<json body>'

<path> is relative to https://api.fireworks.ai/v1/accounts/$FIREWORKS_ACCOUNT (default abloomster).
"""

import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def api_key() -> str:
    if os.environ.get("FIREWORKS_API_KEY"):
        return os.environ["FIREWORKS_API_KEY"]
    for line in (ROOT / ".env").read_text().splitlines():
        if line.startswith("FIREWORKS_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit("FIREWORKS_API_KEY not found")


_GUARD_OK_AT = 0.0
GUARD_TTL_S = 600  # re-check billing every 10 minutes, so a long run stops once it crosses the cap or threshold
FREE_POSTS = ("/datasets",)  # dataset create/upload is free; every other POST to Fireworks may bill (jobs, inference, DPO, deployments)


def spend_guard() -> None:
    """Before paid calls (re-checked every 10 min): config/spend.json daily cap and low-balance hold (fw_guard.py)."""
    global _GUARD_OK_AT
    import time  # noqa: PLC0415

    if time.time() - _GUARD_OK_AT < GUARD_TTL_S:
        return
    import fw_guard  # noqa: PLC0415 - same folder; imported lazily so read-only helpers never touch billing

    if not os.environ.get("FW_GUARD_OVERRIDE"):
        ok, why, _ = fw_guard.check()
        if not ok:
            raise SystemExit(f"fw_guard: BLOCKED: {why}. Paid Fireworks work is on hold (config/spend.json).")
    _GUARD_OK_AT = time.time()


def request(method: str, url: str, body: bytes | None = None, content_type: str = "application/json") -> dict:
    if method == "POST" and "fireworks.ai" in url and not any(p in url for p in FREE_POSTS):
        spend_guard()
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Authorization", f"Bearer {api_key()}")
    if body is not None:
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        return {"http_error": err.code, "body": err.read().decode(errors="replace")[:2000]}


def base() -> str:
    return f"https://api.fireworks.ai/v1/accounts/{os.environ.get('FIREWORKS_ACCOUNT', 'abloomster')}"


def upload(dataset_id: str, path: str) -> dict:
    data = Path(path).read_bytes()
    count = sum(1 for line in data.splitlines() if line.strip())
    created = request("POST", f"{base()}/datasets", json.dumps({
        "datasetId": dataset_id,
        "dataset": {"userUploaded": {}, "exampleCount": str(count)},
    }).encode())
    if "http_error" in created and created["http_error"] != 409:
        return {"create": created}
    boundary = uuid.uuid4().hex
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{Path(path).name}\"\r\n"
        f"Content-Type: application/jsonl\r\n\r\n"
    ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
    uploaded = request("POST", f"{base()}/datasets/{dataset_id}:upload", body, f"multipart/form-data; boundary={boundary}")
    return {"create": created.get("name", created), "upload": uploaded, "examples": count}


def main() -> None:
    cmd = sys.argv[1]
    if cmd == "get":
        out = request("GET", f"{base()}/{sys.argv[2]}")
    elif cmd == "post":
        out = request("POST", f"{base()}/{sys.argv[2]}", sys.argv[3].encode())
    elif cmd == "upload":
        out = upload(sys.argv[2], sys.argv[3])
    elif cmd == "chat":
        out = request("POST", "https://api.fireworks.ai/inference/v1/chat/completions", sys.argv[2].encode())
    else:
        raise SystemExit(__doc__)
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
