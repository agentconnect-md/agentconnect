import { materializeMediaSource } from '../../onebots/index.js'
import type { InputFile } from '../protocol/chat-event.js'

export type ResolvedBlob = { buffer: Buffer; fileName: string; contentType: string }

function isByteContainer(input: InputFile): input is Exclude<InputFile, string | URL | Buffer | Uint8Array> {
  return (
    typeof input === 'object' && !(input instanceof URL) && !Buffer.isBuffer(input) && !(input instanceof Uint8Array)
  )
}

/** 将 SDK 输入桥接到 core 的统一媒体来源与元数据安全边界。 */
export async function materializeUserSuppliedFile(
  input: InputFile,
  options?: { filename?: string; contentType?: string }
): Promise<ResolvedBlob> {
  let source: string | Uint8Array
  let filename = options?.filename
  let contentType = options?.contentType
  if (input instanceof URL) source = input.toString()
  else if (isByteContainer(input)) {
    source = input.source
    filename = input.filename ?? filename
    contentType = input.contentType ?? contentType
  } else source = input
  const media = await materializeMediaSource({
    source,
    filename,
    contentType
  })
  return {
    buffer: Buffer.from(media.data),
    fileName: media.filename,
    contentType: media.contentType
  }
}
