const appUrl = process.env.RIDEFLEET_MOBILE_APP_URL || 'https://ridefleetmanager.com';
const cleartext = appUrl.startsWith('http://');

/** @type {import('@capacitor/cli').CapacitorConfig} */
const config = {
  appId: 'com.ridefleet.mobile',
  appName: 'Ride Fleet',
  webDir: 'mobile-shell',
  bundledWebRuntime: false,
  server: {
    url: appUrl,
    cleartext,
    allowNavigation: ['ridefleetmanager.com', '*.ridefleetmanager.com'],
    // Local branded page with auto-retry when the hosted app can't load
    // (lot wifi drop, backend restart). Lives in mobile-shell/.
    errorPath: 'error.html',
  },
};

module.exports = config;
