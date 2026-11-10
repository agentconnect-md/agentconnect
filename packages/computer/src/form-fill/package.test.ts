import { createHash, createPublicKey, verify } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { extensionId, extensionKey, installExtension, packCrx, zipStored } from './package.js'

const build = {
  buildId: 'build-a',
  files: { 'manifest.json': '{"manifest_version":3,"version":"2.1.0"}', 'worker.js': 'console.log("π")' }
}

// Minimal protobuf reader for the CRX header: field number → payloads.
function fields(bytes: Buffer): Map<number, Buffer[]> {
  const out = new Map<number, Buffer[]>()
  let at = 0
  const varint = () => {
    let value = 0
    let shift = 0
    for (;;) {
      const byte = bytes[at++]!
      value += (byte & 127) * 2 ** shift
      if (byte < 128) return value
      shift += 7
    }
  }
  while (at < bytes.length) {
    const tag = varint()
    const length = varint()
    out.set(tag >>> 3, [...(out.get(tag >>> 3) ?? []), bytes.subarray(at, at + length)])
    at += length
  }
  return out
}

// Reads a stored zip's entries by walking its local headers.
function unzip(zip: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let at = 0
  while (zip.readUInt32LE(at) === 0x04034b50) {
    const method = zip.readUInt16LE(at + 8)
    const size = zip.readUInt32LE(at + 18)
    const nameLength = zip.readUInt16LE(at + 26)
    const extra = zip.readUInt16LE(at + 28)
    const name = zip.subarray(at + 30, at + 30 + nameLength).toString('utf8')
    const data = zip.subarray(at + 30 + nameLength + extra, at + 30 + nameLength + extra + size)
    out[name] = (method === 0 ? data : inflateRawSync(data)).toString('utf8')
    at += 30 + nameLength + extra + size
  }
  return out
}

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('form fill extension packaging (computer-form-fill-and-vault.md §8)', () => {
  it('derives one id per build and a different one for another build', () => {
    const id = extensionId(extensionKey('build-a'))
    expect(id).toMatch(/^[a-p]{32}$/)
    expect(extensionId(extensionKey('build-a'))).toBe(id)
    expect(extensionId(extensionKey('build-b'))).not.toBe(id)
  })

  it('packs a CRX3 whose signed id and ECDSA proof Chromium can verify', () => {
    const key = extensionKey('build-a')
    const zip = zipStored(build.files)
    const crx = packCrx(zip, key)
    expect(crx.subarray(0, 4).toString('latin1')).toBe('Cr24')
    expect(crx.readUInt32LE(4)).toBe(3)
    const headerSize = crx.readUInt32LE(8)
    const header = fields(crx.subarray(12, 12 + headerSize))
    expect(crx.subarray(12 + headerSize).equals(zip)).toBe(true)
    const signedData = header.get(10000)![0]!
    const crxId = fields(signedData).get(1)![0]!
    const proof = fields(header.get(3)![0]!)
    const publicKey = proof.get(1)![0]!
    expect(createHash('sha256').update(publicKey).digest().subarray(0, 16).equals(crxId)).toBe(true)
    const size = Buffer.alloc(4)
    size.writeUInt32LE(signedData.length)
    const message = Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), size, signedData, zip])
    const spki = createPublicKey({ key: publicKey, format: 'der', type: 'spki' })
    expect(verify('sha256', message, { key: spki, dsaEncoding: 'der' }, proof.get(2)![0]!)).toBe(true)
    expect(unzip(zip)).toEqual(build.files)
  })

  it('zips one build to the same bytes, whatever the order of its files', () => {
    const reversed = Object.fromEntries(Object.entries(build.files).reverse())
    expect(zipStored(build.files).equals(zipStored(reversed))).toBe(true)
  })

  it('writes the CRX, an update manifest and a policy that force-installs it and names the endpoint', () => {
    dir = mkdtempSync(join(tmpdir(), 'form-fill-package-'))
    const installed = installExtension({ build, dir: join(dir, 'ext'), policyDir: join(dir, 'policy'), port: 7682 })
    expect(installed).toEqual({ id: extensionId(extensionKey('build-a')), version: '2.1.0' })
    const policy = JSON.parse(readFileSync(join(dir, 'policy', 'agentconnect-form-fill.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(policy).toEqual({
      ExtensionInstallForcelist: [`${installed.id};file://${join(dir, 'ext', 'update.xml')}`],
      '3rdparty': { extensions: { [installed.id]: { endpoint: 'ws://127.0.0.1:7682/' } } }
    })
    const manifest = readFileSync(join(dir, 'ext', 'update.xml'), 'utf8')
    expect(manifest).toContain(`appid='${installed.id}'`)
    expect(manifest).toContain(`codebase='file://${join(dir, 'ext', 'form-fill.crx')}' version='2.1.0'`)
    expect(
      readFileSync(join(dir, 'ext', 'form-fill.crx'))
        .subarray(0, 4)
        .toString('latin1')
    ).toBe('Cr24')
  })
})
