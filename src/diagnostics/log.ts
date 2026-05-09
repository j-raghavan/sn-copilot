// __DEV__-gated console.log wrapper for verbose diagnostic lines.
//
// Production bundles set __DEV__ to false at compile time (Metro /
// Babel), so these calls collapse to no-ops in shipped builds. Use
// it for path/length/identifying metadata that's helpful in dev but
// shouldn't end up in logs shared from a user's device.
//
// Errors and actionable warnings should keep using console.warn /
// console.error directly — those signals matter regardless of build
// type.

export const debugLog = (...args: unknown[]): void => {
  if (typeof __DEV__ !== 'undefined' && __DEV__ === false) {
    return;
  }
  console.log(...args);
};
