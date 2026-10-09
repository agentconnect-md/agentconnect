export function withTrailingSlash(base: string): string {
  return base.endsWith('/') ? base : `${base}/`
}

/** 规范 SDK 服务根地址；生产只允许 HTTPS，本地回环测试可使用 HTTP。 */
import { GatewayFault } from './errors.js'

export function normalizeServiceRoot(value: string, label: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new GatewayFault('INVALID_SERVICE_URL', `${label} 必须是有效 URL`)
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new GatewayFault('INVALID_SERVICE_URL', `${label} 不能包含凭据、查询参数或片段`)
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new GatewayFault('INVALID_SERVICE_URL', `${label} 必须使用 HTTPS`)
  }
  return url.toString().replace(/\/$/u, '')
}
