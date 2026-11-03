import { expect, test } from 'bun:test'
import { cbor, newChallenge, takeChallenge, verifyAssertion, verifyRegistration, type StoredPasskey } from './passkey'
import { cborEncode, softKey } from './softkey'

const e = { rpId: 'dash.example', origin: 'https://dash.example' }

test('cbor decodes what WebAuthn sends', () => {
  const v = { fmt: 'none', n: [0, 23, 24, 300, -1, -300], b: Buffer.from([1, 2]), '3': -7 }
  expect(cbor(cborEncode(v))[0]).toEqual({ fmt: 'none', n: [0, 23, 24, 300, -1, -300], b: Buffer.from([1, 2]), '3': -7 })
})

test('a registered passkey verifies its own assertions and nothing else', () => {
  const key = softKey(e.rpId, e.origin)
  const reg = verifyRegistration(key.create('c1'), { ...e, challenge: 'c1' })
  expect(reg.id).toBe(key.id)
  expect(reg.alg).toBe(-7)
  const stored: StoredPasskey = { ...reg, name: 'x', createdAt: '', lastUsedAt: null }

  stored.signCount = verifyAssertion(key.get('c2'), stored, { ...e, challenge: 'c2' })
  expect(stored.signCount).toBe(1)

  expect(() => verifyAssertion(key.get('c3'), stored, { ...e, challenge: 'other' })).toThrow('challenge mismatch')
  expect(() => verifyAssertion(key.get('c4', { o: 'https://evil.example' }), stored, { ...e, challenge: 'c4' })).toThrow('wrong origin')
  expect(() => verifyAssertion(key.get('c5', { rp: 'evil.example' }), stored, { ...e, challenge: 'c5' })).toThrow('another site')
  expect(() => verifyAssertion(key.get('c6', { flags: 0x01 }), stored, { ...e, challenge: 'c6' })).toThrow('user verification')
  // another key claiming this credential id
  expect(() => verifyAssertion(softKey(e.rpId, e.origin).get('c7'), stored, { ...e, challenge: 'c7' })).toThrow('bad passkey signature')
  // a replayed assertion carries an old counter
  const old = key.get('c8')
  stored.signCount = verifyAssertion(key.get('c8'), stored, { ...e, challenge: 'c8' })
  expect(() => verifyAssertion(old, stored, { ...e, challenge: 'c8' })).toThrow('counter')
  expect(() => verifyRegistration(key.create('r1', 'https://evil.example'), { ...e, challenge: 'r1' })).toThrow('wrong origin')
})

test('challenges are single use and bound to their ceremony', () => {
  const clientData = (c: string) => Buffer.from(JSON.stringify({ challenge: c })).toString('base64url')
  const c = newChallenge('step-up')
  expect(() => takeChallenge(clientData(c), 'login')).toThrow('expired')
  expect(takeChallenge(clientData(c), 'step-up')).toBe(c)
  expect(() => takeChallenge(clientData(c), 'step-up')).toThrow('expired')
  expect(() => takeChallenge(clientData('made-up'), 'step-up')).toThrow('expired')
  expect(() => takeChallenge(42, 'step-up')).toThrow('expired')
})

test('a flood of login challenges is refused and leaves the other ceremonies alone', () => {
  const clientData = (c: string) => Buffer.from(JSON.stringify({ challenge: c })).toString('base64url')
  const first = newChallenge('login')
  for (let i = 1; i < 20; i++) newChallenge('login')
  expect(() => newChallenge('login')).toThrow('Too many open passkey requests')
  // the open ones still work (nothing was evicted), and the owner's step-up is unaffected
  expect(takeChallenge(clientData(first), 'login')).toBe(first)
  expect(() => newChallenge('step-up')).not.toThrow()
})
