import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/l10n/app_localizations_en.dart';
import 'package:rideops/core/l10n/app_localizations_es.dart';

/// Guardián de plurales ICU (prueba de humo del emulador, defecto 1).
///
/// La app mostraba "intentado 1 veces", "1 envíos esperando" y — peor, porque
/// lo LEE el lector de pantalla — "1 pendientes de envío". Todas eran claves
/// que interpolaban un número en una frase cuyo sustantivo/verbo flexiona,
/// sin `{n, plural, ...}`. El patrón correcto ya existía al lado
/// (`outboxDeadBanner`), así que el defecto no fue no saber: fue que nada
/// impedía escribir la forma mala.
///
/// Este archivo es ese impedimento. Un comentario en el .arb no se sostiene
/// solo — una prueba sí.
///
/// ALCANCE (review GD-S6): no solo `{count}`. La primera versión de este
/// guardián miraba esa única variable y dejó vivo un contraejemplo en el
/// mismo archivo: `coStepsSheetTitle` usa `{total}` y gobierna concordancia.
/// Ahora se mira TODO placeholder declarado `"type": "int"` en la metadata
/// `@` de la plantilla — el dato ya estaba en el .arb, nadie lo leía.
/// Ampliarlo destapó cuatro concordancias rotas más (summaryQueueTitle,
/// outboxDrainProgress, coJoinDonePill y el propio coStepsSheetTitle).
///
/// LA EXENCIÓN NO ES UNA LISTA DE PENDIENTES. Es la lista de lugares donde
/// el número no flexiona nada, y — regla que costó una revisión — el motivo
/// tiene que ser una propiedad de LA CADENA, nunca un invariante del que
/// llama. "El llamador solo pasa el tope" no vale: ni la cadena ni esta
/// prueba pueden sostenerlo, y el día que el llamador cambie, el texto se
/// rompe en silencio. Motivos válidos: abreviatura de unidad, forma "X de Y"
/// donde el sustantivo concuerda con el Y LITERAL, el "+" que hace plural la
/// frase por construcción, o que no haya sustantivo que concordar.
void main() {
  final plantilla = _leerArb('es');
  final es = plantilla.mensajes;
  final en = _leerArb('en').mensajes;

  group('plurales ICU en los .arb', () {
    test('es: todo placeholder int usa plural o está justificado', () {
      _exigirPlural(es, plantilla.intsPorClave, 'app_es.arb');
    });

    test('en: todo placeholder int usa plural o está justificado', () {
      // app_en.arb no lleva metadata `@` (no es la plantilla): los tipos
      // salen de app_es.arb, lo que de paso obliga a que las dos traigan
      // los mismos huecos.
      _exigirPlural(en, plantilla.intsPorClave, 'app_en.arb');
    });

    test('la lista de exentas no se pudre (sin entradas obsoletas)', () {
      final obsoletas = <String, String>{};
      for (final entrada in _sinPluralJustificado.keys) {
        final partes = entrada.split('.');
        final clave = partes[0];
        final hueco = partes[1];
        final mensaje = es[clave];
        if (mensaje == null) {
          obsoletas[entrada] = 'la clave ya no existe en app_es.arb';
        } else if (!(plantilla.intsPorClave[clave] ?? const <String>{})
            .contains(hueco)) {
          obsoletas[entrada] = 'ya no hay un placeholder int llamado $hueco';
        } else if (!_usa(mensaje, hueco)) {
          obsoletas[entrada] = 'el mensaje ya no interpola ese hueco';
        } else if (_esPlural(mensaje, hueco)) {
          obsoletas[entrada] = 'YA usa plural — sácala de la exención';
        }
      }
      expect(
        obsoletas,
        isEmpty,
        reason: 'Entradas muertas en _sinPluralJustificado:\n'
            '${obsoletas.entries.map((e) => '  ${e.key}: ${e.value}').join('\n')}',
      );
    });

    test('paridad es/en: mismo uso de plural, o asimetría justificada', () {
      final desparejas = <String>[];
      for (final entrada in plantilla.intsPorClave.entries) {
        final clave = entrada.key;
        final mes = es[clave];
        final men = en[clave];
        if (mes == null || men == null) continue;
        for (final hueco in entrada.value) {
          if (_esPlural(mes, hueco) == _esPlural(men, hueco)) continue;
          if (_asimetriaJustificada.containsKey('$clave.$hueco')) continue;
          desparejas.add('$clave.$hueco');
        }
      }
      expect(
        desparejas,
        isEmpty,
        reason: 'Plural en un idioma y no en el otro: $desparejas.\n'
            'Casi siempre es "arreglé uno y olvidé el otro". Si de verdad un '
            'idioma no flexiona ahí (el inglés a menudo no), agrégalo a '
            '_asimetriaJustificada CON el motivo.',
      );
    });

    test('la lista de asimetrías tampoco se pudre', () {
      final obsoletas = <String>[];
      for (final entrada in _asimetriaJustificada.keys) {
        final partes = entrada.split('.');
        final mes = es[partes[0]];
        final men = en[partes[0]];
        if (mes == null || men == null) {
          obsoletas.add('$entrada: la clave ya no existe');
        } else if (_esPlural(mes, partes[1]) == _esPlural(men, partes[1])) {
          obsoletas.add('$entrada: ya no hay asimetría que justificar');
        }
      }
      expect(obsoletas, isEmpty, reason: obsoletas.join('\n'));
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
      expect(
        esL10n.outboxAttempts(1, '10:30'),
        'intentado 1 vez · último 10:30',
      );
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

    // Las dos exenciones que Diseño desautorizó (review GD-M4).
    test('queueListShowingFirst: nunca "los primeros 1"', () {
      expect(
        esL10n.queueListShowingFirst(1),
        'Mostrando el primero — puede haber más',
      );
      expect(
        esL10n.queueListShowingFirst(8),
        'Mostrando los primeros 8 — puede haber más',
      );
      expect(
        enL10n.queueListShowingFirst(1),
        'Showing the first one — there may be more',
      );
      expect(
        enL10n.queueListShowingFirst(8),
        'Showing the first 8 — there may be more',
      );
    });

    test('emptyAllQueuesLabel perdió el placeholder (era "Las 1 colas")', () {
      expect(esL10n.emptyAllQueuesLabel, 'Todas las colas, en cero');
      expect(enL10n.emptyAllQueuesLabel, 'All queues at zero');
    });

    // Lo que destapó ampliar el guardián más allá de {count} (review GD-S6).
    test('coStepsSheetTitle: nunca "1 pasos"', () {
      expect(esL10n.coStepsSheetTitle(1), '1 paso + salida alterna');
      expect(esL10n.coStepsSheetTitle(11), '11 pasos + salida alterna');
      expect(enL10n.coStepsSheetTitle(1), '1 step + alternate exit');
    });

    test('summaryQueueTitle: nunca "1 fotos"', () {
      expect(esL10n.summaryQueueTitle(1), '1 foto · métricas · firma');
      expect(esL10n.summaryQueueTitle(8), '8 fotos · métricas · firma');
      expect(enL10n.summaryQueueTitle(1), '1 photo · metrics · signature');
    });

    test('outboxDrainProgress: nunca "1 de 1 enviados"', () {
      expect(esL10n.outboxDrainProgress(1, 1), '1 de 1 enviado');
      expect(esL10n.outboxDrainProgress(3, 8), '3 de 8 enviados');
    });

    test('coJoinDonePill: nunca "1 de 1 fases"', () {
      expect(esL10n.coJoinDonePill(1, 1), '1 de 1 fase');
      expect(esL10n.coJoinDonePill(1, 2), '1 de 2 fases');
      expect(enL10n.coJoinDonePill(1, 1), '1 of 1 phase');
    });
  });
}

/// `clave.placeholder` → por qué ese número NO flexiona la frase.
/// El motivo describe LA CADENA, nunca al que llama (ver el doc de arriba).
const _sinPluralJustificado = <String, String>{
  // Forma "X de Y": el sustantivo concuerda con el Y LITERAL de la cadena.
  'pinDigitsProgress.count': 'sustantivo pegado al 4 literal: "N de 4 dígitos"',
  'inspProgressChip.count': '"N de 8" — el 8 es literal y no hay sustantivo',
  'coInspServerPhotos.count': '"N de 8 recibidas": concuerda con el 8 literal',
  'camAnglePill.n': '"{angle} · N de 8" — el 8 es literal',
  // Forma "X de Y <sustantivo>": manda el TOTAL, no el numerador — el
  // guardian pregunta por los dos y este es el que no flexiona nada.
  'outboxDrainProgress.done':
      'numerador de "N de M enviados": el participio concuerda con M',
  'coJoinDonePill.done':
      'numerador de "N de M fases": el sustantivo concuerda con M',
  // Forma "X de Y" sin ningún sustantivo que concordar.
  'queueListShowingOf.shown': '"Mostrando N de M": no hay sustantivo',
  'queueListShowingOf.total': '"Mostrando N de M": no hay sustantivo',
  'outboxFullChip.count':
      '"N de M · ~tamaño en espera": "en espera" es invariable',
  'outboxFullChip.max':
      '"N de M · ~tamaño en espera": "en espera" es invariable',
  // "Paso N (de M)": "paso" es etiqueta fija en singular, no concuerda con
  // el ordinal que la sigue.
  'pinSetupStep.step': '"Paso N de 2": "Paso" es etiqueta fija en singular',
  'coStepOf.index': '"Paso N de M": "Paso" es etiqueta fija en singular',
  'coStepOf.total': '"Paso N de M": "Paso" es etiqueta fija en singular',
  'coPauseSub.index': 'ordinal dentro de "el paso N de M"',
  'coPauseSub.total': 'ordinal dentro de "el paso N de M"',
  'coCloseLegWaiting.index': 'ordinal dentro de "Paso N de M · falta"',
  'coCloseLegWaiting.total': 'ordinal dentro de "Paso N de M · falta"',
  'coChangedStayCta.index': 'ordinal: "Seguir en el paso N"',
  'coGoToStepCta.index': 'ordinal: "Ir al paso N · {step}"',
  'coGoToStepWhy.index': 'ordinal: "Ir al paso N es navegación…"',
  'coJoinContinueCta.index': 'ordinal: "Continuar desde el paso N"',
  'coJoinBannerStarted.index': 'ordinal dentro de "el paso N de M"',
  'coJoinBannerStarted.total': 'ordinal dentro de "el paso N de M"',
  'coJoinBannerStartedAt.index': 'ordinal dentro de "el paso N de M"',
  'coJoinBannerStartedAt.total': 'ordinal dentro de "el paso N de M"',
  'coJoinBannerStartedByOther.index': 'ordinal dentro de "el paso N de M"',
  'coJoinBannerStartedByOther.total': 'ordinal dentro de "el paso N de M"',
  'coConflictTooEarlyBody.index': 'ordinal: "(paso N)"',
  'coConflictTooEarlyBody.targetIndex': 'ordinal: "es el paso N"',
  // Abreviaturas de unidad: invariables en es y en.
  'ageMinutes.count': 'abreviatura de unidad (min)',
  'ageHours.count': 'abreviatura de unidad (h)',
  'ageSeconds.count': 'abreviatura de unidad (s)',
  'cardOverdueMinutes.count': 'abreviatura de unidad (min)',
  // El "+" hace plural la frase POR CONSTRUCCIÓN (review GD-S5): "N+ salidas"
  // se lee plural con cualquier número, incluido el 1 — "1+ salidas" es
  // correcto. No depende de que el llamador solo pase el tope.
  'heroPartDeparturesCapped.count': 'el "+" pluraliza la frase: "N+ salidas"',
  'tileLoanerFootCapped.count':
      'el "+" pluraliza la frase: "N+ piden seguimiento"',
  // Sin sustantivo que concordar.
  'queueCountCapped.count': 'solo el número y un "+"',
  'coPresenceMore.count': 'solo "+N" sobre los avatares',
  'outboxTechnicalHttp.status': '"HTTP N" — código de transporte, sin frase',
  'tileActiveSemantics.count': 'el número va tras dos puntos: "En renta: N."',
  'coOpenOutbox.count': 'el número va entre paréntesis en el botón',
  'coGuardOutboxCta.n': 'el número va entre paréntesis en el botón',
};

/// `clave.placeholder` → por qué un idioma lleva plural y el otro no.
const _asimetriaJustificada = <String, String>{
  'outboxDrainProgress.total':
      'en español el participio concuerda ("1 de 1 enviado" / "3 de 8 '
          'enviados"); en inglés "sent" no flexiona y un plural ahí serían '
          'dos ramas idénticas',
};

/// Mensajes + los placeholders int declarados por clave, leídos de la
/// metadata `@` de la plantilla: el .arb ya trae el tipo, nadie lo usaba.
class _Arb {
  const _Arb(this.mensajes, this.intsPorClave);
  final Map<String, String> mensajes;
  final Map<String, Set<String>> intsPorClave;
}

bool _usa(String mensaje, String hueco) =>
    RegExp('\\{\\s*$hueco\\s*[,}]').hasMatch(mensaje);

bool _esPlural(String mensaje, String hueco) =>
    RegExp('\\{\\s*$hueco\\s*,\\s*plural\\s*,').hasMatch(mensaje);

void _exigirPlural(
  Map<String, String> arb,
  Map<String, Set<String>> intsPorClave,
  String archivo,
) {
  final infractoras = <String>[];
  for (final entrada in intsPorClave.entries) {
    final mensaje = arb[entrada.key];
    if (mensaje == null) continue;
    for (final hueco in entrada.value) {
      if (!_usa(mensaje, hueco)) continue;
      if (_esPlural(mensaje, hueco)) continue;
      final id = '${entrada.key}.$hueco';
      if (_sinPluralJustificado.containsKey(id)) continue;
      // Asimetría declarada: un idioma flexiona y el otro no. No se puede
      // colar un "olvidé los dos" por aquí — la prueba de rot exige que
      // sigan DIFIRIENDO para que la entrada siga viva.
      if (_asimetriaJustificada.containsKey(id)) continue;
      infractoras.add('  ${entrada.key} / $hueco: "$mensaje"');
    }
  }
  infractoras.sort();
  expect(
    infractoras,
    isEmpty,
    reason: 'En $archivo hay números interpolados sin ICU plural.\n'
        '${infractoras.join('\n')}\n\n'
        'Arréglalos con ICU plural en LOS DOS idiomas (mira\n'
        'outboxDeadBanner), o — si ese número de verdad no flexiona nada\n'
        'ahí — agrégalos a _sinPluralJustificado en\n'
        'test/l10n_plural_guard_test.dart CON el motivo escrito, y que el\n'
        'motivo hable de la CADENA, no de quién la llama.',
  );
}

/// Solo las claves de mensaje: los bloques `@clave` son metadatos y sus
/// descripciones sí pueden hablar de números sin ser texto de pantalla.
_Arb _leerArb(String locale) {
  final crudo = File('lib/core/l10n/app_$locale.arb').readAsStringSync();
  final json = jsonDecode(crudo) as Map<String, dynamic>;

  final mensajes = <String, String>{};
  final ints = <String, Set<String>>{};
  for (final e in json.entries) {
    if (!e.key.startsWith('@')) {
      if (e.value is String) mensajes[e.key] = e.value as String;
      continue;
    }
    if (e.value is! Map) continue;
    final huecos = (e.value as Map)['placeholders'];
    if (huecos is! Map) continue;
    final deTipoInt = <String>{
      for (final p in huecos.entries)
        if (p.value is Map && (p.value as Map)['type'] == 'int')
          p.key as String,
    };
    if (deTipoInt.isNotEmpty) ints[e.key.substring(1)] = deTipoInt;
  }
  return _Arb(mensajes, ints);
}
