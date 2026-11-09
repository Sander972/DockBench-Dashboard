import { createHmac, timingSafeEqual } from 'node:crypto'

export const SESSION_TTL_SECONDS = 30 * 24 * 3600

// the placeholder in .env.example would let anyone mint sessions, so the server refuses to start with it
export function checkSessionSecret(v: string): string {
  if (v.length < 32 || v.startsWith('change-me')) throw new Error('SESSION_SECRET must be a random string of at least 32 characters')
  return v
}

// constant-time string compare by bytes: timingSafeEqual throws on a byte-length mismatch, which a non-ASCII string of the right length would cause
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

// <issued>.<expiry>.<hmac>, Unix milliseconds: a self-contained signed token for the short-lived totp_pending and step_up cookies. The session cookie itself is a record id (server/sessions.ts).
export function createSession(secret: string, now = Date.now(), ttlSeconds = SESSION_TTL_SECONDS): string {
  const payload = `${now}.${now + ttlSeconds * 1000}`
  return `${payload}.${sign(secret, payload)}`
}

export function verifySession(secret: string, cookie: string | undefined | null, now = Date.now()): boolean {
  if (!cookie) return false
  const [iat, exp, sig] = cookie.split('.')
  if (!iat || !exp || !sig) return false
  if (!safeEqual(sig, sign(secret, `${iat}.${exp}`))) return false
  return Number(exp) > now
}
