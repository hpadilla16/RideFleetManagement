function normalizedAppIds() {
  const teamId = String(
    process.env.RIDEFLEET_APPLE_TEAM_ID ||
    process.env.NEXT_PUBLIC_RIDEFLEET_APPLE_TEAM_ID ||
    ''
  ).trim();
  const bundleId = String(
    process.env.RIDEFLEET_IOS_BUNDLE_ID ||
    process.env.NEXT_PUBLIC_RIDEFLEET_IOS_BUNDLE_ID ||
    'com.ridefleet.mobile'
  ).trim();

  if (!teamId) return [];
  return [`${teamId}.${bundleId}`];
}

export async function GET() {
  return Response.json({
    applinks: {
      apps: [],
      details: normalizedAppIds().map((appID) => ({
        appID,
        paths: [
          '/guest*',
          '/host-review*',
          '/issue-response*',
          '/customer/*',
          '/book*'
        ]
      }))
    }
  }, {
    headers: {
      'Content-Type': 'application/json'
    }
  });
}
