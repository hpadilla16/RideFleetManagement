from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
LOGO_PATH = ROOT / "frontend" / "public" / "ride-logo.png"
ANDROID_RES = ROOT / "frontend" / "android" / "app" / "src" / "main" / "res"
IOS_ASSETS = ROOT / "frontend" / "ios" / "App" / "App" / "Assets.xcassets"

PURPLE_A = (105, 67, 241)
PURPLE_B = (126, 79, 247)
PURPLE_DARK = (73, 48, 166)
SURFACE = (248, 245, 255)
TEXT = (45, 44, 68)
WHITE = (255, 255, 255)


def load_logo():
    return Image.open(LOGO_PATH).convert("RGBA")


def white_to_alpha(img):
    img = img.convert("RGBA")
    result = []
    for r, g, b, a in img.getdata():
        whiteness = min(r, g, b)
        alpha = 255 - whiteness
        if alpha < 20:
            result.append((0, 0, 0, 0))
            continue
        result.append((r, g, b, alpha))
    clean = Image.new("RGBA", img.size)
    clean.putdata(result)
    bbox = clean.getbbox()
    return clean.crop(bbox) if bbox else clean


def crop_symbol(logo):
    symbol = logo.crop((0, 0, 650, logo.height))
    return white_to_alpha(symbol)


def crop_lockup(logo):
    return white_to_alpha(logo)


def vertical_gradient(size, top_color, bottom_color):
    w, h = size
    img = Image.new("RGBA", size)
    draw = ImageDraw.Draw(img)
    for y in range(h):
        ratio = y / max(h - 1, 1)
        color = tuple(int(top_color[i] * (1 - ratio) + bottom_color[i] * ratio) for i in range(3)) + (255,)
        draw.line((0, y, w, y), fill=color)
    return img


def make_mask_from_alpha(img):
    return img.getchannel("A")


def fit_center(img, size, scale=0.72):
    max_w = int(size[0] * scale)
    max_h = int(size[1] * scale)
    copy = img.copy()
    copy.thumbnail((max_w, max_h), Image.Resampling.LANCZOS)
    x = (size[0] - copy.width) // 2
    y = (size[1] - copy.height) // 2

    if copy.mode == "RGBA":
        canvas = Image.new("RGBA", size, (0, 0, 0, 0))
        canvas.alpha_composite(copy, (x, y))
        return canvas

    canvas = Image.new(copy.mode, size, 0)
    canvas.paste(copy, (x, y))
    return canvas


def create_icon(symbol, size):
    bg = vertical_gradient(size, PURPLE_B, PURPLE_DARK)
    soft = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(soft)
    pad = int(size[0] * 0.12)
    radius = int(size[0] * 0.24)
    draw.rounded_rectangle((pad, pad, size[0] - pad, size[1] - pad), radius=radius, fill=(255, 255, 255, 28))
    bg.alpha_composite(soft)

    symbol_mask = fit_center(make_mask_from_alpha(symbol).convert("L"), size, scale=0.62)
    white_fg = Image.new("RGBA", size, WHITE + (0,))
    white_fg.putalpha(symbol_mask)
    bg.alpha_composite(white_fg)
    return bg


def create_foreground(symbol, size):
    mask = fit_center(make_mask_from_alpha(symbol).convert("L"), size, scale=0.7)
    fg = Image.new("RGBA", size, WHITE + (0,))
    fg.putalpha(mask)
    return fg


def create_splash(lockup, size):
    bg = vertical_gradient(size, SURFACE, WHITE)
    draw = ImageDraw.Draw(bg)

    card_w = int(size[0] * 0.72)
    card_h = int(size[1] * 0.34)
    if size[1] > size[0]:
        card_w = int(size[0] * 0.86)
        card_h = int(size[1] * 0.24)
    radius = int(min(card_w, card_h) * 0.12)
    card = Image.new("RGBA", size, (0, 0, 0, 0))
    card_draw = ImageDraw.Draw(card)
    x0 = (size[0] - card_w) // 2
    y0 = (size[1] - card_h) // 2
    x1 = x0 + card_w
    y1 = y0 + card_h
    card_draw.rounded_rectangle((x0, y0, x1, y1), radius=radius, fill=(255, 255, 255, 230))
    shadow = card.filter(ImageFilter.GaussianBlur(radius=max(6, radius // 4)))
    bg.alpha_composite(shadow)
    bg.alpha_composite(card)

    logo_box = (int(card_w * 0.78), int(card_h * 0.42))
    logo_copy = lockup.copy()
    logo_copy.thumbnail(logo_box, Image.Resampling.LANCZOS)
    lx = x0 + (card_w - logo_copy.width) // 2
    ly = y0 + int(card_h * 0.18)
    bg.alpha_composite(logo_copy, (lx, ly))

    pill_w = max(int(card_w * 0.18), 120)
    pill_h = max(int(card_h * 0.16), 42)
    px = x0 + (card_w - pill_w) // 2
    py = y0 + int(card_h * 0.68)
    pill = Image.new("RGBA", size, (0, 0, 0, 0))
    pill_draw = ImageDraw.Draw(pill)
    pill_draw.rounded_rectangle((px, py, px + pill_w, py + pill_h), radius=pill_h // 2, fill=PURPLE_A + (255,))
    bg.alpha_composite(pill)
    text_draw = ImageDraw.Draw(bg)
    text_draw.text((px + pill_w * 0.28, py + pill_h * 0.2), "BETA", fill=WHITE)
    return bg


def save_png(img, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, format="PNG")


def generate_android_icons(symbol):
    sizes = {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }
    for folder, size in sizes.items():
        combined = create_icon(symbol, (size, size))
        foreground = create_foreground(symbol, (size, size))
        save_png(combined, ANDROID_RES / folder / "ic_launcher.png")
        save_png(combined, ANDROID_RES / folder / "ic_launcher_round.png")
        save_png(foreground, ANDROID_RES / folder / "ic_launcher_foreground.png")


def generate_ios_icon(symbol):
    icon = create_icon(symbol, (1024, 1024))
    save_png(icon, IOS_ASSETS / "AppIcon.appiconset" / "AppIcon-512@2x.png")


def generate_splashes(lockup):
    android_splashes = {
        "drawable/splash.png": (480, 320),
        "drawable-land-mdpi/splash.png": (480, 320),
        "drawable-land-hdpi/splash.png": (800, 480),
        "drawable-land-xhdpi/splash.png": (1280, 720),
        "drawable-land-xxhdpi/splash.png": (1600, 960),
        "drawable-land-xxxhdpi/splash.png": (1920, 1280),
        "drawable-port-mdpi/splash.png": (320, 480),
        "drawable-port-hdpi/splash.png": (480, 800),
        "drawable-port-xhdpi/splash.png": (720, 1280),
        "drawable-port-xxhdpi/splash.png": (960, 1600),
        "drawable-port-xxxhdpi/splash.png": (1280, 1920),
    }
    for rel, size in android_splashes.items():
        save_png(create_splash(lockup, size), ANDROID_RES / rel)

    ios_targets = {
        "splash-2732x2732.png": (2732, 2732),
        "splash-2732x2732-1.png": (2732, 2732),
        "splash-2732x2732-2.png": (2732, 2732),
    }
    for name, size in ios_targets.items():
        save_png(create_splash(lockup, size), IOS_ASSETS / "Splash.imageset" / name)


def main():
    logo = load_logo()
    symbol = crop_symbol(logo)
    lockup = crop_lockup(logo)
    generate_android_icons(symbol)
    generate_ios_icon(symbol)
    generate_splashes(lockup)
    print("Generated mobile brand assets.")


if __name__ == "__main__":
    main()
