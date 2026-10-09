/**
 * 错误处理和分类系统
 * 提供统一的错误类型和处理机制
 */

/**
 * 错误分类枚举
 */
export enum ErrorCategory {
  /** 网络相关错误 */
  NETWORK = 'NETWORK',
  /** 配置相关错误 */
  CONFIG = 'CONFIG',
  /** 运行时错误 */
  RUNTIME = 'RUNTIME',
  /** 验证错误 */
  VALIDATION = 'VALIDATION',
  /** 资源错误 */
  RESOURCE = 'RESOURCE',
  /** 协议错误 */
  PROTOCOL = 'PROTOCOL',
  /** 适配器错误 */
  ADAPTER = 'ADAPTER',
  /** 未知错误 */
  UNKNOWN = 'UNKNOWN'
}

/**
 * 错误严重程度
 */
export enum ErrorSeverity {
  /** 低 - 可以忽略或自动恢复 */
  LOW = 'LOW',
  /** 中 - 需要记录但可以继续运行 */
  MEDIUM = 'MEDIUM',
  /** 高 - 影响功能，需要处理 */
  HIGH = 'HIGH',
  /** 严重 - 可能导致服务停止 */
  CRITICAL = 'CRITICAL'
}

/**
 * 基础错误类
 */
export class OneBotsError extends Error {
  public readonly category: ErrorCategory
  public readonly severity: ErrorSeverity
  public readonly code: string
  public readonly context?: Record<string, unknown>
  public readonly timestamp: Date
  public readonly cause?: Error

  constructor(
    message: string,
    options: {
      category?: ErrorCategory
      severity?: ErrorSeverity
      code?: string
      context?: Record<string, unknown>
      cause?: Error
    } = {}
  ) {
    super(message)
    this.name = 'OneBotsError'
    this.category = options.category || ErrorCategory.UNKNOWN
    this.severity = options.severity || ErrorSeverity.MEDIUM
    this.code = options.code || 'UNKNOWN_ERROR'
    this.context = options.context
    this.cause = options.cause
    this.timestamp = new Date()

    // 保持错误堆栈
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, OneBotsError)
    }
  }

  /**
   * 转换为可序列化的对象
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      category: this.category,
      severity: this.severity,
      code: this.code,
      context: this.context,
      timestamp: this.timestamp.toISOString(),
      stack: this.stack,
      cause: this.cause
        ? {
            message: this.cause.message,
            stack: this.cause.stack
          }
        : undefined
    }
  }

  /**
   * 转换为字符串
   */
  toString(): string {
    return `[${this.category}:${this.code}] ${this.message}`
  }
}

/**
 * 网络错误
 */
export class NetworkError extends OneBotsError {
  constructor(message: string, options?: { context?: Record<string, unknown>; cause?: Error }) {
    super(message, {
      category: ErrorCategory.NETWORK,
      severity: ErrorSeverity.MEDIUM,
      code: 'NETWORK_ERROR',
      ...options
    })
    this.name = 'NetworkError'
  }
}

/**
 * 配置错误
 */
export class ConfigError extends OneBotsError {
  constructor(message: string, options?: { context?: Record<string, unknown>; cause?: Error }) {
    super(message, {
      category: ErrorCategory.CONFIG,
      severity: ErrorSeverity.HIGH,
      code: 'CONFIG_ERROR',
      ...options
    })
    this.name = 'ConfigError'
  }
}

/**
 * 验证错误
 */
export class ValidationError extends OneBotsError {
  constructor(message: string, options?: { context?: Record<string, unknown>; cause?: Error }) {
    super(message, {
      category: ErrorCategory.VALIDATION,
      severity: ErrorSeverity.MEDIUM,
      code: 'VALIDATION_ERROR',
      ...options
    })
    this.name = 'ValidationError'
  }
}

/**
 * 资源错误
 */
export class ResourceError extends OneBotsError {
  constructor(message: string, options?: { context?: Record<string, unknown>; cause?: Error }) {
    super(message, {
      category: ErrorCategory.RESOURCE,
      severity: ErrorSeverity.HIGH,
      code: 'RESOURCE_ERROR',
      ...options
    })
    this.name = 'ResourceError'
  }
}

/**
 * 协议错误
 */
export class ProtocolError extends OneBotsError {
  constructor(message: string, options?: { context?: Record<string, unknown>; cause?: Error }) {
    super(message, {
      category: ErrorCategory.PROTOCOL,
      severity: ErrorSeverity.MEDIUM,
      code: 'PROTOCOL_ERROR',
      ...options
    })
    this.name = 'ProtocolError'
  }
}

/**
 * 适配器错误
 */
export class AdapterError extends OneBotsError {
  constructor(
    message: string,
    options?: {
      context?: Record<string, unknown>
      cause?: Error
      code?: string
      severity?: ErrorSeverity
    }
  ) {
    super(message, {
      category: ErrorCategory.ADAPTER,
      severity: ErrorSeverity.HIGH,
      code: 'ADAPTER_ERROR',
      ...options
    })
    this.name = 'AdapterError'
  }
}

export type UnsupportedCapabilityReason =
  'platform_unsupported' | 'not_implemented' | 'permission_missing' | 'context_missing'

/**
 * 适配器能力不可用。
 *
 * 调用方可以根据 reason 判断应隐藏功能、提示授权，还是补充会话上下文，
 * 不再依赖解析各平台自行拼接的错误文本。
 */
export class UnsupportedCapabilityError extends AdapterError {
  readonly platform: string
  readonly capability: string
  readonly reason: UnsupportedCapabilityReason

  constructor(options: {
    platform: string
    capability: string
    reason?: UnsupportedCapabilityReason
    message?: string
    context?: Record<string, unknown>
  }) {
    const reason = options.reason ?? 'not_implemented'
    super(options.message ?? `${options.platform} 不支持能力 ${options.capability}`, {
      code: 'ADAPTER_CAPABILITY_UNAVAILABLE',
      severity: ErrorSeverity.MEDIUM,
      context: {
        platform: options.platform,
        capability: options.capability,
        reason,
        ...options.context
      }
    })
    this.name = 'UnsupportedCapabilityError'
    this.platform = options.platform
    this.capability = options.capability
    this.reason = reason
  }
}

/**
 * 运行时错误
 */
export class RuntimeError extends OneBotsError {
  constructor(message: string, options?: { context?: Record<string, unknown>; cause?: Error }) {
    super(message, {
      category: ErrorCategory.RUNTIME,
      severity: ErrorSeverity.HIGH,
      code: 'RUNTIME_ERROR',
      ...options
    })
    this.name = 'RuntimeError'
  }
}

/**
 * 错误处理工具函数
 */
export class ErrorHandler {
  /**
   * 包装错误，转换为 OneBotsError
   */
  static wrap(error: unknown, context?: Record<string, unknown>): OneBotsError {
    if (error instanceof OneBotsError) {
      if (context) {
        return new OneBotsError(error.message, {
          category: error.category,
          severity: error.severity,
          code: error.code,
          context: { ...error.context, ...context },
          cause: error.cause || error
        })
      }
      return error
    }

    if (error instanceof Error) {
      // 尝试从错误消息推断错误类型
      const message = error.message.toLowerCase()
      let category = ErrorCategory.UNKNOWN
      let code = 'UNKNOWN_ERROR'

      if (message.includes('network') || message.includes('connection') || message.includes('timeout')) {
        category = ErrorCategory.NETWORK
        code = 'NETWORK_ERROR'
      } else if (message.includes('config') || message.includes('configuration')) {
        category = ErrorCategory.CONFIG
        code = 'CONFIG_ERROR'
      } else if (message.includes('validation') || message.includes('invalid')) {
        category = ErrorCategory.VALIDATION
        code = 'VALIDATION_ERROR'
      } else if (message.includes('not found') || message.includes('missing')) {
        category = ErrorCategory.RESOURCE
        code = 'RESOURCE_NOT_FOUND'
      }

      return new OneBotsError(error.message, {
        category,
        severity: ErrorSeverity.MEDIUM,
        code,
        context,
        cause: error
      })
    }

    return new OneBotsError(String(error), {
      category: ErrorCategory.UNKNOWN,
      severity: ErrorSeverity.MEDIUM,
      code: 'UNKNOWN_ERROR',
      context
    })
  }

  /**
   * 判断错误是否可恢复
   */
  static isRecoverable(error: OneBotsError): boolean {
    return error.severity === ErrorSeverity.LOW || error.severity === ErrorSeverity.MEDIUM
  }

  /**
   * 判断错误是否致命
   */
  static isFatal(error: OneBotsError): boolean {
    return error.severity === ErrorSeverity.CRITICAL
  }
}
