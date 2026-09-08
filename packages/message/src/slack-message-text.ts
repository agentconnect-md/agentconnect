/**
 * The text a person can see in a Slack message is not necessarily stored in the
 * top-level `text` field. App-authored messages commonly put their body in Block
 * Kit `blocks` or legacy secondary `attachments`, leaving `text` as only a short
 * notification fallback (sometimes just an @mention).
 *
 * Keep this extractor dependency-free so Socket Mode, HTTP ingest, and
 * conversations.replies backfill all present the same visible text to an agent.
 */

type UnknownRecord = Record<string, unknown>

export interface SlackTextBearingMessage {
  text?: unknown
  blocks?: unknown
  attachments?: unknown
  files?: unknown
}

/**
 * A Slack file that is a REFERENCE to a hosted surface, not bytes: a canvas (`quip`, the
 * Quip lineage Slack never renamed) or a List. What a model needs from one is the id its tool
 * takes, not a download — `readCanvas` / `readList` do the reading.
 */
export function slackReferenceFileKind(
  file: { filetype?: unknown; mode?: unknown; mimetype?: unknown } | null | undefined
): 'List' | 'Canvas' | undefined {
  if (!file) return undefined
  if (file.filetype === 'list' || file.mode === 'list' || file.mimetype === 'application/vnd.slack-list') return 'List'
  if (file.filetype === 'quip' || file.mode === 'quip' || file.mimetype === 'application/vnd.slack-docs')
    return 'Canvas'
  return undefined
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

/**
 * A reference to a Slack-hosted surface (a List, a canvas, a file), rendered so a model can
 * ACT on it: the kind and the id are always spelled out — `readList` / `readCanvas` take that
 * id — with the display text and link kept around them when Slack sent any. Slack's own
 * fallback `text` renders these as the bare id, which is exactly what a model cannot read.
 */
function surfaceReference(kind: string, id: string, text: string, url: string, rowId = ''): string {
  if (!id) return linkedLabel(text, url)
  const ref = `Slack ${kind} ${id}${rowId ? ` row ${rowId}` : ''}`
  return linkedLabel(text ? `${text} (${ref})` : ref, url)
}

const REFERENCE_RE = /<[^|>]+\|(?:[^>]*\()?Slack (?:List|Canvas|file) ([A-Za-z0-9]+)(?: row [A-Za-z0-9]+)?\)?>/g

function richElementText(value: unknown): string {
  const element = record(value)
  if (!element) return ''

  switch (element.type) {
    case 'text':
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
    // Slack-hosted surfaces mentioned inline. Their fallback `text` is the bare file id.
    case 'list_record':
      return surfaceReference(
        'List',
        string(element.file_id),
        string(element.text),
        string(element.url),
        string(element.record_id)
      )
    case 'canvas':
      return surfaceReference(
        'Canvas',
        string(element.file_id),
        string(element.text) || string(element.label),
        string(element.url)
      )
    case 'file':
      return surfaceReference('file', string(element.file_id), string(element.text), string(element.url))
    case 'message_mention': {
      const channel = string(element.channel_id)
      const ts = string(element.message_ts)
      return linkedLabel(
        string(element.text) || (channel && ts ? `message ${ts} in <#${channel}>` : ''),
        string(element.url)
      )
    }
    case 'canvas_message_unfurl': {
      const channel = string(element.root_message_channel)
      const ts = string(element.root_message_ts)
      return channel && ts ? `message ${ts} in <#${channel}>` : ''
    }
    case 'tag':
      return string(element.text)
    case 'color':
      return string(element.value)
    default: {
      if (Array.isArray(element.elements)) {
        const separator = element.type === 'rich_text_section' || element.type === 'rich_text_preformatted' ? '' : '\n'
        return join(element.elements.map(richElementText), separator)
      }
      // A leaf this extractor does not know (`attachment_mention`, `work_object_mention`,
      // `workflow_mention`, `citation`, whatever Slack adds next): keep the text and link every
      // one of them carries rather than dropping the reference on the floor.
      return linkedLabel(string(element.text) || string(element.product_name), string(element.url))
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

  return structured || string(attachment.fallback)
}

// A rendered surface reference collapses to its bare id, which is how Slack's fallback `text`
// spells the same mention — so the two views of one message dedupe instead of both surviving.
function canonical(value: string): string {
  return value.replace(REFERENCE_RE, '$1').replace(/\s+/g, ' ').trim()
}

/** Join top-level text with visible blocks/attachments while removing the common
 * fallback-vs-layout duplication produced by Slack app messages. */
function uniqueText(parts: string[]): string {
  const kept: { value: string; key: string }[] = []
  for (const value of parts.map((part) => part.trim()).filter(Boolean)) {
    const key = canonical(value)
    // Same text in two renderings: keep the one that spells more (the layout view over the fallback).
    const same = kept.find((part) => part.key === key)
    if (same) {
      if (value.length > same.value.length) same.value = value
      continue
    }
    if (kept.some((part) => key.length > 8 && part.key.includes(key))) continue
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

/** A List or canvas SHARED on the message (its `files`), unless the body already mentions it —
 *  a share without a mention has no blocks element, and the file entry is then the only carrier. */
function referenceFilesText(value: unknown, body: string): string {
  if (!Array.isArray(value)) return ''
  return join(
    value.map((entry) => {
      const file = record(entry)
      const kind = slackReferenceFileKind(file)
      const id = string(file?.id)
      if (!file || !kind || !id || body.includes(`Slack ${kind} ${id}`)) return ''
      return surfaceReference(kind, id, string(file.title), string(file.permalink))
    })
  )
}

export function extractSlackMessageText(message: SlackTextBearingMessage): string {
  const attachments = Array.isArray(message.attachments) ? message.attachments.map(attachmentText) : []
  const body = uniqueText([string(message.text), blocksText(message.blocks), ...attachments])
  return join([body, referenceFilesText(message.files, body)])
}
