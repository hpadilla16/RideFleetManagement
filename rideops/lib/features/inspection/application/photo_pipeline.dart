import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_image_compress/flutter_image_compress.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Resultado de comprimir una captura: bytes finales (para cifrar/encolar y
/// para la miniatura del tile) + el costo medido (telemetría
/// inspection.photo_captured).
class CompressedPhoto {
  const CompressedPhoto({required this.bytes, required this.msCompress});

  final Uint8List bytes;
  final int msCompress;
}

/// Compresor inyectable: la implementación real es flutter_image_compress
/// NATIVO path-a-path (el bitmap decodificado jamás cruza a Dart — DoD #8);
/// los tests inyectan una función pura.
typedef PhotoCompressor = Future<Uint8List> Function(String srcPath);

/// Pipeline de foto (H5, DoD #8): tras el shutter —
///   1. comprimir path-a-path (2048 px lado largo, calidad 80, keepExif),
///   2. borrar el temporal SIN comprimir (el original de ~3-8 MB no puede
///      quedarse en cache),
///   3. entregar los bytes al caller (cifrado + encolado).
/// La liberación del CONTROLADOR de cámara no vive aquí — es de la pantalla
/// (camera_capture_screen), que la hace en inactive/salida.
class PhotoPipeline {
  PhotoPipeline({PhotoCompressor? compressor})
      : _compressor = compressor ?? _nativeCompress;

  final PhotoCompressor _compressor;

  Future<CompressedPhoto> process(String tempPath) async {
    final sw = Stopwatch()..start();
    try {
      final bytes = await _compressor(tempPath);
      return CompressedPhoto(bytes: bytes, msCompress: sw.elapsedMilliseconds);
    } finally {
      // El temporal se borra SIEMPRE, incluso si la compresión falló — la
      // UI ofrece reintentar (re-captura), no re-comprimir un residuo.
      // Sync: archivo chico + el dart:io async no vive bien en widget tests.
      try {
        final f = File(tempPath);
        if (f.existsSync()) f.deleteSync();
      } catch (_) {}
    }
  }

  static Future<Uint8List> _nativeCompress(String srcPath) async {
    final target = '$srcPath.c.jpg';
    try {
      // minWidth/minHeight actúan como caja de 2048: el lado largo queda en
      // ~2048 manteniendo aspecto. keepExif: la orientación/tiempo de la
      // captura son parte de la evidencia.
      final out = await FlutterImageCompress.compressAndGetFile(
        srcPath,
        target,
        minWidth: 2048,
        minHeight: 2048,
        quality: 80,
        keepExif: true,
      );
      if (out == null) {
        throw StateError('compresión devolvió null');
      }
      return File(out.path).readAsBytesSync();
    } finally {
      try {
        final f = File(target);
        if (f.existsSync()) f.deleteSync();
      } catch (_) {}
    }
  }
}

final Provider<PhotoPipeline> photoPipelineProvider =
    Provider<PhotoPipeline>((ref) => PhotoPipeline());
