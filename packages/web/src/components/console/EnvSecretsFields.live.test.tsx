// @vitest-environment happy-dom
// An agent's live secrets show in its secrets editor by name and purpose, marked Live, never with a value (capability-requests.md §4.9.2).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { EnvSecretsFields } from './EnvSecretsFields'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | undefined
let host: HTMLDivElement | undefined

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

async function render(liveSecrets?: { name: string; description: string | null }[]): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root!.render(
      <EnvSecretsFields
        envRows={[]}
        setEnvRows={() => {}}
        secretRows={[]}
        setSecretRows={() => {}}
        {...(liveSecrets ? { liveSecrets } : {})}
      />
    )
  )
  return host
}

describe('live secrets in the secrets editor', () => {
  it('lists each by name with a Live marker and its purpose, read-only', async () => {
    const scope = await render([
      { name: 'GRAFANA_TOKEN', description: 'Grafana API token' },
      { name: 'KUBECONFIG_DATA', description: null }
    ])
    const group = scope.querySelector('[data-live-secrets]')!
    expect(group.textContent).toContain('GRAFANA_TOKEN')
    expect(group.textContent).toContain('Grafana API token')
    expect(group.textContent).toContain('KUBECONFIG_DATA')
    expect([...group.querySelectorAll('.badge')].map((b) => b.textContent)).toEqual(['Live', 'Live'])
    expect(group.querySelector('input, textarea, button')).toBeNull()
  })

  it('shows no group for an agent without any', async () => {
    expect((await render()).querySelector('[data-live-secrets]')).toBeNull()
  })
})
