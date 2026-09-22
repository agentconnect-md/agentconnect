export type QQProtocol = typeof import('@tencent-connect/qqbot-nodejs/protocol')

let protocol: Promise<QQProtocol> | undefined

/** Load the QQ SDK only when a QQ connection is actually used. */
export function loadQQProtocol(): Promise<QQProtocol> {
  return (protocol ??= import('@tencent-connect/qqbot-nodejs/protocol'))
}

export interface QQApiErrorLike {
  httpStatus: number
  bizCode?: number
}

export function isQQApiError(error: unknown): error is QQApiErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    'httpStatus' in error &&
    typeof (error as { httpStatus?: unknown }).httpStatus === 'number'
  )
}
