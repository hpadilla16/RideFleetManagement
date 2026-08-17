// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'outbox_db.dart';

// ignore_for_file: type=lint
class $OutboxEntriesTable extends OutboxEntries
    with TableInfo<$OutboxEntriesTable, OutboxEntry> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $OutboxEntriesTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _userIdMeta = const VerificationMeta('userId');
  @override
  late final GeneratedColumn<String> userId = GeneratedColumn<String>(
    'user_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _tenantIdMeta = const VerificationMeta(
    'tenantId',
  );
  @override
  late final GeneratedColumn<String> tenantId = GeneratedColumn<String>(
    'tenant_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _locationIdMeta = const VerificationMeta(
    'locationId',
  );
  @override
  late final GeneratedColumn<String> locationId = GeneratedColumn<String>(
    'location_id',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _groupKeyMeta = const VerificationMeta(
    'groupKey',
  );
  @override
  late final GeneratedColumn<String> groupKey = GeneratedColumn<String>(
    'group_key',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _kindMeta = const VerificationMeta('kind');
  @override
  late final GeneratedColumn<String> kind = GeneratedColumn<String>(
    'kind',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _payloadMeta = const VerificationMeta(
    'payload',
  );
  @override
  late final GeneratedColumn<String> payload = GeneratedColumn<String>(
    'payload',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _dependsOnMeta = const VerificationMeta(
    'dependsOn',
  );
  @override
  late final GeneratedColumn<String> dependsOn = GeneratedColumn<String>(
    'depends_on',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _idempotencyKeyMeta = const VerificationMeta(
    'idempotencyKey',
  );
  @override
  late final GeneratedColumn<String> idempotencyKey = GeneratedColumn<String>(
    'idempotency_key',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
    defaultConstraints: GeneratedColumn.constraintIsAlways('UNIQUE'),
  );
  static const VerificationMeta _attemptsMeta = const VerificationMeta(
    'attempts',
  );
  @override
  late final GeneratedColumn<int> attempts = GeneratedColumn<int>(
    'attempts',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _lastErrorMeta = const VerificationMeta(
    'lastError',
  );
  @override
  late final GeneratedColumn<String> lastError = GeneratedColumn<String>(
    'last_error',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _lastErrorCodeMeta = const VerificationMeta(
    'lastErrorCode',
  );
  @override
  late final GeneratedColumn<String> lastErrorCode = GeneratedColumn<String>(
    'last_error_code',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _statusMeta = const VerificationMeta('status');
  @override
  late final GeneratedColumn<String> status = GeneratedColumn<String>(
    'status',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant('pending'),
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<DateTime> createdAt = GeneratedColumn<DateTime>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<DateTime> updatedAt = GeneratedColumn<DateTime>(
    'updated_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    userId,
    tenantId,
    locationId,
    groupKey,
    kind,
    payload,
    dependsOn,
    idempotencyKey,
    attempts,
    lastError,
    lastErrorCode,
    status,
    createdAt,
    updatedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'outbox_entries';
  @override
  VerificationContext validateIntegrity(
    Insertable<OutboxEntry> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('user_id')) {
      context.handle(
        _userIdMeta,
        userId.isAcceptableOrUnknown(data['user_id']!, _userIdMeta),
      );
    } else if (isInserting) {
      context.missing(_userIdMeta);
    }
    if (data.containsKey('tenant_id')) {
      context.handle(
        _tenantIdMeta,
        tenantId.isAcceptableOrUnknown(data['tenant_id']!, _tenantIdMeta),
      );
    } else if (isInserting) {
      context.missing(_tenantIdMeta);
    }
    if (data.containsKey('location_id')) {
      context.handle(
        _locationIdMeta,
        locationId.isAcceptableOrUnknown(data['location_id']!, _locationIdMeta),
      );
    }
    if (data.containsKey('group_key')) {
      context.handle(
        _groupKeyMeta,
        groupKey.isAcceptableOrUnknown(data['group_key']!, _groupKeyMeta),
      );
    }
    if (data.containsKey('kind')) {
      context.handle(
        _kindMeta,
        kind.isAcceptableOrUnknown(data['kind']!, _kindMeta),
      );
    } else if (isInserting) {
      context.missing(_kindMeta);
    }
    if (data.containsKey('payload')) {
      context.handle(
        _payloadMeta,
        payload.isAcceptableOrUnknown(data['payload']!, _payloadMeta),
      );
    } else if (isInserting) {
      context.missing(_payloadMeta);
    }
    if (data.containsKey('depends_on')) {
      context.handle(
        _dependsOnMeta,
        dependsOn.isAcceptableOrUnknown(data['depends_on']!, _dependsOnMeta),
      );
    }
    if (data.containsKey('idempotency_key')) {
      context.handle(
        _idempotencyKeyMeta,
        idempotencyKey.isAcceptableOrUnknown(
          data['idempotency_key']!,
          _idempotencyKeyMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_idempotencyKeyMeta);
    }
    if (data.containsKey('attempts')) {
      context.handle(
        _attemptsMeta,
        attempts.isAcceptableOrUnknown(data['attempts']!, _attemptsMeta),
      );
    }
    if (data.containsKey('last_error')) {
      context.handle(
        _lastErrorMeta,
        lastError.isAcceptableOrUnknown(data['last_error']!, _lastErrorMeta),
      );
    }
    if (data.containsKey('last_error_code')) {
      context.handle(
        _lastErrorCodeMeta,
        lastErrorCode.isAcceptableOrUnknown(
          data['last_error_code']!,
          _lastErrorCodeMeta,
        ),
      );
    }
    if (data.containsKey('status')) {
      context.handle(
        _statusMeta,
        status.isAcceptableOrUnknown(data['status']!, _statusMeta),
      );
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    } else if (isInserting) {
      context.missing(_createdAtMeta);
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    } else if (isInserting) {
      context.missing(_updatedAtMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  OutboxEntry map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return OutboxEntry(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}id'],
      )!,
      userId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}user_id'],
      )!,
      tenantId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}tenant_id'],
      )!,
      locationId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}location_id'],
      ),
      groupKey: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}group_key'],
      ),
      kind: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}kind'],
      )!,
      payload: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}payload'],
      )!,
      dependsOn: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}depends_on'],
      ),
      idempotencyKey: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}idempotency_key'],
      )!,
      attempts: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}attempts'],
      )!,
      lastError: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}last_error'],
      ),
      lastErrorCode: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}last_error_code'],
      ),
      status: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}status'],
      )!,
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}created_at'],
      )!,
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}updated_at'],
      )!,
    );
  }

  @override
  $OutboxEntriesTable createAlias(String alias) {
    return $OutboxEntriesTable(attachedDatabase, alias);
  }
}

class OutboxEntry extends DataClass implements Insertable<OutboxEntry> {
  final String id;
  final String userId;
  final String tenantId;

  /// Ubicación activa (`x-view-location`) al momento de crear la fila, o
  /// null si el usuario opera sin override. Criterio registrado H5: se sella
  /// AL ENCOLAR — el drenado jamás depende del selector vivo.
  final String? locationId;

  /// Agrupador de cadena: para inspección, el checkoutSessionId. Permite la
  /// purga selectiva de 6F ("otra superficie completó → retirar los envíos
  /// de ESA sesión") sin parsear payloads en un where.
  final String? groupKey;

  /// Tipo de operación: inspection_photo | inspection_complete | ...
  /// El dinero NUNCA aparece aquí (ADR-5) — el drenador rechaza kinds
  /// desconocidos y no existe kind de pago.
  final String kind;

  /// Payload JSON de la operación (para fotos: path del archivo cifrado en
  /// disco + angleKey + sessionId/reservationId — el binario no vive en la
  /// fila para que la DB no explote).
  final String payload;

  /// id de otra fila que debe drenar ANTES que esta, o null.
  final String? dependsOn;
  final String idempotencyKey;
  final int attempts;
  final String? lastError;
  final String? lastErrorCode;
  final String status;
  final DateTime createdAt;
  final DateTime updatedAt;
  const OutboxEntry({
    required this.id,
    required this.userId,
    required this.tenantId,
    this.locationId,
    this.groupKey,
    required this.kind,
    required this.payload,
    this.dependsOn,
    required this.idempotencyKey,
    required this.attempts,
    this.lastError,
    this.lastErrorCode,
    required this.status,
    required this.createdAt,
    required this.updatedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    map['user_id'] = Variable<String>(userId);
    map['tenant_id'] = Variable<String>(tenantId);
    if (!nullToAbsent || locationId != null) {
      map['location_id'] = Variable<String>(locationId);
    }
    if (!nullToAbsent || groupKey != null) {
      map['group_key'] = Variable<String>(groupKey);
    }
    map['kind'] = Variable<String>(kind);
    map['payload'] = Variable<String>(payload);
    if (!nullToAbsent || dependsOn != null) {
      map['depends_on'] = Variable<String>(dependsOn);
    }
    map['idempotency_key'] = Variable<String>(idempotencyKey);
    map['attempts'] = Variable<int>(attempts);
    if (!nullToAbsent || lastError != null) {
      map['last_error'] = Variable<String>(lastError);
    }
    if (!nullToAbsent || lastErrorCode != null) {
      map['last_error_code'] = Variable<String>(lastErrorCode);
    }
    map['status'] = Variable<String>(status);
    map['created_at'] = Variable<DateTime>(createdAt);
    map['updated_at'] = Variable<DateTime>(updatedAt);
    return map;
  }

  OutboxEntriesCompanion toCompanion(bool nullToAbsent) {
    return OutboxEntriesCompanion(
      id: Value(id),
      userId: Value(userId),
      tenantId: Value(tenantId),
      locationId: locationId == null && nullToAbsent
          ? const Value.absent()
          : Value(locationId),
      groupKey: groupKey == null && nullToAbsent
          ? const Value.absent()
          : Value(groupKey),
      kind: Value(kind),
      payload: Value(payload),
      dependsOn: dependsOn == null && nullToAbsent
          ? const Value.absent()
          : Value(dependsOn),
      idempotencyKey: Value(idempotencyKey),
      attempts: Value(attempts),
      lastError: lastError == null && nullToAbsent
          ? const Value.absent()
          : Value(lastError),
      lastErrorCode: lastErrorCode == null && nullToAbsent
          ? const Value.absent()
          : Value(lastErrorCode),
      status: Value(status),
      createdAt: Value(createdAt),
      updatedAt: Value(updatedAt),
    );
  }

  factory OutboxEntry.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return OutboxEntry(
      id: serializer.fromJson<String>(json['id']),
      userId: serializer.fromJson<String>(json['userId']),
      tenantId: serializer.fromJson<String>(json['tenantId']),
      locationId: serializer.fromJson<String?>(json['locationId']),
      groupKey: serializer.fromJson<String?>(json['groupKey']),
      kind: serializer.fromJson<String>(json['kind']),
      payload: serializer.fromJson<String>(json['payload']),
      dependsOn: serializer.fromJson<String?>(json['dependsOn']),
      idempotencyKey: serializer.fromJson<String>(json['idempotencyKey']),
      attempts: serializer.fromJson<int>(json['attempts']),
      lastError: serializer.fromJson<String?>(json['lastError']),
      lastErrorCode: serializer.fromJson<String?>(json['lastErrorCode']),
      status: serializer.fromJson<String>(json['status']),
      createdAt: serializer.fromJson<DateTime>(json['createdAt']),
      updatedAt: serializer.fromJson<DateTime>(json['updatedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'userId': serializer.toJson<String>(userId),
      'tenantId': serializer.toJson<String>(tenantId),
      'locationId': serializer.toJson<String?>(locationId),
      'groupKey': serializer.toJson<String?>(groupKey),
      'kind': serializer.toJson<String>(kind),
      'payload': serializer.toJson<String>(payload),
      'dependsOn': serializer.toJson<String?>(dependsOn),
      'idempotencyKey': serializer.toJson<String>(idempotencyKey),
      'attempts': serializer.toJson<int>(attempts),
      'lastError': serializer.toJson<String?>(lastError),
      'lastErrorCode': serializer.toJson<String?>(lastErrorCode),
      'status': serializer.toJson<String>(status),
      'createdAt': serializer.toJson<DateTime>(createdAt),
      'updatedAt': serializer.toJson<DateTime>(updatedAt),
    };
  }

  OutboxEntry copyWith({
    String? id,
    String? userId,
    String? tenantId,
    Value<String?> locationId = const Value.absent(),
    Value<String?> groupKey = const Value.absent(),
    String? kind,
    String? payload,
    Value<String?> dependsOn = const Value.absent(),
    String? idempotencyKey,
    int? attempts,
    Value<String?> lastError = const Value.absent(),
    Value<String?> lastErrorCode = const Value.absent(),
    String? status,
    DateTime? createdAt,
    DateTime? updatedAt,
  }) => OutboxEntry(
    id: id ?? this.id,
    userId: userId ?? this.userId,
    tenantId: tenantId ?? this.tenantId,
    locationId: locationId.present ? locationId.value : this.locationId,
    groupKey: groupKey.present ? groupKey.value : this.groupKey,
    kind: kind ?? this.kind,
    payload: payload ?? this.payload,
    dependsOn: dependsOn.present ? dependsOn.value : this.dependsOn,
    idempotencyKey: idempotencyKey ?? this.idempotencyKey,
    attempts: attempts ?? this.attempts,
    lastError: lastError.present ? lastError.value : this.lastError,
    lastErrorCode: lastErrorCode.present
        ? lastErrorCode.value
        : this.lastErrorCode,
    status: status ?? this.status,
    createdAt: createdAt ?? this.createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
  );
  OutboxEntry copyWithCompanion(OutboxEntriesCompanion data) {
    return OutboxEntry(
      id: data.id.present ? data.id.value : this.id,
      userId: data.userId.present ? data.userId.value : this.userId,
      tenantId: data.tenantId.present ? data.tenantId.value : this.tenantId,
      locationId: data.locationId.present
          ? data.locationId.value
          : this.locationId,
      groupKey: data.groupKey.present ? data.groupKey.value : this.groupKey,
      kind: data.kind.present ? data.kind.value : this.kind,
      payload: data.payload.present ? data.payload.value : this.payload,
      dependsOn: data.dependsOn.present ? data.dependsOn.value : this.dependsOn,
      idempotencyKey: data.idempotencyKey.present
          ? data.idempotencyKey.value
          : this.idempotencyKey,
      attempts: data.attempts.present ? data.attempts.value : this.attempts,
      lastError: data.lastError.present ? data.lastError.value : this.lastError,
      lastErrorCode: data.lastErrorCode.present
          ? data.lastErrorCode.value
          : this.lastErrorCode,
      status: data.status.present ? data.status.value : this.status,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('OutboxEntry(')
          ..write('id: $id, ')
          ..write('userId: $userId, ')
          ..write('tenantId: $tenantId, ')
          ..write('locationId: $locationId, ')
          ..write('groupKey: $groupKey, ')
          ..write('kind: $kind, ')
          ..write('payload: $payload, ')
          ..write('dependsOn: $dependsOn, ')
          ..write('idempotencyKey: $idempotencyKey, ')
          ..write('attempts: $attempts, ')
          ..write('lastError: $lastError, ')
          ..write('lastErrorCode: $lastErrorCode, ')
          ..write('status: $status, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    id,
    userId,
    tenantId,
    locationId,
    groupKey,
    kind,
    payload,
    dependsOn,
    idempotencyKey,
    attempts,
    lastError,
    lastErrorCode,
    status,
    createdAt,
    updatedAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is OutboxEntry &&
          other.id == this.id &&
          other.userId == this.userId &&
          other.tenantId == this.tenantId &&
          other.locationId == this.locationId &&
          other.groupKey == this.groupKey &&
          other.kind == this.kind &&
          other.payload == this.payload &&
          other.dependsOn == this.dependsOn &&
          other.idempotencyKey == this.idempotencyKey &&
          other.attempts == this.attempts &&
          other.lastError == this.lastError &&
          other.lastErrorCode == this.lastErrorCode &&
          other.status == this.status &&
          other.createdAt == this.createdAt &&
          other.updatedAt == this.updatedAt);
}

class OutboxEntriesCompanion extends UpdateCompanion<OutboxEntry> {
  final Value<String> id;
  final Value<String> userId;
  final Value<String> tenantId;
  final Value<String?> locationId;
  final Value<String?> groupKey;
  final Value<String> kind;
  final Value<String> payload;
  final Value<String?> dependsOn;
  final Value<String> idempotencyKey;
  final Value<int> attempts;
  final Value<String?> lastError;
  final Value<String?> lastErrorCode;
  final Value<String> status;
  final Value<DateTime> createdAt;
  final Value<DateTime> updatedAt;
  final Value<int> rowid;
  const OutboxEntriesCompanion({
    this.id = const Value.absent(),
    this.userId = const Value.absent(),
    this.tenantId = const Value.absent(),
    this.locationId = const Value.absent(),
    this.groupKey = const Value.absent(),
    this.kind = const Value.absent(),
    this.payload = const Value.absent(),
    this.dependsOn = const Value.absent(),
    this.idempotencyKey = const Value.absent(),
    this.attempts = const Value.absent(),
    this.lastError = const Value.absent(),
    this.lastErrorCode = const Value.absent(),
    this.status = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  OutboxEntriesCompanion.insert({
    required String id,
    required String userId,
    required String tenantId,
    this.locationId = const Value.absent(),
    this.groupKey = const Value.absent(),
    required String kind,
    required String payload,
    this.dependsOn = const Value.absent(),
    required String idempotencyKey,
    this.attempts = const Value.absent(),
    this.lastError = const Value.absent(),
    this.lastErrorCode = const Value.absent(),
    this.status = const Value.absent(),
    required DateTime createdAt,
    required DateTime updatedAt,
    this.rowid = const Value.absent(),
  }) : id = Value(id),
       userId = Value(userId),
       tenantId = Value(tenantId),
       kind = Value(kind),
       payload = Value(payload),
       idempotencyKey = Value(idempotencyKey),
       createdAt = Value(createdAt),
       updatedAt = Value(updatedAt);
  static Insertable<OutboxEntry> custom({
    Expression<String>? id,
    Expression<String>? userId,
    Expression<String>? tenantId,
    Expression<String>? locationId,
    Expression<String>? groupKey,
    Expression<String>? kind,
    Expression<String>? payload,
    Expression<String>? dependsOn,
    Expression<String>? idempotencyKey,
    Expression<int>? attempts,
    Expression<String>? lastError,
    Expression<String>? lastErrorCode,
    Expression<String>? status,
    Expression<DateTime>? createdAt,
    Expression<DateTime>? updatedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (userId != null) 'user_id': userId,
      if (tenantId != null) 'tenant_id': tenantId,
      if (locationId != null) 'location_id': locationId,
      if (groupKey != null) 'group_key': groupKey,
      if (kind != null) 'kind': kind,
      if (payload != null) 'payload': payload,
      if (dependsOn != null) 'depends_on': dependsOn,
      if (idempotencyKey != null) 'idempotency_key': idempotencyKey,
      if (attempts != null) 'attempts': attempts,
      if (lastError != null) 'last_error': lastError,
      if (lastErrorCode != null) 'last_error_code': lastErrorCode,
      if (status != null) 'status': status,
      if (createdAt != null) 'created_at': createdAt,
      if (updatedAt != null) 'updated_at': updatedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  OutboxEntriesCompanion copyWith({
    Value<String>? id,
    Value<String>? userId,
    Value<String>? tenantId,
    Value<String?>? locationId,
    Value<String?>? groupKey,
    Value<String>? kind,
    Value<String>? payload,
    Value<String?>? dependsOn,
    Value<String>? idempotencyKey,
    Value<int>? attempts,
    Value<String?>? lastError,
    Value<String?>? lastErrorCode,
    Value<String>? status,
    Value<DateTime>? createdAt,
    Value<DateTime>? updatedAt,
    Value<int>? rowid,
  }) {
    return OutboxEntriesCompanion(
      id: id ?? this.id,
      userId: userId ?? this.userId,
      tenantId: tenantId ?? this.tenantId,
      locationId: locationId ?? this.locationId,
      groupKey: groupKey ?? this.groupKey,
      kind: kind ?? this.kind,
      payload: payload ?? this.payload,
      dependsOn: dependsOn ?? this.dependsOn,
      idempotencyKey: idempotencyKey ?? this.idempotencyKey,
      attempts: attempts ?? this.attempts,
      lastError: lastError ?? this.lastError,
      lastErrorCode: lastErrorCode ?? this.lastErrorCode,
      status: status ?? this.status,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (userId.present) {
      map['user_id'] = Variable<String>(userId.value);
    }
    if (tenantId.present) {
      map['tenant_id'] = Variable<String>(tenantId.value);
    }
    if (locationId.present) {
      map['location_id'] = Variable<String>(locationId.value);
    }
    if (groupKey.present) {
      map['group_key'] = Variable<String>(groupKey.value);
    }
    if (kind.present) {
      map['kind'] = Variable<String>(kind.value);
    }
    if (payload.present) {
      map['payload'] = Variable<String>(payload.value);
    }
    if (dependsOn.present) {
      map['depends_on'] = Variable<String>(dependsOn.value);
    }
    if (idempotencyKey.present) {
      map['idempotency_key'] = Variable<String>(idempotencyKey.value);
    }
    if (attempts.present) {
      map['attempts'] = Variable<int>(attempts.value);
    }
    if (lastError.present) {
      map['last_error'] = Variable<String>(lastError.value);
    }
    if (lastErrorCode.present) {
      map['last_error_code'] = Variable<String>(lastErrorCode.value);
    }
    if (status.present) {
      map['status'] = Variable<String>(status.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<DateTime>(createdAt.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<DateTime>(updatedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('OutboxEntriesCompanion(')
          ..write('id: $id, ')
          ..write('userId: $userId, ')
          ..write('tenantId: $tenantId, ')
          ..write('locationId: $locationId, ')
          ..write('groupKey: $groupKey, ')
          ..write('kind: $kind, ')
          ..write('payload: $payload, ')
          ..write('dependsOn: $dependsOn, ')
          ..write('idempotencyKey: $idempotencyKey, ')
          ..write('attempts: $attempts, ')
          ..write('lastError: $lastError, ')
          ..write('lastErrorCode: $lastErrorCode, ')
          ..write('status: $status, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $OutboxAuditEntriesTable extends OutboxAuditEntries
    with TableInfo<$OutboxAuditEntriesTable, OutboxAuditEntry> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $OutboxAuditEntriesTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _userIdMeta = const VerificationMeta('userId');
  @override
  late final GeneratedColumn<String> userId = GeneratedColumn<String>(
    'user_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _tenantIdMeta = const VerificationMeta(
    'tenantId',
  );
  @override
  late final GeneratedColumn<String> tenantId = GeneratedColumn<String>(
    'tenant_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _locationIdMeta = const VerificationMeta(
    'locationId',
  );
  @override
  late final GeneratedColumn<String> locationId = GeneratedColumn<String>(
    'location_id',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _rowIdMeta = const VerificationMeta('rowId');
  @override
  late final GeneratedColumn<String> rowId = GeneratedColumn<String>(
    'row_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _rowKindMeta = const VerificationMeta(
    'rowKind',
  );
  @override
  late final GeneratedColumn<String> rowKind = GeneratedColumn<String>(
    'row_kind',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _summaryMeta = const VerificationMeta(
    'summary',
  );
  @override
  late final GeneratedColumn<String> summary = GeneratedColumn<String>(
    'summary',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _reasonCodeMeta = const VerificationMeta(
    'reasonCode',
  );
  @override
  late final GeneratedColumn<String> reasonCode = GeneratedColumn<String>(
    'reason_code',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _discardedAtMeta = const VerificationMeta(
    'discardedAt',
  );
  @override
  late final GeneratedColumn<DateTime> discardedAt = GeneratedColumn<DateTime>(
    'discarded_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _syncedMeta = const VerificationMeta('synced');
  @override
  late final GeneratedColumn<bool> synced = GeneratedColumn<bool>(
    'synced',
    aliasedName,
    false,
    type: DriftSqlType.bool,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'CHECK ("synced" IN (0, 1))',
    ),
    defaultValue: const Constant(false),
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    userId,
    tenantId,
    locationId,
    rowId,
    rowKind,
    summary,
    reasonCode,
    discardedAt,
    synced,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'outbox_audit_entries';
  @override
  VerificationContext validateIntegrity(
    Insertable<OutboxAuditEntry> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('user_id')) {
      context.handle(
        _userIdMeta,
        userId.isAcceptableOrUnknown(data['user_id']!, _userIdMeta),
      );
    } else if (isInserting) {
      context.missing(_userIdMeta);
    }
    if (data.containsKey('tenant_id')) {
      context.handle(
        _tenantIdMeta,
        tenantId.isAcceptableOrUnknown(data['tenant_id']!, _tenantIdMeta),
      );
    } else if (isInserting) {
      context.missing(_tenantIdMeta);
    }
    if (data.containsKey('location_id')) {
      context.handle(
        _locationIdMeta,
        locationId.isAcceptableOrUnknown(data['location_id']!, _locationIdMeta),
      );
    }
    if (data.containsKey('row_id')) {
      context.handle(
        _rowIdMeta,
        rowId.isAcceptableOrUnknown(data['row_id']!, _rowIdMeta),
      );
    } else if (isInserting) {
      context.missing(_rowIdMeta);
    }
    if (data.containsKey('row_kind')) {
      context.handle(
        _rowKindMeta,
        rowKind.isAcceptableOrUnknown(data['row_kind']!, _rowKindMeta),
      );
    } else if (isInserting) {
      context.missing(_rowKindMeta);
    }
    if (data.containsKey('summary')) {
      context.handle(
        _summaryMeta,
        summary.isAcceptableOrUnknown(data['summary']!, _summaryMeta),
      );
    } else if (isInserting) {
      context.missing(_summaryMeta);
    }
    if (data.containsKey('reason_code')) {
      context.handle(
        _reasonCodeMeta,
        reasonCode.isAcceptableOrUnknown(data['reason_code']!, _reasonCodeMeta),
      );
    }
    if (data.containsKey('discarded_at')) {
      context.handle(
        _discardedAtMeta,
        discardedAt.isAcceptableOrUnknown(
          data['discarded_at']!,
          _discardedAtMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_discardedAtMeta);
    }
    if (data.containsKey('synced')) {
      context.handle(
        _syncedMeta,
        synced.isAcceptableOrUnknown(data['synced']!, _syncedMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  OutboxAuditEntry map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return OutboxAuditEntry(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}id'],
      )!,
      userId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}user_id'],
      )!,
      tenantId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}tenant_id'],
      )!,
      locationId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}location_id'],
      ),
      rowId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}row_id'],
      )!,
      rowKind: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}row_kind'],
      )!,
      summary: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}summary'],
      )!,
      reasonCode: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}reason_code'],
      ),
      discardedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}discarded_at'],
      )!,
      synced: attachedDatabase.typeMapping.read(
        DriftSqlType.bool,
        data['${effectivePrefix}synced'],
      )!,
    );
  }

  @override
  $OutboxAuditEntriesTable createAlias(String alias) {
    return $OutboxAuditEntriesTable(attachedDatabase, alias);
  }
}

class OutboxAuditEntry extends DataClass
    implements Insertable<OutboxAuditEntry> {
  final String id;
  final String userId;
  final String tenantId;
  final String? locationId;

  /// id de la fila de outbox descartada.
  final String rowId;
  final String rowKind;

  /// Resumen NO sensible del payload (reserva, ángulo) — jamás la foto/firma.
  final String summary;

  /// Código del motivo: el lastErrorCode del dead-letter, o un motivo local
  /// (SESSION_COMPLETED en la purga selectiva de 6F).
  final String? reasonCode;
  final DateTime discardedAt;
  final bool synced;
  const OutboxAuditEntry({
    required this.id,
    required this.userId,
    required this.tenantId,
    this.locationId,
    required this.rowId,
    required this.rowKind,
    required this.summary,
    this.reasonCode,
    required this.discardedAt,
    required this.synced,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    map['user_id'] = Variable<String>(userId);
    map['tenant_id'] = Variable<String>(tenantId);
    if (!nullToAbsent || locationId != null) {
      map['location_id'] = Variable<String>(locationId);
    }
    map['row_id'] = Variable<String>(rowId);
    map['row_kind'] = Variable<String>(rowKind);
    map['summary'] = Variable<String>(summary);
    if (!nullToAbsent || reasonCode != null) {
      map['reason_code'] = Variable<String>(reasonCode);
    }
    map['discarded_at'] = Variable<DateTime>(discardedAt);
    map['synced'] = Variable<bool>(synced);
    return map;
  }

  OutboxAuditEntriesCompanion toCompanion(bool nullToAbsent) {
    return OutboxAuditEntriesCompanion(
      id: Value(id),
      userId: Value(userId),
      tenantId: Value(tenantId),
      locationId: locationId == null && nullToAbsent
          ? const Value.absent()
          : Value(locationId),
      rowId: Value(rowId),
      rowKind: Value(rowKind),
      summary: Value(summary),
      reasonCode: reasonCode == null && nullToAbsent
          ? const Value.absent()
          : Value(reasonCode),
      discardedAt: Value(discardedAt),
      synced: Value(synced),
    );
  }

  factory OutboxAuditEntry.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return OutboxAuditEntry(
      id: serializer.fromJson<String>(json['id']),
      userId: serializer.fromJson<String>(json['userId']),
      tenantId: serializer.fromJson<String>(json['tenantId']),
      locationId: serializer.fromJson<String?>(json['locationId']),
      rowId: serializer.fromJson<String>(json['rowId']),
      rowKind: serializer.fromJson<String>(json['rowKind']),
      summary: serializer.fromJson<String>(json['summary']),
      reasonCode: serializer.fromJson<String?>(json['reasonCode']),
      discardedAt: serializer.fromJson<DateTime>(json['discardedAt']),
      synced: serializer.fromJson<bool>(json['synced']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'userId': serializer.toJson<String>(userId),
      'tenantId': serializer.toJson<String>(tenantId),
      'locationId': serializer.toJson<String?>(locationId),
      'rowId': serializer.toJson<String>(rowId),
      'rowKind': serializer.toJson<String>(rowKind),
      'summary': serializer.toJson<String>(summary),
      'reasonCode': serializer.toJson<String?>(reasonCode),
      'discardedAt': serializer.toJson<DateTime>(discardedAt),
      'synced': serializer.toJson<bool>(synced),
    };
  }

  OutboxAuditEntry copyWith({
    String? id,
    String? userId,
    String? tenantId,
    Value<String?> locationId = const Value.absent(),
    String? rowId,
    String? rowKind,
    String? summary,
    Value<String?> reasonCode = const Value.absent(),
    DateTime? discardedAt,
    bool? synced,
  }) => OutboxAuditEntry(
    id: id ?? this.id,
    userId: userId ?? this.userId,
    tenantId: tenantId ?? this.tenantId,
    locationId: locationId.present ? locationId.value : this.locationId,
    rowId: rowId ?? this.rowId,
    rowKind: rowKind ?? this.rowKind,
    summary: summary ?? this.summary,
    reasonCode: reasonCode.present ? reasonCode.value : this.reasonCode,
    discardedAt: discardedAt ?? this.discardedAt,
    synced: synced ?? this.synced,
  );
  OutboxAuditEntry copyWithCompanion(OutboxAuditEntriesCompanion data) {
    return OutboxAuditEntry(
      id: data.id.present ? data.id.value : this.id,
      userId: data.userId.present ? data.userId.value : this.userId,
      tenantId: data.tenantId.present ? data.tenantId.value : this.tenantId,
      locationId: data.locationId.present
          ? data.locationId.value
          : this.locationId,
      rowId: data.rowId.present ? data.rowId.value : this.rowId,
      rowKind: data.rowKind.present ? data.rowKind.value : this.rowKind,
      summary: data.summary.present ? data.summary.value : this.summary,
      reasonCode: data.reasonCode.present
          ? data.reasonCode.value
          : this.reasonCode,
      discardedAt: data.discardedAt.present
          ? data.discardedAt.value
          : this.discardedAt,
      synced: data.synced.present ? data.synced.value : this.synced,
    );
  }

  @override
  String toString() {
    return (StringBuffer('OutboxAuditEntry(')
          ..write('id: $id, ')
          ..write('userId: $userId, ')
          ..write('tenantId: $tenantId, ')
          ..write('locationId: $locationId, ')
          ..write('rowId: $rowId, ')
          ..write('rowKind: $rowKind, ')
          ..write('summary: $summary, ')
          ..write('reasonCode: $reasonCode, ')
          ..write('discardedAt: $discardedAt, ')
          ..write('synced: $synced')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    id,
    userId,
    tenantId,
    locationId,
    rowId,
    rowKind,
    summary,
    reasonCode,
    discardedAt,
    synced,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is OutboxAuditEntry &&
          other.id == this.id &&
          other.userId == this.userId &&
          other.tenantId == this.tenantId &&
          other.locationId == this.locationId &&
          other.rowId == this.rowId &&
          other.rowKind == this.rowKind &&
          other.summary == this.summary &&
          other.reasonCode == this.reasonCode &&
          other.discardedAt == this.discardedAt &&
          other.synced == this.synced);
}

class OutboxAuditEntriesCompanion extends UpdateCompanion<OutboxAuditEntry> {
  final Value<String> id;
  final Value<String> userId;
  final Value<String> tenantId;
  final Value<String?> locationId;
  final Value<String> rowId;
  final Value<String> rowKind;
  final Value<String> summary;
  final Value<String?> reasonCode;
  final Value<DateTime> discardedAt;
  final Value<bool> synced;
  final Value<int> rowid;
  const OutboxAuditEntriesCompanion({
    this.id = const Value.absent(),
    this.userId = const Value.absent(),
    this.tenantId = const Value.absent(),
    this.locationId = const Value.absent(),
    this.rowId = const Value.absent(),
    this.rowKind = const Value.absent(),
    this.summary = const Value.absent(),
    this.reasonCode = const Value.absent(),
    this.discardedAt = const Value.absent(),
    this.synced = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  OutboxAuditEntriesCompanion.insert({
    required String id,
    required String userId,
    required String tenantId,
    this.locationId = const Value.absent(),
    required String rowId,
    required String rowKind,
    required String summary,
    this.reasonCode = const Value.absent(),
    required DateTime discardedAt,
    this.synced = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : id = Value(id),
       userId = Value(userId),
       tenantId = Value(tenantId),
       rowId = Value(rowId),
       rowKind = Value(rowKind),
       summary = Value(summary),
       discardedAt = Value(discardedAt);
  static Insertable<OutboxAuditEntry> custom({
    Expression<String>? id,
    Expression<String>? userId,
    Expression<String>? tenantId,
    Expression<String>? locationId,
    Expression<String>? rowId,
    Expression<String>? rowKind,
    Expression<String>? summary,
    Expression<String>? reasonCode,
    Expression<DateTime>? discardedAt,
    Expression<bool>? synced,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (userId != null) 'user_id': userId,
      if (tenantId != null) 'tenant_id': tenantId,
      if (locationId != null) 'location_id': locationId,
      if (rowId != null) 'row_id': rowId,
      if (rowKind != null) 'row_kind': rowKind,
      if (summary != null) 'summary': summary,
      if (reasonCode != null) 'reason_code': reasonCode,
      if (discardedAt != null) 'discarded_at': discardedAt,
      if (synced != null) 'synced': synced,
      if (rowid != null) 'rowid': rowid,
    });
  }

  OutboxAuditEntriesCompanion copyWith({
    Value<String>? id,
    Value<String>? userId,
    Value<String>? tenantId,
    Value<String?>? locationId,
    Value<String>? rowId,
    Value<String>? rowKind,
    Value<String>? summary,
    Value<String?>? reasonCode,
    Value<DateTime>? discardedAt,
    Value<bool>? synced,
    Value<int>? rowid,
  }) {
    return OutboxAuditEntriesCompanion(
      id: id ?? this.id,
      userId: userId ?? this.userId,
      tenantId: tenantId ?? this.tenantId,
      locationId: locationId ?? this.locationId,
      rowId: rowId ?? this.rowId,
      rowKind: rowKind ?? this.rowKind,
      summary: summary ?? this.summary,
      reasonCode: reasonCode ?? this.reasonCode,
      discardedAt: discardedAt ?? this.discardedAt,
      synced: synced ?? this.synced,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (userId.present) {
      map['user_id'] = Variable<String>(userId.value);
    }
    if (tenantId.present) {
      map['tenant_id'] = Variable<String>(tenantId.value);
    }
    if (locationId.present) {
      map['location_id'] = Variable<String>(locationId.value);
    }
    if (rowId.present) {
      map['row_id'] = Variable<String>(rowId.value);
    }
    if (rowKind.present) {
      map['row_kind'] = Variable<String>(rowKind.value);
    }
    if (summary.present) {
      map['summary'] = Variable<String>(summary.value);
    }
    if (reasonCode.present) {
      map['reason_code'] = Variable<String>(reasonCode.value);
    }
    if (discardedAt.present) {
      map['discarded_at'] = Variable<DateTime>(discardedAt.value);
    }
    if (synced.present) {
      map['synced'] = Variable<bool>(synced.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('OutboxAuditEntriesCompanion(')
          ..write('id: $id, ')
          ..write('userId: $userId, ')
          ..write('tenantId: $tenantId, ')
          ..write('locationId: $locationId, ')
          ..write('rowId: $rowId, ')
          ..write('rowKind: $rowKind, ')
          ..write('summary: $summary, ')
          ..write('reasonCode: $reasonCode, ')
          ..write('discardedAt: $discardedAt, ')
          ..write('synced: $synced, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

abstract class _$OutboxDb extends GeneratedDatabase {
  _$OutboxDb(QueryExecutor e) : super(e);
  $OutboxDbManager get managers => $OutboxDbManager(this);
  late final $OutboxEntriesTable outboxEntries = $OutboxEntriesTable(this);
  late final $OutboxAuditEntriesTable outboxAuditEntries =
      $OutboxAuditEntriesTable(this);
  @override
  Iterable<TableInfo<Table, Object?>> get allTables =>
      allSchemaEntities.whereType<TableInfo<Table, Object?>>();
  @override
  List<DatabaseSchemaEntity> get allSchemaEntities => [
    outboxEntries,
    outboxAuditEntries,
  ];
}

typedef $$OutboxEntriesTableCreateCompanionBuilder =
    OutboxEntriesCompanion Function({
      required String id,
      required String userId,
      required String tenantId,
      Value<String?> locationId,
      Value<String?> groupKey,
      required String kind,
      required String payload,
      Value<String?> dependsOn,
      required String idempotencyKey,
      Value<int> attempts,
      Value<String?> lastError,
      Value<String?> lastErrorCode,
      Value<String> status,
      required DateTime createdAt,
      required DateTime updatedAt,
      Value<int> rowid,
    });
typedef $$OutboxEntriesTableUpdateCompanionBuilder =
    OutboxEntriesCompanion Function({
      Value<String> id,
      Value<String> userId,
      Value<String> tenantId,
      Value<String?> locationId,
      Value<String?> groupKey,
      Value<String> kind,
      Value<String> payload,
      Value<String?> dependsOn,
      Value<String> idempotencyKey,
      Value<int> attempts,
      Value<String?> lastError,
      Value<String?> lastErrorCode,
      Value<String> status,
      Value<DateTime> createdAt,
      Value<DateTime> updatedAt,
      Value<int> rowid,
    });

class $$OutboxEntriesTableFilterComposer
    extends Composer<_$OutboxDb, $OutboxEntriesTable> {
  $$OutboxEntriesTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get userId => $composableBuilder(
    column: $table.userId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get tenantId => $composableBuilder(
    column: $table.tenantId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get locationId => $composableBuilder(
    column: $table.locationId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get groupKey => $composableBuilder(
    column: $table.groupKey,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get kind => $composableBuilder(
    column: $table.kind,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get payload => $composableBuilder(
    column: $table.payload,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get dependsOn => $composableBuilder(
    column: $table.dependsOn,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get idempotencyKey => $composableBuilder(
    column: $table.idempotencyKey,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get attempts => $composableBuilder(
    column: $table.attempts,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get lastError => $composableBuilder(
    column: $table.lastError,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get lastErrorCode => $composableBuilder(
    column: $table.lastErrorCode,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$OutboxEntriesTableOrderingComposer
    extends Composer<_$OutboxDb, $OutboxEntriesTable> {
  $$OutboxEntriesTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get userId => $composableBuilder(
    column: $table.userId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get tenantId => $composableBuilder(
    column: $table.tenantId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get locationId => $composableBuilder(
    column: $table.locationId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get groupKey => $composableBuilder(
    column: $table.groupKey,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get kind => $composableBuilder(
    column: $table.kind,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get payload => $composableBuilder(
    column: $table.payload,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get dependsOn => $composableBuilder(
    column: $table.dependsOn,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get idempotencyKey => $composableBuilder(
    column: $table.idempotencyKey,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get attempts => $composableBuilder(
    column: $table.attempts,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get lastError => $composableBuilder(
    column: $table.lastError,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get lastErrorCode => $composableBuilder(
    column: $table.lastErrorCode,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$OutboxEntriesTableAnnotationComposer
    extends Composer<_$OutboxDb, $OutboxEntriesTable> {
  $$OutboxEntriesTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get userId =>
      $composableBuilder(column: $table.userId, builder: (column) => column);

  GeneratedColumn<String> get tenantId =>
      $composableBuilder(column: $table.tenantId, builder: (column) => column);

  GeneratedColumn<String> get locationId => $composableBuilder(
    column: $table.locationId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get groupKey =>
      $composableBuilder(column: $table.groupKey, builder: (column) => column);

  GeneratedColumn<String> get kind =>
      $composableBuilder(column: $table.kind, builder: (column) => column);

  GeneratedColumn<String> get payload =>
      $composableBuilder(column: $table.payload, builder: (column) => column);

  GeneratedColumn<String> get dependsOn =>
      $composableBuilder(column: $table.dependsOn, builder: (column) => column);

  GeneratedColumn<String> get idempotencyKey => $composableBuilder(
    column: $table.idempotencyKey,
    builder: (column) => column,
  );

  GeneratedColumn<int> get attempts =>
      $composableBuilder(column: $table.attempts, builder: (column) => column);

  GeneratedColumn<String> get lastError =>
      $composableBuilder(column: $table.lastError, builder: (column) => column);

  GeneratedColumn<String> get lastErrorCode => $composableBuilder(
    column: $table.lastErrorCode,
    builder: (column) => column,
  );

  GeneratedColumn<String> get status =>
      $composableBuilder(column: $table.status, builder: (column) => column);

  GeneratedColumn<DateTime> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);

  GeneratedColumn<DateTime> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);
}

class $$OutboxEntriesTableTableManager
    extends
        RootTableManager<
          _$OutboxDb,
          $OutboxEntriesTable,
          OutboxEntry,
          $$OutboxEntriesTableFilterComposer,
          $$OutboxEntriesTableOrderingComposer,
          $$OutboxEntriesTableAnnotationComposer,
          $$OutboxEntriesTableCreateCompanionBuilder,
          $$OutboxEntriesTableUpdateCompanionBuilder,
          (
            OutboxEntry,
            BaseReferences<_$OutboxDb, $OutboxEntriesTable, OutboxEntry>,
          ),
          OutboxEntry,
          PrefetchHooks Function()
        > {
  $$OutboxEntriesTableTableManager(_$OutboxDb db, $OutboxEntriesTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$OutboxEntriesTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$OutboxEntriesTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$OutboxEntriesTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> id = const Value.absent(),
                Value<String> userId = const Value.absent(),
                Value<String> tenantId = const Value.absent(),
                Value<String?> locationId = const Value.absent(),
                Value<String?> groupKey = const Value.absent(),
                Value<String> kind = const Value.absent(),
                Value<String> payload = const Value.absent(),
                Value<String?> dependsOn = const Value.absent(),
                Value<String> idempotencyKey = const Value.absent(),
                Value<int> attempts = const Value.absent(),
                Value<String?> lastError = const Value.absent(),
                Value<String?> lastErrorCode = const Value.absent(),
                Value<String> status = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => OutboxEntriesCompanion(
                id: id,
                userId: userId,
                tenantId: tenantId,
                locationId: locationId,
                groupKey: groupKey,
                kind: kind,
                payload: payload,
                dependsOn: dependsOn,
                idempotencyKey: idempotencyKey,
                attempts: attempts,
                lastError: lastError,
                lastErrorCode: lastErrorCode,
                status: status,
                createdAt: createdAt,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String id,
                required String userId,
                required String tenantId,
                Value<String?> locationId = const Value.absent(),
                Value<String?> groupKey = const Value.absent(),
                required String kind,
                required String payload,
                Value<String?> dependsOn = const Value.absent(),
                required String idempotencyKey,
                Value<int> attempts = const Value.absent(),
                Value<String?> lastError = const Value.absent(),
                Value<String?> lastErrorCode = const Value.absent(),
                Value<String> status = const Value.absent(),
                required DateTime createdAt,
                required DateTime updatedAt,
                Value<int> rowid = const Value.absent(),
              }) => OutboxEntriesCompanion.insert(
                id: id,
                userId: userId,
                tenantId: tenantId,
                locationId: locationId,
                groupKey: groupKey,
                kind: kind,
                payload: payload,
                dependsOn: dependsOn,
                idempotencyKey: idempotencyKey,
                attempts: attempts,
                lastError: lastError,
                lastErrorCode: lastErrorCode,
                status: status,
                createdAt: createdAt,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$OutboxEntriesTableProcessedTableManager =
    ProcessedTableManager<
      _$OutboxDb,
      $OutboxEntriesTable,
      OutboxEntry,
      $$OutboxEntriesTableFilterComposer,
      $$OutboxEntriesTableOrderingComposer,
      $$OutboxEntriesTableAnnotationComposer,
      $$OutboxEntriesTableCreateCompanionBuilder,
      $$OutboxEntriesTableUpdateCompanionBuilder,
      (
        OutboxEntry,
        BaseReferences<_$OutboxDb, $OutboxEntriesTable, OutboxEntry>,
      ),
      OutboxEntry,
      PrefetchHooks Function()
    >;
typedef $$OutboxAuditEntriesTableCreateCompanionBuilder =
    OutboxAuditEntriesCompanion Function({
      required String id,
      required String userId,
      required String tenantId,
      Value<String?> locationId,
      required String rowId,
      required String rowKind,
      required String summary,
      Value<String?> reasonCode,
      required DateTime discardedAt,
      Value<bool> synced,
      Value<int> rowid,
    });
typedef $$OutboxAuditEntriesTableUpdateCompanionBuilder =
    OutboxAuditEntriesCompanion Function({
      Value<String> id,
      Value<String> userId,
      Value<String> tenantId,
      Value<String?> locationId,
      Value<String> rowId,
      Value<String> rowKind,
      Value<String> summary,
      Value<String?> reasonCode,
      Value<DateTime> discardedAt,
      Value<bool> synced,
      Value<int> rowid,
    });

class $$OutboxAuditEntriesTableFilterComposer
    extends Composer<_$OutboxDb, $OutboxAuditEntriesTable> {
  $$OutboxAuditEntriesTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get userId => $composableBuilder(
    column: $table.userId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get tenantId => $composableBuilder(
    column: $table.tenantId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get locationId => $composableBuilder(
    column: $table.locationId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get rowId => $composableBuilder(
    column: $table.rowId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get rowKind => $composableBuilder(
    column: $table.rowKind,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get summary => $composableBuilder(
    column: $table.summary,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get reasonCode => $composableBuilder(
    column: $table.reasonCode,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get discardedAt => $composableBuilder(
    column: $table.discardedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<bool> get synced => $composableBuilder(
    column: $table.synced,
    builder: (column) => ColumnFilters(column),
  );
}

class $$OutboxAuditEntriesTableOrderingComposer
    extends Composer<_$OutboxDb, $OutboxAuditEntriesTable> {
  $$OutboxAuditEntriesTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get userId => $composableBuilder(
    column: $table.userId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get tenantId => $composableBuilder(
    column: $table.tenantId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get locationId => $composableBuilder(
    column: $table.locationId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get rowId => $composableBuilder(
    column: $table.rowId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get rowKind => $composableBuilder(
    column: $table.rowKind,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get summary => $composableBuilder(
    column: $table.summary,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get reasonCode => $composableBuilder(
    column: $table.reasonCode,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get discardedAt => $composableBuilder(
    column: $table.discardedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<bool> get synced => $composableBuilder(
    column: $table.synced,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$OutboxAuditEntriesTableAnnotationComposer
    extends Composer<_$OutboxDb, $OutboxAuditEntriesTable> {
  $$OutboxAuditEntriesTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get userId =>
      $composableBuilder(column: $table.userId, builder: (column) => column);

  GeneratedColumn<String> get tenantId =>
      $composableBuilder(column: $table.tenantId, builder: (column) => column);

  GeneratedColumn<String> get locationId => $composableBuilder(
    column: $table.locationId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get rowId =>
      $composableBuilder(column: $table.rowId, builder: (column) => column);

  GeneratedColumn<String> get rowKind =>
      $composableBuilder(column: $table.rowKind, builder: (column) => column);

  GeneratedColumn<String> get summary =>
      $composableBuilder(column: $table.summary, builder: (column) => column);

  GeneratedColumn<String> get reasonCode => $composableBuilder(
    column: $table.reasonCode,
    builder: (column) => column,
  );

  GeneratedColumn<DateTime> get discardedAt => $composableBuilder(
    column: $table.discardedAt,
    builder: (column) => column,
  );

  GeneratedColumn<bool> get synced =>
      $composableBuilder(column: $table.synced, builder: (column) => column);
}

class $$OutboxAuditEntriesTableTableManager
    extends
        RootTableManager<
          _$OutboxDb,
          $OutboxAuditEntriesTable,
          OutboxAuditEntry,
          $$OutboxAuditEntriesTableFilterComposer,
          $$OutboxAuditEntriesTableOrderingComposer,
          $$OutboxAuditEntriesTableAnnotationComposer,
          $$OutboxAuditEntriesTableCreateCompanionBuilder,
          $$OutboxAuditEntriesTableUpdateCompanionBuilder,
          (
            OutboxAuditEntry,
            BaseReferences<
              _$OutboxDb,
              $OutboxAuditEntriesTable,
              OutboxAuditEntry
            >,
          ),
          OutboxAuditEntry,
          PrefetchHooks Function()
        > {
  $$OutboxAuditEntriesTableTableManager(
    _$OutboxDb db,
    $OutboxAuditEntriesTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$OutboxAuditEntriesTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$OutboxAuditEntriesTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$OutboxAuditEntriesTableAnnotationComposer(
                $db: db,
                $table: table,
              ),
          updateCompanionCallback:
              ({
                Value<String> id = const Value.absent(),
                Value<String> userId = const Value.absent(),
                Value<String> tenantId = const Value.absent(),
                Value<String?> locationId = const Value.absent(),
                Value<String> rowId = const Value.absent(),
                Value<String> rowKind = const Value.absent(),
                Value<String> summary = const Value.absent(),
                Value<String?> reasonCode = const Value.absent(),
                Value<DateTime> discardedAt = const Value.absent(),
                Value<bool> synced = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => OutboxAuditEntriesCompanion(
                id: id,
                userId: userId,
                tenantId: tenantId,
                locationId: locationId,
                rowId: rowId,
                rowKind: rowKind,
                summary: summary,
                reasonCode: reasonCode,
                discardedAt: discardedAt,
                synced: synced,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String id,
                required String userId,
                required String tenantId,
                Value<String?> locationId = const Value.absent(),
                required String rowId,
                required String rowKind,
                required String summary,
                Value<String?> reasonCode = const Value.absent(),
                required DateTime discardedAt,
                Value<bool> synced = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => OutboxAuditEntriesCompanion.insert(
                id: id,
                userId: userId,
                tenantId: tenantId,
                locationId: locationId,
                rowId: rowId,
                rowKind: rowKind,
                summary: summary,
                reasonCode: reasonCode,
                discardedAt: discardedAt,
                synced: synced,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$OutboxAuditEntriesTableProcessedTableManager =
    ProcessedTableManager<
      _$OutboxDb,
      $OutboxAuditEntriesTable,
      OutboxAuditEntry,
      $$OutboxAuditEntriesTableFilterComposer,
      $$OutboxAuditEntriesTableOrderingComposer,
      $$OutboxAuditEntriesTableAnnotationComposer,
      $$OutboxAuditEntriesTableCreateCompanionBuilder,
      $$OutboxAuditEntriesTableUpdateCompanionBuilder,
      (
        OutboxAuditEntry,
        BaseReferences<_$OutboxDb, $OutboxAuditEntriesTable, OutboxAuditEntry>,
      ),
      OutboxAuditEntry,
      PrefetchHooks Function()
    >;

class $OutboxDbManager {
  final _$OutboxDb _db;
  $OutboxDbManager(this._db);
  $$OutboxEntriesTableTableManager get outboxEntries =>
      $$OutboxEntriesTableTableManager(_db, _db.outboxEntries);
  $$OutboxAuditEntriesTableTableManager get outboxAuditEntries =>
      $$OutboxAuditEntriesTableTableManager(_db, _db.outboxAuditEntries);
}
