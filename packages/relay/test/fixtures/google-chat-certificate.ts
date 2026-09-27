// A minimal self-signed x509 certificate for a test RSA key, shaped like the entries of Google's certificate map.
import { createPublicKey, sign, type KeyObject } from 'node:crypto'

// DER TLV; lengths here never exceed two length bytes.
function der(tag: number, content: Buffer): Buffer {
  const len = content.length
  const lenBytes = len < 0x80 ? Buffer.from([len]) : Buffer.from([0x80 | 2, len >> 8, len & 0xff])
  return Buffer.concat([Buffer.from([tag]), lenBytes, content])
}
const sequence = (...items: Buffer[]) => der(0x30, Buffer.concat(items))
const integer = (n: number) => der(0x02, Buffer.from([n]))
const utcTime = (value: string) => der(0x17, Buffer.from(value, 'ascii'))
const bitString = (bytes: Buffer) => der(0x03, Buffer.concat([Buffer.from([0]), bytes]))
// sha256WithRSAEncryption (1.2.840.113549.1.1.11) with its NULL parameters.
const SHA256_WITH_RSA = sequence(
  der(0x06, Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b])),
  der(0x05, Buffer.alloc(0))
)

/** A v3 certificate over the key's public half, signed by that key; the issuer and subject names are empty. */
export function selfSignedCertificatePem(privateKey: KeyObject): string {
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  const name = sequence()
  const tbs = sequence(
    der(0xa0, integer(2)),
    integer(1),
    SHA256_WITH_RSA,
    name,
    sequence(utcTime('260101000000Z'), utcTime('270101000000Z')),
    name,
    spki
  )
  const certificate = sequence(tbs, SHA256_WITH_RSA, bitString(sign('sha256', tbs, privateKey)))
  const lines = certificate.toString('base64').match(/.{1,64}/g) ?? []
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`
}
