/**
 * Per-device identity helpers: derive a stable, deterministic host-side CDP
 * port from a device's hardware serial so the same device gets the same port
 * across runs. Collisions are resolved at forward time (probe upward) by the
 * caller; this is the *preferred* port, not a guarantee.
 */
import { createHash } from 'crypto';

export const CDP_PORT_BASE = 9223;
export const CDP_PORT_SPAN = 64;

export function cdpPortForSerial(serial: string): number {
  const digest = createHash('sha1').update(serial).digest();
  // Use the first 4 bytes as an unsigned int for the modulus.
  const n = digest.readUInt32BE(0);
  return CDP_PORT_BASE + (n % CDP_PORT_SPAN);
}
