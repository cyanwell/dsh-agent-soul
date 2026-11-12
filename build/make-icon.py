
import math, struct, sys, os, io
from PIL import Image, ImageDraw, ImageFilter

ASSETS = r"D:\AI\agent-soul\build\assets"

def lerp(a, b, t): return a + (b - a) * t
def mix(c1, c2, t): return tuple(int(round(lerp(c1[i], c2[i], t))) for i in range(len(c1)))

def bez(p0, p1, p2, p3, n):
    pts = []
    for i in range(n + 1):
        t = i / n; mt = 1.0 - t
        pts.append((mt**3*p0[0] + 3*mt*mt*t*p1[0] + 3*mt*t*t*p2[0] + t**3*p3[0],
                    mt**3*p0[1] + 3*mt*mt*t*p1[1] + 3*mt*t*t*p2[1] + t**3*p3[1]))
    return pts

TAIL = (44, 112, 240)
HEAD = (140, 226, 255)
BG_TOP = (11, 20, 36)
BG_BOT = (24, 40, 64)

def render(size, ss):
    S = size * ss
    grad = Image.new("RGB", (1, S))
    for y in range(S):
        grad.putpixel((0, y), mix(BG_TOP, BG_BOT, y / max(1, S - 1)))
    bg = grad.resize((S, S)).convert("RGBA")
    haze = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    hd = ImageDraw.Draw(haze)
    hx, hy, hr = int(0.68 * S), int(0.38 * S), int(0.40 * S)
    for i in range(18, 0, -1):
        rr = int(hr * i / 18.0)
        hd.ellipse([hx - rr, hy - rr, hx + rr, hy + rr], fill=(46, 120, 235, int(2 + 12 * (1 - i / 18.0))))
    haze = haze.filter(ImageFilter.GaussianBlur(max(1, S * 0.06)))
    bg = Image.alpha_composite(bg, haze)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(bg, (0, 0), mask)

    p0, p1, p2, p3 = (0.25, 0.71), (0.35, 0.30), (0.57, 0.17), (0.77, 0.33)
    n = 300
    pts = [(x * S, y * S) for (x, y) in bez(p0, p1, p2, p3, n)]
    width = max(2.0 * ss, size * 0.070 * ss)
    w = width / 2.0
    bead_r = size * 0.072 * ss

    # glow (tight, keeps the small sizes crisp)
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for i in range(0, n + 1, 2):
        px, py = pts[i]
        r = w * 1.8
        gd.ellipse([px - r, py - r, px + r, py + r], fill=(56, 132, 255, 70))
    r = bead_r * 1.7
    gd.ellipse([pts[-1][0] - r, pts[-1][1] - r, pts[-1][0] + r, pts[-1][1] + r], fill=(120, 214, 255, 140))
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.020 * ss))
    img = Image.alpha_composite(img, glow)

    # arc body: overlapping discs -> smooth stroke, colour ramp along the path
    arc = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ad = ImageDraw.Draw(arc)
    for i in range(0, n + 1):
        t = i / float(n)
        px, py = pts[i]
        c = mix(TAIL, HEAD, t ** 0.8)
        a = int(lerp(205, 255, t ** 0.5))
        ww = w * (0.80 + 0.42 * t)          # 轻微收尖：尾细头粗，像一道扫过去的极光
        ad.ellipse([px - ww, py - ww, px + ww, py + ww], fill=c + (a,))
    img = Image.alpha_composite(img, arc)

    # glass bead: body + rim + specular
    bead = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bead)
    cx, cy = pts[-1]
    steps = 18
    for i in range(steps, 0, -1):
        t = i / float(steps)
        rr = bead_r * t
        c = mix((132, 214, 250), (246, 253, 255), (1.0 - t) ** 1.4)
        bd.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=c + (255,))
    bd.ellipse([cx - bead_r, cy - bead_r, cx + bead_r, cy + bead_r],
               outline=(46, 132, 196, 190), width=max(1, int(0.9 * ss)))
    hr = bead_r * 0.36
    bd.ellipse([cx - hr * 1.15, cy - hr * 1.65, cx + hr * 0.75, cy + hr * 0.25], fill=(255, 255, 255, 245))
    img = Image.alpha_composite(img, bead)

    if size >= 48:
        rim = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        ImageDraw.Draw(rim).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22),
                                              outline=(104, 164, 232, 46), width=max(1, int(ss * 0.8)))
        img = Image.alpha_composite(img, rim)

    return img.resize((size, size), Image.LANCZOS)

def dib(img):
    w, h = img.size
    header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    px = img.convert("RGBA").tobytes()
    rows = []
    for y in range(h - 1, -1, -1):
        row = px[y * w * 4:(y + 1) * w * 4]
        b = bytearray()
        for x in range(w):
            r, g, bl, a = row[x * 4:x * 4 + 4]
            b += bytes((bl, g, r, a))
        rows.append(bytes(b))
    xor = b"".join(rows)
    stride = ((w + 31) // 32) * 4
    return header + xor + b"\x00" * (stride * h)

def write_ico(path, images):
    blobs = []
    for size, im in images:
        if size >= 256:
            buf = io.BytesIO(); im.save(buf, format="PNG", optimize=True); data = buf.getvalue()
        else:
            data = dib(im)
        blobs.append((size, data))
    offset = 6 + 16 * len(blobs)
    out = [struct.pack("<HHH", 0, 1, len(blobs))]
    dirs = []
    for size, data in blobs:
        v = 0 if size >= 256 else size
        dirs.append(struct.pack("<BBBBHHII", v, v, 0, 0, 1, 32, len(data), offset))
        offset += len(data)
    with open(path, "wb") as f:
        f.write(out[0] + b"".join(dirs) + b"".join(d for _, d in blobs))

def sheet(imgs, path):
    W, H = 1000, 660
    im = Image.new("RGB", (W, H), (14, 16, 20))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, 86], fill=(22, 26, 33))
    d.text((24, 24), "AgentSoul app icon - multi-size proof", fill=(214, 228, 244))
    d.text((24, 46), "16 / 32 / 48 / 256 px, plus 16px at 8x for legibility check", fill=(138, 154, 176))
    d.rectangle([0, 86, W, 366], fill=(26, 30, 38))
    d.text((24, 96), "on dark taskbar (#1A1E26)", fill=(150, 168, 188))
    d.rectangle([0, 366, W, H], fill=(232, 236, 242))
    d.text((24, 376), "on light background", fill=(58, 70, 88))
    for ytop, light in ((112, False), (392, True)):
        x = 32
        for size in (16, 32, 48):
            tile = imgs[size]
            im.paste(tile, (x, ytop + 40), tile)
            d.text((x, ytop + 100), str(size) + "px", fill=(60, 72, 90) if light else (150, 168, 188))
            x += 110
        big = imgs[16].resize((16 * 8, 16 * 8), Image.NEAREST)
        im.paste(big, (380, ytop + 4), big)
        d.text((380, ytop + 140), "16px x8 (nearest)", fill=(60, 72, 90) if light else (150, 168, 188))
        im.paste(imgs[256], (560, ytop), imgs[256])
        d.text((560, ytop + 262), "256px", fill=(60, 72, 90) if light else (150, 168, 188))
    im.save(path, "PNG")

os.makedirs(ASSETS, exist_ok=True)
imgs = {}
for size, ss in ((16, 10), (32, 8), (48, 6), (256, 4)):
    imgs[size] = render(size, ss)
    imgs[size].save(os.path.join(ASSETS, "agentsoul-%d.png" % size))
write_ico(os.path.join(ASSETS, "agentsoul.ico"), [(s, imgs[s]) for s in (16, 32, 48, 256)])
sheet(imgs, os.path.join(ASSETS, "_preview.png"))
print("ico", os.path.getsize(os.path.join(ASSETS, "agentsoul.ico")))
chk = Image.open(os.path.join(ASSETS, "agentsoul.ico"))
print("ico sizes", sorted(chk.info.get("sizes", [])))
