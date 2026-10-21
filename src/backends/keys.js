/** Opaque keys used to address one bridge's native session id. */

function encodeBase64Url(value) {
  return Buffer.from(String(value), 'utf8').toString('base64url')
}

function decodeBase64Url(value) {
  return Buffer.from(String(value), 'base64url').toString('utf8')
}

/** A key is `<bridge id>.<base64url(native session key)>`. Bridge ids are safe slugs. */
export function encodeSessionKey(bridgeId, nativeKey) {
  return `${bridgeId}.${encodeBase64Url(nativeKey)}`
}

export function decodeSessionKey(key) {
  if (typeof key !== 'string') throw new Error('missing session key')
  const separator = key.lastIndexOf('.')
  if (separator <= 0 || separator === key.length - 1) throw new Error('invalid session key')
  const bridgeId = key.slice(0, separator)
  const encoded = key.slice(separator + 1)
  let nativeKey
  try {
    nativeKey = decodeBase64Url(encoded)
  } catch {
    throw new Error('invalid session key')
  }
  return { bridgeId, nativeKey }
}
