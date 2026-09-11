import type { ShimRequester } from './channels.js'
import { ClusterSkillLedgerSchema } from '../store/cluster-skill-ledger.js'
import {
  ClusterSkillBeginReplySchema,
  ClusterSkillBeginSchema,
  ClusterSkillReconcileSchema,
  ClusterSkillManifestReplySchema,
  ClusterSkillManifestSchema,
  ClusterSkillReconcileReplySchema,
  ClusterSkillReconcileResultSchema,
  ClusterSkillPriorSchema,
  ClusterSkillPriorReplySchema,
  ClusterSkillReceiptPageSchema,
  ClusterSkillVerifySchema,
  skillControlPages,
  ClusterSkillUploadReplySchema,
  ClusterSkillVerifyReplySchema,
  LEGACY_MAX_CLUSTER_SKILL_FILES,
  LEGACY_MAX_CLUSTER_SKILL_TOTAL_BYTES,
  MAX_CLUSTER_SKILL_CHUNK_BYTES,
  MAX_CLUSTER_SKILL_CONTROL_BYTES,
  MAX_CLUSTER_SKILL_FILES,
  MAX_CLUSTER_SKILL_TOTAL_BYTES,
  type ClusterSkillBegin,
  type ClusterSkillBeginReply,
  type ClusterSkillFile,
  type ClusterSkillReconcile,
  type ClusterSkillReconcileReply,
  type ClusterSkillUploadReply,
  type ClusterSkillVerifyReply
} from './skill-protocol.js'

export class ClusterSkillClient {
  /** `wide` mirrors the peer's `cluster-skills-v2` grant. */
  constructor(
    private readonly requester: ShimRequester,
    private readonly wide = false,
    // Enabled when the caller supplies a matching shim bundle; retained images may predate this field.
    readonly fileModes = false,
    private readonly receiptPaging = false
  ) {}

  /** What the BOUND image admits, so a caller can drop one oversized source instead of failing a launch. */
  get manifestLimits(): { maxFiles: number; maxTotalBytes: number } {
    return this.wide
      ? { maxFiles: MAX_CLUSTER_SKILL_FILES, maxTotalBytes: MAX_CLUSTER_SKILL_TOTAL_BYTES }
      : { maxFiles: LEGACY_MAX_CLUSTER_SKILL_FILES, maxTotalBytes: LEGACY_MAX_CLUSTER_SKILL_TOTAL_BYTES }
  }

  /** Open the operation and declare every file, paging the manifest so each page is its own frame.
   *  A v1 image has no `manifest` op, so it gets the whole list in `begin` or nothing. */
  async begin(input: Omit<ClusterSkillBegin, 'op' | 'moreFiles'>): Promise<ClusterSkillBeginReply> {
    // Refuse against the BOUND image's admission: a v1 shim answers an oversized manifest opaquely.
    const { maxFiles, maxTotalBytes } = this.manifestLimits
    const total = input.files.reduce((bytes, file) => bytes + file.size, 0)
    if (input.files.length > maxFiles || total > maxTotalBytes) {
      throw new Error('cluster skill sources exceed what this sandbox image admits')
    }
    const pages = this.wide ? skillControlPages(input.files) : [input.files]
    const request = ClusterSkillBeginSchema.parse({
      op: 'begin',
      ...input,
      files: pages[0] ?? [],
      ...(pages.length > 1 ? { moreFiles: true } : {})
    })
    const reply = ClusterSkillBeginReplySchema.parse(await this.requester.request('skills', request))
    for (const [index, files] of pages.slice(1).entries()) {
      const page = ClusterSkillManifestSchema.parse({
        op: 'manifest',
        operationId: input.operationId,
        handle: reply.handle,
        files,
        moreFiles: index < pages.length - 2
      })
      ClusterSkillManifestReplySchema.parse(await this.requester.request('skills', page))
    }
    return reply
  }

  async upload(operationId: string, handle: string, file: ClusterSkillFile, content: Buffer): Promise<void> {
    let offset = 0
    if (content.length === 0) await this.uploadChunk(operationId, handle, file, content, 0, true)
    while (offset < content.length) {
      const chunk = content.subarray(offset, offset + MAX_CLUSTER_SKILL_CHUNK_BYTES)
      const final = offset + chunk.length === content.length
      const reply = await this.uploadChunk(operationId, handle, file, chunk, offset, final)
      if (reply.received !== offset + chunk.length || reply.complete !== final) {
        throw new Error('cluster skill shim returned an inconsistent upload receipt')
      }
      offset = reply.received
    }
  }

  async reconcile(input: Omit<ClusterSkillReconcile, 'op' | 'priorRootCount'>): Promise<ClusterSkillReconcileReply> {
    if (!this.receiptPaging) {
      const request = ClusterSkillReconcileSchema.parse({ op: 'reconcile', ...input })
      return ClusterSkillReconcileReplySchema.parse(
        await this.requester.request('skills', request, { timeoutMs: 15 * 60_000 })
      )
    }
    const priorRoots = ClusterSkillLedgerSchema.parse({ roots: input.priorRoots }).roots
    const request = { op: 'reconcile' as const, ...input, priorRoots, priorRootCount: priorRoots.length }
    if (Buffer.byteLength(JSON.stringify(request)) > MAX_CLUSTER_SKILL_CONTROL_BYTES) {
      request.priorRoots = []
      ClusterSkillReconcileSchema.parse(request)
      let offset = 0
      for (const roots of skillControlPages(priorRoots)) {
        const page = ClusterSkillPriorSchema.parse({
          op: 'prior',
          operationId: input.operationId,
          handle: input.handle,
          offset,
          roots
        })
        const reply = ClusterSkillPriorReplySchema.parse(await this.requester.request('skills', page))
        offset += roots.length
        if (reply.received !== offset) throw new Error('inconsistent prior skill receipt offset')
      }
    }
    let page = ClusterSkillReceiptPageSchema.parse(
      await this.requester.request('skills', ClusterSkillReconcileSchema.parse(request), { timeoutMs: 15 * 60_000 })
    )
    const result = { roots: [...page.roots], conflicts: page.conflicts }
    while (page.nextOffset !== undefined) {
      if (page.nextOffset !== result.roots.length) throw new Error('inconsistent skill receipt offset')
      page = ClusterSkillReceiptPageSchema.parse(
        await this.requester.request('skills', {
          op: 'receipt',
          operationId: input.operationId,
          handle: input.handle,
          offset: page.nextOffset
        })
      )
      if (page.roots.length === 0 || JSON.stringify(page.conflicts) !== JSON.stringify(result.conflicts))
        throw new Error('inconsistent skill receipt page')
      result.roots.push(...page.roots)
      ClusterSkillReconcileResultSchema.parse(result)
    }
    return ClusterSkillReconcileResultSchema.parse(result)
  }

  async verify(roots: ClusterSkillReconcile['priorRoots']): Promise<ClusterSkillVerifyReply> {
    ClusterSkillLedgerSchema.parse({ roots })
    const intact: boolean[] = []
    for (const page of skillControlPages(roots)) {
      const reply = ClusterSkillVerifyReplySchema.parse(
        await this.requester.request('skills', ClusterSkillVerifySchema.parse({ op: 'verify', roots: page }))
      )
      if (reply.intact.length !== page.length) throw new Error('inconsistent skill verification receipt')
      intact.push(...reply.intact)
    }
    return { intact }
  }

  private async uploadChunk(
    operationId: string,
    handle: string,
    file: ClusterSkillFile,
    data: Buffer,
    offset: number,
    final: boolean
  ): Promise<ClusterSkillUploadReply> {
    return ClusterSkillUploadReplySchema.parse(
      await this.requester.request('skills', {
        op: 'upload',
        operationId,
        handle,
        sourceId: file.sourceId,
        path: file.path,
        offset,
        data: data.toString('base64'),
        final
      })
    )
  }
}
