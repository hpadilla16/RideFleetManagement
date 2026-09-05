/**
 * Ride University — the figure registry.
 *
 * A curriculum step may carry `figure: '<name>'` instead of pointing at an
 * element on a page. The name resolves here. The anchors test asserts the two
 * directions the same way it does for data-tour anchors: every figure a step
 * names exists, and every figure registered is named by a step.
 */
import {
  ScanTrouble, Escalated, GuestNoticeDone, GuestNoticeNow, HelpChat, RemoteLimits,
  NameMismatch, NameCode, PayQr, PayFailed, Idle, NotMine, Locked, Done,
} from './kiosk-guest';
import { StaffPin, StaffManualId, StaffVerify, StaffNameConfirm } from './kiosk-staff';

export const FIGURES = Object.freeze({
  'scan-trouble': ScanTrouble,
  'escalated': Escalated,
  'staff-pin': StaffPin,
  'staff-manual-id': StaffManualId,
  'staff-verify': StaffVerify,
  'guest-notice-done': GuestNoticeDone,
  'name-mismatch': NameMismatch,
  'name-code': NameCode,
  'staff-name-confirm': StaffNameConfirm,
  'help-chat': HelpChat,
  'guest-notice-now': GuestNoticeNow,
  'remote-limits': RemoteLimits,
  'pay-qr': PayQr,
  'pay-failed': PayFailed,
  'idle': Idle,
  'not-mine': NotMine,
  'locked': Locked,
  'done': Done,
});

export function figureFor(name) {
  return FIGURES[String(name || '')] || null;
}
