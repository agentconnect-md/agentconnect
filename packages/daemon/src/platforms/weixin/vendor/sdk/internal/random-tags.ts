import crypto from 'node:crypto'
import { OUTBOUND_TRACE_SCOPE } from './config.js'

/** 为 JSON 请求生成 X-Wechat-UIN 风格的伪标识（非真实 UIN） */
export function ephemeralWeixinHeaderTag(): string {
  const n = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(n), 'utf8').toString('base64')
}

/** 生成带作用域的去重 client_id */
export function nextScopedOpId(scope: string): string {
  return `${scope}:${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`
}

export function nextOutboundClientMarker(): string {
  return nextScopedOpId(OUTBOUND_TRACE_SCOPE)
}
