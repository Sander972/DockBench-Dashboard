// ed25519 key pairs in the two encodings OpenSSH and GitHub read, built by hand because oven/bun:1-slim has no ssh-keygen and OpenSSH does not load PKCS#8 ed25519 keys
import { generateKeyPairSync, randomBytes } from 'node:crypto'

const TYPE = Buffer.from('ssh-ed25519')
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
const str = (b: Buffer) => Buffer.concat([u32(b.length), b])

export function encodeKeyPair(seed: Buffer, pub: Buffer, checkint: number): { publicKey: string; privateKeyBase64: string } {
  const pubBlob = Buffer.concat([str(TYPE), str(pub)])
  const check = u32(checkint)
  let priv = Buffer.concat([check, check, str(TYPE), str(pub), str(Buffer.concat([seed, pub])), str(Buffer.alloc(0))])
  for (let i = 1; priv.length % 8; i++) priv = Buffer.concat([priv, Buffer.from([i])])
  const file = Buffer.concat([Buffer.from('openssh-key-v1\0'), str(Buffer.from('none')), str(Buffer.from('none')), str(Buffer.alloc(0)), u32(1), str(pubBlob), str(priv)])
  const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${file.toString('base64').match(/.{1,70}/g)!.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`
  return { publicKey: `ssh-ed25519 ${pubBlob.toString('base64')}`, privateKeyBase64: Buffer.from(pem).toString('base64') }
}

export function generateDeployKey(): { publicKey: string; privateKeyBase64: string } {
  // the JWK of an ed25519 private key carries the raw seed (d) and the raw public key (x)
  const { d, x } = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' })
  return encodeKeyPair(Buffer.from(d!, 'base64url'), Buffer.from(x!, 'base64url'), randomBytes(4).readUInt32BE())
}
