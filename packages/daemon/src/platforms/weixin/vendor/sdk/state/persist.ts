import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { CredentialBlob, SessionStore } from '../protocol/chat-event.js'
import { GatewayFault } from '../internal/errors.js'

export class MemoryCredentialStore implements SessionStore {
  private snapshot: CredentialBlob | null

  constructor(initial?: CredentialBlob | null) {
    this.snapshot = initial ?? null
  }

  async load(): Promise<CredentialBlob | null> {
    return this.snapshot ? { ...this.snapshot, contextTokens: { ...(this.snapshot.contextTokens ?? {}) } } : null
  }

  async save(session: CredentialBlob): Promise<void> {
    this.snapshot = { ...session, contextTokens: { ...(session.contextTokens ?? {}) } }
  }

  async clear(): Promise<void> {
    this.snapshot = null
  }
}

export class JsonFileCredentialStore implements SessionStore {
  readonly absolutePath: string

  constructor(filePath: string) {
    this.absolutePath = path.resolve(filePath)
  }

  async load(): Promise<CredentialBlob | null> {
    try {
      const raw = await fs.readFile(this.absolutePath, 'utf-8')
      return parseCredential(raw, this.absolutePath)
    } catch (error) {
      if (isFileNotFound(error)) return null
      if (error instanceof GatewayFault) throw error
      throw new GatewayFault('SESSION_READ_FAILED', '读取 iLink 会话文件失败', {
        cause: error,
        details: { path: this.absolutePath }
      })
    }
  }

  async save(session: CredentialBlob): Promise<void> {
    const directory = path.dirname(this.absolutePath)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const temporaryPath = path.join(directory, `.${path.basename(this.absolutePath)}.${crypto.randomUUID()}.tmp`)
    let handle: fs.FileHandle | undefined
    try {
      handle = await fs.open(temporaryPath, 'wx', 0o600)
      await handle.writeFile(JSON.stringify(session, null, 2), 'utf-8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await fs.rename(temporaryPath, this.absolutePath)
      await fs.chmod(this.absolutePath, 0o600)
    } catch (error) {
      const cleanupResults = await Promise.allSettled([handle?.close() ?? Promise.resolve(), fs.unlink(temporaryPath)])
      const cleanupErrors = cleanupResults.flatMap((result) =>
        result.status === 'rejected' && !isFileNotFound(result.reason) ? [result.reason] : []
      )
      throw new GatewayFault('SESSION_WRITE_FAILED', '写入 iLink 会话文件失败', {
        cause:
          cleanupErrors.length > 0 ? new AggregateError([error, ...cleanupErrors], '写入及清理临时会话失败') : error,
        details: { path: this.absolutePath }
      })
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.absolutePath)
    } catch (error) {
      if (!isFileNotFound(error)) {
        throw new GatewayFault('SESSION_CLEAR_FAILED', '清除 iLink 会话文件失败', {
          cause: error,
          details: { path: this.absolutePath }
        })
      }
    }
  }
}

function parseCredential(raw: string, filePath: string): CredentialBlob {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch (error) {
    throw new GatewayFault('SESSION_INVALID_JSON', 'iLink 会话文件不是有效 JSON', {
      cause: error,
      details: { path: filePath }
    })
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('token' in value) ||
    typeof value.token !== 'string' ||
    !value.token ||
    !('accountId' in value) ||
    typeof value.accountId !== 'string' ||
    !value.accountId
  ) {
    throw new GatewayFault('SESSION_INVALID', 'iLink 会话文件缺少 token 或 accountId', {
      details: { path: filePath }
    })
  }
  const record = value as Record<string, unknown>
  const optionalStrings = ['userId', 'baseUrl', 'cdnBaseUrl', 'routeTag', 'syncBuffer', 'createdAt', 'updatedAt']
  if (optionalStrings.some((key) => record[key] !== undefined && typeof record[key] !== 'string')) {
    throw new GatewayFault('SESSION_INVALID', 'iLink 会话文件包含类型无效的字段', {
      details: { path: filePath }
    })
  }
  const contextTokens = record.contextTokens
  if (
    contextTokens !== undefined &&
    (!contextTokens ||
      typeof contextTokens !== 'object' ||
      Array.isArray(contextTokens) ||
      Object.values(contextTokens).some((token) => typeof token !== 'string'))
  ) {
    throw new GatewayFault('SESSION_INVALID', 'iLink 会话文件 contextTokens 格式无效', {
      details: { path: filePath }
    })
  }
  return record as unknown as CredentialBlob
}

function isFileNotFound(error: unknown): boolean {
  return (
    error !== null && error !== undefined && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
  )
}
