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
    // Launch with a real secret in the runtime env, so the assertion below is about a value
    // that was actually present to leak rather than one that never existed.
    await driver
      .launch({ command: 'runtime', args: [], env: { AC_AGENT_ID: 'agent-a', ANTHROPIC_API_KEY: SECRET } })
      .catch(() => undefined)
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

  it('classifies a provider auth rejection by the type the provider itself sends', () => {
    // Anthropic and OpenAI both send a typed code; that identifies the provider, which an
    // HTTP number does not.
    expect(turnFailureCode({ error: { type: 'authentication_error', message: 'invalid x-api-key' } })).toBe(
      HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED
    )
    expect(turnFailureCode({ data: { error: { code: 'invalid_api_key' } } })).toBe(
      HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED
    )
    expect(turnFailureCode(new Error('Incorrect API key provided: sk-***'))).toBe(
      HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED
    )
  })

  it('does NOT treat an unrelated 403 as a provider credential problem', () => {
    // The defect an earlier revision of this PR introduced. K8sApiError carries a numeric
    // status, and turnFailureCode sees failures from far beyond the model call — so matching
    // on 401/403 told users their provider key was bad when Kubernetes RBAC had denied a
    // claim. A status belongs to whichever layer produced it, so it is not evidence.
    const rbacDenial = new K8sApiError(403, 'Forbidden', 'sandboxclaims is forbidden: cannot create')
    expect(turnFailureCode(rbacDenial)).toBe('turn_failed')
    expect(turnFailureCode({ status: 401, message: 'Unauthorized' })).toBe('turn_failed')
    expect(turnFailureCode({ data: { response: { statusCode: 403 } } })).toBe('turn_failed')
  })

  it('survives a hostile getter while classifying, keeping the original failure', () => {
    // The classifier runs while handling someone else's error; throwing from it would replace
    // the failure a user needs to see with one about our own traversal.
    const hostile = new Error('the original failure')
    Object.defineProperty(hostile, 'message', {
      get() {
        throw new Error('getter exploded')
      }
    })
    Object.defineProperty(hostile, 'data', {
      get() {
        throw new Error('getter exploded')
      }
    })
    expect(() => turnFailureCode(hostile)).not.toThrow()
    expect(turnFailureCode(hostile)).toBe('turn_failed')
  })

  it('still recognises the message-shaped auth failures it always did', () => {
    expect(turnFailureCode(new Error('OAuth session expired and could not be refreshed'))).toBe(
      HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED
    )
  })
})
