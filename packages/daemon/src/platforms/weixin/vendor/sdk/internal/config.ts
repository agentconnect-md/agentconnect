import { readPackageVersionFile } from '../../onebots/index.js'

/** 默认端点与超时 */
export const ILINK_HTTP_ORIGIN_DEFAULT = 'https://ilinkai.weixin.qq.com'
export const ILINK_CDN_ROOT_DEFAULT = 'https://novac2c.cdn.weixin.qq.com/c2c'
export const ILINK_QR_BOT_CLASS_DEFAULT = '3'
export const ILINK_LONG_WAIT_MS = 35_000
export const ILINK_RPC_BUDGET_MS = 15_000
export const ILINK_FAST_RPC_MS = 10_000
export const ILINK_RETRY_INITIAL_MS = 1_000
export const ILINK_RETRY_MAX_MS = 30_000
/** iLink 在服务端登记的应用标识，不是 npm 包名。 */
export const ILINK_APP_ID = 'bot'
/** 始终从发布包元数据读取，避免 Changesets 升版后请求头仍携带旧版本。 */
export const ADAPTER_SEMVER = await readPackageVersionFile(new URL('../../../package.json', import.meta.url))
export const ILINK_APP_CLIENT_VERSION = encodeIlinkClientVersion(ADAPTER_SEMVER)
/** outbound client_id 前缀，仅作日志/排障区分 */
export const OUTBOUND_TRACE_SCOPE = 'ob-wxcb'

/** iLink 约定的 0x00MMNNPP 无符号整数版本。 */
export function encodeIlinkClientVersion(version: string): number {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version)
  if (!match) return 0
  const [, major = 0, minor = 0, patch = 0] = match.map(Number)
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}
