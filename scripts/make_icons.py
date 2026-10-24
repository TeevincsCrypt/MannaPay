"""Render the MannaPay toolbar icons (rounded PayPal-blue square with a white "M")."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "icons"
BLUE = (0, 112, 186, 255)
GOLD = (255, 196, 57, 255)


def render(size: int) -> Image.Image:
    scale = 8  # supersample for smooth edges
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=BLUE)
    # "M" drawn as a polyline so it needs no font.
    w = s * 0.11
    left, right = s * 0.24, s * 0.76
    top, bottom = s * 0.28, s * 0.70
    mid = s / 2
    d.line([(left, bottom), (left, top), (mid, s * 0.54), (right, top), (right, bottom)],
           fill=(255, 255, 255, 255), width=int(w), joint="curve")
    # Gold dot: the "one click".
    r = s * 0.075
    cx, cy = s * 0.5, s * 0.80
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GOLD)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for size in (16, 32, 48, 128):
        render(size).save(OUT / f"icon-{size}.png")
        print(f"wrote icons/icon-{size}.png")
