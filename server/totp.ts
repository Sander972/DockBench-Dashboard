// RFC 6238 TOTP (SHA-1, 6 digits, 30 s), the variant Google Authenticator speaks
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Decode(s: string): Buffer {
  let bits = 0
  let val = 0
  const out: number[] = []
  for (const c of s.toUpperCase().replace(/[\s=]/g, '')) {
    const i = B32.indexOf(c)
    if (i < 0) throw new Error('TOTP_SECRET must be base32')
    val = ((val << 5) | i) & 0xffff
    bits += 5
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

// RFC 4226 minimum of 128 bits; a short or truncated secret would let one observed code brute-force the key offline. `bun server/totp.ts` prints 160 bits.
export function checkTotpSecret(s: string): Buffer {
  const key = base32Decode(s)
  if (key.length < 16) throw new Error('TOTP_SECRET must decode to at least 16 bytes (26+ base32 characters); generate one with `bun server/totp.ts`')
  return key
}

export function base32Encode(b: Buffer): string {
  let bits = 0
  let val = 0
  let out = ''
  for (const x of b) {
    val = ((val << 8) | x) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return bits ? out + B32[(val << (5 - bits)) & 31] : out
}

export function totpAt(key: Buffer, counter: number): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', key).update(msg).digest()
  return String((h.readUInt32BE(h[19] & 15) & 0x7fffffff) % 1e6).padStart(6, '0')
}

// the matching time step (one step of clock drift either way), or null; callers refuse steps already used to block replays
export function verifyTotp(key: Buffer, code: unknown, now = Date.now()): number | null {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null
  const t = Math.floor(now / 30000)
  for (const c of [t - 1, t, t + 1]) if (timingSafeEqual(Buffer.from(totpAt(key, c)), Buffer.from(code))) return c
  return null
}

// bun server/totp.ts <login>: prints a fresh secret to put in TOTP_SECRET and to type into Google Authenticator (Enter a setup key, Time based)
if (import.meta.main) {
  const secret = base32Encode(randomBytes(20))
  const login = process.argv[2] ?? 'dashboard'
  console.log(`TOTP_SECRET=${secret}`)
  console.log(`otpauth://totp/DockBench:${encodeURIComponent(login)}?secret=${secret}&issuer=DockBench`)
}
