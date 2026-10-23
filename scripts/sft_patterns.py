"""Patterns shared by build-sft.py (scrubs) and lint-sft.py (checks the scrub held).

Edit here only, so the linter always checks for exactly what the builder removes.
"""

import re

# Reps and crew heard on calls or in texts. Replaced with the Sam persona.
# Alex is intentionally absent: it is also a stand-in customer name.
REP_NAMES = (
    "Eddie", "Eddy", "Kevin", "Manny", "Chris", "Chirs", "Josh",
    "Brenden", "Brendan", "Brennan", "Brandon", "Bernard", "Bernie",
    "Ralph", "Eric", "Sarah",
)
REP_NAME = re.compile(rf"\b({'|'.join(re.escape(name) for name in REP_NAMES)})\b", re.I)

# The old company name and its transcription misspellings.
OLD_BRAND = re.compile(
    r"(?:natural|national|nigro|nigra|mattress)\s+sanitation"
    r"(?:\s+(?:and\s+)?(?:holiday|harley)\s+\w+)?"
    r"|natural penetration"
    r"|christmas light company"
    r"|harley lighting"
    r"|holiday liding"
    r"|national annotation(?:\s+holiday\s+\w+)?",
    re.I,
)
