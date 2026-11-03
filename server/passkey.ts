import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from 'node:crypto'
import { mkdir, rename } from 'node:fs/promises'
import { HttpError } from './http'

// WebAuthn without a library, because the image keeps runtime dependencies at zero (it holds the Docker socket). Only what this dashboard asks for: attestation "none", user verification required, ES256 or RS256 keys.

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url')
const unb64u = (s: unknown) => {
  if (typeof s !== 'string') throw new Error('malformed credential')
  return Buffer.from(s, 'base64url')
}
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest()

// CBOR subset WebAuthn uses: unsigned and negative ints, byte and text strings, arrays, maps, true/false/null
export function cbor(buf: Buffer, at = 0): [unknown, number] {
  const head = buf[at]
  if (head === undefined) throw new Error('truncated CBOR')
  const major = head >> 5
  const info = head & 31
  let len: number
  let p = at + 1
  if (info < 24) len = info
  else if (info === 24) (len = buf[p]), (p += 1)
  else if (info === 25) (len = buf.readUInt16BE(p)), (p += 2)
  else if (info === 26) (len = buf.readUInt32BE(p)), (p += 4)
  else if (info === 27) (len = Number(buf.readBigUInt64BE(p))), (p += 8)
  else throw new Error('unsupported CBOR length')
  switch (major) {
    case 0: return [len, p]
    case 1: return [-1 - len, p]
    case 2: return [buf.subarray(p, p + len), p + len]
    case 3: return [buf.subarray(p, p + len).toString('utf8'), p + len]
    case 4: {
      const out: unknown[] = []
      for (let i = 0; i < len; i++) { const [v, n] = cbor(buf, p); out.push(v); p = n }
      return [out, p]
    }
    case 5: {
      const out: Record<string, unknown> = {}
      for (let i = 0; i < len; i++) { const [k, n] = cbor(buf, p); const [v, m] = cbor(buf, n); out[String(k)] = v; p = m }
      return [out, p]
    }
    case 7: return [info === 20 ? false : info === 21 ? true : null, p]
    default: throw new Error('unsupported CBOR type')
  }
}

// COSE key to JWK: EC2 P-256 (alg -7) or RSA (alg -257)
export function coseToJwk(cose: Record<string, unknown>): { jwk: JsonWebKey; alg: number } {
  const bytes = (k: string) => b64u(cose[k] as Buffer)
  if (cose['1'] === 2 && cose['3'] === -7 && cose['-1'] === 1) return { jwk: { kty: 'EC', crv: 'P-256', x: bytes('-2'), y: bytes('-3') }, alg: -7 }
  if (cose['1'] === 3 && cose['3'] === -257) return { jwk: { kty: 'RSA', n: bytes('-1'), e: bytes('-2') }, alg: -257 }
  throw new Error('unsupported passkey algorithm')
}

const UP = 0x01
const UV = 0x04
const AT = 0x40

export interface AuthData {
  rpIdHash: Buffer
  flags: number
  signCount: number
  credId?: Buffer
  cose?: Record<string, unknown>
}

export function parseAuthData(b: Buffer): AuthData {
  if (b.length < 37) throw new Error('authenticator data too short')
  const out: AuthData = { rpIdHash: b.subarray(0, 32), flags: b[32], signCount: b.readUInt32BE(33) }
  if (out.flags & AT) {
    const n = b.readUInt16BE(53)
    out.credId = b.subarray(55, 55 + n)
    out.cose = cbor(b, 55 + n)[0] as Record<string, unknown>
  }
  return out
}

export interface Expect {
  challenge: string
  origin: string
  rpId: string
}

function checkClient(clientDataJSON: Buffer, type: string, e: Expect) {
  const c = JSON.parse(clientDataJSON.toString('utf8')) as { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean }
  if (c.type !== type) throw new Error('wrong ceremony type')
  if (c.challenge !== e.challenge) throw new Error('challenge mismatch')
  if (c.origin !== e.origin || c.crossOrigin) throw new Error('wrong origin')
}

function checkAuthData(a: AuthData, rpId: string) {
  if (!a.rpIdHash.equals(sha256(rpId))) throw new Error('passkey is for another site')
  if (!(a.flags & UP) || !(a.flags & UV)) throw new Error('user verification missing')
}

export interface StoredPasskey {
  id: string
  jwk: JsonWebKey
  alg: number
  signCount: number
  name: string
  createdAt: string
  lastUsedAt: string | null
}

// navigator.credentials.create() result as the frontend sends it (base64url fields)
export function verifyRegistration(cred: { response?: { clientDataJSON?: unknown; attestationObject?: unknown } }, e: Expect): Omit<StoredPasskey, 'name' | 'createdAt' | 'lastUsedAt'> {
  checkClient(unb64u(cred.response?.clientDataJSON), 'webauthn.create', e)
  const att = cbor(unb64u(cred.response?.attestationObject))[0] as { authData?: Buffer }
  if (!att?.authData) throw new Error('attestation without authenticator data')
  const a = parseAuthData(att.authData)
  checkAuthData(a, e.rpId)
  if (!a.credId || !a.cose) throw new Error('no credential in the attestation')
  return { id: b64u(a.credId), ...coseToJwk(a.cose), signCount: a.signCount }
}

// navigator.credentials.get() result; returns the new signature counter. A counter that does not grow (when the authenticator keeps one) means a cloned key.
export function verifyAssertion(cred: { response?: { clientDataJSON?: unknown; authenticatorData?: unknown; signature?: unknown } }, stored: StoredPasskey, e: Expect): number {
  const clientDataJSON = unb64u(cred.response?.clientDataJSON)
  const authData = unb64u(cred.response?.authenticatorData)
  checkClient(clientDataJSON, 'webauthn.get', e)
  const a = parseAuthData(authData)
  checkAuthData(a, e.rpId)
  const ok = verify('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), createPublicKey({ key: stored.jwk, format: 'jwk' }), unb64u(cred.response?.signature))
  if (!ok) throw new Error('bad passkey signature')
  if ((a.signCount || stored.signCount) && a.signCount <= stored.signCount) throw new Error('passkey counter went backwards, it may be cloned')
  return a.signCount
}

// challenges live 5 minutes and are single use. ponytail: in memory, fine for one user; a restart only cancels a ceremony in progress.
type Purpose = 'login' | 'step-up' | 'register'
const challenges = new Map<string, { purpose: Purpose; exp: number }>()
// capped per purpose and refused when full, never evicted: login challenges are issued to anyone, so a flood of them must not expire the owner's step-up or registration, and a refusal says "later" where an eviction would say "expired" mid-ceremony. The 2FA sign-in stays open meanwhile.
const CAP = 20
export function newChallenge(purpose: Purpose): string {
  const now = Date.now()
  for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k)
  if ([...challenges.values()].filter((v) => v.purpose === purpose).length >= CAP) throw new HttpError(429, 'Too many open passkey requests. Try again in a few minutes, or sign in with GitHub and the authenticator code.')
  const c = b64u(randomBytes(32))
  challenges.set(c, { purpose, exp: now + 300_000 })
  return c
}

// the challenge the browser signed, once, and only for the ceremony it was issued for
export function takeChallenge(clientDataJSON: unknown, purpose: Purpose): string {
  let c: string | undefined
  try { c = JSON.parse(unb64u(clientDataJSON).toString('utf8')).challenge } catch { /* refused below */ }
  const v = c ? challenges.get(c) : undefined
  if (!c || !v || v.purpose !== purpose || v.exp < Date.now()) throw new Error('passkey request expired, try again')
  challenges.delete(c)
  return c
}

export type Guarded = 'stop' | 'restart' | 'pull' | 'deploy' | 'update' | 'remove'
export type StepUpPrefs = Record<Guarded, boolean>
export interface PasskeyFile {
  creds: StoredPasskey[]
  stepUp: StepUpPrefs
}

const DEFAULT_STEP_UP: StepUpPrefs = { stop: true, restart: true, pull: true, deploy: true, update: true, remove: true }

export async function readPasskeys(dataDir: string): Promise<PasskeyFile> {
  const f = Bun.file(`${dataDir}/passkeys.json`)
  const d = (await f.exists()) ? ((await f.json()) as Partial<PasskeyFile>) : {}
  return { creds: d.creds ?? [], stepUp: { ...DEFAULT_STEP_UP, ...d.stepUp } }
}

// temp file plus rename, so a crash mid-write never loses every passkey
export async function writePasskeys(dataDir: string, d: PasskeyFile): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  await Bun.write(`${dataDir}/passkeys.json.tmp`, JSON.stringify(d))
  await rename(`${dataDir}/passkeys.json.tmp`, `${dataDir}/passkeys.json`)
}

// stable WebAuthn user handle for the one allowed account
export const userHandle = (login: string) => b64u(sha256(`dockbench:${login}`).subarray(0, 16))
