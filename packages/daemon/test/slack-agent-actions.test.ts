import { describe, it, expect, vi, afterEach } from 'vitest'
import { SlackConnection } from '../src/slack/connection.js'

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
  it('derives the columns and their types from the rows it read', async () => {
    const list = vi.fn(async () => ({
      items: [
        {
          id: 'Rec1',
          fields: [
            { column_id: 'Col1', rich_text: [{ type: 'text', text: 'ship it' }] },
            { column_id: 'Col2', checkbox: true }
          ]
        }
      ],
      response_metadata: { next_cursor: 'p2' }
    }))
    const conn = connWith({ slackLists: { items: { list, create: async () => ({}), update: async () => ({}) } } })

    const page = await conn.readList('F1', { limit: 10 })
    expect(page.columns).toEqual([
      { id: 'Col1', type: 'rich_text' },
      { id: 'Col2', type: 'checkbox' }
    ])
    expect(page.items).toEqual([{ id: 'Rec1', fields: { Col1: [{ type: 'text', text: 'ship it' }], Col2: true } }])
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

    await conn.updateListItem('F1', 'Rec1', [{ columnId: 'Col1', type: 'date', value: ['2026-08-31'] }])
    expect(update).toHaveBeenCalledWith({
      list_id: 'F1',
      id: 'Rec1',
      cells: [{ column_id: 'Col1', date: ['2026-08-31'] }]
    })
  })
})
