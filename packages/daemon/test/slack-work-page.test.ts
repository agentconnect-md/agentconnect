// The Slack Work page (assistant-mode.md §5.19): a read-only canvas shared with the channel and pinned as a bookmark.
import { describe, expect, it, vi } from 'vitest'
import type { WorkPage } from '../src/platforms/contract.js'
import { SlackConnection } from '../src/slack/connection.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const PAGE: WorkPage = {
  agentName: 'Butler',
  tasks: [
    { kind: 'follow-up', status: 'waiting', title: 'Tell Alice when 2.9 is tagged', thread: '1761980000.000100' }
  ],
  schedules: [],
  updatedAt: Date.parse('2026-11-10T08:00:00Z')
}

const slackError = (error: string) => Object.assign(new Error(error), { data: { error } })

async function fixture(channel: Record<string, unknown> = { id: 'C0ENG', name: 'eng' }) {
  const app = fakeSlackAppFactory({ url: 'https://example.slack.com/' })({} as never)
  vi.spyOn(app.client.conversations, 'info').mockResolvedValue({ channel } as never)
  const create = vi.spyOn(app.client.canvases, 'create').mockResolvedValue({ canvas_id: 'F0WORK' })
  const edit = vi.spyOn(app.client.canvases, 'edit')
  const access = vi.spyOn(app.client.canvases.access, 'set')
  const del = vi.spyOn(app.client.canvases, 'delete')
  vi.spyOn(app.client.files, 'info').mockResolvedValue({
    file: { permalink: 'https://example.slack.com/docs/T0/F0WORK' }
  } as never)
  const bookmark = vi.spyOn(app.client.bookmarks, 'add').mockResolvedValue({ bookmark: { id: 'Bk0WORK' } })
  const unbookmark = vi.spyOn(app.client.bookmarks, 'remove')
  const rebookmark = vi.spyOn(app.client.bookmarks, 'edit')
  const channelCanvas = vi.fn(async (_a: unknown) => ({ canvas_id: 'F0CHANNEL' }))
  Object.assign(app.client.conversations, { canvases: { create: channelCanvas } })
  const conn = new SlackConnection(
    {
      group: { appToken: 'xapp', botToken: 'xoxb', integrations: [] },
      onMessage: () => {},
      newTraceId: () => 'trace',
      sendIntervalMs: 0
    },
    () => app
  )
  await conn.start()
  return { conn, create, edit, access, del, bookmark, unbookmark, rebookmark, channelCanvas }
}

describe('the Slack Work page', () => {
  it('creates a canvas named for its agent and channel, shares it read-only with the channel and pins it', async () => {
    const f = await fixture()
    try {
      expect(await f.conn.putWorkPage('C0ENG', PAGE)).toEqual({
        state: 'live',
        canvasId: 'F0WORK',
        bookmarkId: 'Bk0WORK'
      })
      const markdown = (f.create.mock.calls[0]![0] as { document_content: { markdown: string } }).document_content
        .markdown
      expect(markdown).toContain('[thread](https://example.slack.com/archives/C0ENG/p1761980000000100)')
      expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Butler · #eng' }))
      expect(f.access).toHaveBeenCalledWith({ canvas_id: 'F0WORK', access_level: 'read', channel_ids: ['C0ENG'] })
      expect(f.bookmark).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'C0ENG',
          title: "Butler's work",
          type: 'link',
          link: 'https://example.slack.com/docs/T0/F0WORK'
        })
      )
    } finally {
      await f.conn.stop()
    }
  })

  it('rewrites a stored canvas in place, and reports one a person deleted', async () => {
    const f = await fixture()
    try {
      const stored = { canvasId: 'F0WORK', bookmarkId: 'Bk0WORK' }
      expect(await f.conn.putWorkPage('C0ENG', PAGE, stored)).toEqual({ state: 'live', ...stored })
      expect(f.edit).toHaveBeenCalledWith(
        expect.objectContaining({ canvas_id: 'F0WORK', changes: [expect.objectContaining({ operation: 'replace' })] })
      )
      // A page made under an older name is renamed once, with its bookmark.
      expect(f.edit).toHaveBeenCalledWith({
        canvas_id: 'F0WORK',
        changes: [{ operation: 'rename', title_content: { type: 'markdown', markdown: 'Butler · #eng' } }]
      })
      expect(f.rebookmark).toHaveBeenCalledWith({ channel_id: 'C0ENG', bookmark_id: 'Bk0WORK', title: "Butler's work" })
      await f.conn.putWorkPage('C0ENG', PAGE, stored)
      expect(f.edit).toHaveBeenCalledTimes(3)
      expect(f.rebookmark).toHaveBeenCalledTimes(1)
      f.edit.mockRejectedValueOnce(slackError('canvas_not_found'))
      expect(await f.conn.putWorkPage('C0ENG', PAGE, stored)).toEqual({ state: 'deleted' })
      expect(f.create).not.toHaveBeenCalled()
    } finally {
      await f.conn.stop()
    }
  })

  it('keeps none in a DM, a group DM, a channel shared outside or a code channel', async () => {
    for (const channel of [
      { id: 'D0ALICE', is_im: true },
      { id: 'G0GROUP', is_mpim: true },
      { id: 'C0SHARED', is_ext_shared: true },
      {
        id: 'C0CODE',
        properties: {
          record_channel: { record_type: 'agent_channel' },
          agent_session: { encoded_agent_bot_user_ids: ['U_FAKE_BOT'] }
        }
      }
    ]) {
      const f = await fixture(channel)
      try {
        expect(await f.conn.putWorkPage(channel.id, PAGE)).toEqual({ state: 'skipped' })
        expect(f.create).not.toHaveBeenCalled()
      } finally {
        await f.conn.stop()
      }
    }
  })

  it('falls back to the channel’s own canvas where a standalone one cannot be made, and leaves one the channel has', async () => {
    const f = await fixture()
    try {
      f.create.mockRejectedValue(slackError('free_teams_cannot_create_standalone_canvases'))
      expect(await f.conn.putWorkPage('C0ENG', PAGE)).toEqual({ state: 'live', canvasId: 'F0CHANNEL' })
      expect(f.bookmark).not.toHaveBeenCalled()
      f.channelCanvas.mockRejectedValueOnce(slackError('channel_canvas_already_exists'))
      expect(await f.conn.putWorkPage('C0ENG', PAGE)).toEqual({ state: 'skipped' })
    } finally {
      await f.conn.stop()
    }
  })

  it('deletes a canvas it could not pin, and takes a page down with its bookmark', async () => {
    const f = await fixture()
    try {
      f.bookmark.mockRejectedValueOnce(slackError('not_in_channel'))
      await expect(f.conn.putWorkPage('C0ENG', PAGE)).rejects.toThrow('not_in_channel')
      expect(f.del).toHaveBeenCalledWith({ canvas_id: 'F0WORK' })
      await f.conn.removeWorkPage('C0ENG', { canvasId: 'F0WORK', bookmarkId: 'Bk0WORK' })
      expect(f.unbookmark).toHaveBeenCalledWith({ channel_id: 'C0ENG', bookmark_id: 'Bk0WORK' })
      expect(f.del).toHaveBeenCalledTimes(2)
    } finally {
      await f.conn.stop()
    }
  })
})
