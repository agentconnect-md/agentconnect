import { describe, it, expect } from 'vitest'
import { resolveUserConfigAccessToken } from './slack-user-config.js'
import type { HttpDeps } from './deps.js'
import type { SlackUserConfigRecord, SlackUserConfigMaterial } from '../persistence/ports.js'
import type { SlackRotateResult } from './slack-config-api.js'
import { OrgId } from '../domain/ids.js'

const ORG = OrgId('org_test')
const USER = 'user_test'
const NOW = new Date('2026-01-01T00:00:00Z')

function row(expiresAt: Date, access = 'access'): SlackUserConfigRecord {
  return {
    orgId: ORG,
    userId: USER,
    accessToken: access,
    refreshToken: 'refresh',
    accessExpiresAt: expiresAt,
    updatedAt: NOW
  }
}
const fresh = (access?: string) => row(new Date(NOW.getTime() + 3600_000), access) // +1h ⇒ fresh
const stale = (access?: string) => row(new Date(NOW.getTime() + 60_000), access) // +1m ⇒ within margin ⇒ stale

/** Fake deps: `rows` are returned by successive get() calls; captures rotate calls + puts. */
function makeDeps(rows: (SlackUserConfigRecord | null)[], rotate: SlackRotateResult) {
  let i = 0
  const rotateCalls: string[] = []
  const puts: { userId: string; material: SlackUserConfigMaterial }[] = []
  const deps = {
    slackConfigApi: {
      async rotateConfigToken(r: string) {
        rotateCalls.push(r)
        return rotate
      }
    },
    repos: {
      slackUserConfig: {
        async get() {
          return rows[Math.min(i++, rows.length - 1)] ?? null
        },
        async put(_org: OrgId, userId: string, material: SlackUserConfigMaterial) {
          puts.push({ userId, material })
        }
      }
    }
  } as unknown as HttpDeps
  return { deps, rotateCalls, puts }
}

const okRotate: SlackRotateResult = {
  ok: true,
  rotated: {
    accessToken: 'rotated-access',
    refreshToken: 'rotated-refresh',
    accessExpiresAt: new Date(NOW.getTime() + 12 * 3600_000)
  }
}

describe('resolveUserConfigAccessToken', () => {
  it('is not_configured when the user has no stored token', async () => {
    const { deps, rotateCalls } = makeDeps([null], okRotate)
    expect(await resolveUserConfigAccessToken(deps, ORG, USER, NOW)).toEqual({ ok: false, reason: 'not_configured' })
    expect(rotateCalls).toHaveLength(0)
  })

  it('returns the stored access token as-is when it is still fresh (no rotate)', async () => {
    const { deps, rotateCalls, puts } = makeDeps([fresh('live')], okRotate)
    expect(await resolveUserConfigAccessToken(deps, ORG, USER, NOW)).toEqual({ ok: true, accessToken: 'live' })
    expect(rotateCalls).toHaveLength(0)
    expect(puts).toHaveLength(0)
  })

  it('rotates a stale token, persists the fresh pair for that user, and returns the new access token', async () => {
    const { deps, rotateCalls, puts } = makeDeps([stale()], okRotate)
    expect(await resolveUserConfigAccessToken(deps, ORG, USER, NOW)).toEqual({
      ok: true,
      accessToken: 'rotated-access'
    })
    expect(rotateCalls).toEqual(['refresh'])
    expect(puts).toEqual([{ userId: USER, material: okRotate.rotated }])
  })

  it('reports unreachable (does not persist) when the rotate cannot reach Slack', async () => {
    const { deps, puts } = makeDeps([stale()], { ok: false, error: 'unreachable' })
    expect(await resolveUserConfigAccessToken(deps, ORG, USER, NOW)).toEqual({ ok: false, reason: 'unreachable' })
    expect(puts).toHaveLength(0)
  })

  it('recovers when a concurrent install already rotated: rotate fails but the reloaded row is fresh', async () => {
    // 1st get ⇒ stale (drives a rotate attempt); rotate rejected (refresh spent);
    // 2nd get ⇒ fresh (the same user's other tab persisted a new pair) ⇒ use it.
    const { deps, puts } = makeDeps([stale(), fresh('concurrent')], { ok: false, error: 'invalid_refresh_token' })
    expect(await resolveUserConfigAccessToken(deps, ORG, USER, NOW)).toEqual({ ok: true, accessToken: 'concurrent' })
    expect(puts).toHaveLength(0)
  })

  it('is rotate_failed when the rotate is rejected and the reloaded row is still stale', async () => {
    const { deps } = makeDeps([stale(), stale()], { ok: false, error: 'invalid_refresh_token' })
    expect(await resolveUserConfigAccessToken(deps, ORG, USER, NOW)).toEqual({ ok: false, reason: 'rotate_failed' })
  })
})
