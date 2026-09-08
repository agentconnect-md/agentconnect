import { describe, expect, it } from 'vitest'
import { extractSlackMessageText } from '../src/slack-message-text.js'
import { normalizeSlackMessage, toSlackAttachment } from '../src/slack-message.js'

const LIST_URL = 'https://slack.example.test/lists/T1/F0LIST'
const CANVAS_URL = 'https://slack.example.test/docs/T1/F0CANVAS'

/** A List shared inline, exactly as Slack delivered it: the fallback `text` spells the bare
 *  file id, the `list_record` element carries the link, and the `files` entry repeats it. */
const listMention = {
  text: 'can you see F0LIST',
  blocks: [
    {
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_section',
          elements: [
            { type: 'text', text: 'can you see ' },
            { type: 'list_record', file_id: 'F0LIST', url: LIST_URL }
          ]
        }
      ]
    }
  ],
  files: [
    {
      id: 'F0LIST',
      filetype: 'list',
      mode: 'list',
      mimetype: 'application/vnd.slack-list',
      name: 'list',
      title: 'Untitled list',
      url_private: 'https://files.example.test/T1-F0LIST/list',
      permalink: LIST_URL
    }
  ]
}

function section(...elements: Record<string, unknown>[]) {
  return [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements }] }]
}

describe('Slack-hosted surfaces mentioned inline', () => {
  it('renders a list_record as a link that names the kind and the id, and drops the bare-id fallback', () => {
    expect(extractSlackMessageText(listMention)).toBe(`can you see <${LIST_URL}|Slack List F0LIST>`)
  })

  it('keeps the display text and the row when Slack sends them', () => {
    const text = extractSlackMessageText({
      blocks: section({ type: 'list_record', file_id: 'F0LIST', record_id: 'Rec1', text: 'Roadmap', url: LIST_URL })
    })
    expect(text).toBe(`<${LIST_URL}|Roadmap (Slack List F0LIST row Rec1)>`)
  })

  it('renders a canvas mention the same way, from its label when it has no text', () => {
    expect(
      extractSlackMessageText({
        blocks: section({ type: 'canvas', file_id: 'F0CANVAS', label: 'Q3 plan', url: CANVAS_URL })
      })
    ).toBe(`<${CANVAS_URL}|Q3 plan (Slack Canvas F0CANVAS)>`)
    expect(extractSlackMessageText({ blocks: section({ type: 'canvas', file_id: 'F0CANVAS' }) })).toBe(
      'Slack Canvas F0CANVAS'
    )
  })

  it('renders a file mention with its id', () => {
    expect(extractSlackMessageText({ blocks: section({ type: 'file', file_id: 'F0DOC', text: 'spec.pdf' }) })).toBe(
      'spec.pdf (Slack file F0DOC)'
    )
  })

  it('renders message mentions and canvas message unfurls as an addressable channel + ts', () => {
    expect(
      extractSlackMessageText({
        blocks: section({ type: 'message_mention', channel_id: 'C1', message_ts: '1700000000.000100' })
      })
    ).toBe('message 1700000000.000100 in <#C1>')
    expect(
      extractSlackMessageText({
        blocks: section({
          type: 'canvas_message_unfurl',
          root_message_channel: 'C1',
          root_message_ts: '1700000000.000100'
        })
      })
    ).toBe('message 1700000000.000100 in <#C1>')
  })

  it('keeps the text and link of the leaf element types it does not model', () => {
    const text = extractSlackMessageText({
      blocks: section(
        {
          type: 'work_object_mention',
          entity_id: 'E1',
          app_id: 'A1',
          text: 'PROJ-1',
          url: 'https://tracker.example.test/PROJ-1'
        },
        { type: 'text', text: ' ' },
        { type: 'citation', url: 'https://source.example.test/1', text: 'Source', index: 1, details: {} },
        { type: 'text', text: ' ' },
        { type: 'attachment_mention', url: 'https://app.example.test/a' },
        { type: 'text', text: ' ' },
        { type: 'tag', text: 'In progress' },
        { type: 'text', text: ' ' },
        { type: 'color', value: '#F405B3' }
      )
    })
    expect(text).toBe(
      '<https://tracker.example.test/PROJ-1|PROJ-1> <https://source.example.test/1|Source> https://app.example.test/a In progress #F405B3'
    )
  })
})

describe('Slack-hosted surfaces shared on a message', () => {
  it('surfaces a shared List from its file entry when nothing in the body mentions it', () => {
    const text = extractSlackMessageText({ text: '', files: listMention.files })
    expect(text).toBe(`<${LIST_URL}|Untitled list (Slack List F0LIST)>`)
  })

  it('does not repeat a file entry the body already renders', () => {
    expect(extractSlackMessageText(listMention)).not.toContain('Untitled list')
  })

  it('surfaces a shared canvas by its quip file type', () => {
    const text = extractSlackMessageText({
      text: 'notes',
      files: [
        {
          id: 'F0CANVAS',
          filetype: 'quip',
          mimetype: 'application/vnd.slack-docs',
          title: 'Retro',
          permalink: CANVAS_URL
        }
      ]
    })
    expect(text).toBe(`notes\n<${CANVAS_URL}|Retro (Slack Canvas F0CANVAS)>`)
  })

  it('never turns a List or canvas into a downloadable attachment', () => {
    expect(toSlackAttachment(listMention.files[0])).toBeNull()
    expect(
      toSlackAttachment({
        id: 'F0CANVAS',
        filetype: 'quip',
        mimetype: 'application/vnd.slack-docs',
        url_private: 'https://files.example.test/c'
      })
    ).toBeNull()
    expect(
      toSlackAttachment({
        id: 'F0IMG',
        filetype: 'png',
        mimetype: 'image/png',
        url_private: 'https://files.example.test/i'
      })?.id
    ).toBe('F0IMG')
  })

  it('normalizes a List mention to text only — the reference, no attachment marker', () => {
    const normalized = normalizeSlackMessage({ type: 'message', channel: 'C1', ts: '1.0', user: 'U1', ...listMention })
    expect(normalized?.text).toBe(`can you see <${LIST_URL}|Slack List F0LIST>`)
    expect(normalized?.attachments).toBeUndefined()
  })
})
