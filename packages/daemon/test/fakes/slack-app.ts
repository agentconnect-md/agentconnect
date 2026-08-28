// An inert Slack app for daemon tests.
//
// Without it, `Daemon.start()` builds the real `@slack/web-api` client for every configured Slack
// integration and reaches slack.com. That made a unit suite depend on Slack being reachable: on CI
// the API answers `invalid_auth` fast, but a slow answer is a flake, and the one test that boots two
// distinct apps has twice the exposure — it timed out at the 5s budget for exactly that reason.
// Behind a proxy the failure is transport-level instead, so `p-retry` spends its 1s + 2s ladder and
// `daemon.start()` takes ~4s instead of ~40ms.
//
// Every method resolves empty rather than throwing: these suites assert routing and authorship
// decisions, and a rejection here would fail them for a reason that has nothing to do with Slack.
import type { SlackAppFactory } from '../../src/slack/connection.js'

/** `auth.test`'s answer. Suites that assert on the bot identity pass their own ids. */
export interface FakeSlackIdentity {
  userId?: string
  botId?: string
  teamId?: string
  url?: string
}

export function fakeSlackAppFactory(identity: FakeSlackIdentity = {}): SlackAppFactory {
  const ok = async (): Promise<Record<string, never>> => ({})
  return () =>
    ({
      message: () => {},
      event: () => {},
      action: () => {},
      shortcut: () => {},
      client: {
        views: { open: ok, update: ok },
        auth: {
          test: async () => ({
            user_id: identity.userId ?? 'U_FAKE_BOT',
            bot_id: identity.botId ?? 'B_FAKE_BOT',
            team_id: identity.teamId ?? 'T_FAKE_TEAM',
            url: identity.url ?? 'https://fake.slack.com/'
          })
        },
        chat: {
          postMessage: async () => ({ ts: '1700000000.000100' }),
          getPermalink: async () => ({ permalink: 'https://fake.slack.com/archives/C1/p1700000000000100' }),
          update: async () => ({ ts: '1700000000.000100' }),
          delete: ok
        },
        files: {
          getUploadURLExternal: async () => ({
            upload_url: 'https://files.slack.com/upload/v1/fake',
            file_id: 'F_FAKE'
          }),
          completeUploadExternal: async () => ({ files: [{ id: 'F_FAKE' }] }),
          uploadV2: async () => ({ ok: true, files: [{ ok: true, files: [{ id: 'F_FAKE' }] }] }),
          info: async () => ({ file: { shares: { public: { C1: [{ ts: '1700000000.000100' }] } } } })
        },
        conversations: {
          open: async () => ({ channel: { id: 'D_FAKE' } }),
          info: async () => ({ channel: { id: 'C1', name: 'fake' } }),
          members: async () => ({ members: [] }),
          leave: ok,
          list: async () => ({ channels: [] }),
          replies: async () => ({ messages: [] }),
          history: async () => ({ messages: [] })
        },
        users: {
          info: async () => ({}),
          conversations: async () => ({ channels: [] })
        },
        assistant: { threads: { setStatus: ok } },
        reactions: { add: ok },
        agents: { sessions: { setStatus: ok, rename: ok } }
      },
      start: async () => {},
      stop: async () => {}
    }) as ReturnType<SlackAppFactory>
}
