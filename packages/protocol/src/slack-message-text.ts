/**
 * The text a person can see in a Slack message is not necessarily stored in the
 * top-level `text` field. App-authored messages commonly put their body in Block
 * Kit `blocks` or legacy secondary `attachments`, leaving `text` as only a short
 * notification fallback (sometimes just an @mention).
 *
 * Keep this extractor dependency-free so Socket Mode, shared HTTP ingest, and
 * conversations.replies backfill all present the same visible text to an agent.
 */

type UnknownRecord = Record<string, unknown>

export interface SlackTextBearingMessage {
  text?: unknown
  blocks?: unknown
  attachments?: unknown
}

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : undefined
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function inlineString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function textObject(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  return string(record(value)?.text)
}

function join(parts: string[], separator = '\n'): string {
  return parts.filter(Boolean).join(separator).trim()
}

function linkedLabel(label: string, url: string): string {
  if (!url) return label
  if (!label || label === url) return url
  return `<${url}|${label}>`
}

function richElementText(value: unknown): string {
  const element = record(value)
  if (!element) return ''

  switch (element.type) {
    case 'text':
      // Rich-text sections encode spacing inside adjacent inline text elements.
      return inlineString(element.text)
    case 'link':
      return linkedLabel(string(element.text), string(element.url))
    case 'user': {
      const id = string(element.user_id)
      return id ? `<@${id}>` : ''
    }
    case 'channel': {
      const id = string(element.channel_id)
      return id ? `<#${id}>` : ''
    }
    case 'usergroup': {
      const id = string(element.usergroup_id)
      return id ? `<!subteam^${id}>` : ''
    }
    case 'broadcast': {
      const range = string(element.range)
      return range ? `<!${range}>` : ''
    }
    case 'emoji': {
      const name = string(element.name)
      return name ? `:${name}:` : ''
    }
    case 'date':
      return string(element.fallback)
    default: {
      if (!Array.isArray(element.elements)) return ''
      const separator = element.type === 'rich_text_section' || element.type === 'rich_text_preformatted' ? '' : '\n'
      return join(element.elements.map(richElementText), separator)
    }
  }
}

function imageText(value: unknown): string {
  const image = record(value)
  if (!image || image.type !== 'image') return ''
  const label = textObject(image.title) || string(image.alt_text)
  return linkedLabel(label, string(image.image_url))
}

function blockText(value: unknown): string {
  const block = record(value)
  if (!block) return ''

  switch (block.type) {
    case 'section': {
      const fields = Array.isArray(block.fields) ? block.fields.map(textObject) : []
      return join([textObject(block.text), ...fields, imageText(block.accessory)])
    }
    case 'header':
    case 'markdown':
      return textObject(block.text)
    case 'context':
      return Array.isArray(block.elements)
        ? join(block.elements.map((element) => textObject(element) || imageText(element)))
        : ''
    case 'rich_text':
      return Array.isArray(block.elements) ? join(block.elements.map(richElementText)) : ''
    case 'image':
      return imageText(block)
    case 'video':
      return join([
        linkedLabel(textObject(block.title), string(block.video_url)),
        textObject(block.description),
        string(block.alt_text)
      ])
    default:
      // Interactive controls (`actions`, `input`, etc.) are deliberately omitted:
      // their labels are UI chrome, not message body or user-authored input.
      return ''
  }
}

function blocksText(value: unknown): string {
  return Array.isArray(value) ? join(value.map(blockText)) : ''
}

function embeddedMessagesText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return join(
    value.map((entry) => {
      const message = record(record(entry)?.message)
      return message ? extractSlackMessageText(message) : ''
    })
  )
}

function attachmentText(value: unknown): string {
  const attachment = record(value)
  if (!attachment) return ''

  const fields = Array.isArray(attachment.fields)
    ? attachment.fields.map((field) => {
        const item = record(field)
        return item ? join([string(item.title), string(item.value)]) : ''
      })
    : []
  const structured = uniqueText([
    string(attachment.pretext),
    linkedLabel(string(attachment.author_name), string(attachment.author_link)),
    linkedLabel(string(attachment.title), string(attachment.title_link)),
    string(attachment.text),
    ...fields,
    blocksText(attachment.blocks),
    embeddedMessagesText(attachment.message_blocks),
    string(attachment.footer),
    string(attachment.from_url)
  ])

  // `fallback` is usually a lossy duplicate of the structured visible fields.
  // Use it only when the attachment exposes no richer readable representation.
  return structured || string(attachment.fallback)
}

function canonical(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Join top-level text with visible blocks/attachments while removing the common
 * fallback-vs-layout duplication produced by Slack app messages. */
function uniqueText(parts: string[]): string {
  const kept: { value: string; key: string }[] = []
  for (const value of parts.map((part) => part.trim()).filter(Boolean)) {
    const key = canonical(value)
    if (kept.some((part) => part.key === key || (key.length > 8 && part.key.includes(key)))) continue
    for (let i = kept.length - 1; i >= 0; i--) {
      const previous = kept[i]!
      if (previous.key.length > 8 && key.includes(previous.key)) kept.splice(i, 1)
    }
    kept.push({ value, key })
  }
  return kept
    .map((part) => part.value)
    .join('\n')
    .trim()
}

export function extractSlackMessageText(message: SlackTextBearingMessage): string {
  const attachments = Array.isArray(message.attachments) ? message.attachments.map(attachmentText) : []
  return uniqueText([string(message.text), blocksText(message.blocks), ...attachments])
}
