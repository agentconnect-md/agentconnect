/** The teardown skeletons' release step: a freed bot goes only when its platform gives it up (google-chat-integration.md §10.5). */
import { describe, expect, it, vi } from 'vitest'
import type { HttpDeps } from './deps.js'
import type { BotRecord } from '../persistence/ports.js'
import { BotId, OrgId } from '../domain/ids.js'
import { releaseFreedBot } from './uninstall.js'

const ORG = OrgId('11111111-1111-4111-8111-111111111111')
const BOT = BotId('88888888-8888-4888-8888-888888888888')
const log = { debug: () => {}, warn: () => {} }

function rig(opts: { releases?: boolean; installs?: number; onBotDelete?: () => Promise<void> } = {}) {
  const deleted: BotId[] = []
  const deps = {
    platforms: {
      get: () => ({
        ...(opts.releases === undefined ? {} : { releasesFreedBot: () => opts.releases }),
        ...(opts.onBotDelete ? { sideEffects: { onBotDelete: opts.onBotDelete } } : {})
      })
    },
    repos: {
      integration: { listForBot: async () => Array.from({ length: opts.installs ?? 0 }, () => ({})) },
      bot: {
        delete: async (_org: OrgId, id: BotId) => {
          deleted.push(id)
        }
      },
      botSecret: { get: async () => null }
    }
  } as unknown as HttpDeps
  const bot = { id: BOT, orgId: ORG, platform: 'googlechat' } as BotRecord
  return { deps, bot, deleted }
}

describe('releaseFreedBot', () => {
  it('deletes a freed bot its platform releases and runs the declared delete side effect', async () => {
    const onBotDelete = vi.fn(async () => {})
    const { deps, bot, deleted } = rig({ releases: true, onBotDelete })
    expect(await releaseFreedBot(deps, log, ORG, bot)).toBe(true)
    expect(deleted).toEqual([BOT])
    expect(onBotDelete).toHaveBeenCalledOnce()
  })

  it('keeps a bot its platform does not release, one still installed, and one of a platform that says nothing', async () => {
    for (const opts of [{ releases: false }, { releases: true, installs: 1 }, {}]) {
      const { deps, bot, deleted } = rig(opts)
      expect(await releaseFreedBot(deps, log, ORG, bot)).toBe(false)
      expect(deleted).toEqual([])
    }
  })
})
