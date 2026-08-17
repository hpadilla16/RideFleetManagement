import 'package:freezed_annotation/freezed_annotation.dart';

/// Prisma `Decimal` serializa a **string** ("412.50") pero varios paths
/// emiten números ya convertidos (p.ej. `commissionAmount` pasa por
/// `Number(...)` en employee-app.service.js:436). El contrato real es
/// "número o string decimal" — este converter acepta ambos y la app trabaja
/// siempre con `double`. (Los montos que la app MUESTRA vienen del preview
/// del servidor — ADR-6; esto es solo deserialización.)
class FlexibleDoubleConverter implements JsonConverter<double?, Object?> {
  const FlexibleDoubleConverter();

  @override
  double? fromJson(Object? json) {
    if (json == null) return null;
    if (json is num) return json.toDouble();
    if (json is String) return double.tryParse(json);
    return null;
  }

  @override
  Object? toJson(double? value) => value;
}

/// Fechas ISO del backend (`DateTime` de Prisma → ISO-8601 con Z). Campos
/// `*At` nulos son la norma, no la excepción (los stamps de la state machine
/// empiezan null).
class IsoDateTimeConverter implements JsonConverter<DateTime?, String?> {
  const IsoDateTimeConverter();

  @override
  DateTime? fromJson(String? json) =>
      json == null ? null : DateTime.tryParse(json);

  @override
  String? toJson(DateTime? value) => value?.toUtc().toIso8601String();
}
