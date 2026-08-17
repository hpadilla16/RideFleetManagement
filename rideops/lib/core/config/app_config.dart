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
    required this.sentryDsn,
  });

  final String env; // dev | stg | prod
  final String apiBaseUrl;

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
    sentryDsn: String.fromEnvironment('RIDEOPS_SENTRY_DSN', defaultValue: ''),
  );

  bool get isProd => env == 'prod';
  bool get sentryEnabled => sentryDsn.isNotEmpty;
}
