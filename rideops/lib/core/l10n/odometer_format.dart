import 'package:intl/intl.dart';

import 'app_localizations.dart';

/// **La ÚNICA forma de escribir una lectura de odómetro en esta app.**
///
/// Nació de un hallazgo de la primera corrida e2e contra backend real: el paso
/// de confirmación decía «Odómetro 9.800 km» y el paso de métricas, para el
/// MISMO número, «Última lectura registrada: 9800 mi» con sufijo `mi` en el
/// campo. Dos unidades y dos formatos de miles para el mismo dato.
///
/// El primer barrido dejó vivo un cuarto sitio —la cabecera de sesión
/// (`wizard_chrome.dart`), que se pinta COMPLETA en los pasos de pago, firma y
/// cierre— y con él la contradicción entera: «IKL-427 · Odometer 48,190 km» en
/// el header sobre «48,190 mi» en la tarjeta. Los CINCO consumidores están
/// enumerados aquí a propósito, para que quien venga a agregar el sexto vea la
/// lista y no la afirmación suelta:
///
///  1. `steps/confirming_step.dart` — tarjeta de vehículo del paso 1.
///  2. `steps/inspection_step.dart` — «última lectura» del handoff.
///  3. `widgets/vehicle_swap_sheet.dart` — cada candidata del swap.
///  4. `widgets/wizard_chrome.dart` — la cabecera de sesión.
///  5. `inspection_bodies.dart` — el sufijo del campo y la lectura previa.
///
/// La prueba que sostiene la lista: `flutter analyze` no puede verlo, pero
/// cada uno tiene una aserción de texto sobre la unidad (la del header es
/// `checkout_wizard_screen_test.dart`, y no existía hasta el review MC-1: sin
/// ella, cambiar `odometerUnit` a 'km' dejaba el header verde).
///
/// **La verdad es MILLAS**, y no es una preferencia de copy — es lo que el
/// backend factura:
///  - `computeExcessMileage()` cobra el excedente *por milla*
///    (`fees/fee-engine.service.js:163-176`, `includedMilesPerDay`),
///  - `Vehicle.targetFleetMiles` es la regla de rotación de flota,
///  - los términos que firma el cliente dicen «billed per mile»
///    (`checkout-session/terms-content.js:34`),
///  - y el mostrador web ya rotula `mi` (`frontend/src/locales/*.json`,
///    `mileageWarning`).
///
/// **No hay configuración de unidad por tenant**: se buscó `distanceUnit`,
/// `unitSystem` y cualquier variante de «kilómetro» en `backend/src`, en el
/// schema de Prisma y en los locales del web — cero resultados. `km` era
/// simplemente un error de traducción en `coOdometerValue`.
///
/// Por eso la unidad se escribe UNA vez en el catálogo (`odometerUnit`) y se
/// inyecta en `odometerValue`: ninguna traducción futura puede volver a
/// inventar una distinta sin tocar la clave que este helper consume.
String formatOdometer(AppLocalizations l10n, String locale, int value) =>
    l10n.odometerValue(
      NumberFormat.decimalPattern(locale).format(value),
      l10n.odometerUnit,
    );
