import type { SourceCacheBundleStager } from '../source-cache/write-back.js'
import { DEFAULT_BUNDLE_CREATE_TIMEOUT_MS, DEFAULT_BUNDLE_UPLOAD_TIMEOUT_MS } from './bundle-handler.js'
import {
  BundleCreateResultSchema,
  BundleDiscardResultSchema,
  BundleUploadResultSchema,
  type BundleRequest
} from './bundle-protocol.js'
import type { ShimRequester } from './channels.js'

// The daemon side of the `bundle` capability on one bound shim (source-cache.md §9, §13).

const REPLY_MARGIN_MS = 30_000
const DISCARD_TIMEOUT_MS = 30_000

export class ShimBundleClient implements SourceCacheBundleStager {
  constructor(
    private readonly requester: ShimRequester,
    private readonly uploadTimeoutMs = DEFAULT_BUNDLE_UPLOAD_TIMEOUT_MS
  ) {}

  async create(
    input: Parameters<SourceCacheBundleStager['create']>[0],
    abort?: AbortSignal
  ): Promise<{ handle: string; bytes: number; sha256: string }> {
    const payload: BundleRequest = { op: 'create', ...input, timeoutMs: DEFAULT_BUNDLE_CREATE_TIMEOUT_MS }
    const reply = await this.requester.request('bundle', payload, {
      timeoutMs: DEFAULT_BUNDLE_CREATE_TIMEOUT_MS + REPLY_MARGIN_MS,
      ...(abort ? { abort } : {})
    })
    return BundleCreateResultSchema.parse(reply)
  }

  async upload(
    input: Parameters<SourceCacheBundleStager['upload']>[0],
    abort?: AbortSignal
  ): Promise<{ bytes: number; sha256: string }> {
    const payload: BundleRequest = { op: 'upload', ...input, timeoutMs: this.uploadTimeoutMs }
    const reply = await this.requester.request('bundle', payload, {
      timeoutMs: this.uploadTimeoutMs + REPLY_MARGIN_MS,
      ...(abort ? { abort } : {})
    })
    return BundleUploadResultSchema.parse(reply)
  }

  // After an abort the discard is sent but never awaited; the shim's stale-handle sweep is the backstop.
  async discard(handle: string, abort?: AbortSignal): Promise<void> {
    const payload: BundleRequest = { op: 'discard', handle }
    if (abort?.aborted) {
      void this.requester.request('bundle', payload, { timeoutMs: DISCARD_TIMEOUT_MS }).catch(() => undefined)
      return
    }
    const reply = await this.requester.request('bundle', payload, {
      timeoutMs: DISCARD_TIMEOUT_MS,
      ...(abort ? { abort } : {})
    })
    BundleDiscardResultSchema.parse(reply)
  }
}
