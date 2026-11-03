import { expect, test } from 'bun:test'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { encodeKeyPair, generateDeployKey } from './sshkey'

const seed = Buffer.from('cd84e22a006e7395e080d9ea0587598c5d61d6012b23264831af05d462474fe0', 'hex')
const pub = Buffer.from('fca8bb89f10f02dc3a745153dcd2babe474ebf891e287f46d87a395969c75a4a', 'hex')
const FIXTURE_PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPyou4nxDwLcOnRRU9zSur5HTr+JHih/Rth6OVlpx1pK'
const FIXTURE_PRIV = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  'QyNTUxOQAAACD8qLuJ8Q8C3Dp0UVPc0rq+R06/iR4of0bYejlZacdaSgAAAIhGAsNDRgLD',
  'QwAAAAtzc2gtZWQyNTUxOQAAACD8qLuJ8Q8C3Dp0UVPc0rq+R06/iR4of0bYejlZacdaSg',
  'AAAEDNhOIqAG5zleCA2eoFh1mMXWHWASsjJkgxrwXUYkdP4Pyou4nxDwLcOnRRU9zSur5H',
  'Tr+JHih/Rth6OVlpx1pKAAAAAAECAwQF',
  '-----END OPENSSH PRIVATE KEY-----',
  '',
].join('\n')

test('encodes exactly what ssh-keygen wrote', () => {
  const k = encodeKeyPair(seed, pub, 0x4602c343)
  expect(k.publicKey).toBe(FIXTURE_PUB)
  expect(Buffer.from(k.privateKeyBase64, 'base64').toString()).toBe(FIXTURE_PRIV)
})

// ed25519 PKCS#8 DER is a fixed 16-byte prefix followed by the 32-byte seed
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

test('a generated key pair is consistent and fresh each time', () => {
  const a = generateDeployKey()
  const b = generateDeployKey()
  expect(a.publicKey).not.toBe(b.publicKey)
  expect(a.publicKey.startsWith('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI')).toBe(true)
  // pull the seed back out of the private file: it sits right after the second "ssh-ed25519" type string and the 32-byte public key
  const file = Buffer.from(a.privateKeyBase64, 'base64').toString()
  const body = Buffer.from(file.split('\n').filter((l) => !l.startsWith('-')).join(''), 'base64')
  const marker = Buffer.from('ssh-ed25519')
  const second = body.indexOf(marker, body.indexOf(marker) + 1)
  const seedOut = body.subarray(second + marker.length + 4 + 32 + 4, second + marker.length + 4 + 32 + 4 + 32)
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seedOut]), format: 'der', type: 'pkcs8' })
  const pubOut = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32)
  expect(encodeKeyPair(seedOut, pubOut, 1).publicKey).toBe(a.publicKey)
})
