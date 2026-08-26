import { describe, expect, it } from 'vitest'
import { bootHost } from './acp-matrix/harness.js'
import { PROFILES } from './acp-matrix/profiles.js'

describe('evaluation permission-policy evidence', () => {
  it('reports the real fallback decision without letting observer failures or mutation change it', async () => {
    const profile = PROFILES.find(({ id }) => id === 'codex')!
    const handle = await bootHost(profile, {
      override: {
        prompt: {
          requestPermission: {
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
            ]
          }
        }
      },
      onPermissionEvent: (_sessionId, params, event) => {
        if (event.kind === 'requested') {
          const mutableOptions = params.options as unknown[]
          mutableOptions.splice(0)
        } else {
          const mutableResponse = event.response as { outcome: unknown }
          mutableResponse.outcome = { outcome: 'cancelled' }
        }
      }
    })

    try {
      const sessionId = await handle.host.newSession('/tmp')
      await handle.host.prompt(sessionId, [{ type: 'text', text: 'request permission' }])

      expect(handle.texts().some((text) => text.includes('"outcome":"selected"') && text.includes('"allow"'))).toBe(
        true
      )
      expect(handle.permissionEvents.map(({ event }) => event)).toEqual([
        { kind: 'requested' },
        {
          kind: 'resolved',
          source: 'fallback',
          fallbackReason: 'no_resolver',
          response: { outcome: { outcome: 'selected', optionId: 'allow' } }
        }
      ])
    } finally {
      await handle.stop()
    }
  })
})
