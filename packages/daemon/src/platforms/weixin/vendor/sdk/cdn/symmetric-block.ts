import crypto from 'node:crypto'
import { GatewayFault } from '../internal/errors.js'

/** PKCS#7 填充后的密文长度（16 字节块） */
export function cipherBudgetForPlain(plainLen: number): number {
  return Math.ceil((plainLen + 1) / 16) * 16
}

export function sealAes128Ecb(plain: Buffer, key16: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key16, null)
  cipher.setAutoPadding(true)
  return Buffer.concat([cipher.update(plain), cipher.final()])
}

export function openAes128Ecb(cipherBuf: Buffer, key16: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key16, null)
  decipher.setAutoPadding(true)
  return Buffer.concat([decipher.update(cipherBuf), decipher.final()])
}

/** 上游可能给 base64 或 32hex 形态的 aes 描述 */
export function decodeCdnAesMaterial(encoded: string): Buffer {
  const asBuf = Buffer.from(encoded, 'base64')
  if (asBuf.length === 16) return asBuf
  if (asBuf.length === 32 && /^[0-9a-fA-F]{32}$/.test(asBuf.toString('ascii'))) {
    return Buffer.from(asBuf.toString('ascii'), 'hex')
  }
  throw new GatewayFault(
    'INVALID_AES_KEY',
    `CDN aes 材料无法解析：需 16 字节或 32 位 hex，实际 ${String(asBuf.length)} 字节`
  )
}
