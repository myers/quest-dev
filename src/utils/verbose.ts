/**
 * Global verbose flag for debug output
 */
let _verbose = false;

export function setVerbose(v: boolean): void {
  _verbose = v;
}

export function verbose(...args: unknown[]): void {
  if (_verbose) {
    console.log('[verbose]', ...args);
  }
}
