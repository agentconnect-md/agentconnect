export interface RecentEventDeduplicatorOptions {
  /** 事件在窗口内保留的最长时间。 */
  ttlMs?: number
  /** 防止异常流量让内存无限增长。 */
  maxEntries?: number
  /** 测试或特殊运行时可注入单调时钟。 */
  now?: () => number
}

/**
 * 有界的进程内事件去重窗口。
 *
 * 检查与提交刻意分离：调用方应只在 canonical 处理成功后调用 commit，
 * 这样上游重投仍能恢复一次失败的事件处理。
 */
export class RecentEventDeduplicator<TKey> {
  private readonly entries = new Map<TKey, number>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(options: RecentEventDeduplicatorOptions = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60_000
    this.maxEntries = options.maxEntries ?? 4_096
    this.now = options.now ?? Date.now
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError('RecentEventDeduplicator ttlMs 必须是正数')
    }
    if (!Number.isInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new RangeError('RecentEventDeduplicator maxEntries 必须是正整数')
    }
  }

  has(key: TKey): boolean {
    const now = this.now()
    this.prune(now)
    const committedAt = this.entries.get(key)
    return committedAt !== undefined && now - committedAt <= this.ttlMs
  }

  commit(key: TKey): void {
    const now = this.now()
    this.entries.delete(key)
    this.entries.set(key, now)
    this.prune(now)
  }

  private prune(now: number): void {
    for (const [key, committedAt] of this.entries) {
      if (this.entries.size <= this.maxEntries && now - committedAt <= this.ttlMs) break
      this.entries.delete(key)
    }
  }
}
