// Packs and installs the form-fill extension for a Chromium policy force-install (computer-form-fill-and-vault.md §8).
import { createECDH, createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { COMPUTER_FORM_FILL_ENDPOINT_KEY } from '@agentconnect.md/protocol/computer-form-fill'

/** The extension as the bundle carries it: its build id and files. */
export interface ExtensionBuild {
  buildId: string
  files: Record<string, string>
}

const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')

/** The signing key, derived from the build id: one build always has one extension id, and a new build a new one. */
export function extensionKey(buildId: string): KeyObject {
  // Not a secret: the id only names this build to Chromium; the daemon trusts a socket by /proc attribution and build id.
  const seed = BigInt(`0x${createHash('sha256').update(`agentconnect-form-fill-key\0${buildId}`).digest('hex')}`)
  const d = Buffer.from(((seed % (P256_ORDER - 1n)) + 1n).toString(16).padStart(64, '0'), 'hex')
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(d)
  const point = ecdh.getPublicKey()
  const b64 = (bytes: Buffer) => bytes.toString('base64url')
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64(d), x: b64(point.subarray(1, 33)), y: b64(point.subarray(33, 65)) },
    format: 'jwk'
  })
}

const spki = (key: KeyObject): Buffer => createPublicKey(key).export({ type: 'spki', format: 'der' })

/** Chromium's id for a key: the first 16 bytes of its SPKI hash, written with the letters a–p. */
export function extensionId(key: KeyObject): string {
  return [...createHash('sha256').update(spki(key)).digest().subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15)))
    .join('')
}

/** A stored (uncompressed) zip of the files, in name order so one build packs to the same bytes. */
export function zipStored(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const name of Object.keys(files).sort()) {
    const data = Buffer.from(files[name]!, 'utf8')
    const path = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(path.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(path.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, path, data)
    centrals.push(central, path)
    offset += local.length + path.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

// Protobuf: a length-delimited field (wire type 2) with a small varint tag.
function field(number: number, bytes: Buffer): Buffer {
  const varint = (value: number): Buffer => {
    const out: number[] = []
    while (value > 127) {
      out.push((value & 127) | 128)
      value >>>= 7
    }
    out.push(value)
    return Buffer.from(out)
  }
  return Buffer.concat([varint((number << 3) | 2), varint(bytes.length), bytes])
}

/** A CRX3 file: the zip, signed with the ECDSA P-256 key whose hash is the id (CrxFileHeader.sha256_with_ecdsa). */
export function packCrx(zip: Buffer, key: KeyObject): Buffer {
  const publicKey = spki(key)
  const crxId = createHash('sha256').update(publicKey).digest().subarray(0, 16)
  const signedData = field(1, crxId)
  const size = Buffer.alloc(4)
  size.writeUInt32LE(signedData.length)
  const signature = sign(
    'sha256',
    Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), size, signedData, zip]),
    {
      key,
      dsaEncoding: 'der'
    }
  )
  const header = Buffer.concat([
    field(3, Buffer.concat([field(1, publicKey), field(2, signature)])),
    field(10000, signedData)
  ])
  const prefix = Buffer.alloc(12)
  prefix.write('Cr24', 0, 'latin1')
  prefix.writeUInt32LE(3, 4)
  prefix.writeUInt32LE(header.length, 8)
  return Buffer.concat([prefix, header, zip])
}

/** The policy file every browser's managed-policy directory gets. */
export const FORM_FILL_POLICY_FILE = 'agentconnect-form-fill.json'

/** What an install writes: the CRX and its update manifest in `dir`, and one policy that names both by their final paths. */
export function extensionArtifacts(options: { build: ExtensionBuild; dir: string; port: number }): {
  id: string
  version: string
  crx: Buffer
  updateXml: string
  policy: string
} {
  const key = extensionKey(options.build.buildId)
  const id = extensionId(key)
  const version = (JSON.parse(options.build.files['manifest.json'] ?? '{}') as { version?: string }).version ?? '0.0.0'
  const crxPath = join(options.dir, 'form-fill.crx')
  const manifestPath = join(options.dir, 'update.xml')
  const updateXml = `<?xml version='1.0' encoding='UTF-8'?>\n<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n  <app appid='${id}'>\n    <updatecheck codebase='file://${crxPath}' version='${version}' />\n  </app>\n</gupdate>\n`
  // Exactly one install mechanism: the force-install list, never --load-extension as well (§8).
  const policy = {
    ExtensionInstallForcelist: [`${id};file://${manifestPath}`],
    '3rdparty': { extensions: { [id]: { [COMPUTER_FORM_FILL_ENDPOINT_KEY]: `ws://127.0.0.1:${options.port}/` } } }
  }
  return {
    id,
    version,
    crx: packCrx(zipStored(options.build.files), key),
    updateXml,
    policy: `${JSON.stringify(policy, null, 2)}\n`
  }
}

/** Writes the CRX, its update manifest and the managed policy, as the image build (root) does. */
export function installExtension(options: { build: ExtensionBuild; dir: string; policyDir: string; port: number }): {
  id: string
  version: string
} {
  const artifacts = extensionArtifacts(options)
  mkdirSync(options.dir, { recursive: true })
  writeFileSync(join(options.dir, 'form-fill.crx'), artifacts.crx)
  writeFileSync(join(options.dir, 'update.xml'), artifacts.updateXml)
  mkdirSync(options.policyDir, { recursive: true })
  const target = join(options.policyDir, FORM_FILL_POLICY_FILE)
  writeFileSync(`${target}.tmp`, artifacts.policy)
  renameSync(`${target}.tmp`, target)
  return { id: artifacts.id, version: artifacts.version }
}
