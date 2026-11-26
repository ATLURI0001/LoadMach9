export function assertPayloadWithinLimit(byteLength, maxBytes = 1048576) {
  if (byteLength < 0 || byteLength > maxBytes) {
    throw new Error(`Payload size ${byteLength} violates limit [0, ${maxBytes}]`);
  }
}
