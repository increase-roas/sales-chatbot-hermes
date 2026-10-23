"""Make the send-safe Dynamite photo library from Alex's originals (originals untouched).

Usage: python3 scripts/process-photos.py <bot-photos dir>
Reads <dir>/inbox, writes <dir>/library/*.jpg (house numbers and plates blurred, max 1200px,
JPEG q80 to stay under MMS size limits). Boxes are in original-image pixels.
"""

import sys
from pathlib import Path

from PIL import Image, ImageFilter

# (file, out name, blur boxes x0,y0,x1,y1)
JOBS = [
    ("alex-upload-01.webp", "dyn-rooftop-install-01.jpg", [(120, 230, 300, 310), (300, 240, 460, 312)]),
    ("alex-upload-02.webp", "dyn-warmwhite-brick-colonial-02.jpg", [(1370, 690, 1460, 745)]),
    ("alex-upload-03.webp", "dyn-warmwhite-roofline-bushes-03.jpg", [(460, 825, 575, 855)]),
    ("alex-upload-04.webp", "dyn-multicolor-roofline-columns-04.jpg", [(1280, 900, 1500, 1110)]),
    ("alex-upload-07.webp", "dyn-rooftop-install-07.jpg", [(410, 175, 620, 250), (640, 470, 730, 555), (110, 230, 320, 300), (360, 260, 560, 325)]),
    ("alex-upload-08.webp", "dyn-redgreen-roofline-uplights-08.jpg", [(1070, 490, 1160, 530), (40, 440, 110, 485), (575, 450, 640, 495)]),
    ("alex-upload-09.webp", "dyn-red-roofline-09.jpg", [(1090, 1020, 1270, 1110)]),
    ("alex-upload-10.webp", "dyn-warmwhite-modern-white-brick-10.jpg", [(190, 890, 270, 930), (1360, 950, 1500, 1030)]),
    ("alex-upload-11.webp", "dyn-warmwhite-garage-outline-11.jpg", [(195, 890, 270, 925)]),
    # Rapport photos (Alex 2026-10-15). 13: blur the old company's phone number on the trailer.
    ("alex-upload-12-manny-colombia-wife.jpg", "dyn-rapport-manny-colombia-12.jpg", []),
    ("alex-upload-13-manny-tv-channel4-natural-sanitation.webp", "dyn-rapport-manny-channel4-13.jpg", [(300, 430, 600, 560)]),
    # 14 is the same rooftop scene as 07 (smaller copy); same vehicle blurs, scaled.
    ("alex-upload-14-rooftop-high.jpg", "dyn-rooftop-high-14.jpg", [(280, 120, 423, 171), (437, 321, 499, 379), (75, 157, 219, 205), (246, 178, 382, 222)]),
]


def main(root: Path) -> None:
    out = root / "library"
    out.mkdir(exist_ok=True)
    for src, name, boxes in JOBS:
        im = Image.open(root / "inbox" / src).convert("RGB")
        for box in boxes:
            region = im.crop(box).filter(ImageFilter.GaussianBlur(14)).filter(ImageFilter.BoxBlur(10))
            im.paste(region, box)
        im.thumbnail((1200, 1200))
        im.save(out / name, quality=80, optimize=True)
        print(name, im.size, (out / name).stat().st_size)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
