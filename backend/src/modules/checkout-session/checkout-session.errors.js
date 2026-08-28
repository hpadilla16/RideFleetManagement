/**
 * The checkout-session error type, alone in a leaf module.
 *
 * WHY IT LIVES HERE AND NOT IN checkout-session.service.js. Every helper the
 * service delegates to needs to THROW this class, and the service needs to
 * import those helpers — which made a cycle every time (the gate being the
 * first). ESM tolerates that as long as neither side dereferences the other's
 * bindings during module evaluation, but "tolerates" is a property of today's
 * code, not of the design: the first person to add top-level code touching the
 * binding gets a TDZ ReferenceError at boot, far from the edit that caused it.
 * A leaf module with no imports of its own cannot participate in a cycle at
 * all, which removes the failure class instead of the current instance.
 *
 * checkout-session.service.js re-exports this symbol, so all existing importers
 * keep working unchanged.
 */

export class CheckoutSessionError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.name = 'CheckoutSessionError';
    this.status = status;
    this.code = code;
  }
}
