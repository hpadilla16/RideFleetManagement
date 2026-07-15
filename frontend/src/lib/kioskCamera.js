'use client';

/**
 * Ride Kiosk — hardened camera acquisition (iPad/WebKit fixes, 2026-07-06).
 *
 * Hector's iPad re-test: permission granted but the preview never opened.
 * iOS getUserMedia is only reliable when:
 *   1. it is called SYNCHRONOUSLY inside a user tap (especially the very
 *      first time, when the permission prompt interrupts the flow) — this
 *      module calls getUserMedia with NO awaits before it, so a tap handler
 *      that invokes acquireCameraStream() keeps the gesture context;
 *   2. only ONE request is in flight — a concurrent second request can kill
 *      both, so a module-level flag rejects overlapping calls (the caller's
 *      retry timers / re-renders / phase changes can never double-request);
 *   3. a request left pending on the permission prompt while the component
 *      unmounts must not orphan a live stream — callers pass isCancelled()
 *      and the resolved stream's tracks are stopped immediately.
 *
 * Returns { stream } or { error: { name, message } } — NEVER throws. The
 * error.name is surfaced verbatim in the UI diagnostics line (we debug
 * remotely through Hector: "NotAllowedError" vs "NotReadableError" vs
 * "AbortError" is the signal).
 */

let inFlight = false;
// A stream succeeded once this session → permission is granted and
// effect-initiated (non-gesture) starts are safe fast paths.
let grantedOnce = false;

export function cameraGrantedOnce() {
  return grantedOnce;
}

export const CAMERA_ERR_IN_FLIGHT = 'RequestInFlight';

export async function acquireCameraStream({
  facingMode = 'user',
  idealWidth = 1280,
  idealHeight = 720,
  retryOnce = true,
  isCancelled = () => false,
} = {}) {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return { error: { name: 'NotSupportedError', message: 'mediaDevices unavailable' } };
  }
  if (inFlight) {
    // Never fire a second concurrent request on iOS. The first request's
    // outcome will drive the UI; callers treat this as a silent no-op.
    return { error: { name: CAMERA_ERR_IN_FLIGHT } };
  }
  inFlight = true;
  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: facingMode },
      width: { ideal: idealWidth },
      height: { ideal: idealHeight },
    },
  };
  const kill = (stream) => { try { stream?.getTracks?.().forEach((track) => track.stop()); } catch {} };

  try {
    let stream = null;
    let lastErr = null;
    try {
      // IMPORTANT: first getUserMedia call happens synchronously within the
      // caller's tap gesture (async fn runs sync until its first await).
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) { lastErr = e; }

    if (!stream && retryOnce && !isCancelled()) {
      // WebKit single-stream rule: a previous surface's tracks may still be
      // releasing. One 500ms-spaced retry, never more.
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!isCancelled()) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
          lastErr = null;
        } catch (e) { lastErr = e; }
      }
    }

    if (!stream) {
      return { error: { name: lastErr?.name || 'UnknownError', message: lastErr?.message || '' } };
    }
    grantedOnce = true;
    if (isCancelled()) {
      // Permission-prompt race: resolved after the component died → the
      // stream must not stay orphaned/holding the camera.
      kill(stream);
      return { error: { name: 'Cancelled' } };
    }
    return { stream };
  } finally {
    inFlight = false;
  }
}
