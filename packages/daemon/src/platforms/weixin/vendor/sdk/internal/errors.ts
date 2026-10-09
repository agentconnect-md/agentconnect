import { ErrorCategory, ErrorSeverity, OneBotsError } from '../../onebots/index.js'

export interface GatewayFaultOptions {
  cause?: unknown
  operation?: string
  status?: number
  details?: Readonly<Record<string, unknown>>
  category?: ErrorCategory
  severity?: ErrorSeverity
}

/** 网关或协议层可恢复/不可恢复故障。 */
export class GatewayFault extends OneBotsError {
  readonly operation?: string
  readonly status?: number
  readonly details?: Readonly<Record<string, unknown>>

  constructor(code: string, message: string, options: GatewayFaultOptions = {}) {
    super(message, {
      code,
      category: options.category ?? categoryFor(code, options.status),
      severity: options.severity ?? ErrorSeverity.HIGH,
      context: {
        ...(options.operation === undefined ? {} : { operation: options.operation }),
        ...(options.status === undefined ? {} : { status: options.status }),
        ...(options.details === undefined ? {} : { details: options.details })
      },
      cause: options.cause instanceof Error ? options.cause : undefined
    })
    this.name = 'GatewayFault'
    this.operation = options.operation
    this.status = options.status
    this.details = options.details
  }
}

function categoryFor(code: string, status?: number): ErrorCategory {
  if (status === 400 || status === 422) return ErrorCategory.VALIDATION
  if (status === 401 || status === 403) return ErrorCategory.CONFIG
  if (status === 404) return ErrorCategory.RESOURCE
  if (status === 429 || (status ?? 0) >= 500) return ErrorCategory.NETWORK
  if (code.includes('SESSION') || code.includes('CREDENTIAL') || code.includes('CONFIG')) {
    return ErrorCategory.CONFIG
  }
  if (code.includes('INVALID') || code.includes('REQUIRED') || code.includes('EMPTY') || code.includes('UNSUPPORTED')) {
    return ErrorCategory.VALIDATION
  }
  if (code.includes('NOT_FOUND') || code.includes('NOT_CACHED')) {
    return ErrorCategory.RESOURCE
  }
  if (code.includes('NETWORK') || code.includes('TIMEOUT') || code.includes('HTTP')) {
    return ErrorCategory.NETWORK
  }
  return ErrorCategory.ADAPTER
}

/** 缺少回复所需的 context_token */
export class MissingReplyLaneFault extends GatewayFault {
  constructor(peerKey: string) {
    super('MISSING_CONTEXT_TOKEN', `目标 "${peerKey}" 尚无可用 context_token：需对方先发言，或在发送参数里显式传入。`)
    this.name = 'MissingReplyLaneFault'
  }
}

/** 凭证被上游判定失效（常见 errcode -14） */
export class StaleCredentialFault extends GatewayFault {
  constructor(detail = 'iLink 凭证失效，请重新登录') {
    super('SESSION_EXPIRED', detail)
    this.name = 'StaleCredentialFault'
  }
}
