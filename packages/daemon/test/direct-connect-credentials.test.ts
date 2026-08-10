import { describe, expect, it, vi } from 'vitest'
import { HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED } from '@agentconnect.md/protocol'
import { turnFailureCode } from '../src/acp/acp-host.js'
import { ClusterSpawnDriver, RUNTIME_GRANTS } from '../src/k8s/cluster-driver.js'
import { K8sApiError } from '../src/k8s/http.js'
import type { Sandbox, SandboxClaim } from '../src/k8s/sandbox-api.js'
import type { ShimConnection } from '../src/shim/listener.js'

/**
 * The direct-connect stage: the runtime reaches its provider itself, so provider credentials
 * travel the same paths they always did and only their DELIVERY changes.
 *
 * Two things must hold. Credential material must never reach a Kubernetes object — a claim
 * carrying env bypasses warm-pool adoption, and a pool pod is stamped from the template
 * before any user exists, so a template env value would be visible to whoever is adopted
 * next. And an upstream rejection must be explainable, or a user with an expired key sees
 * only "turn failed".
 */

const SECRET = 'sk-ant-not-a-real-key-000000'

function fakeApi() {
  const created: SandboxClaim[] = []
  return {
    created,
    api: {
      ensureClaim: async (claim: SandboxClaim & { metadata: { name: string } }) => {
        created.push(claim)
        return { ...claim, status: { sandbox: { name: 'sb-1' } } }
      },
      getClaim: async () => {
        const claim = created[0]
        if (!claim) throw new K8sApiError(404, 'NotFound', 'no claim')
        return { ...claim, status: { sandbox: { name: 'sb-1' } } }
      },
      deleteClaim: async () => {},
      getSandbox: async () =>
        ({
          metadata: { name: 'sb-1', uid: 'sandbox-uid-1' },
          spec: { operatingMode: 'Running' },
          status: { conditions: [{ type: 'Ready', status: 'True' }] }
        }) as Sandbox,
      setOperatingMode: async () => ({}) as Sandbox,
      watchClaims: vi.fn(),
      watchSandboxes: vi.fn(),
      reviewToken: vi.fn()
    }
  }
}

describe('provider credentials in the direct-connect stage', () => {
  it('never writes credential material into the Kubernetes claim', async () => {
    const { api, created } = fakeApi()
    const driver = new ClusterSpawnDriver({
      api: api as never,
      orgId: 'org-1',
      warmPoolName: 'pool',
      awaitChannel: async () => ({}) as ShimConnection,
      publishSpawnRecord: () => {},
      log: { info: () => {}, warn: () => {}, debug: () => {} }
    })
    await driver.ensureSandbox('agent-a')
    // The whole claim, serialized: a secret must not appear anywhere in it, not merely be
    // absent from the field we happened to check.
    const serialized = JSON.stringify(created)
    expect(serialized).not.toContain(SECRET)
    expect(serialized).not.toContain('ANTHROPIC_API_KEY')
    expect(serialized).not.toMatch(/"env"/)
    expect(serialized).not.toMatch(/volumeClaimTemplates/)
  })

  it('grants the runtime exactly the channels it needs and nothing else', () => {
    // Credentials arrive over the shim, so `materialize` is required; the set stays closed so
    // a future capability is an explicit decision rather than a side effect.
    expect([...RUNTIME_GRANTS].sort()).toEqual(['acp', 'exec', 'materialize', 'read', 'tunnel'])
  })

  it('classifies an upstream 401 as a credential problem, whatever the wording', () => {
    // A provider reached directly answers with a status, not prose. Before this, a numeric
    // status was skipped entirely and the user saw a bare "turn failed".
    expect(turnFailureCode({ status: 401, message: 'Unauthorized' })).toBe(HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED)
    expect(turnFailureCode({ data: { response: { statusCode: 403 } } })).toBe(HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED)
    expect(turnFailureCode({ cause: { http_status: 401 } })).toBe(HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED)
  })

  it('does not call a 429 quota exhaustion, because it is not', () => {
    // Rate limiting is transient. Reporting it as quota exhausted would tell someone their
    // plan ran out when it did not, which is worse than a generic failure.
    expect(turnFailureCode({ status: 429, message: 'Too Many Requests' })).toBe('turn_failed')
    // A message that genuinely says the quota is gone still classifies as quota.
    expect(turnFailureCode({ status: 429, message: "You've hit your usage limit" })).toBe('provider_quota_exhausted')
  })

  it('ignores a JSON-RPC code that happens to be numeric', () => {
    // -32603 must not be read as an HTTP status, and 500 is not an auth problem.
    expect(turnFailureCode({ code: -32603, message: 'Internal error' })).toBe('turn_failed')
    expect(turnFailureCode({ status: 500, message: 'Internal Server Error' })).toBe('turn_failed')
  })

  it('still recognises the message-shaped auth failures it always did', () => {
    expect(turnFailureCode(new Error('OAuth session expired and could not be refreshed'))).toBe(
      HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED
    )
  })
})
