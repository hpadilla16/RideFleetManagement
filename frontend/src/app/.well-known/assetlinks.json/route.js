function normalizedFingerprints() {
  const raw = String(
    process.env.RIDEFLEET_ANDROID_SHA256_CERT_FINGERPRINTS ||
    process.env.NEXT_PUBLIC_RIDEFLEET_ANDROID_SHA256_CERT_FINGERPRINTS ||
    ''
  ).trim();

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function GET() {
  const packageName = String(
    process.env.RIDEFLEET_ANDROID_APP_ID ||
    process.env.NEXT_PUBLIC_RIDEFLEET_ANDROID_APP_ID ||
    'com.ridefleet.mobile'
  ).trim();
  const fingerprints = normalizedFingerprints();

  return Response.json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: packageName,
        sha256_cert_fingerprints: fingerprints
      }
    }
  ]);
}
