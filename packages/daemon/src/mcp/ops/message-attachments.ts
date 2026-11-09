import { z } from 'zod'
import { MESSAGE_ATTACHMENTS_MAX, MessageAttachmentSource } from '@agentconnect.md/protocol'
import type { MessageFile, SessionContext } from './context.js'
import { ambiguousIntegrations, resolveGatewayForPlatform, type GatewayDeps } from './gateway.js'
import type { ShareFileDeps } from './share-file.js'
import { sharedFileKind } from './share-file-types.js'

// Each source keeps its existing identifier; names are never attachment selectors.
export const MessageAttachment = MessageAttachmentSource
export type MessageAttachment = z.infer<typeof MessageAttachment>
export const messageAttachmentsField = z.array(MessageAttachment).min(1).max(MESSAGE_ATTACHMENTS_MAX).optional()

export interface MessageAttachmentDeps
  extends GatewayDeps, Pick<ShareFileDeps, 'readWorkspaceFile' | 'chargeShareBudget'> {
  maxOutboundFileBytes?: number
  readUploadedFile?: (ctx: SessionContext, uploadId: string) => Promise<MessageFile | undefined>
  authorizeFileRead?: (source: { platform: string; integrationId: string; channels: string[] }) => Promise<void>
}

export async function resolveMessageAttachment(
  ctx: SessionContext,
  source: MessageAttachment,
  deps: MessageAttachmentDeps
): Promise<{ file: MessageFile; source: MessageAttachment }> {
  const cap = deps.maxOutboundFileBytes ?? 8 * 1024 * 1024
  let file: MessageFile | undefined
  if (source.source === 'workspace') {
    const read = await deps.readWorkspaceFile?.(ctx, source.path)
    if (!read?.ok)
      throw new Error(
        `sendMessage: cannot read workspace attachment (${read?.reason ?? 'unavailable'}). Nothing was sent.`
      )
    file = read
  } else if (source.source === 'upload') {
    file = await deps.readUploadedFile?.(ctx, source.uploadId)
    if (!file)
      throw new Error('sendMessage: the upload is unavailable in this session or has expired. Nothing was sent.')
  } else {
    if (!source.integrationId && ambiguousIntegrations(ctx, source.platform).length > 1)
      throw new Error('sendMessage: specify the attachment’s source integrationId. Nothing was sent.')
    const { gw, integrationId } = resolveGatewayForPlatform(ctx, deps, source.platform, source.integrationId)
    source = { ...source, integrationId }
    if (!gw.getFileInfo || !deps.authorizeFileRead)
      throw new Error('sendMessage: this integration cannot resolve attachments by fileId. Nothing was sent.')
    const info = await gw.getFileInfo(source.fileId)
    if (!info) throw new Error('sendMessage: the platform attachment is unavailable. Nothing was sent.')
    await deps.authorizeFileRead({ platform: source.platform, integrationId, channels: info.channels })
    if (info.size !== undefined && info.size > cap)
      throw new Error('sendMessage: the platform attachment exceeds the file size limit. Nothing was sent.')
    const bytes = await gw.downloadFile(info.sourceUrl, cap)
    if (bytes) file = { bytes, name: info.name, mimeType: info.mimeType }
  }
  if (!file || file.bytes.length === 0)
    throw new Error('sendMessage: the attachment could not be read. Nothing was sent.')
  if (file.bytes.length > cap)
    throw new Error('sendMessage: the attachment exceeds the file size limit. Nothing was sent.')
  return { file: { bytes: file.bytes, ...sharedFileKind(file.name, file.bytes) }, source }
}
