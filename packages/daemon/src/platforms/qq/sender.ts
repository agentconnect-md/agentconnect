import type { ImageUploader, UploadOutcome } from '../../mcp/ops/context.js'
import { sniffImageMimeType } from '../../session/attachment-block.js'
import { QQImageMaxBytes, QQImageUploadError, uploadQQImage } from './images.js'
import { isQQApiError } from './sdk.js'
import { QQProgressMaxBytes, QQTextMaxBytes } from './text.js'

export interface QQRestPort {
  request<T>(token: string, method: string, path: string, body?: unknown): Promise<T>
}

interface QQMessageReceipt {
  id?: string
  ext_info?: { ref_idx?: string }
}

export interface QQTarget {
  kind: 'c2c' | 'group'
  id: string
}

export function QQTargetForChannel(channel: string): QQTarget {
  if (channel.startsWith('dm:') && channel.length > 3) return { kind: 'c2c', id: channel.slice(3) }
  if (channel.startsWith('group:') && channel.length > 6) return { kind: 'group', id: channel.slice(6) }
  throw new Error('QQ reply has no supported conversation target')
}

export interface QQStreamCursor {
  sequence?: number
  index: number
  id?: string
}

export interface QQReplyPort {
  sendImage?(
    channel: string,
    replyId: string,
    file: Parameters<ImageUploader>[0],
    caption?: string,
    signal?: AbortSignal
  ): Promise<UploadOutcome>
  sendText(channel: string, replyId: string, text: string): Promise<void>
  sendAcknowledgement?(channel: string, replyId: string, text: string, signal?: AbortSignal): Promise<void>
  sendProgress?(channel: string, replyId: string, text: string, signal?: AbortSignal): Promise<boolean>
  sendStream?(
    channel: string,
    replyId: string,
    cursor: QQStreamCursor,
    text: string,
    done: boolean,
    signal?: AbortSignal
  ): Promise<void>
}

// A conservative local group budget matches the SDK default; provider limits may be stricter.
const QQGroupReplyLimit = 4
const QQGroupTruncated =
  '\n\n[QQ group reply limit reached; remaining text was not sent. The full answer is saved in AgentConnect.]'

interface QQReplyState {
  sequence: number
  sends: number
  acknowledged?: boolean
  uncertainTexts?: Set<string>
}

// Permission/endpoint refusals before the first accepted frame can fall back to plain text.
export function QQStreamUnavailable(error: unknown): boolean {
  return isQQApiError(error) && [403, 404, 405].includes(error.httpStatus)
}

export class QQSender {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly replies = new Map<string, QQReplyState>()

  constructor(
    private readonly api: QQRestPort,
    private readonly token: () => Promise<string>,
    private readonly signal: AbortSignal,
    private readonly warn: (message: string) => void = () => {},
    private readonly info: (message: string) => void = () => {},
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly onSent?: (target: QQTarget, receipt: QQMessageReceipt, text: string) => void
  ) {}

  private enqueue<T>(target: QQTarget, send: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([target.kind, target.id])
    const step = (this.queues.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        this.signal.throwIfAborted()
        return send()
      })
    this.queues.set(key, step)
    void step
      .finally(() => {
        if (this.queues.get(key) === step) this.queues.delete(key)
      })
      .catch(() => {})
    return step
  }

  private replyState(target: QQTarget, replyId: string): QQReplyState {
    if (!replyId) throw new Error('QQ passive reply requires a message id')
    const key = JSON.stringify([target.kind, target.id, replyId])
    let state = this.replies.get(key)
    if (!state) {
      state = { sequence: 0, sends: 0 }
      this.replies.set(key, state)
      if (this.replies.size > 2000) this.replies.delete(this.replies.keys().next().value!)
    }
    return state
  }

  private nextSequence(target: QQTarget, replyId: string): number {
    return ++this.replyState(target, replyId).sequence
  }

  private remaining(target: QQTarget, replyId: string): number {
    return target.kind === 'group' ? QQGroupReplyLimit - this.replyState(target, replyId).sends : Infinity
  }

  private async postMessage(
    token: string,
    target: QQTarget,
    replyId: string,
    body: Record<string, unknown>
  ): Promise<QQMessageReceipt> {
    const state = this.replyState(target, replyId)
    if (this.remaining(target, replyId) <= 0) throw new Error('QQ group reply budget exhausted')
    state.sends++
    try {
      const result = await this.api.request<QQMessageReceipt>(token, 'POST', this.path(target, 'messages'), {
        ...body,
        ...(target.kind === 'group' ? { message_reference: { message_id: replyId } } : {}),
        msg_id: replyId,
        msg_seq: this.nextSequence(target, replyId)
      })
      this.onSent?.(
        target,
        result,
        String(body.content ?? (body.markdown as { content?: string })?.content ?? '[Image]')
      )
      return result
    } catch (error) {
      // An uncertain send spends its slot; only a definite refusal releases it.
      if (isQQApiError(error) && error.httpStatus >= 400 && error.httpStatus < 500) state.sends--
      throw error
    }
  }

  private async postText(
    token: string,
    target: QQTarget,
    replyId: string,
    content: string,
    signal?: AbortSignal
  ): Promise<void> {
    const state = this.replyState(target, replyId)
    if (state.uncertainTexts?.has(content))
      throw new Error('QQ text may already have been delivered; no automatic resend')
    this.signal.throwIfAborted()
    signal?.throwIfAborted()
    try {
      let result: QQMessageReceipt
      try {
        result = await this.postMessage(token, target, replyId, { markdown: { content }, msg_type: 2 })
      } catch (error) {
        // Only a definite permission rejection allows a second send in another format.
        if (!isQQApiError(error) || error.httpStatus !== 403) throw error
        this.warn(`qq: Markdown delivery refused (HTTP 403, code ${error.bizCode ?? 'unknown'}); using plain text`)
        this.signal.throwIfAborted()
        signal?.throwIfAborted()
        result = await this.postMessage(token, target, replyId, { content, msg_type: 0 })
      }
      if (target.kind === 'group' && !result.id)
        throw new Error('QQ text returned no message id; delivery is uncertain')
    } catch (error) {
      if (target.kind === 'group' && !(isQQApiError(error) && error.httpStatus >= 400 && error.httpStatus < 500))
        (state.uncertainTexts ??= new Set()).add(content)
      throw error
    }
  }

  sendText(target: QQTarget, replyId: string, text: string): Promise<void> {
    return this.enqueue(target, async () => {
      let parts = splitQQText(text)
      const remaining = this.remaining(target, replyId)
      if (remaining <= 0) throw new Error('QQ group reply budget exhausted; full answer retained')
      if (parts.length > remaining) {
        parts = parts.slice(0, remaining)
        parts[remaining - 1] =
          splitQQText(parts[remaining - 1]!, QQTextMaxBytes - Buffer.byteLength(QQGroupTruncated))[0]! +
          QQGroupTruncated
        this.warn('qq: group answer exceeds remaining reply budget; full answer retained')
      }
      const token = await this.token()
      for (const content of parts) {
        this.signal.throwIfAborted()
        await this.postText(token, target, replyId, content)
      }
    })
  }

  async sendAcknowledgement(target: QQTarget, replyId: string, text: string, signal?: AbortSignal): Promise<void> {
    if (target.kind !== 'group') return
    await this.enqueue(target, async () => {
      const state = this.replyState(target, replyId)
      if (state.acknowledged || state.sends > 0) return
      signal?.throwIfAborted()
      state.acknowledged = true
      const token = await this.token()
      this.signal.throwIfAborted()
      signal?.throwIfAborted()
      const result = await this.postMessage(token, target, replyId, {
        content: text,
        msg_type: 0
      })
      if (!result.id) throw new Error('QQ acknowledgement returned no message id')
      this.info('qq: group acknowledgement delivered')
    }).catch((error: unknown) => {
      if (!signal?.aborted && !this.signal.aborted) {
        const reason = isQQApiError(error)
          ? `HTTP ${error.httpStatus}, code ${error.bizCode ?? 'unknown'}`
          : 'transport error or missing message id'
        this.warn(`qq: group acknowledgement unavailable (${reason}); task will continue`)
      }
    })
  }

  sendProgress(target: QQTarget, replyId: string, text: string, signal?: AbortSignal): Promise<boolean> {
    if (target.kind !== 'group' || !text.trim() || Buffer.byteLength(text) > QQProgressMaxBytes)
      return Promise.resolve(false)
    return this.enqueue(target, async () => {
      // Progress leaves room for an image and at least one final-answer message.
      if (this.remaining(target, replyId) <= 2) return false
      signal?.throwIfAborted()
      const token = await this.token()
      signal?.throwIfAborted()
      await this.postText(token, target, replyId, text, signal)
      this.info('qq: group progress delivered')
      return true
    }).catch(() => {
      if (!signal?.aborted && !this.signal.aborted)
        this.warn('qq: group progress unavailable; final reply will still be attempted')
      return false
    })
  }

  sendStream(
    target: QQTarget,
    replyId: string,
    cursor: QQStreamCursor,
    text: string,
    done: boolean,
    signal?: AbortSignal
  ): Promise<void> {
    if (target.kind !== 'c2c') return Promise.reject(new Error('QQ streaming requires a private conversation'))
    return this.enqueue(target, async () => {
      const token = await this.token()
      this.signal.throwIfAborted()
      signal?.throwIfAborted()
      cursor.sequence ??= this.nextSequence(target, replyId)
      const first = !cursor.id
      let response: QQMessageReceipt
      try {
        response = await this.api.request<QQMessageReceipt>(token, 'POST', this.path(target, 'stream_messages'), {
          input_mode: 'replace',
          input_state: done ? 10 : 1,
          content_type: 'markdown',
          content_raw: text,
          event_id: replyId,
          msg_id: replyId,
          msg_seq: cursor.sequence,
          index: cursor.index++,
          ...(cursor.id ? { stream_msg_id: cursor.id } : {})
        })
      } catch (error) {
        const reason = isQQApiError(error)
          ? `HTTP ${error.httpStatus}, code ${error.bizCode ?? 'unknown'}`
          : 'transport error'
        const fallback = first && QQStreamUnavailable(error)
        this.warn(
          `qq: private stream failed (${reason}); ${fallback ? 'using ordinary Markdown at completion' : 'no automatic resend'}`
        )
        throw error
      }
      if (!response.id) throw new Error('QQ stream returned no message id; delivery is uncertain')
      cursor.id ??= response.id
      this.onSent?.(target, response, text)
      if (first || done)
        this.info(
          `qq: private stream ${done ? 'completed' : 'started'} (index ${cursor.index - 1}, bytes ${Buffer.byteLength(text)})`
        )
    })
  }

  sendImage(
    target: QQTarget,
    replyId: string,
    file: Parameters<ImageUploader>[0],
    caption?: string,
    signal?: AbortSignal
  ): Promise<UploadOutcome> {
    if (!replyId) return Promise.resolve({ ok: false, reason: 'forbidden' })
    if (file.bytes.length > QQImageMaxBytes) return Promise.resolve({ ok: false, reason: 'too_large' })
    if (!sniffImageMimeType(file.bytes))
      return Promise.resolve({ ok: false, reason: 'platform_error', detail: 'Unsupported image format' })
    let posting = false
    return this.enqueue(target, async (): Promise<UploadOutcome> => {
      const abort = signal ? AbortSignal.any([this.signal, signal]) : this.signal
      abort.throwIfAborted()
      if (this.remaining(target, replyId) <= 1)
        return {
          ok: false,
          reason: 'platform_error',
          detail: 'QQ group reply budget reserved for the final answer; stop sharing images this turn'
        }
      const token = await this.token()
      const fileInfo = await uploadQQImage(this.api, token, target, file, abort, this.fetchImpl)
      abort.throwIfAborted()
      posting = true
      const result = await this.postMessage(token, target, replyId, {
        msg_type: 7,
        media: { file_info: fileInfo },
        ...(caption ? { content: caption } : {})
      })
      if (!result.id) return { ok: false, reason: 'indeterminate' }
      this.info(`qq: image delivered (bytes ${file.bytes.length})`)
      return { ok: true, messageId: result.id }
    }).catch((error: unknown): UploadOutcome => {
      const definite = isQQApiError(error) && error.httpStatus >= 400 && error.httpStatus < 500
      const reason =
        posting && !definite
          ? 'indeterminate'
          : isQQApiError(error) && error.httpStatus === 403
            ? 'forbidden'
            : isQQApiError(error) && error.httpStatus === 413
              ? 'too_large'
              : 'platform_error'
      const detail = isQQApiError(error)
        ? `HTTP ${error.httpStatus}, code ${error.bizCode ?? 'unknown'}`
        : error instanceof QQImageUploadError
          ? error.message
          : undefined
      this.warn(`qq: image delivery failed (${reason}${detail ? `: ${detail}` : ''}); no automatic resend`)
      return {
        ok: false,
        reason,
        ...(detail ? { detail } : {})
      }
    })
  }

  private path(target: QQTarget, operation: string): string {
    return `/v2/${target.kind === 'c2c' ? 'users' : 'groups'}/${encodeURIComponent(target.id)}/${operation}`
  }
}

// Split only at Unicode boundaries, preferring a complete line within the byte limit.
export function splitQQText(text: string, limit = QQTextMaxBytes): string[] {
  if (!Number.isInteger(limit) || limit < 4) throw new Error('QQ text limit must be at least four bytes')
  const chunks: string[] = []
  let part = '',
    bytes = 0
  for (const character of text) {
    const size = Buffer.byteLength(character)
    while (bytes + size > limit) {
      const boundary = part.lastIndexOf('\n') + 1
      const cut = boundary || part.length
      chunks.push(part.slice(0, cut))
      part = part.slice(cut)
      bytes = Buffer.byteLength(part)
    }
    part += character
    bytes += size
  }
  if (part) chunks.push(part)
  return chunks
}
