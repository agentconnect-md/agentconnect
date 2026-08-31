import { describe, it, expect, vi, afterEach } from 'vitest'
import { LIST_SCHEMA_TYPES, LIST_WRITE_KEY_BY_TYPE, SlackConnection } from '../src/slack/connection.js'

/**
 * The Slack half of the agent-callable ACTIONS (`mcp/ops/platform-actions.ts`): reactions,
 * conversation creation, scheduled sends, and canvases.
 *
 * What these hold down is the difference from the chrome above them in the adapter. Turn
 * chrome degrades to nothing visible when a workspace's grant is short; these are things the
 * AGENT asked for, so each must report Slack's own code — an installation that predates the
 * capability scopes has to be told `missing_scope`, not handed a silent success.
 */
const deps = () => ({
  group: { appToken: 'xapp-1', botToken: 'xoxb-a', integrations: [] },
  onMessage: () => {},
  newTraceId: () => 't'
})

const slackError = (code: string) => Object.assign(new Error(code), { data: { error: code } })

type ClientOverrides = Record<string, Record<string, unknown>>

function connWith(overrides: ClientOverrides = {}) {
  const client: Record<string, Record<string, unknown>> = {
    auth: { test: async () => ({ user_id: 'U1', team_id: 'T123' }) },
    chat: {
      postMessage: async () => ({}),
      getPermalink: async () => ({ permalink: 'https://x/y' }),
      scheduleMessage: async () => ({ scheduled_message_id: 'Q1', channel: 'C1' })
    },
    files: { info: async () => ({ file: {} }) },
    conversations: {
      open: async () => ({ channel: { id: 'D1', is_im: true } }),
      create: async () => ({ channel: { id: 'C_NEW', name: 'plans', is_private: true } }),
      invite: async () => ({}),
      canvases: { create: async () => ({ canvas_id: 'F_TAB' }) }
    },
    reactions: { add: async () => ({}), get: async () => ({ message: { reactions: [] } }) },
    canvases: {
      create: async () => ({ canvas_id: 'F1' }),
      edit: async () => ({}),
      sections: { lookup: async () => ({ sections: [] }) }
    }
  }
  for (const [group, members] of Object.entries(overrides)) client[group] = { ...client[group], ...members }
  const app = {
    message() {},
    event() {},
    action() {},
    shortcut() {},
    client,
    start: async () => {},
    stop: async () => {}
  }
  return new SlackConnection(deps() as never, (() => app) as never)
}

afterEach(() => vi.unstubAllGlobals())

describe('SlackConnection reactions', () => {
  it('places the emoji the agent named, and treats a repeat as the state it asked for', async () => {
    const add = vi.fn(async () => ({}))
    await connWith({ reactions: { add } }).addReaction('C1', '100.1', 'tada')
    expect(add).toHaveBeenCalledWith({ channel: 'C1', timestamp: '100.1', name: 'tada' })

    const repeat = connWith({
      reactions: {
        add: async () => {
          throw slackError('already_reacted')
        }
      }
    })
    await expect(repeat.addReaction('C1', '100.1', 'tada')).resolves.toBeUndefined()
  })

  // The agent asked for this, so the refusal has to reach it — a workspace whose grant
  // predates `reactions:read` must see WHY, not an empty list.
  it('surfaces Slack’s own code on a refusal', async () => {
    const conn = connWith({
      reactions: {
        get: async () => {
          throw slackError('missing_scope')
        }
      }
    })
    await expect(conn.getReactions('C1', '100.1')).rejects.toThrow('Slack reading reactions failed: missing_scope')
  })

  it('projects the tallies, dropping a row with no emoji name', async () => {
    const conn = connWith({
      reactions: {
        get: async () => ({ message: { reactions: [{ name: 'tada', count: 2, users: ['U1', 'U2'] }, { count: 9 }] } })
      }
    })
    expect(await conn.getReactions('C1', '100.1')).toEqual([{ name: 'tada', count: 2, users: ['U1', 'U2'] }])
  })
})

describe('SlackConnection.createConversation', () => {
  it('opens a direct conversation when told only who to talk to', async () => {
    const open = vi.fn(async () => ({ channel: { id: 'D1', is_im: true } }))
    const create = vi.fn()
    const conn = connWith({ conversations: { open, create } })

    expect(await conn.createConversation({ users: ['U1', 'U2'] })).toEqual({ id: 'D1', isIm: true, isMpim: undefined })
    expect(open).toHaveBeenCalledWith({ users: 'U1,U2', return_im: true })
    expect(create).not.toHaveBeenCalled()
  })

  // The channel exists either way. Reporting a failed invite as a failed creation would
  // invite a retry, and that retry trips `name_taken` on the channel we just made.
  it('creates a channel and invites best-effort', async () => {
    const invite = vi.fn(async () => {
      throw slackError('cannot_invite')
    })
    const conn = connWith({ conversations: { invite } })

    expect(await conn.createConversation({ name: 'plans', isPrivate: true, users: ['U1'] })).toEqual({
      id: 'C_NEW',
      name: 'plans',
      isPrivate: true
    })
    expect(invite).toHaveBeenCalledWith({ channel: 'C_NEW', users: 'U1' })
  })

  it('reports a refused creation with Slack’s code', async () => {
    const conn = connWith({
      conversations: {
        create: async () => {
          throw slackError('name_taken')
        }
      }
    })
    await expect(conn.createConversation({ name: 'plans' })).rejects.toThrow(
      'Slack creating a channel failed: name_taken'
    )
  })
})

describe('SlackConnection.scheduleMessage', () => {
  it('hands Slack the future post and returns the handle a cancel would need', async () => {
    const scheduleMessage = vi.fn(async () => ({ scheduled_message_id: 'Q9', channel: 'C1' }))
    const conn = connWith({ chat: { scheduleMessage } })

    expect(await conn.scheduleMessage('C1', 'standup', 1_800_000_000)).toEqual({
      id: 'Q9',
      channel: 'C1',
      postAt: 1_800_000_000
    })
    expect(scheduleMessage).toHaveBeenCalledWith({ channel: 'C1', text: 'standup', post_at: 1_800_000_000 })
  })

  it('reports a refusal rather than inventing a handle', async () => {
    const conn = connWith({
      chat: {
        scheduleMessage: async () => {
          throw slackError('time_in_past')
        }
      }
    })
    await expect(conn.scheduleMessage('C1', 'x', 1)).rejects.toThrow('Slack scheduling a message failed: time_in_past')
  })
})

describe('SlackConnection canvases', () => {
  it('tabs a canvas onto a conversation when given one, and creates it standalone otherwise', async () => {
    const create = vi.fn(async () => ({ canvas_id: 'F1' }))
    const tabbed = vi.fn(async () => ({ canvas_id: 'F_TAB' }))
    const conn = connWith({
      canvases: { create },
      conversations: { canvases: { create: tabbed } },
      files: { info: async () => ({ file: { permalink: 'https://x/canvas' } }) }
    })

    expect(await conn.createCanvas('Plan', '# Plan')).toEqual({ id: 'F1', title: 'Plan', url: 'https://x/canvas' })
    expect(create).toHaveBeenCalledWith({ title: 'Plan', document_content: { type: 'markdown', markdown: '# Plan' } })

    expect(await conn.createCanvas('Plan', '# Plan', 'C1')).toMatchObject({ id: 'F_TAB' })
    expect(tabbed).toHaveBeenCalledWith({
      channel_id: 'C1',
      title: 'Plan',
      document_content: { type: 'markdown', markdown: '# Plan' }
    })
  })

  // Slack publishes no full canvas read: `canvases:read` buys section ids and nothing else,
  // so the body comes back down the ordinary credentialed file path — or not at all.
  it('reads metadata and anchors always, and the body only when the file path serves it', async () => {
    const conn = connWith({
      files: {
        info: async () => ({
          file: { title: 'Plan', permalink: 'https://x/canvas', url_private: 'https://files.slack.com/c/F1' }
        })
      },
      canvases: { sections: { lookup: async () => ({ sections: [{ id: 's1' }, {}] }) } }
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: new Headers({ 'content-type': 'text/markdown' }),
        arrayBuffer: async () => new TextEncoder().encode('# Plan').buffer
      }))
    )

    expect(await conn.readCanvas('F1')).toEqual({
      id: 'F1',
      title: 'Plan',
      url: 'https://x/canvas',
      markdown: '# Plan',
      sections: [{ id: 's1' }]
    })
  })

  it('still answers with the canvas when the body is not fetchable and the anchors are not granted', async () => {
    const conn = connWith({
      files: { info: async () => ({ file: { title: 'Plan' } }) },
      canvases: {
        sections: {
          lookup: async () => {
            throw slackError('missing_scope')
          }
        }
      }
    })
    expect(await conn.readCanvas('F1')).toEqual({ id: 'F1', title: 'Plan' })
  })

  it('maps edits onto Slack’s change vocabulary', async () => {
    const edit = vi.fn(async () => ({}))
    const conn = connWith({ canvases: { edit } })

    await conn.updateCanvas('F1', [
      { operation: 'replace', markdown: '# New' },
      { operation: 'delete', sectionId: 's2' }
    ])
    expect(edit).toHaveBeenCalledWith({
      canvas_id: 'F1',
      changes: [
        { operation: 'replace', document_content: { type: 'markdown', markdown: '# New' } },
        { operation: 'delete', section_id: 's2' }
      ]
    })
  })
})

describe('SlackConnection bookmarks', () => {
  it('creates a link bookmark and reads the pinned set back', async () => {
    const add = vi.fn(async () => ({ bookmark: { id: 'Bk1', title: 'Runbook', link: 'https://x.test/rb' } }))
    const list = vi.fn(async () => ({ bookmarks: [{ id: 'Bk1', title: 'Runbook', link: 'https://x.test/rb' }] }))
    const conn = connWith({ bookmarks: { add, list, remove: async () => ({}) } })

    const made = await conn.addBookmark('C1', { title: 'Runbook', link: 'https://x.test/rb' })
    // `type: 'link'` is the only kind an agent can create — the others need an entity id.
    expect(add).toHaveBeenCalledWith({
      channel_id: 'C1',
      title: 'Runbook',
      type: 'link',
      link: 'https://x.test/rb'
    })
    expect(made).toEqual({ id: 'Bk1', title: 'Runbook', link: 'https://x.test/rb' })
    expect(await conn.listBookmarks('C1')).toEqual([made])
  })

  it('surfaces Slack’s own code when a pin is refused', async () => {
    const conn = connWith({
      bookmarks: {
        list: async () => ({}),
        remove: async () => ({}),
        add: async () => {
          throw slackError('missing_scope')
        }
      }
    })
    await expect(conn.addBookmark('C1', { title: 't', link: 'l' })).rejects.toThrow(
      'Slack adding a bookmark failed: missing_scope'
    )
  })
})

describe('SlackConnection lists', () => {
  // Slack has no schema endpoint for a list, so the columns are derived from the rows — and
  // the value key IS the column type, which is how a write must address it too.
  // Slack's real field carries `key`, `value` and often `text` BESIDE the typed property, and
  // its own examples put `key` first — so reading "the first property that is not column_id"
  // yields `key` and a type the write endpoints reject. This fixture is the documented shape.
  it('reads the typed field past the metadata Slack puts in front of it', async () => {
    const list = vi.fn(async () => ({
      list: {
        columns: [
          // The PRIMARY column: Slack's schema calls it `text`, and a write must use
          // `rich_text` — the one key `text` would have been rejected for.
          { id: 'Col1', key: 'rich_text_notes', name: 'Notes', type: 'text' },
          { id: 'Col2', key: 'done', name: 'Done', type: 'checkbox' },
          // A column no row has filled in: only `include_list` can see it.
          { id: 'Col3', key: 'estimate', name: 'Estimate', type: 'number' },
          // Slack computes this one; no request may set it.
          { id: 'Col4', key: 'created', name: 'Created', type: 'created_time' }
        ]
      },
      items: [
        {
          id: 'Rec1',
          fields: [
            {
              key: 'rich_text_notes',
              value: '[{"type":"rich_text"}]',
              text: 'ship it',
              rich_text: [{ type: 'rich_text', block_id: 'b1' }],
              column_id: 'Col1'
            },
            { key: 'done', value: true, checkbox: true, column_id: 'Col2' }
          ]
        }
      ],
      response_metadata: { next_cursor: 'p2' }
    }))
    const conn = connWith({ slackLists: { items: { list, create: async () => ({}), update: async () => ({}) } } })

    const page = await conn.readList('F1', { limit: 10 })
    expect(list).toHaveBeenCalledWith({ list_id: 'F1', include_list: true, limit: 10 })
    // The schema wins, including the column with no rows — a write needs it as much as the rest.
    expect(page.columns).toEqual([
      { id: 'Col1', type: 'rich_text', name: 'Notes' },
      { id: 'Col2', type: 'checkbox', name: 'Done' },
      { id: 'Col3', type: 'number', name: 'Estimate' },
      { id: 'Col4', type: 'created_time', name: 'Created', readOnly: true }
    ])
    expect(page.items).toEqual([{ id: 'Rec1', fields: { Col1: [{ type: 'rich_text', block_id: 'b1' }], Col2: true } }])
    expect(page.nextCursor).toBe('p2')
  })

  it('writes a value keyed by its column type', async () => {
    const create = vi.fn(async () => ({ item: { id: 'Rec2' } }))
    const update = vi.fn(async () => ({}))
    const conn = connWith({
      slackLists: { items: { create, update, list: async () => ({ items: [] }) } }
    })

    await conn.addListItem('F1', [{ columnId: 'Col2', type: 'checkbox', value: true }])
    expect(create).toHaveBeenCalledWith({
      list_id: 'F1',
      initial_fields: [{ column_id: 'Col2', checkbox: true }]
    })

    // The row is named per cell — there is no top-level id, and a cell without `row_id` is
    // refused with `row_id_not_provided`, so every update would have failed.
    await conn.updateListItem('F1', 'Rec1', [{ columnId: 'Col1', type: 'date', value: ['2026-08-31'] }])
    expect(update).toHaveBeenCalledWith({
      list_id: 'F1',
      cells: [{ row_id: 'Rec1', column_id: 'Col1', date: ['2026-08-31'] }]
    })
  })
})

describe('SlackConnection lists: schema types are normalized to write keys', () => {
  // Slack: "you may see the `text` property appear in a response as a fallback, but it is not
  // accepted in the request payload". A response-only `text` must still report `rich_text`,
  // or the agent copies the read straight into a write that is refused.
  it('reports rich_text for a column whose value arrived as a text fallback', async () => {
    const list = vi.fn(async () => ({
      items: [{ id: 'Rec1', fields: [{ key: 'title', value: 'ship it', text: 'ship it', column_id: 'Col1' }] }]
    }))
    const conn = connWith({ slackLists: { items: { list, create: async () => ({}), update: async () => ({}) } } })

    const page = await conn.readList('F1')
    expect(page.columns).toEqual([{ id: 'Col1', type: 'rich_text' }])
    expect(page.items[0]!.fields.Col1).toBe('ship it')
  })
})

describe('List schema vocabulary', () => {
  // Four rounds of review found the same shape of bug: a schema type nobody had enumerated,
  // passed through as if it were a write key. Enumeration is the fix — this asserts the table
  // answers for EVERY documented type, so the next one Slack adds fails here instead of in a
  // refused write.
  it('maps every documented schema type to a write key or to read-only', () => {
    const unmapped = LIST_SCHEMA_TYPES.filter((t) => !(t in LIST_WRITE_KEY_BY_TYPE))
    expect(unmapped).toEqual([])
  })

  // The write keys are the item endpoints' vocabulary, not the schema's — nothing may map to
  // a name a request would be refused for, and `text` is the one Slack calls out by name.
  it('never maps a column to a key the write endpoints reject', () => {
    const WRITABLE = [
      'rich_text',
      'message',
      'number',
      'select',
      'date',
      'user',
      'attachment',
      'checkbox',
      'email',
      'phone',
      'channel',
      'rating',
      'timestamp',
      'link',
      'reference'
    ]
    const bad = Object.entries(LIST_WRITE_KEY_BY_TYPE).filter(([, key]) => key !== null && !WRITABLE.includes(key))
    expect(bad).toEqual([])
  })

  it('writes a task list’s three columns as the fields they are made of', () => {
    for (const [schema, write] of [
      ['assignee', 'user'],
      ['todo_assignee', 'user'],
      ['due_date', 'date'],
      ['todo_due_date', 'date'],
      ['completed', 'checkbox'],
      ['todo_completed', 'checkbox']
    ]) {
      expect(LIST_WRITE_KEY_BY_TYPE[schema!]).toBe(write)
    }
  })
})
