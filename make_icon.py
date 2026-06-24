#!/usr/bin/env python3
from PIL import Image, ImageDraw, ImageFont
import math, os

def make_icon(size):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Background rounded rect
    r = int(size * 0.22)
    bg = (26, 26, 30, 255)
    d.rounded_rectangle([0, 0, size-1, size-1], radius=r, fill=bg)

    # Outer ring
    pad = int(size * 0.08)
    stroke = max(2, int(size * 0.045))
    d.ellipse([pad, pad, size-pad, size-pad], outline=(41, 121, 255, 255), width=stroke)

    # Clock ticks
    cx, cy = size / 2, size / 2
    rad = size / 2 - pad - stroke
    for i in range(12):
        angle = math.radians(i * 30 - 90)
        inner = rad * 0.82 if i % 3 == 0 else rad * 0.88
        x1 = cx + inner * math.cos(angle)
        y1 = cy + inner * math.sin(angle)
        x2 = cx + rad * math.cos(angle)
        y2 = cy + rad * math.sin(angle)
        tick_w = max(1, int(size * 0.025)) if i % 3 == 0 else max(1, int(size * 0.015))
        color = (100, 160, 255, 200) if i % 3 == 0 else (60, 100, 180, 140)
        d.line([x1, y1, x2, y2], fill=color, width=tick_w)

    # Hour hand (pointing ~10 o'clock)
    hangle = math.radians(-60)
    hlen = rad * 0.42
    hw = max(2, int(size * 0.04))
    d.line([cx, cy, cx + hlen*math.cos(hangle), cy + hlen*math.sin(hangle)],
           fill=(255, 255, 255, 240), width=hw)

    # Minute hand (pointing ~2 o'clock)
    mangle = math.radians(60)
    mlen = rad * 0.6
    mw = max(2, int(size * 0.03))
    d.line([cx, cy, cx + mlen*math.cos(mangle), cy + mlen*math.sin(mangle)],
           fill=(41, 121, 255, 255), width=mw)

    # Center dot
    cdot = int(size * 0.06)
    d.ellipse([cx-cdot, cy-cdot, cx+cdot, cy+cdot], fill=(41, 121, 255, 255))

    return img

sizes = [16, 32, 64, 128, 256, 512, 1024]
iconset = 'src/assets/icon.iconset'
os.makedirs(iconset, exist_ok=True)

for s in sizes:
    img = make_icon(s)
    img.save(f'{iconset}/icon_{s}x{s}.png')
    if s <= 512:
        img2 = make_icon(s * 2)
        img2.save(f'{iconset}/icon_{s}x{s}@2x.png')

print('PNG files generated')
