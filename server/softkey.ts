import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'

// Test-only software authenticator: answers WebAuthn create and get the way a platform passkey does (attestation none, user verified, ES256), so the server ceremonies can be checked without a browser.

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url')
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest()

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n])
  if (n < 256) return Buffer.from([(major << 5) | 24, n])
  const b = Buffer.alloc(3)
  b[0] = (major << 5) | 25
  b.writeUInt16BE(n, 1)
  return b
}

// keys that look like integers are written as CBOR integers, as COSE needs
export function cborEncode(v: unknown): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v)
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v])
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)])
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cborEncode)])
  const entries = Object.entries(v as Record<string, unknown>)
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cborEncode(/^-?\d+$/.test(k) ? Number(k) : k), cborEncode(x)])])
}

export function softKey(rpId: string, origin: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const credId = randomBytes(16)
  let count = 0
  const client = (type: string, challenge: string, o = origin) => Buffer.from(JSON.stringify({ type, challenge, origin: o, crossOrigin: false }))
  const counter = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
  return {
    id: b64u(credId),
    create(challenge: string, o = origin) {
      const cose = cborEncode({ 1: 2, 3: -7, '-1': 1, '-2': Buffer.from(jwk.x!, 'base64url'), '-3': Buffer.from(jwk.y!, 'base64url') })
      const len = Buffer.alloc(2)
      len.writeUInt16BE(credId.length)
      const authData = Buffer.concat([sha256(rpId), Buffer.from([0x45]), counter(count), Buffer.alloc(16), len, credId, cose])
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', response: { clientDataJSON: b64u(client('webauthn.create', challenge, o)), attestationObject: b64u(cborEncode({ fmt: 'none', attStmt: {}, authData })) } }
    },
    get(challenge: string, { o = origin, rp = rpId, flags = 0x05 } = {}) {
      const clientDataJSON = client('webauthn.get', challenge, o)
      const authData = Buffer.concat([sha256(rp), Buffer.from([flags]), counter(++count)])
      const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), privateKey)
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: null } }
    },
  }
}
