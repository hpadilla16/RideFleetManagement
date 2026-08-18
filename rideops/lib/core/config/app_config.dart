/// Config por flavor (M0-2). El flavor de Android decide el applicationId;
/// esto decide a qué API habla y con qué DSN reporta. Se inyecta por
/// `--dart-define` en los targets de VS Code / CI:
///
///   flutter run --flavor dev --dart-define=RIDEOPS_ENV=dev \
///     --dart-define=RIDEOPS_API_BASE=http://10.0.2.2:4000
///
/// Sin defines (tests, tooling) cae a dev/localhost — nunca a prod.
class AppConfig {
  const AppConfig._({
    required this.env,
    required this.apiBaseUrl,
    required this.webBaseUrl,
    required this.sentryDsn,
  });

  final String env; // dev | stg | prod
  final String apiBaseUrl;

  /// Origen de la app WEB (Next.js), no de la API: es lo que se codifica en
  /// el QR del paso T&C (`<webBaseUrl>/sign/<token>` — la misma ruta que arma
  /// el wizard web con `window.location.origin`,
  /// `checkout-wizard-v2/page.js:905`).
  ///
  /// Vive aparte de [apiBaseUrl] porque en prod son hosts distintos y NO se
  /// pueden derivar uno del otro sin adivinar.
  ///
  /// **Gap declarado para backend (M2-H2):** que `POST /:id/terms-token`
  /// devuelva la URL absoluta ya armada — el backend YA resuelve
  /// `APP_BASE_URL` para todos los demás enlaces al cliente
  /// (`customer-inspection.service.js:46`, `people.service.js:64`…). Mientras
  /// no lo haga, esta constante de compilación es el único puente, y un tenant
  /// con dominio propio necesitaría otro build — razón de peso para el pedido.
  final String webBaseUrl;

  /// Versión mostrada en el pie del login (mockup 1A). Manual y en sincronía
  /// con pubspec.yaml hasta que entre package_info_plus (TODO H4, junto con
  /// connectivity_plus).
  static const appVersion = '0.1.0';

  /// Vacío = Sentry apagado (dev local). El DSN real entra por dart-define
  /// desde CI; jamás se hardcodea.
  final String sentryDsn;

  static const current = AppConfig._(
    env: String.fromEnvironment('RIDEOPS_ENV', defaultValue: 'dev'),
    apiBaseUrl: String.fromEnvironment(
      'RIDEOPS_API_BASE',
      // 10.0.2.2 = localhost del host visto desde el emulador Android.
      defaultValue: 'http://10.0.2.2:4000',
    ),
    webBaseUrl: String.fromEnvironment(
      'RIDEOPS_WEB_BASE',
      // Puerto 3000 = el Next.js local visto desde el emulador; mismo default
      // que usa el backend cuando no hay APP_BASE_URL.
      defaultValue: 'http://10.0.2.2:3000',
    ),
    sentryDsn: String.fromEnvironment('RIDEOPS_SENTRY_DSN', defaultValue: ''),
  );

  /// URL que el cliente abre al escanear el QR de T&C. Se normaliza la barra
  /// final para no emitir `//sign/...` (un QR con doble barra escanea igual
  /// pero se ve mal en el enlace copiado y en los logs del servidor).
  String signUrl(String token) =>
      '${webBaseUrl.replaceAll(RegExp(r'/+$'), '')}/sign/$token';

  bool get isProd => env == 'prod';
  bool get sentryEnabled => sentryDsn.isNotEmpty;
}
