import 'package:clock/clock.dart';
import 'package:flutter/material.dart';

import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/theme/ride_tokens.dart';
import '../../../../core/widgets/ride_buttons.dart';
import '../../domain/checkout_presence.dart';
import '../checkout_labels.dart';
import 'wizard_banners.dart';

/// Frame 20B — "Quién está en esta sesión".
///
/// Es el destino que el chip de presencia de H1 no tenía. Tres cosas que esta
/// hoja hace y ninguna otra pantalla puede hacer por ella:
///
///  1. **Distingue persona de aparato.** Círculo + iniciales + morado para
///     quien tiene nombre; cuadrado + glifo + gris para el mueble. Las tres
///     señales cambian a la vez a propósito: con guantes y sol de frente una
///     sola no se lee. Y la decisión que habilita es real — a "Diego Torres ·
///     mostrador" le gritas desde la otra punta del patio; al kiosco hay que
///     caminarle al lobby.
///  2. **Dice el reverso.** Desde H6 el agente también es VISIBLE, con su
///     nombre, para las otras superficies. Eso se le cuenta una vez y donde
///     puede verlo — no en un ajuste ni en una política enterrada.
///  3. **No miente sobre el vacío.** Una lista vacía dice "no hay nadie
///     visible", jamás "estás solo": `withPresence()` degrada a `[]` ante
///     error, así que vacío y "falló la lectura" son indistinguibles por
///     contrato.
class WhoIsHereSheet extends StatelessWidget {
  const WhoIsHereSheet({
    super.key,
    required this.roster,
    required this.myName,
    required this.offline,
    required this.onClose,
  });

  final List<PresenceRosterEntry> roster;

  /// `me.fullName` — lo que las otras superficies van a ver de este agente.
  /// Null (sesión degradada sin `/me`) ⇒ se dice QUÉ se anuncia sin fingir
  /// saber el nombre exacto que resolverá la cascada del servidor.
  final String? myName;

  /// Sin red no se puede afirmar que nadie esté AHORA: los puntos vivos se
  /// apagan y la hoja lo explica en vez de dejar un verde sin respaldo.
  final bool offline;

  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 8, 14, 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              width: 44,
              height: 5,
              margin: const EdgeInsets.only(top: 2, bottom: 10),
              decoration: BoxDecoration(
                color: RideTokens.n300,
                borderRadius: BorderRadius.circular(3),
              ),
            ),
          ),
          Text(
            l10n.coWhoIsHereTitle,
            style: const TextStyle(
              fontSize: 17,
              fontWeight: FontWeight.w900,
              color: RideTokens.n900,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            // El TTL se nombra, no se esconde: tres polls perdidos y te vas.
            offline ? l10n.coPresenceOfflineWhy : l10n.coWhoIsHereSub,
            style: const TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w700,
              color: RideTokens.n700,
            ),
          ),
          const SizedBox(height: 12),
          Flexible(
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (final entry in roster) ...[
                    _PresenceRow(entry: entry, offline: offline),
                    const SizedBox(height: 8),
                  ],
                  if (roster.isNotEmpty) ...[
                    // La regla antisoledad va en pantalla, no en un comentario
                    // de código: es la más fácil de romper por lectura, y con
                    // el latido encendido el agente se acostumbra a confiar en
                    // el dato. Va con la lista LLENA a propósito — con la
                    // lista vacía, `coPresenceEmpty` lo dice mejor.
                    Text(
                      l10n.coPresenceNeverAlone,
                      style: const TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w700,
                        height: 1.4,
                        color: RideTokens.n700,
                      ),
                    ),
                    const SizedBox(height: 10),
                  ],
                  if (roster.isEmpty) ...[
                    // NUNCA "estás solo". Otra superficie puede estar
                    // avanzando sin aparecer aquí.
                    WizardBanner(
                      icon: Icons.info_outline_rounded,
                      iconColor: RideTokens.focus,
                      background: RideTokens.infoBg,
                      border: RideTokens.infoBd,
                      child: Text(
                        l10n.coPresenceEmpty,
                        style: const TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w700,
                          color: RideTokens.n800,
                        ),
                      ),
                    ),
                    const SizedBox(height: 8),
                  ],
                  _YouRow(myName: myName),
                  const SizedBox(height: 10),
                  WizardBanner(
                    icon: Icons.visibility_outlined,
                    iconColor: RideTokens.focus,
                    background: RideTokens.infoBg,
                    border: RideTokens.infoBd,
                    child: Text(
                      l10n.coWhoIsHereDisclosure,
                      style: const TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w600,
                        height: 1.4,
                        color: RideTokens.n800,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          RideGhostButton(label: l10n.coSheetClose, onPressed: onClose),
        ],
      ),
    );
  }
}

/// Una superficie acompañante. El estado va con PALABRA ("ahora" / "hace
/// 31 s") además de con el punto: el color nunca es el único portador.
class _PresenceRow extends StatelessWidget {
  const _PresenceRow({required this.entry, required this.offline});

  final PresenceRosterEntry entry;
  final bool offline;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final live = !offline && entry.freshness == PresenceFreshness.live;
    final lastSeen = entry.lastSeenAt;
    final age = lastSeen == null
        ? Duration.zero
        : clock.now().difference(lastSeen);
    final when = live
        ? l10n.coWhoIsHereNow
        : l10n.coWhoIsHereAge(checkoutAgeLabel(l10n, age));
    return Container(
      constraints: const BoxConstraints(minHeight: 56),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: RideTokens.n0,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: RideTokens.n200),
      ),
      child: Row(
        children: [
          _Avatar(entry: entry),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  entry.displayName.isEmpty
                      ? surfaceLabel(l10n, entry.entry.surface)
                      : entry.displayName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w900,
                    color: RideTokens.n900,
                  ),
                ),
                Text(
                  entry.isDevice
                      ? l10n.coWhoIsHereDeviceSub
                      : surfaceLabel(l10n, entry.entry.surface),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    color: RideTokens.n700,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          _Dot(live: live),
          const SizedBox(width: 6),
          Text(
            when,
            style: TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w800,
              // n600 sobre blanco = 5,5:1 (AA a 11,5 px en negrita); el vivo
              // sube a okTx para que el verde tampoco cargue solo el estado.
              color: live ? RideTokens.okTx : RideTokens.n600,
            ),
          ),
        ],
      ),
    );
  }
}

class _Dot extends StatelessWidget {
  const _Dot({required this.live});

  final bool live;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 7,
      height: 7,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        // n500 y no n400: el gris "envejecido" tiene que VERSE, o el punto
        // tendría un solo estado (misma medida que el chip de H1).
        color: live ? RideTokens.ok : RideTokens.n500,
      ),
    );
  }
}

/// APARATO, no persona: cuadrado (no círculo), glifo (no iniciales), rampa
/// neutra (no morada). Un círculo con iniciales "KI" disfrazaría al kiosco de
/// persona, que es exactamente la confusión que esta hoja existe para evitar.
class _Avatar extends StatelessWidget {
  const _Avatar({required this.entry});

  final PresenceRosterEntry entry;

  @override
  Widget build(BuildContext context) {
    if (entry.isDevice) {
      return Container(
        width: 36,
        height: 36,
        decoration: BoxDecoration(
          color: RideTokens.n100,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: RideTokens.n300),
        ),
        child: const Icon(
          Icons.desktop_windows_outlined,
          size: 18,
          color: RideTokens.n700,
        ),
      );
    }
    return Container(
      width: 36,
      height: 36,
      alignment: Alignment.center,
      decoration: const BoxDecoration(
        color: RideTokens.p100,
        shape: BoxShape.circle,
      ),
      child: Text(
        initialsOf(entry.displayName),
        style: const TextStyle(
          fontSize: 13,
          fontWeight: FontWeight.w900,
          color: RideTokens.p800,
        ),
      ),
    );
  }
}

/// "Tú · RideOps — los demás te ven como Ana Ruiz". El reverso vive AQUÍ y en
/// ningún otro sitio.
class _YouRow extends StatelessWidget {
  const _YouRow({required this.myName});

  final String? myName;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Container(
      constraints: const BoxConstraints(minHeight: 56),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: RideTokens.tonal,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: RideTokens.brandA20),
      ),
      child: Row(
        children: [
          Container(
            width: 36,
            height: 36,
            alignment: Alignment.center,
            decoration: const BoxDecoration(
              color: RideTokens.p600,
              shape: BoxShape.circle,
            ),
            child: Text(
              myName == null ? '·' : initialsOf(myName!),
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w900,
                color: RideTokens.n0,
              ),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  l10n.coWhoIsHereYou,
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w900,
                    color: RideTokens.n900,
                  ),
                ),
                Text(
                  myName == null || myName!.isEmpty
                      ? l10n.coWhoIsHereYouSeenAsUnknown
                      : l10n.coWhoIsHereYouSeenAs(myName!),
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    // n700 sobre tonal = 8,4:1.
                    color: RideTokens.n700,
                  ),
                ),
              ],
            ),
          ),
          const _Dot(live: true),
          const SizedBox(width: 6),
          Text(
            l10n.coWhoIsHereNow,
            style: const TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w800,
              color: RideTokens.okTx,
            ),
          ),
        ],
      ),
    );
  }
}
