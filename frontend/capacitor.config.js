const appUrl = process.env.RIDEFLEET_MOBILE_APP_URL || 'https://beta.ridefleetmanager.com';
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
  },
};

module.exports = config;
