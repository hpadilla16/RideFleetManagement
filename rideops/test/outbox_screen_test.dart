import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:drift/drift.dart' show Value;
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/db/outbox_db.dart';
import 'package:rideops/core/db/outbox_providers.dart';
import 'package:rideops/core/outbox/drain_coordinator.dart';
import 'package:rideops/core/outbox/network_status.dart';
import 'package:rideops/core/outbox/outbox_service.dart';
import 'package:rideops/core/outbox/photo_vault.dart';
import 'package:rideops/core/session/active_location.dart';
import 'package:rideops/core/session/session_controller.dart';
import 'package:rideops/core/session/session_state.dart';
import 'package:rideops/features/outbox/presentation/outbox_screen.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/outbox_test_helpers.dart';
import 'helpers/shell_test_helpers.dart';

/// Bandeja UI (H5, mockup 7A-7D): motivo en humano + acción a la medida del
/// code, descarte con sheet de consecuencias + rastro, tope que pausa y
/// estado feliz.
void main() {
  const tenantId = 'cmdten001fixture0000000001';

  late OutboxDb db;
  late Directory tempDir;
  late PhotoVault vault;
  late FakeNetworkStatus network;
  late ProviderContainer container;

  /// El contenedor de la bandeja. [drainRunning] sustituye el coordinador por
  /// uno que declara una corrida VIVA: es la única forma de llegar al estado
  /// "Subiendo" desde un widget test, y sin él la prueba de la barra pasaría
  /// por el motivo equivocado (sin corrida no hay barra, se mire el
  /// reduced-motion o no).
  ///
  /// Los overrides van INLINE y no en una lista hoisted porque el tipo
  /// `Override` no está exportado por riverpod 3.4.2 y no se puede nombrar.
  ProviderContainer buildContainer({bool drainRunning = false}) {
    return ProviderContainer(overrides: [
      sessionControllerProvider.overrideWith(
        () => StubSessionController(
          SessionState.authenticated(
            token: fakeJwt(
              exp: DateTime.now().add(const Duration(hours: 8)),
              sub: kFixtureUserId,
            ),
            user: sessionUserFixture(),
          ),
        ),
      ),
      activeLocationStoreProvider
          .overrideWithValue(InMemoryActiveLocationStore()),
      outboxDbProvider.overrideWithValue(db),
      photoVaultProvider.overrideWithValue(vault),
      networkStatusProvider.overrideWithValue(network),
      if (drainRunning)
        drainCoordinatorProvider.overrideWith(_DrenadoEnCurso.new),
    ]);
  }

  setUp(() {
    db = OutboxDb(NativeDatabase.memory());
    tempDir = Directory.systemTemp.createTempSync('rideops_tray_test');
    vault = tempVault(tempDir);
    network = FakeNetworkStatus(online: false);
    container = buildContainer();
    addTearDown(container.dispose);
  });

  tearDown(() async {
    await db.close();
    try {
      tempDir.deleteSync(recursive: true);
    } catch (_) {}
  });

  Future<void> seedRow({
    required String id,
    required String kind,
    String status = 'pending',
    String? code,
    // Status HTTP de la respuesta que mató la fila, o null = no hubo
    // respuesta. Es el dato que separa "sin señal" de "el servidor dijo que
    // no": ver los casos de _DeadRow más abajo.
    int? httpStatus,
    String? photoPath,
    String? dependsOn,
    int attempts = 0,
    // Otra superficie ya cerró la inspección de esta sesión (columna
    // sessionSealedAt, sellada por discardSession).
    bool sessionSealed = false,
  }) async {
    final now = DateTime.now();
    await db.into(db.outboxEntries).insert(OutboxEntriesCompanion.insert(
          id: id,
          userId: kFixtureUserId,
          tenantId: tenantId,
          kind: kind,
          groupKey: const Value('cs1'),
          payload: json.encode({
            'checkoutSessionId': 'cs1',
            'reservationId': 'r1',
            'reservationNumber': 'R-2492',
            if (kind == OutboxKinds.inspectionPhoto) 'angleKey': 'trunk',
            if (kind == OutboxKinds.inspectionPhoto) 'bytes': 402 * 1024,
            'photoPath': ?photoPath,
          }),
          dependsOn: Value(dependsOn),
          idempotencyKey: 'ik-$id',
          status: Value(status),
          attempts: Value(attempts),
          lastError: Value(code == null && status == 'dead' ? 'red' : code),
          lastErrorCode: Value(code),
          lastErrorStatus: Value(httpStatus),
          sessionSealedAt: Value(sessionSealed ? now : null),
          createdAt: now,
          updatedAt: now,
        ));
  }

  Widget tray({ProviderContainer? on, bool reducedMotion = false}) {
    final body = l10nApp(const Scaffold(body: OutboxScreen()));
    return UncontrolledProviderScope(
      container: on ?? container,
      child: reducedMotion
          ? MediaQuery(
              data: const MediaQueryData(disableAnimations: true),
              child: body,
            )
          : body,
    );
  }

  testWidgets('vacía = estado feliz', (tester) async {
    await tester.pumpWidget(tray());
    await tester.pumpAndSettle();
    expect(find.text('All sent'), findsOneWidget);
  });

  testWidgets(
      'dead-letter REQUIRED_ANGLES_MISSING: motivo humano + "Abrir '
      'inspección", sin Reintentar', (tester) async {
    await seedRow(
      id: 'c1',
      kind: OutboxKinds.inspectionComplete,
      status: 'dead',
      code: 'REQUIRED_ANGLES_MISSING',
      attempts: 5,
    );
    await tester.pumpWidget(tray());
    await tester.pumpAndSettle();

    expect(find.textContaining('front and rear angles are missing'),
        findsOneWidget);
    expect(find.text('Open inspection'), findsOneWidget);
    expect(find.text('Discard'), findsOneWidget);
    expect(find.text('Retry'), findsNothing,
        reason: 'reintentar sin las fotos daría el mismo 400');
    expect(find.textContaining('needs your decision'), findsOneWidget);
    // GD-MC-4: el motivo no puede nombrar un botón que la fila no ofrece.
    expect(
      find.textContaining('Capture them and retry'),
      findsNothing,
      reason: 'no hay Reintentar aquí, y sin reservationId tampoco habría '
          '"Abrir inspección": el texto mandaba a un sitio inexistente',
    );
  });

  testWidgets('dead-letter TOKEN_EXPIRED: Reintentar re-encola y drena',
      (tester) async {
    await seedRow(
      id: 'p1',
      kind: OutboxKinds.inspectionPhoto,
      status: 'dead',
      code: 'TOKEN_EXPIRED',
      attempts: 2,
    );
    await tester.pumpWidget(tray());
    await tester.pumpAndSettle();

    expect(find.textContaining('upload permit expired'), findsOneWidget);
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();

    final row = (await db.allFor(userId: kFixtureUserId, tenantId: tenantId))
        .single;
    expect(row.status, 'pending');
    expect(row.attempts, 0, reason: 'el humano decidió: contador de nuevo');
  });

  // ——— F3 de la segunda corrida e2e: "Reintentar" tiene que poder ganar ———

  testWidgets(
      'F3 — dead-letter de foto CON binario en disco: Reintentar sigue en pie',
      (tester) async {
    // Desde el arreglo del drenador, morir ya no borra el archivo.
    final name = await vault.store(Uint8List.fromList(List.filled(64, 7)));
    await seedRow(
      id: 'pviva',
      kind: OutboxKinds.inspectionPhoto,
      status: 'dead',
      code: 'TOKEN_EXPIRED',
      photoPath: name,
      attempts: 2,
    );
    await tester.pumpWidget(tray());
    await tester.pumpAndSettle();

    expect(find.text('Retry'), findsOneWidget);
    expect(find.textContaining('no longer on this phone'), findsNothing);
  });

  testWidgets(
      'F3 — dead-letter de foto SIN binario (teléfono que viene de una versión '
      'anterior): solo Descartar, y dice por qué', (tester) async {
    // El archivo NUNCA existió en la bóveda: es el residuo de cuando el
    // drenador borraba el binario al morir la fila. Ofrecer "Reintentar" aquí
    // es una puerta falsa — muere otra vez con PHOTO_LOST.
    await seedRow(
      id: 'pfantasma',
      kind: OutboxKinds.inspectionPhoto,
      status: 'dead',
      code: 'TOKEN_EXPIRED',
      photoPath: 'ph_borrada_en_una_version_anterior.bin',
      attempts: 2,
    );
    await tester.pumpWidget(tray());
    await tester.pumpAndSettle();

    expect(find.text('Retry'), findsNothing,
        reason: 'sin foto, reintentar solo puede volver a morir');
    expect(find.text('Discard'), findsOneWidget);
    expect(find.textContaining('no longer on this phone'), findsOneWidget,
        reason: 'el motivo manda sobre el code que la mató');
  });

  testWidgets(
      'MINOR-2 — dead-letter de una sesión que otra pantalla ya selló: sin '
      'Reintentar, y con el motivo escrito', (tester) async {
    // El reintento re-acuñaría el token contra una inspección cerrada y
    // moriría con SESSION_GONE. Se corrige solo y la evidencia sobrevive,
    // pero es una puerta que no puede abrirse — y esta pantalla no ofrece de
    // esas.
    final name = await vault.store(Uint8List.fromList(List.filled(64, 3)));
    await seedRow(
      id: 'psellada',
      kind: OutboxKinds.inspectionPhoto,
      status: 'dead',
      // Un code que SÍ ofrecería Reintentar, y de los primarios: sin el
      // sellado, esta fila enseñaría el botón más grande de la tarjeta.
      code: 'TOKEN_EXPIRED',
      photoPath: name,
      attempts: 2,
      sessionSealed: true,
    );
    await tester.pumpWidget(tray());
    await tester.pumpAndSettle();

    expect(find.text('Retry'), findsNothing);
    expect(find.text('Discard'), findsOneWidget);
    expect(
      find.textContaining('Another screen closed this inspection'),
      findsOneWidget,
    );
    // Las dos mitades que el agente necesita: no se perdió la inspección, y
    // su evidencia sigue aquí.
    expect(find.textContaining('sealed with what did arrive'), findsOneWidget);
    expect(find.textContaining('stays on the phone'), findsOneWidget);
    // Y el diagnóstico de soporte NO se pisó con el hecho nuevo.
    expect(find.text('Technical detail: TOKEN_EXPIRED'), findsOneWidget);
  });

  testWidgets(
      'F4 — fila en inflight SIN corrida viva: "En cola", no "Subiendo" con '
      'barra animada', (tester) async {
    // ORDEN DELIBERADO: la bandeja se monta primero (su kick de arranque ya
    // pasó) y la fila queda en `inflight` DESPUÉS. Sembrarla antes no prueba
    // esta pantalla: el rescate del coordinador —el arreglo F4— la devuelve a
    // `pending` antes del primer frame y la aserción pasaría sin llegar a la
    // línea. El hueco que queda es el real: una corrida que muere a media
    // subida en este proceso, o el isolate de background dejando la fila así
    // mientras la bandeja está abierta.
    await tester.pumpWidget(tray());
    await tester.pumpAndSettle();
    await seedRow(
      id: 'phuerfana',
      kind: OutboxKinds.inspectionPhoto,
      status: 'inflight',
    );
    await tester.pumpAndSettle();

    // `inflight` sobrevive a la muerte del proceso: la fila puede llevar
    // horas ahí sin un solo POST detrás (corrida e2e 2). Afirmar la subida
    // con una barra en movimiento era la parte visible de ese defecto.
    expect(find.text('QUEUED'), findsOneWidget);
    expect(find.text('UPLOADING'), findsNothing);
    expect(find.byType(LinearProgressIndicator), findsNothing);
  });

  // ——— Defecto 2 de la prueba de humo en el emulador ———
  //
  // Un 404 del backend SIN `code` en el cuerpo (el backend no lo manda en
  // todos los 4xx) caía en la rama `null =>` y la bandeja decía "Reintenta
  // cuando haya señal" con cobertura perfecta. El empleado sale a buscar red
  // por un problema que no está en su teléfono, y el envío no se recupera
  // jamás. Lo que decide ahora es si HUBO respuesta (lastErrorStatus), no si
  // el backend se acordó de mandar `code`.

  testWidgets(
      'rechazo del servidor SIN code (404): no lo llama falta de señal',
      (tester) async {
    await seedRow(
      id: 'c404',
      kind: OutboxKinds.inspectionComplete,
      status: 'dead',
      code: null, // el 404 vino sin `code` — como en el emulador
      httpStatus: 404,
      attempts: 1,
    );
    await tester.pumpWidget(tray());
    await tester.pumpAndSettle();

    expect(
      find.text(
        'The server rejected this item. Open the technical detail and send it to support before discarding it.',
      ),
      findsOneWidget,
    );
    expect(
      find.textContaining('Retry when there is signal'),
      findsNothing,
      reason: 'hubo respuesta del servidor: la señal no tiene nada que ver',
    );
    // Y el detalle plegado dice el hecho de transporte, sin separador
    // colgando (defecto 3: antes se pasaba '' como segundo hueco).
    expect(find.text('Technical detail: HTTP 404'), findsOneWidget);
  });

  testWidgets('sin respuesta del servidor: eso SÍ es falta de señal',
      (tester) async {
    await seedRow(
      id: 'cnet',
      kind: OutboxKinds.inspectionComplete,
      status: 'dead',
      code: null,
      httpStatus: null, // nunca llegó una respuesta
      attempts: 8,
    );
    await tester.pumpWidget(tray());
    await tester.pumpAndSettle();

    expect(
      find.textContaining('Retry when there is signal'),
      findsOneWidget,
      reason: 'este es el ÚNICO caso en que el consejo de la señal aplica',
    );
    expect(
      find.textContaining('The server rejected this item'),
      findsNothing,
    );
    // Sin code ni status no hay nada que juntar: la etiqueta sola.
    expect(find.text('Technical detail'), findsOneWidget);
  });

  testWidgets('5xx agotado: el servidor contestó, pero no fue un rechazo',
      (tester) async {
    await seedRow(
      id: 'c503',
      kind: OutboxKinds.inspectionComplete,
      status: 'dead',
      code: null,
      httpStatus: 503,
      attempts: 8,
    );
    await tester.pumpWidget(tray());
    await tester.pumpAndSettle();

    expect(
      find.textContaining("It's not your connection"),
      findsOneWidget,
    );
    expect(find.textContaining('Retry when there is signal'), findsNothing);
    expect(find.textContaining('The server rejected this item'), findsNothing,
        reason: 'un 503 no es un rechazo de lo que se mandó');
    expect(find.text('Technical detail: HTTP 503'), findsOneWidget);
  });

  // Review GD-M1 + S4. Los dos brazos de status colgaban de `code == null`,
  // así que un 5xx/429 que SÍ trae code — los 429 lo traen de rutina — se
  // iba al genérico "El servidor rechazó este envío": la misma culpa mal
  // repartida que este lote existe para matar, por la otra puerta. Nada lo
  // probaba porque el único caso cubierto tenía code null.
  //
  // La fila se siembra directo porque `markFailed` acepta code y status por
  // SEPARADO: la combinación es escribible por cualquier llamador del store
  // aunque hoy el drenador no la genere, y el render no puede depender de
  // que uno esté vacío para honrar el otro.
  testWidgets('5xx CON code: sigue siendo "no es tu conexión", no un rechazo',
      (tester) async {
    await seedRow(
      id: 'c429',
      kind: OutboxKinds.inspectionComplete,
      status: 'dead',
      code: 'RATE_LIMITED',
      httpStatus: 429,
      attempts: 8,
    );
    await tester.pumpWidget(tray());
    await tester.pumpAndSettle();

    expect(
      find.textContaining("It's not your connection"),
      findsOneWidget,
      reason: 'el status manda: que el backend mandara code no convierte '
          'un 429 en un rechazo de lo que se envió',
    );
    expect(find.textContaining('The server rejected this item'), findsNothing);
    expect(find.textContaining('Retry when there is signal'), findsNothing);
    // El code sí viaja al detalle técnico: no se pierde información.
    expect(find.text('Technical detail: RATE_LIMITED · HTTP 429'),
        findsOneWidget);
  });

  testWidgets('code + status: el detalle junta los dos, con un solo separador',
      (tester) async {
    await seedRow(
      id: 'c400',
      kind: OutboxKinds.inspectionComplete,
      status: 'dead',
      code: 'REQUIRED_ANGLES_MISSING',
      httpStatus: 400,
      attempts: 1,
    );
    await tester.pumpWidget(tray());
    await tester.pumpAndSettle();

    expect(
      find.text('Technical detail: REQUIRED_ANGLES_MISSING · HTTP 400'),
      findsOneWidget,
    );
    // El motivo lo sigue mandando el code, no el status.
    expect(find.textContaining('front and rear angles are missing'),
        findsOneWidget);
  });

  testWidgets('PHOTO_LOST: solo Descartar (no hay nada que reintentar)',
      (tester) async {
    await seedRow(
      id: 'p1',
      kind: OutboxKinds.inspectionPhoto,
      status: 'dead',
      code: 'PHOTO_LOST',
    );
    await tester.pumpWidget(tray());
    await tester.pumpAndSettle();
    expect(find.text('Retry'), findsNothing);
    expect(find.text('Open inspection'), findsNothing);
    expect(find.text('Discard'), findsOneWidget);
  });

  testWidgets('descarte: sheet con consecuencias + rastro + archivo borrado',
      (tester) async {
    final name =
        await vault.store(Uint8List.fromList(List.filled(200, 7)));
    await seedRow(
      id: 'p1',
      kind: OutboxKinds.inspectionPhoto,
      status: 'dead',
      code: 'SESSION_GONE',
      photoPath: name,
    );
    await tester.pumpWidget(tray());
    await tester.pumpAndSettle();

    // GD-MC-4: el brazo sin Reintentar dice POR QUÉ no lo hay y QUÉ no se
    // perdió — el modelo de coCloseNoRetry. Antes era un hecho a secas y el
    // agente decidía a ciegas si estaba destruyendo algo.
    expect(find.textContaining("can't be retried from here"), findsOneWidget);
    expect(
      find.textContaining('still on the reservation'),
      findsOneWidget,
      reason: 'antes de un botón destructivo hay que decir qué NO se pierde',
    );
    expect(find.text('Retry'), findsNothing);

    await tester.tap(find.text('Discard'));
    await tester.pumpAndSettle();
    // Consecuencias explícitas antes del botón destructivo.
    expect(find.textContaining('will be deleted from this phone'),
        findsOneWidget);

    // La opción segura conserva.
    await tester.tap(find.text('Keep in outbox'));
    await tester.pumpAndSettle();
    expect(await db.totalRows(), 1);

    await tester.tap(find.text('Discard'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Yes, discard'));
    await tester.pumpAndSettle();

    expect(await db.totalRows(), 0);
    expect(await vault.read(name), isNull, reason: 'el binario también se va');
    final audit = await db.auditRows();
    expect(audit.single.reasonCode, 'SESSION_GONE',
        reason: 'rastro de auditoría: quién/qué/motivo/hora');
    expect(audit.single.userId, kFixtureUserId);
  });

  testWidgets('cadena visible: el complete "espera sus fotos"',
      (tester) async {
    await seedRow(id: 'p1', kind: OutboxKinds.inspectionPhoto);
    await seedRow(
      id: 'c1',
      kind: OutboxKinds.inspectionComplete,
      dependsOn: 'p1',
    );
    await tester.pumpWidget(tray());
    await tester.pumpAndSettle();
    expect(find.text('WAITS FOR ITS PHOTOS'), findsOneWidget);
    expect(find.text('QUEUED'), findsOneWidget);
  });

  testWidgets('tope: banner "llena" + CTA honesto deshabilitado sin red',
      (tester) async {
    for (var i = 0; i < OutboxDb.maxRows; i++) {
      await seedRow(id: 'row-$i', kind: OutboxKinds.inspectionPhoto);
    }
    await tester.pumpWidget(tray());
    await tester.pumpAndSettle();

    expect(find.text('The outbox is full'), findsOneWidget);
    // El CTA y su nota viven al FINAL de la lista de 50 — scrollear hasta
    // ellos (el ListView construye perezoso).
    await tester.dragUntilVisible(
      find.text('Send now (no signal)'),
      find.byType(ListView),
      const Offset(0, -400),
    );
    // Sin red: el CTA existe pero dice la causa y no dispara nada.
    expect(find.text('Send now (no signal)'), findsOneWidget);
    expect(find.textContaining('New captures are paused'), findsOneWidget);
  });

  testWidgets(
      'GD-SC-1 — bandeja llena CON rechazados: la decisión va ARRIBA de la '
      'instrucción de red, y el conteo se dice UNA vez', (tester) async {
    for (var i = 0; i < OutboxDb.maxRows - 1; i++) {
      await seedRow(id: 'row-$i', kind: OutboxKinds.inspectionPhoto);
    }
    await seedRow(
      id: 'muerta',
      kind: OutboxKinds.inspectionPhoto,
      status: 'dead',
      code: 'TOKEN_EXPIRED',
      attempts: 3,
    );
    await tester.pumpWidget(tray());
    await tester.pumpAndSettle();

    final decision = find.textContaining('needs your decision');
    final red = find.textContaining('connect to a network');
    expect(decision, findsOneWidget);
    expect(red, findsOneWidget);
    // Mandar primero a buscar señal, con el muro puesto por filas que la
    // señal no mueve, es mandar al agente a caminar en balde.
    expect(
      tester.getTopLeft(decision).dy,
      lessThan(tester.getTopLeft(red).dy),
      reason: 'la acción que SÍ puede tomar ahí de pie va primero',
    );

    // El bloque ámbar dice que los rechazados no se van con la red, y NO
    // repite el número que el banner rojo ya dio.
    expect(
      find.textContaining('waiting for your decision below'),
      findsOneWidget,
    );
    expect(find.textContaining('1 of them'), findsNothing);
    expect(find.textContaining('retry it or discard it'), findsNothing,
        reason: 'el bloque no nombra botones: cada fila trae los suyos');
  });

  testWidgets(
      'GD-MC-6 — con reduced-motion la barra de "Subiendo" NO se pinta: una '
      'barra quieta al 100 % afirma "completo"', (tester) async {
    // Una corrida VIVA de verdad: sin ella `uploading` es false y la barra no
    // se pintaría por otro motivo — la prueba pasaría sin tocar la línea.
    final corriendo = buildContainer(drainRunning: true);
    addTearDown(corriendo.dispose);
    await seedRow(
      id: 'psubiendo',
      kind: OutboxKinds.inspectionPhoto,
      status: 'inflight',
    );

    // Con movimiento: la barra ESTÁ (es de actividad, así que anima — de ahí
    // `pump` y no `pumpAndSettle`, que esperaría un reposo que no llega).
    await tester.pumpWidget(tray(on: corriendo));
    await tester.pump();
    await tester.pump();
    expect(find.text('UPLOADING'), findsOneWidget);
    expect(find.byType(LinearProgressIndicator), findsOneWidget);

    // Sin movimiento: la barra desaparece en vez de congelarse llena. El
    // estado sigue dicho, con palabras, por el chip.
    await tester.pumpWidget(tray(on: corriendo, reducedMotion: true));
    await tester.pump();
    expect(find.byType(LinearProgressIndicator), findsNothing);
    expect(find.text('UPLOADING'), findsOneWidget);
  });
}

/// Coordinador con una corrida EN CURSO, sin red ni timers: la bandeja solo
/// mira `DrainStatus.running`, así que se sustituye el estado y nada más.
class _DrenadoEnCurso extends DrainCoordinator {
  @override
  DrainStatus build() => const DrainStatus(running: true, done: 0, total: 1);
}
