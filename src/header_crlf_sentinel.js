export function assertSafeHeaderValue(value) {
  if (/[\r\n]/.test(value)) {
    throw new Error('Sentinel violation: CRLF injection detected in HTTP header value');
  }
}
