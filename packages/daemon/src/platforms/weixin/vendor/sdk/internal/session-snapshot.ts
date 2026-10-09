import { ILINK_CDN_ROOT_DEFAULT } from './config.js'
import type { CredentialBlob } from '../protocol/chat-event.js'

/** 从残缺字段推导可工作的凭证快照；不满足最低字段则返回 null */
export function pickCredentialOrNull(partial?: Partial<CredentialBlob> | null): CredentialBlob | null {
  if (!partial?.token || !partial.accountId) return null
  return {
    token: partial.token,
    accountId: partial.accountId,
    userId: partial.userId,
    baseUrl: partial.baseUrl?.trim() || '',
    cdnBaseUrl: partial.cdnBaseUrl?.trim() || ILINK_CDN_ROOT_DEFAULT,
    routeTag: partial.routeTag,
    syncBuffer: partial.syncBuffer ?? '',
    contextTokens: { ...(partial.contextTokens ?? {}) },
    createdAt: partial.createdAt,
    updatedAt: partial.updatedAt
  }
}
