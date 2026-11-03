import { expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { checkSessionSecret, createSession, verifySession } from './session'

const secret = 'test-secret-at-least-32-characters-long'

test('a fresh session verifies and has three parts', () => {
  const cookie = createSession(secret)
  expect(cookie.split('.')).toHaveLength(3)
  expect(verifySession(secret, cookie)).toBe(true)
})

test('a tampered signature, issued time or expiry fails', () => {
  const [iat, exp, sig] = createSession(secret).split('.')
  const flipped = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1)
  expect(verifySession(secret, `${iat}.${exp}.${flipped}`)).toBe(false)
  expect(verifySession(secret, `${Number(iat) + 1}.${exp}.${sig}`)).toBe(false)
  expect(verifySession(secret, `${iat}.${Number(exp) + 1}.${sig}`)).toBe(false)
})

test('a different secret fails', () => {
  expect(verifySession('other-secret', createSession(secret))).toBe(false)
})

test('an expired session fails', () => {
  expect(verifySession(secret, createSession(secret, 0), 31 * 24 * 3600 * 1000)).toBe(false)
})

test('a seconds-based cookie from before the switch to milliseconds is expired', () => {
  const payload = '1700000000.1702592000'
  const sig = createHmac('sha256', secret).update(payload).digest('hex')
  expect(verifySession(secret, `${payload}.${sig}`, 1_700_000_100_000)).toBe(false)
})

test('checkSessionSecret refuses the example value and short strings', () => {
  expect(() => checkSessionSecret('change-me-to-a-random-string-of-at-least-32-chars')).toThrow('SESSION_SECRET')
  expect(() => checkSessionSecret('a'.repeat(31))).toThrow('SESSION_SECRET')
  expect(checkSessionSecret('a'.repeat(32))).toBe('a'.repeat(32))
})

test('missing or malformed cookies fail', () => {
  expect(verifySession(secret, undefined)).toBe(false)
  expect(verifySession(secret, '')).toBe(false)
  expect(verifySession(secret, 'nodot')).toBe(false)
  expect(verifySession(secret, '123.456')).toBe(false)
  expect(verifySession(secret, '123.456.')).toBe(false)
})
