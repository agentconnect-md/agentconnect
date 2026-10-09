/** 可附带 AbortSignal 的固定延迟 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException('操作已取消', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    if (!signal) return
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
  })
}

/**
 * 在 deadlineMs 后触发 abort；若外层 signal 已取消则联动。
 * 返回子 signal 与清理函数（务必在 finally 调用）。
 */
export function fuseAbortClock(deadlineMs: number, outer?: AbortSignal): { signal: AbortSignal; disarm: () => void } {
  const inner = new AbortController()
  const abortFromOuter = () =>
    inner.abort(outer?.reason instanceof Error ? outer.reason : new DOMException('操作已取消', 'AbortError'))
  const timer = setTimeout(() => inner.abort(new DOMException(`请求超过 ${deadlineMs}ms`, 'TimeoutError')), deadlineMs)
  if (outer?.aborted) abortFromOuter()
  else outer?.addEventListener('abort', abortFromOuter, { once: true })

  return {
    signal: inner.signal,
    disarm: () => {
      clearTimeout(timer)
      outer?.removeEventListener('abort', abortFromOuter)
    }
  }
}
