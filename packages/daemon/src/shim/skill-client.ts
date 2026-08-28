import type { ShimRequester } from './channels.js'
import {
  ClusterSkillBeginReplySchema,
  ClusterSkillBeginSchema,
  ClusterSkillReconcileSchema,
  ClusterSkillManifestReplySchema,
  ClusterSkillManifestSchema,
  ClusterSkillReconcileReplySchema,
  ClusterSkillUploadReplySchema,
  ClusterSkillVerifyReplySchema,
  LEGACY_MAX_CLUSTER_SKILL_FILES,
  LEGACY_MAX_CLUSTER_SKILL_TOTAL_BYTES,
  MAX_CLUSTER_SKILL_CHUNK_BYTES,
  MAX_CLUSTER_SKILL_CONTROL_BYTES,
  MAX_CLUSTER_SKILL_FILES,
  MAX_CLUSTER_SKILL_MANIFEST_PAGE,
  MAX_CLUSTER_SKILL_TOTAL_BYTES,
  type ClusterSkillBegin,
  type ClusterSkillBeginReply,
  type ClusterSkillFile,
  type ClusterSkillReconcile,
  type ClusterSkillReconcileReply,
  type ClusterSkillUploadReply,
  type ClusterSkillVerifyReply
} from './skill-protocol.js'

/** Room for a page's op/operationId/handle/moreFiles keys around the file rows. */
const MANIFEST_PAGE_ENVELOPE_BYTES = 512

export class ClusterSkillClient {
  /** `wide` mirrors the peer's `cluster-skills-v2` grant. */
  constructor(
    private readonly requester: ShimRequester,
    private readonly wide = false
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
    const pages = this.wide ? pageFiles(input.files) : [input.files]
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

  async reconcile(input: Omit<ClusterSkillReconcile, 'op'>): Promise<ClusterSkillReconcileReply> {
    const request = ClusterSkillReconcileSchema.parse({ op: 'reconcile', ...input })
    return ClusterSkillReconcileReplySchema.parse(
      await this.requester.request('skills', request, { timeoutMs: 15 * 60_000 })
    )
  }

  async verify(roots: ClusterSkillReconcile['priorRoots']): Promise<ClusterSkillVerifyReply> {
    return ClusterSkillVerifyReplySchema.parse(await this.requester.request('skills', { op: 'verify', roots }))
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

/** Split a manifest into frame-safe pages, on BYTES as well as count: the count cap is a coarse
 *  guard and long paths blow the control-byte budget well before 512 rows. */
function pageFiles(files: ClusterSkillFile[]): ClusterSkillFile[][] {
  const budget = MAX_CLUSTER_SKILL_CONTROL_BYTES - MANIFEST_PAGE_ENVELOPE_BYTES
  const pages: ClusterSkillFile[][] = [[]]
  let bytes = 0
  for (const file of files) {
    const row = Buffer.byteLength(JSON.stringify(file)) + 1
    if (pages.at(-1)!.length > 0 && (pages.at(-1)!.length >= MAX_CLUSTER_SKILL_MANIFEST_PAGE || bytes + row > budget)) {
      pages.push([])
      bytes = 0
    }
    pages.at(-1)!.push(file)
    bytes += row
  }
  return pages
}
