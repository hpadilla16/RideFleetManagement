import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/l10n/app_localizations_en.dart';
import 'package:rideops/core/l10n/app_localizations_es.dart';

/// Guardián de plurales ICU (prueba de humo del emulador, defecto 1).
///
/// La app mostraba "intentado 1 veces", "1 envíos esperando" y — peor, porque
/// lo LEE el lector de pantalla — "1 pendientes de envío". Todas eran claves
/// que interpolaban `{count}` en una frase cuyo sustantivo/verbo flexiona,
/// sin `{count, plural, ...}`. El patrón correcto ya existía al lado
/// (`outboxDeadBanner`), así que el defecto no fue no saber: fue que nada
/// impedía escribir la forma mala.
///
/// Este archivo es ese impedimento. Un comentario en el .arb no se sostiene
/// solo — una prueba sí. Regla: TODA clave cuyo mensaje interpole `{count}`
/// usa ICU plural, o está en [_sinPluralJustificado] con un motivo escrito.
/// Agregar una clave nueva con `{count}` y sin plural rompe la suite; la
/// salida dice exactamente qué hacer.
///
/// Ojo con la exención: NO es una lista de "pendientes". Es la lista de
/// lugares donde `{count}` no flexiona nada (abreviaturas de unidad, formas
/// "X de Y", contadores tope "N+"). Si una entrada de ahí deja de aplicar,
/// la prueba de higiene la delata en vez de dejarla pudrirse.
void main() {
  final es = _leerArb('es');
  final en = _leerArb('en');

  group('plurales ICU en los .arb', () {
    test('es: toda clave con {count} usa plural o está justificada', () {
      _exigirPlural(es, 'app_es.arb');
    });

    test('en: toda clave con {count} usa plural o está justificada', () {
      _exigirPlural(en, 'app_en.arb');
    });

    test('la lista de exentas no se pudre (sin entradas obsoletas)', () {
      final obsoletas = <String, String>{};
      for (final clave in _sinPluralJustificado.keys) {
        final mensaje = es[clave];
        if (mensaje == null) {
          obsoletas[clave] = 'la clave ya no existe en app_es.arb';
        } else if (!_usaCount(mensaje)) {
          obsoletas[clave] = 'la clave ya no interpola {count}';
        } else if (_usaPlural(mensaje)) {
          obsoletas[clave] = 'la clave YA usa plural — sácala de la exención';
        }
      }
      expect(
        obsoletas,
        isEmpty,
        reason: 'Entradas muertas en _sinPluralJustificado:\n'
            '${obsoletas.entries.map((e) => '  ${e.key}: ${e.value}').join('\n')}',
      );
    });

    test('paridad es/en: mismas claves con {count} y mismo uso de plural', () {
      final clavesEs = es.keys.where((k) => _usaCount(es[k]!)).toSet();
      final clavesEn = en.keys.where((k) => _usaCount(en[k]!)).toSet();
      expect(
        clavesEs.difference(clavesEn),
        isEmpty,
        reason: 'claves con {count} que existen en es pero no en en',
      );
      expect(
        clavesEn.difference(clavesEs),
        isEmpty,
        reason: 'claves con {count} que existen en en pero no en es',
      );

      // Un idioma con plural y el otro sin él es el bug de origen visto por
      // la mitad: el emulador en español decía "1 envíos" mientras el inglés
      // hubiera podido estar bien (o al revés).
      final desparejas = <String>[
        for (final k in clavesEs)
          if (_usaPlural(es[k]!) != _usaPlural(en[k]!)) k,
      ];
      expect(
        desparejas,
        isEmpty,
        reason: 'plural en un idioma y no en el otro: $desparejas',
      );
    });
  });

  // Las de arriba miran el .arb; estas miran lo que de verdad se PINTA — que
  // el ICU esté bien escrito y que gen-l10n se haya vuelto a correr. Un .arb
  // corregido sin regenerar app_localizations_*.dart deja la app igual de
  // rota, y solo estas pruebas lo notan.
  group('el singular renderizado (lo que ve el empleado)', () {
    final esL10n = AppLocalizationsEs();
    final enL10n = AppLocalizationsEn();

    test('outboxAttempts: 1 → "vez"/"once", 2 → "veces"/"times"', () {
      expect(esL10n.outboxAttempts(1, '10:30'), 'intentado 1 vez · último 10:30');
      expect(
        esL10n.outboxAttempts(3, '10:30'),
        'intentado 3 veces · último 10:30',
      );
      expect(enL10n.outboxAttempts(1, '10:30'), 'tried once · last 10:30');
      expect(enL10n.outboxAttempts(3, '10:30'), 'tried 3 times · last 10:30');
    });

    test('outboxBadgeSemantics: lo que dicta TalkBack en singular', () {
      expect(esL10n.outboxBadgeSemantics(1), '1 pendiente de envío');
      expect(esL10n.outboxBadgeSemantics(4), '4 pendientes de envío');
      expect(enL10n.outboxBadgeSemantics(1), '1 pending to send');
      expect(enL10n.outboxBadgeSemantics(4), '4 pending to send');
    });

    test('outboxFullBody: "1 envío" / "1 item"', () {
      expect(esL10n.outboxFullBody(1), startsWith('1 envío esperando'));
      expect(esL10n.outboxFullBody(50), startsWith('50 envíos esperando'));
      expect(enL10n.outboxFullBody(1), startsWith('1 item waiting'));
      expect(enL10n.outboxFullBody(50), startsWith('50 items waiting'));
    });

    test('policyRuleMinLength: "1 carácter" / "1 character"', () {
      expect(esL10n.policyRuleMinLength(1), 'Mínimo 1 carácter');
      expect(esL10n.policyRuleMinLength(8), 'Mínimo 8 caracteres');
      expect(enL10n.policyRuleMinLength(1), 'At least 1 character');
      expect(enL10n.policyRuleMinLength(8), 'At least 8 characters');
    });
  });
}

/// Claves donde `{count}` NO flexiona la frase. Cada una con su motivo: la
/// exención se gana explicándola, no marcándola.
const _sinPluralJustificado = <String, String>{
  'pinDigitsProgress':
      'forma "X de 4": el sustantivo concuerda con el 4, no con {count}',
  'inspProgressChip': 'forma "X de 8" — igual que pinDigitsProgress',
  'coInspServerPhotos': 'forma "X de 8 recibidas" — el 8 manda',
  'outboxFullChip': 'forma "X de {max}" — el sustantivo va con {max}',
  'ageMinutes': 'abreviatura de unidad (min) — invariable en es y en',
  'ageHours': 'abreviatura de unidad (h) — invariable',
  'ageSeconds': 'abreviatura de unidad (s) — invariable',
  'cardOverdueMinutes': 'abreviatura de unidad (min) — invariable',
  'queueCountCapped': 'solo el número y un "+" — no hay frase que flexione',
  'coPresenceMore': 'solo "+N" sobre los avatares — no hay frase',
  'heroPartDeparturesCapped':
      'contador TOPADO: solo se pinta con {count} == el tope, jamás 1',
  'tileLoanerFootCapped': 'contador TOPADO — idem heroPartDeparturesCapped',
  'queueListShowingFirst':
      'solo se pinta cuando queueCapped(count) es true (count == el tope, 8)',
  'tileActiveSemantics':
      'el número va tras dos puntos ("En renta: N.") — no concuerda con nada',
  'emptyAllQueuesLabel':
      'el {count} es cuántas colas tiene el tablero (constante ≥ 2), no un dato',
  'coOpenOutbox': 'el número va entre paréntesis en el botón — no concuerda',
};

final _reCount = RegExp(r'\{\s*count\s*[,}]');
final _rePlural = RegExp(r'\{\s*count\s*,\s*plural\s*,');

bool _usaCount(String mensaje) => _reCount.hasMatch(mensaje);
bool _usaPlural(String mensaje) => _rePlural.hasMatch(mensaje);

void _exigirPlural(Map<String, String> arb, String archivo) {
  final infractoras = <String>[];
  for (final entrada in arb.entries) {
    if (!_usaCount(entrada.value)) continue;
    if (_usaPlural(entrada.value)) continue;
    if (_sinPluralJustificado.containsKey(entrada.key)) continue;
    infractoras.add('  ${entrada.key}: "${entrada.value}"');
  }
  expect(
    infractoras,
    isEmpty,
    reason:
        'En $archivo hay claves que interpolan {count} sin ICU plural.\n'
        '${infractoras.join('\n')}\n\n'
        'Arréglalas con {count, plural, one{...} other{{count} ...}} en LOS DOS\n'
        'idiomas (mira outboxDeadBanner), o — si {count} de verdad no flexiona\n'
        'nada ahí — agrégalas a _sinPluralJustificado en test/l10n_plural_guard_test.dart\n'
        'CON el motivo escrito.',
  );
}

/// Solo las claves de mensaje: los bloques `@clave` son metadatos y sus
/// descripciones sí pueden hablar de "count" sin ser texto de pantalla.
Map<String, String> _leerArb(String locale) {
  final crudo = File('lib/core/l10n/app_$locale.arb').readAsStringSync();
  final json = jsonDecode(crudo) as Map<String, dynamic>;
  return {
    for (final e in json.entries)
      if (!e.key.startsWith('@') && e.value is String) e.key: e.value as String,
  };
}
