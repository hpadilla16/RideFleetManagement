import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/db/outbox_db.dart';
import '../../../core/db/outbox_providers.dart';
import '../../../core/l10n/app_localizations.dart';
import '../../../core/outbox/drain_coordinator.dart';
import '../../../core/outbox/network_status.dart';
import '../../../core/outbox/outbox_service.dart';
import '../../../core/theme/ride_tokens.dart';
import '../../../core/widgets/ride_buttons.dart';

/// Bandeja de salida (mockup 7A-7D): la cola local de TODA escritura no
/// financiera, con dead-letter de primera clase — motivo en humano + acción
/// a la medida del motivo. Nada falla en silencio.
class OutboxScreen extends ConsumerWidget {
  const OutboxScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final rows = ref.watch(outboxRowsProvider).value ?? const <OutboxEntry>[];
    final drain = ref.watch(drainCoordinatorProvider);
    final online = ref.watch(_onlineProvider).value ?? true;

    final dead = rows.where((r) => r.status == 'dead').toList();
    final live = rows.where((r) => r.status != 'dead').toList();
    final isFull = rows.length >= OutboxDb.maxRows;

    if (rows.isEmpty) {
      return _EmptyState(l10n: l10n, lastDrainAt: drain.lastDrainAt);
    }

    final pendingIds = live.map((r) => r.id).toSet();
    final pendingPhotoBytes = live
        .where((r) => r.kind == OutboxKinds.inspectionPhoto)
        .fold<int>(0, (sum, r) => sum + (_payload(r)['bytes'] as int? ?? 0));

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 96),
      children: [
        if (isFull) ...[
          _FullHeader(
            l10n: l10n,
            count: rows.length,
            bytes: pendingPhotoBytes,
          ),
          const SizedBox(height: 10),
        ],
        if (drain.running) ...[
          _DrainHeader(l10n: l10n, drain: drain, bytes: pendingPhotoBytes),
          const SizedBox(height: 10),
        ],
        if (dead.isNotEmpty) ...[
          _DangerBanner(text: l10n.outboxDeadBanner(dead.length)),
          const SizedBox(height: 10),
        ],
        // Los muertos ARRIBA (review GD): piden una decisión del humano; lo
        // vivo fluye solo y puede esperar debajo.
        for (final row in dead) ...[
          _DeadRow(row: row, l10n: l10n),
          const SizedBox(height: 10),
        ],
        for (final row in live) ...[
          _LiveRow(row: row, l10n: l10n, pendingIds: pendingIds),
          const SizedBox(height: 10),
        ],
        if (!drain.running && live.isNotEmpty) ...[
          const SizedBox(height: 4),
          RidePrimaryButton(
            // CTA visible pero deshabilitado sin red, con la causa entre
            // paréntesis (nota 7 del mockup 7D) — mejor que esconderlo.
            label: online ? l10n.outboxSendNow : l10n.outboxSendNowNoNetwork,
            onPressed: online
                ? () =>
                    ref.read(drainCoordinatorProvider.notifier).kick('manual')
                : null,
          ),
          if (isFull) ...[
            const SizedBox(height: 8),
            Text(
              l10n.outboxFullCapturesPaused,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w600,
                color: RideTokens.n700,
              ),
            ),
          ],
        ],
      ],
    );
  }
}

/// Red actual (autoDispose: se re-consulta al volver a la pantalla).
final _onlineProvider = FutureProvider.autoDispose<bool>((ref) async {
  try {
    return await ref.watch(networkStatusProvider).hasNetwork();
  } catch (_) {
    return true; // sin plugin (tests): el intento real decide
  }
});

Map<String, dynamic> _payload(OutboxEntry row) {
  try {
    return json.decode(row.payload) as Map<String, dynamic>;
  } catch (_) {
    return const {};
  }
}

String _formatBytes(int bytes) {
  if (bytes >= 1024 * 1024) {
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }
  return '${(bytes / 1024).round()} KB';
}

String _angleLabelFor(AppLocalizations l10n, String? key) => switch (key) {
      'front' => l10n.angleFront,
      'rear' => l10n.angleRear,
      'left' => l10n.angleLeft,
      'right' => l10n.angleRight,
      'front_seat' => l10n.angleFrontSeat,
      'rear_seat' => l10n.angleRearSeat,
      'dash' => l10n.angleDash,
      'trunk' => l10n.angleTrunk,
      _ => key ?? '—',
    };

class _LiveRow extends StatelessWidget {
  const _LiveRow({
    required this.row,
    required this.l10n,
    required this.pendingIds,
  });

  final OutboxEntry row;
  final AppLocalizations l10n;
  final Set<String> pendingIds;

  @override
  Widget build(BuildContext context) {
    final payload = _payload(row);
    final reservation = payload['reservationNumber'] as String? ??
        payload['reservationId'] as String? ??
        '—';
    final isPhoto = row.kind == OutboxKinds.inspectionPhoto;
    final uploading = row.status == 'inflight';
    // "Espera sus fotos" (nota 2 del mockup): un complete cuya dependencia
    // sigue viva en la bandeja jamás se manda antes que ella.
    final waitsPhotos = !isPhoto &&
        row.dependsOn != null &&
        pendingIds.contains(row.dependsOn);

    final title = isPhoto
        ? l10n.outboxItemPhoto(
            _angleLabelFor(l10n, payload['angleKey'] as String?))
        : l10n.outboxItemComplete;
    final meta = isPhoto
        ? l10n.outboxItemMetaPhoto(
            reservation, _formatBytes(payload['bytes'] as int? ?? 0))
        : l10n.outboxItemMetaComplete(reservation);
    final statusLabel = uploading
        ? l10n.outboxStatusUploading
        : waitsPhotos
            ? l10n.outboxStatusWaitsPhotos
            : l10n.outboxStatusQueued;

    return _RowShell(
      icon: isPhoto ? Icons.photo_camera_outlined : Icons.description_outlined,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 14.5,
                    fontWeight: FontWeight.w800,
                    color: RideTokens.n900,
                  ),
                ),
              ),
              _Chip(
                label: statusLabel,
                bg: uploading ? RideTokens.p50 : RideTokens.n50,
                border: uploading ? RideTokens.brandA20 : RideTokens.n200,
                fg: uploading ? RideTokens.p800 : RideTokens.n700,
              ),
            ],
          ),
          const SizedBox(height: 3),
          Text(
            meta,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w600,
              color: RideTokens.n600,
            ),
          ),
          if (uploading) ...[
            const SizedBox(height: 6),
            // TODO(M2): progreso determinista por bytes reales vía
            // onSendProgress de Dio enchufado al drenador — hoy la barra es
            // de actividad. Con reduced-motion se CONGELA (review GD): el
            // estado ya lo dice el chip "Subiendo".
            ClipRRect(
              borderRadius: const BorderRadius.all(Radius.circular(4)),
              child: LinearProgressIndicator(
                minHeight: 7,
                value: MediaQuery.of(context).disableAnimations ? 1 : null,
                color: RideTokens.p600,
                backgroundColor: RideTokens.n200,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _DeadRow extends ConsumerWidget {
  const _DeadRow({required this.row, required this.l10n});

  final OutboxEntry row;
  final AppLocalizations l10n;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final payload = _payload(row);
    final reservation = payload['reservationNumber'] as String? ??
        payload['reservationId'] as String? ??
        '—';
    final reservationId = payload['reservationId'] as String?;
    final isPhoto = row.kind == OutboxKinds.inspectionPhoto;
    final angle = _angleLabelFor(l10n, payload['angleKey'] as String?);
    final code = row.lastErrorCode;

    // Motivo en humano + acción a la medida (nota 4 del mockup 7B). Codes
    // del drenador: REQUIRED_ANGLES_MISSING → abrir inspección; TOKEN_* →
    // reintentar como acción PRIMARIA (mockup 7B — es 100 % recuperable: el
    // drenado re-mintea con la sesión y el pre-check evita duplicados);
    // PHOTO_LOST / SESSION_GONE → solo descartar.
    final (reason, canRetry, retryIsPrimary, canOpenInspection) =
        switch (code) {
      'REQUIRED_ANGLES_MISSING' => (
          l10n.outboxReasonAnglesMissing,
          false,
          false,
          true
        ),
      _ when code?.startsWith('TOKEN_') ?? false => (
          l10n.outboxReasonToken,
          true,
          true,
          false
        ),
      'PHOTO_LOST' => (l10n.outboxReasonPhotoLost, false, false, false),
      'SESSION_GONE' => (l10n.outboxReasonSessionGone, false, false, false),
      null => (l10n.outboxReasonNetwork, true, false, false),
      _ => (l10n.outboxReasonGeneric, true, false, false),
    };

    final title = isPhoto ? l10n.outboxItemPhoto(angle) : l10n.outboxItemComplete;
    final lastTime = TimeOfDay.fromDateTime(row.updatedAt.toLocal());

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFFFFFBFB),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: RideTokens.dangerBd, width: 1.5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(
                  color: RideTokens.dangerBg,
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Icon(
                  isPhoto
                      ? Icons.photo_camera_outlined
                      : Icons.description_outlined,
                  size: 20,
                  color: RideTokens.dangerTx,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 14.5,
                              fontWeight: FontWeight.w800,
                              color: RideTokens.n900,
                            ),
                          ),
                        ),
                        _Chip(
                          label: l10n.outboxStatusRejected,
                          bg: RideTokens.dangerBg,
                          border: RideTokens.dangerBd,
                          fg: RideTokens.dangerTx,
                        ),
                      ],
                    ),
                    const SizedBox(height: 3),
                    Text(
                      '$reservation · '
                      '${l10n.outboxAttempts(row.attempts, lastTime.format(context))}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w600,
                        color: RideTokens.n600,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
            decoration: BoxDecoration(
              color: RideTokens.dangerBg,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: RideTokens.dangerBd),
            ),
            child: Text(
              reason,
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w700,
                color: RideTokens.dangerTx,
                height: 1.4,
              ),
            ),
          ),
          // Detalle técnico crudo, plegado — para soporte (nota 4). El
          // Material transparente existe porque el ListTile del
          // ExpansionTile pinta su tinta en el Material más cercano — sin
          // él, el fondo del card lo taparía (assert del framework).
          if (row.lastError != null)
            Material(
              type: MaterialType.transparency,
              child: Theme(
                data: Theme.of(context)
                    .copyWith(dividerColor: Colors.transparent),
                child: ExpansionTile(
                  tilePadding: EdgeInsets.zero,
                  childrenPadding: const EdgeInsets.only(bottom: 8),
                  title: Text(
                    l10n.outboxTechnicalDetail(code ?? '—', ''),
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: RideTokens.n600,
                    ),
                  ),
                  children: [
                    Align(
                      alignment: Alignment.centerLeft,
                      child: Text(
                        row.lastError!,
                        style: const TextStyle(
                          fontSize: 12,
                          color: RideTokens.n700,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          const SizedBox(height: 8),
          Row(
            children: [
              if (canOpenInspection && reservationId != null) ...[
                Expanded(
                  child: RideGhostButton(
                    label: l10n.outboxActionOpenInspection,
                    onPressed: () => context.go('/inspection/$reservationId'),
                  ),
                ),
                const SizedBox(width: 8),
              ],
              if (canRetry) ...[
                Expanded(
                  child: retryIsPrimary
                      ? RidePrimaryButton(
                          label: l10n.retryButton,
                          onPressed: () => _retry(ref),
                        )
                      : RideGhostButton(
                          label: l10n.retryButton,
                          onPressed: () => _retry(ref),
                        ),
                ),
                const SizedBox(width: 8),
              ],
              Expanded(
                child: _DangerGhostButton(
                  label: l10n.outboxActionDiscard,
                  onPressed: () => _confirmDiscard(context, ref),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _retry(WidgetRef ref) async {
    await ref.read(outboxServiceProvider).retryDead(row.id);
    await ref.read(drainCoordinatorProvider.notifier).kick('manual_retry');
  }

  Future<void> _confirmDiscard(BuildContext context, WidgetRef ref) async {
    final payload = _payload(row);
    final reservation = payload['reservationNumber'] as String? ??
        payload['reservationId'] as String? ??
        '—';
    final isPhoto = row.kind == OutboxKinds.inspectionPhoto;
    final angle = _angleLabelFor(l10n, payload['angleKey'] as String?);

    final confirmed = await showModalBottomSheet<bool>(
      context: context,
      // Plate opaco .96 (política de blur: el único BackdropFilter de la
      // pantalla ya lo tendría el tab bar; aquí JAMÁS se suma otro).
      backgroundColor: const Color(0xF5FFFFFF),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
      ),
      builder: (context) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              width: 44,
              height: 5,
              margin: const EdgeInsets.only(bottom: 12),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: RideTokens.n300,
                borderRadius: BorderRadius.circular(3),
              ),
            ),
            Text(
              l10n.outboxDiscardTitle,
              style: const TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.w800,
                color: RideTokens.n900,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              // Consecuencias explícitas: qué se pierde y qué NO se toca.
              isPhoto
                  ? l10n.outboxDiscardBodyPhoto(angle, reservation)
                  : l10n.outboxDiscardBodyComplete(reservation),
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w600,
                color: RideTokens.n700,
                height: 1.45,
              ),
            ),
            const SizedBox(height: 14),
            Material(
              color: RideTokens.danger,
              borderRadius: BorderRadius.circular(18),
              child: InkWell(
                onTap: () => Navigator.of(context).pop(true),
                borderRadius: BorderRadius.circular(18),
                child: Container(
                  constraints: const BoxConstraints(minHeight: 56),
                  alignment: Alignment.center,
                  child: Text(
                    l10n.outboxDiscardConfirm,
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 16,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 8),
            RideGhostButton(
              label: l10n.outboxDiscardKeep,
              onPressed: () => Navigator.of(context).pop(false),
            ),
          ],
        ),
      ),
    );
    if (confirmed == true) {
      // Descarte con RASTRO de auditoría local sincronizable (quién/qué/
      // motivo/hora) — criterio del mockup 7B′.
      await ref.read(outboxServiceProvider).discardDead(row);
    }
  }
}

class _RowShell extends StatelessWidget {
  const _RowShell({required this.icon, required this.child});

  final IconData icon;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: RideTokens.n0,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0x248752FE)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: const Color(0x148752FE),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Icon(icon, size: 20, color: RideTokens.p700),
          ),
          const SizedBox(width: 12),
          Expanded(child: child),
        ],
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({
    required this.label,
    required this.bg,
    required this.border,
    required this.fg,
  });

  final String label;
  final Color bg;
  final Color border;
  final Color fg;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: border),
      ),
      child: Text(
        label.toUpperCase(),
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.4,
          color: fg,
        ),
      ),
    );
  }
}

class _DrainHeader extends StatelessWidget {
  const _DrainHeader({
    required this.l10n,
    required this.drain,
    required this.bytes,
  });

  final AppLocalizations l10n;
  final DrainStatus drain;
  final int bytes;

  @override
  Widget build(BuildContext context) {
    final fraction =
        drain.total == 0 ? 0.0 : (drain.done / drain.total).clamp(0.0, 1.0);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: RideTokens.tonal,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: const Color(0x248752FE)),
      ),
      child: Row(
        children: [
          SizedBox(
            width: 64,
            height: 64,
            child: Stack(
              fit: StackFit.expand,
              children: [
                CircularProgressIndicator(
                  value: fraction,
                  strokeWidth: 6,
                  color: RideTokens.p600,
                  backgroundColor: RideTokens.n200,
                ),
                Center(
                  child: Text(
                    // La fracción en texto manda; el arco es redundante
                    // (nota 1 del mockup 7A).
                    '${drain.done}/${drain.total}',
                    style: const TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w800,
                      color: RideTokens.n900,
                      fontFeatures: [FontFeature.tabularFigures()],
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  l10n.outboxDraining,
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w800,
                    color: RideTokens.n900,
                  ),
                ),
                Text(
                  '${l10n.outboxDrainProgress(drain.done, drain.total)} · '
                  '${l10n.outboxDrainRemaining(_formatBytes(bytes))}',
                  style: const TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                    color: RideTokens.n700,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _FullHeader extends StatelessWidget {
  const _FullHeader({
    required this.l10n,
    required this.count,
    required this.bytes,
  });

  final AppLocalizations l10n;
  final int count;
  final int bytes;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: RideTokens.warnBg,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: RideTokens.warnBd, width: 1.5),
      ),
      child: Column(
        children: [
          Text(
            l10n.outboxFullTitle,
            style: const TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w800,
              color: RideTokens.n900,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            // El tope PAUSA, no purga (nota 7): la única instrucción es
            // conéctate.
            l10n.outboxFullBody(count),
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 13.5,
              fontWeight: FontWeight.w600,
              color: RideTokens.warnTx,
              height: 1.45,
            ),
          ),
          const SizedBox(height: 8),
          _Chip(
            label: l10n.outboxFullChip(
                count, OutboxDb.maxRows, _formatBytes(bytes)),
            bg: RideTokens.n0,
            border: RideTokens.warnBd,
            fg: RideTokens.warnTx,
          ),
        ],
      ),
    );
  }
}

class _DangerBanner extends StatelessWidget {
  const _DangerBanner({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: RideTokens.dangerBg,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: RideTokens.dangerBd),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.error_outline_rounded,
              size: 18, color: RideTokens.dangerTx),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(
                fontSize: 13.5,
                fontWeight: FontWeight.w600,
                color: RideTokens.dangerTx,
                height: 1.45,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _DangerGhostButton extends StatelessWidget {
  const _DangerGhostButton({required this.label, required this.onPressed});

  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: RideTokens.n0,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(14),
        child: Container(
          constraints: const BoxConstraints(minHeight: 48),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            border: Border.all(color: RideTokens.dangerBd, width: 1.5),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Text(
            label,
            style: const TextStyle(
              color: RideTokens.dangerTx,
              fontSize: 14.5,
              fontWeight: FontWeight.w800,
            ),
          ),
        ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.l10n, required this.lastDrainAt});

  final AppLocalizations l10n;
  final DateTime? lastDrainAt;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 64,
              height: 64,
              decoration: BoxDecoration(
                color: RideTokens.okBg,
                shape: BoxShape.circle,
              ),
              child:
                  const Icon(Icons.check_rounded, size: 30, color: RideTokens.okTx),
            ),
            const SizedBox(height: 12),
            Text(
              l10n.outboxEmptyTitle,
              style: const TextStyle(
                fontSize: 22,
                fontWeight: FontWeight.w800,
                color: RideTokens.n900,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              l10n.outboxEmptyBody,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w500,
                color: RideTokens.n700,
              ),
            ),
            if (lastDrainAt != null) ...[
              const SizedBox(height: 12),
              _Chip(
                label: l10n.outboxLastDrain(
                  TimeOfDay.fromDateTime(lastDrainAt!.toLocal())
                      .format(context),
                ),
                bg: RideTokens.okBg,
                border: RideTokens.okBd,
                fg: RideTokens.okTx,
              ),
            ],
          ],
        ),
      ),
    );
  }
}
