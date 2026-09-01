# Genera el icono de lanzador de RideOps REUSANDO la marca de Ride que ya
# vive en el repo. No dibuja arte nuevo: recorta la flecha-carretera morada
# de frontend/public/ride-logo.png y la compone sobre blanco, que es como
# Ride presenta su marca en la web.
#
#   python rideops/tool/make_launcher_icons.py     (desde la raiz del repo)
#
# Requiere Pillow. Los PNG resultantes SI se versionan: esto es la receta,
# no un paso del build.
#
# Lo que NO hace, a proposito:
#  - no recolorea la marca (eso seria rediseniarla, y la marca es de Hector);
#  - no genera capa <monochrome> para el icono tematico de Android 13.
import os
import sys

from PIL import Image, ImageDraw

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(RAIZ, "frontend", "public", "ride-logo.png")
RES = os.path.join(
    RAIZ, "rideops", "android", "app", "src", "main", "res"
)

# (carpeta de densidad, px del icono legacy, px del foreground adaptativo)
DENSIDADES = [
    ("mdpi", 48, 108),
    ("hdpi", 72, 162),
    ("xhdpi", 96, 216),
    ("xxhdpi", 144, 324),
    ("xxxhdpi", 192, 432),
]


def marca(img):
    """Recorta SOLO la flecha-carretera (la parte morada del lockup).

    El wordmark 'ride' es gris oscuro (#3F3F3F) y la marca es morada, asi que
    un filtro por canal separa las dos sin recortar a ojo.
    """
    px = img.load()
    minx, miny, maxx, maxy = img.width, img.height, -1, -1
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            if a < 40:
                continue
            if b > 140 and b - g > 50 and r - g > 30:
                minx, miny = min(minx, x), min(miny, y)
                maxx, maxy = max(maxx, x), max(maxy, y)
    if maxx < 0:
        sys.exit("no se encontro la marca morada en " + SRC)
    # Se recorta la imagen ORIGINAL por esa caja: asi se conservan las rayas
    # blancas de la carretera que caen dentro.
    return img.crop((minx, miny, maxx + 1, maxy + 1))


def sellar_huecos(img):
    """Rellena de BLANCO los huecos INTERIORES de la marca.

    frontend/public/_make_logo_png.py volvio transparente todo lo casi-blanco
    del JPG original, asi que las rayas de la carretera son agujeros, no
    pixeles blancos. Sobre fondo blanco se verian bien por casualidad; aqui
    se hacen explicitas para que el foreground sea autosuficiente y no
    dependa del color del background del icono adaptativo.
    """
    w, h = img.size
    px = img.load()
    opaco = [[px[x, y][3] >= 40 for y in range(h)] for x in range(w)]

    # BFS desde el borde por los transparentes: eso es el EXTERIOR.
    exterior = [[False] * h for _ in range(w)]
    pila = []

    def sembrar(x, y):
        if not opaco[x][y] and not exterior[x][y]:
            exterior[x][y] = True
            pila.append((x, y))

    for x in range(w):
        sembrar(x, 0)
        sembrar(x, h - 1)
    for y in range(h):
        sembrar(0, y)
        sembrar(w - 1, y)
    while pila:
        x, y = pila.pop()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h:
                sembrar(nx, ny)

    rellenados = 0
    for x in range(w):
        for y in range(h):
            if not opaco[x][y] and not exterior[x][y]:
                px[x, y] = (255, 255, 255, 255)
                rellenados += 1
    print("huecos interiores rellenados:", rellenados)
    return img


def encajar(marca_img, lienzo_px, fraccion):
    """Marca centrada dentro de un lienzo cuadrado transparente."""
    objetivo = int(lienzo_px * fraccion)
    w, h = marca_img.size
    escala = min(objetivo / w, objetivo / h)
    nueva = marca_img.resize(
        (max(1, round(w * escala)), max(1, round(h * escala))), Image.LANCZOS
    )
    lienzo = Image.new("RGBA", (lienzo_px, lienzo_px), (0, 0, 0, 0))
    lienzo.paste(
        nueva,
        ((lienzo_px - nueva.width) // 2, (lienzo_px - nueva.height) // 2),
        nueva,
    )
    return lienzo


def cuadro_redondeado(px, radio_frac, color):
    lienzo = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    ImageDraw.Draw(lienzo).rounded_rectangle(
        [0, 0, px - 1, px - 1], radius=int(px * radio_frac), fill=color
    )
    return lienzo


def main():
    m = sellar_huecos(marca(Image.open(SRC).convert("RGBA")))

    for carpeta, legacy_px, fg_px in DENSIDADES:
        destino = os.path.join(RES, "mipmap-" + carpeta)
        os.makedirs(destino, exist_ok=True)

        # Foreground adaptativo (API 26+): lienzo de 108 dp, zona segura los
        # 66 dp centrales. 0.58 deja margen para que ninguna mascara
        # (circulo, squircle, gota) le muerda una esquina.
        encajar(m, fg_px, 0.58).save(
            os.path.join(destino, "ic_launcher_foreground.png"), "PNG"
        )

        # Legacy (API < 26 y algunos launchers): cuadro blanco redondeado.
        base = cuadro_redondeado(legacy_px, 0.22, (255, 255, 255, 255))
        base.alpha_composite(encajar(m, legacy_px, 0.62))
        base.save(os.path.join(destino, "ic_launcher.png"), "PNG")
        print("escrito mipmap-%s (%d px legacy, %d px foreground)"
              % (carpeta, legacy_px, fg_px))


if __name__ == "__main__":
    main()
