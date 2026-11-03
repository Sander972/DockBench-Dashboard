import { expect, test } from 'bun:test'
import { base32Decode, base32Encode, checkTotpSecret, totpAt, verifyTotp } from './totp'

// RFC 6238 appendix B SHA-1 vectors, last 6 digits
const key = Buffer.from('12345678901234567890')

test('base32 matches the RFC secret and round-trips', () => {
  expect(base32Encode(key)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').equals(key)).toBe(true)
  expect(() => base32Decode('not base32!')).toThrow()
})

test('checkTotpSecret refuses secrets under 128 bits', () => {
  expect(() => checkTotpSecret('AAAA')).toThrow('TOTP_SECRET')
  expect(() => checkTotpSecret('A'.repeat(25))).toThrow('TOTP_SECRET')
  expect(checkTotpSecret('A'.repeat(26))).toHaveLength(16)
  expect(checkTotpSecret('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').equals(key)).toBe(true)
})

test('codes match the RFC vectors', () => {
  expect(totpAt(key, Math.floor(59 / 30))).toBe('287082')
  expect(totpAt(key, Math.floor(1111111109 / 30))).toBe('081804')
  expect(totpAt(key, Math.floor(20000000000 / 30))).toBe('353130')
})

test('verify accepts one step of drift and nothing else', () => {
  const now = 1111111109_000
  const t = Math.floor(now / 30000)
  expect(verifyTotp(key, '081804', now)).toBe(t)
  expect(verifyTotp(key, totpAt(key, t - 1), now)).toBe(t - 1)
  expect(verifyTotp(key, totpAt(key, t + 1), now)).toBe(t + 1)
  expect(verifyTotp(key, totpAt(key, t + 2), now)).toBeNull()
  for (const bad of ['', '81804', '0818040', 'abcdef', 81804, null]) expect(verifyTotp(key, bad, now)).toBeNull()
})
