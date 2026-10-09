import type { IlinkJsonTransport } from '../transport/ilink-json-transport.js'
import { formatOutboundText } from '../internal/markdown-lite.js'
import type { OutboundTextFormat } from '../ilink-options.js'
import { nextOutboundClientMarker } from '../internal/random-tags.js'
import { AuthorKind, ItemKind, OutboxPhase } from '../protocol/wire-models.js'
import type { OutboundWireEnvelope, WireCompositeItem } from '../protocol/wire-models.js'
import type { StagedCipherPayload } from '../cdn/payload-pipeline.js'

/** iLink 线协议要求 Base64 的内容是 32 位 hex 文本，而不是 16 字节原始密钥。 */
function encodeCdnAesKey(aesKeyHex: string): string {
  return Buffer.from(aesKeyHex, 'utf8').toString('base64')
}

async function emitIsolatedFacet(
  transport: IlinkJsonTransport,
  peerKey: string,
  contextToken: string,
  facet: WireCompositeItem
): Promise<string> {
  const clientId = nextOutboundClientMarker()
  const envelope: OutboundWireEnvelope = {
    msg: {
      from_user_id: '',
      to_user_id: peerKey,
      client_id: clientId,
      message_type: AuthorKind.Bot,
      message_state: OutboxPhase.Settled,
      item_list: [facet],
      context_token: contextToken
    }
  }
  await transport.dispatchOutboundEnvelope(envelope)
  return clientId
}

async function emitFacetChain(
  transport: IlinkJsonTransport,
  peerKey: string,
  contextToken: string,
  facets: WireCompositeItem[]
): Promise<string> {
  let last = ''
  for (const facet of facets) {
    last = await emitIsolatedFacet(transport, peerKey, contextToken, facet)
  }
  return last
}

export function packLiteralReply(
  peerKey: string,
  contextToken: string,
  markdown: string,
  textFormat: OutboundTextFormat = 'plain'
): OutboundWireEnvelope {
  const formatted = formatOutboundText(markdown, textFormat)
  return {
    msg: {
      from_user_id: '',
      to_user_id: peerKey,
      client_id: nextOutboundClientMarker(),
      message_type: AuthorKind.Bot,
      message_state: OutboxPhase.Settled,
      item_list: formatted ? [{ type: ItemKind.Text, text_item: { text: formatted } }] : undefined,
      context_token: contextToken
    }
  }
}

export async function postLiteralReply(
  transport: IlinkJsonTransport,
  peerKey: string,
  contextToken: string,
  markdown: string,
  textFormat: OutboundTextFormat = 'plain'
): Promise<{ messageId: string }> {
  const envelope = packLiteralReply(peerKey, contextToken, markdown, textFormat)
  await transport.dispatchOutboundEnvelope(envelope)
  return { messageId: envelope.msg?.client_id ?? '' }
}

export async function postPhotoBundle(
  transport: IlinkJsonTransport,
  peerKey: string,
  contextToken: string,
  staged: StagedCipherPayload,
  caption?: string,
  textFormat: OutboundTextFormat = 'plain'
): Promise<string> {
  const chain: WireCompositeItem[] = []
  if (caption) {
    chain.push({
      type: ItemKind.Text,
      text_item: { text: formatOutboundText(caption, textFormat) }
    })
  }
  chain.push({
    type: ItemKind.Image,
    image_item: {
      media: {
        encrypt_query_param: staged.remoteHandle,
        aes_key: encodeCdnAesKey(staged.aesKeyHex),
        encrypt_type: 1
      },
      hd_size: staged.cipherBudget,
      mid_size: staged.cipherBudget
    }
  })
  return emitFacetChain(transport, peerKey, contextToken, chain)
}

export async function postVideoBundle(
  transport: IlinkJsonTransport,
  peerKey: string,
  contextToken: string,
  staged: StagedCipherPayload,
  caption?: string,
  textFormat: OutboundTextFormat = 'plain'
): Promise<string> {
  const chain: WireCompositeItem[] = []
  if (caption) {
    chain.push({
      type: ItemKind.Text,
      text_item: { text: formatOutboundText(caption, textFormat) }
    })
  }
  chain.push({
    type: ItemKind.Video,
    video_item: {
      media: {
        encrypt_query_param: staged.remoteHandle,
        aes_key: encodeCdnAesKey(staged.aesKeyHex),
        encrypt_type: 1
      },
      video_size: staged.plainBytes
    }
  })
  return emitFacetChain(transport, peerKey, contextToken, chain)
}

export async function postFileBundle(
  transport: IlinkJsonTransport,
  peerKey: string,
  contextToken: string,
  staged: StagedCipherPayload,
  caption?: string,
  textFormat: OutboundTextFormat = 'plain'
): Promise<string> {
  const chain: WireCompositeItem[] = []
  if (caption) {
    chain.push({
      type: ItemKind.Text,
      text_item: { text: formatOutboundText(caption, textFormat) }
    })
  }
  chain.push({
    type: ItemKind.File,
    file_item: {
      media: {
        encrypt_query_param: staged.remoteHandle,
        aes_key: encodeCdnAesKey(staged.aesKeyHex),
        encrypt_type: 1
      },
      file_name: staged.originalName,
      len: String(staged.plainBytes),
      md5: staged.plainMd5Hex
    }
  })
  return emitFacetChain(transport, peerKey, contextToken, chain)
}

/** 将传输层与文本格式绑定为单个出站发送器，避免调用方重复传递策略。 */
export function createOutboundSender(transport: IlinkJsonTransport, textFormat: OutboundTextFormat) {
  return {
    postText: (peerKey: string, contextToken: string, markdown: string) =>
      postLiteralReply(transport, peerKey, contextToken, markdown, textFormat),
    postPhoto: (peerKey: string, contextToken: string, staged: StagedCipherPayload, caption?: string) =>
      postPhotoBundle(transport, peerKey, contextToken, staged, caption, textFormat),
    postVideo: (peerKey: string, contextToken: string, staged: StagedCipherPayload, caption?: string) =>
      postVideoBundle(transport, peerKey, contextToken, staged, caption, textFormat),
    postFile: (peerKey: string, contextToken: string, staged: StagedCipherPayload, caption?: string) =>
      postFileBundle(transport, peerKey, contextToken, staged, caption, textFormat)
  }
}
