import type { ShimRequester } from './channels.js'
import {
  ClusterSkillBeginReplySchema,
  ClusterSkillUploadReplySchema,
  MAX_CLUSTER_SKILL_CHUNK_BYTES,
  type ClusterSkillBegin,
  type ClusterSkillBeginReply,
  type ClusterSkillFile,
  type ClusterSkillUploadReply
} from './skill-protocol.js'

export class ClusterSkillClient {
  constructor(private readonly requester: ShimRequester) {}

  async begin(input: Omit<ClusterSkillBegin, 'op'>): Promise<ClusterSkillBeginReply> {
    return ClusterSkillBeginReplySchema.parse(await this.requester.request('skills', { op: 'begin', ...input }))
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
