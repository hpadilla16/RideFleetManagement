import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/theme/ride_tokens.dart';

/// Marca del lado nativo (defecto 4 de la prueba de humo en el emulador).
///
/// El teléfono de patio mostraba el logo de Flutter en el cajón de apps y un
/// splash blanco (negro en modo oscuro) que saltaba a la aurora morada: los
/// tres archivos eran la plantilla intacta de `flutter create`.
///
/// Una plantilla intacta no se nota en una demo — se nota cuando alguien del
/// mostrador busca la app entre veinte iconos. Por eso hay prueba: es
/// exactamente el tipo de cosa que se vuelve a colar en el siguiente
/// `flutter create` de un módulo nuevo.
void main() {
  const res = 'android/app/src/main/res';

  /// SHA-256 de los iconos que trae `flutter create` (medidos en 1fa6fabd,
  /// antes de este cambio). Si un icono vuelve a valer esto, es que alguien
  /// regeneró el proyecto Android encima de la marca.
  const plantillaFlutter = <String, String>{
    'mdpi': 'c7c0c0189145e4e32a401c61c9bdc615754b0264e7afae24e834bb81049eaf81',
    'hdpi': '6a7c8f0d703e3682108f9662f813302236240d3f8f638bb391e32bfb96055fef',
    'xhdpi': 'e14aa40904929bf313fded22cf7e7ffcbf1d1aac4263b5ef1be8bfce650397aa',
    'xxhdpi': '4d470bf22d5c17d84edc5f82516d1ba8a1c09559cd761cefb792f86d9f52b540',
    'xxxhdpi': '3c34e1f298d0c9ea3455d46db6b7759c8211a49e9ec6e44b635fc5c87dfb4180',
  };

  /// px del foreground adaptativo por densidad (108 dp × factor).
  const foregroundPx = <String, int>{
    'mdpi': 108,
    'hdpi': 162,
    'xhdpi': 216,
    'xxhdpi': 324,
    'xxxhdpi': 432,
  };

  /// Lee un recurso SIN sus comentarios XML. Los comentarios de estos
  /// archivos explican de qué se salió la plantilla (y nombran los valores
  /// viejos, "Theme.Black" entre ellos): buscar en el texto crudo haría que
  /// documentar el porqué rompiera la prueba.
  String leer(String ruta) => File('$res/$ruta')
      .readAsStringSync()
      .replaceAll(RegExp(r'<!--.*?-->', dotAll: true), '');

  test('ningún ic_launcher sigue siendo el de la plantilla de Flutter', () {
    for (final entrada in plantillaFlutter.entries) {
      final archivo = File('$res/mipmap-${entrada.key}/ic_launcher.png');
      expect(archivo.existsSync(), isTrue, reason: '${archivo.path} no existe');

      final huella = sha256.convert(archivo.readAsBytesSync()).toString();
      expect(
        huella,
        isNot(entrada.value),
        reason: 'mipmap-${entrada.key}/ic_launcher.png volvió a ser el logo '
            'de Flutter. Regenéralo: python rideops/tool/make_launcher_icons.py',
      );
    }
  });

  test('hay icono adaptativo (API 26+) con foreground en todas las densidades',
      () {
    final xml = leer('mipmap-anydpi-v26/ic_launcher.xml');
    expect(xml, contains('<adaptive-icon'));
    expect(xml, contains('@mipmap/ic_launcher_foreground'));
    expect(xml, contains('@color/ride_launcher_background'));

    for (final entrada in foregroundPx.entries) {
      final archivo =
          File('$res/mipmap-${entrada.key}/ic_launcher_foreground.png');
      expect(archivo.existsSync(), isTrue,
          reason: 'falta el foreground en mipmap-${entrada.key}: el icono '
              'adaptativo se caería a un cuadro blanco vacío en esa densidad');

      // Ancho del PNG, leído del header IHDR (bytes 16-19, big-endian). Un
      // foreground de 108 dp mal escalado se recorta contra la máscara.
      final bytes = archivo.readAsBytesSync();
      final ancho = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) |
          bytes[19];
      expect(ancho, entrada.value,
          reason: 'mipmap-${entrada.key}/ic_launcher_foreground.png mide '
              '$ancho px y el lienzo adaptativo de esa densidad es '
              '${entrada.value} px');
    }
  });

  test('el splash es la aurora de Ride, no el blanco de la plantilla', () {
    final xml = leer('drawable/launch_background.xml');
    expect(
      xml,
      isNot(contains('@android:color/white')),
      reason: 'ese es el relleno que trae `flutter create`',
    );
    expect(xml, contains('<gradient'));
    expect(xml, contains('@color/ride_aurora_start'));
    expect(xml, contains('@color/ride_aurora_end'));
  });

  test('no existe drawable-v21/launch_background.xml (sombreaba al de verdad)',
      () {
    // Con minSdk 24 el recurso -v21 SIEMPRE gana. Si vuelve a aparecer,
    // editar drawable/launch_background.xml deja de tener efecto en el
    // teléfono y la siguiente persona pierde una tarde.
    expect(
      File('$res/drawable-v21/launch_background.xml').existsSync(),
      isFalse,
    );
  });

  test('los colores nativos de la aurora siguen a RideTokens.aurora', () {
    // Este es el amarre que evita que el splash nativo y el primer frame de
    // Flutter se separen en silencio: si alguien retoca el gradiente en
    // ride_tokens.dart y no toca colors.xml, vuelve el destello al arrancar.
    final colores = leer('values/colors.xml');

    String hex(String nombre) {
      final m = RegExp('<color name="$nombre">#([0-9A-Fa-f]{8})</color>')
          .firstMatch(colores);
      expect(m, isNotNull, reason: 'falta el color $nombre en colors.xml');
      return m!.group(1)!.toUpperCase();
    }

    String deColor(Color c) =>
        c.toARGB32().toRadixString(16).padLeft(8, '0').toUpperCase();

    final aurora = RideTokens.aurora.colors;
    expect(hex('ride_aurora_start'), deColor(aurora.first));
    expect(hex('ride_aurora_end'), deColor(aurora.last));

    // El centro es la aproximación declarada (Flutter tiene 4 paradas y
    // GradientDrawable admite 3): no se fija al pixel, pero tiene que caer
    // ENTRE las puntas o el gradiente nativo iría en otra dirección.
    final centro = int.parse(hex('ride_aurora_center'), radix: 16);
    final inicio = aurora.first.toARGB32();
    final fin = aurora.last.toARGB32();
    for (final desplazamiento in [16, 8, 0]) {
      final c = (centro >> desplazamiento) & 0xFF;
      final a = (inicio >> desplazamiento) & 0xFF;
      final b = (fin >> desplazamiento) & 0xFF;
      expect(c, inInclusiveRange(a < b ? a : b, a < b ? b : a),
          reason: 'el centro se salió del rango del gradiente de Dart');
    }
  });

  test('Android 12+ tiene su propio splash pinneado al aurora', () {
    // targetSdk 36: en API 31+ la plataforma pinta SU splash encima del
    // nuestro y `@drawable/launch_background` no se ve hasta que lo retira.
    // Sin `windowSplashScreenBackground` el color lo decide un aplanado sin
    // documentar del windowBackground — medido en el AVD, se movió entre
    // #33127B, #35157F y #391687 según qué pin hubiera. Con el pin es
    // exacto y es el mismo token que el resto del arranque.
    final v31 = leer('values-v31/styles.xml');
    expect(
      v31,
      contains('android:windowSplashScreenBackground'),
      reason: 'sin esto el color del splash de API 31+ lo elige Android',
    );
    // Y tiene que ser un color del aurora, no un hex suelto: así la prueba
    // de colors.xml ↔ RideTokens.aurora también lo cubre.
    expect(v31, contains('@color/ride_aurora_'));
    expect(
      RegExp(r'windowSplashScreenBackground">#').hasMatch(v31),
      isFalse,
      reason: 'hex suelto: se desataria de RideTokens sin que nadie lo note',
    );
  });

  test('modo oscuro del sistema no reintroduce el arranque negro', () {
    // La app no tiene darkTheme (app.dart): un LaunchTheme oscuro daba
    // negro → aurora → app clara, dos destellos antes del login.
    final noche = leer('values-night/styles.xml');
    expect(noche, isNot(contains('Theme.Black')));
    expect(noche, contains('@drawable/launch_background'));
    expect(
      noche,
      isNot(contains('?android:colorBackground')),
      reason: 'resuelve a negro en modo oscuro — ese era el destello',
    );
  });
}
