package com.ridefleet.rideops

import io.flutter.embedding.android.FlutterFragmentActivity

// FlutterFragmentActivity (no FlutterActivity): requisito de local_auth para
// mostrar el prompt biométrico (BiometricPrompt necesita FragmentActivity).
class MainActivity : FlutterFragmentActivity()
