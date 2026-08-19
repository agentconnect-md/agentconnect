// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceRepoPicker, resolveWorkspaceRepoScope, workspaceRepoParamRewrite } from './WorkspaceRepoPicker'
import type { AgentRepoAuthDto } from '@/lib/api'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function grant(repoFullName: string, access: AgentRepoAuthDto['access'] = 'write'): AgentRepoAuthDto {
  return { id: `grant-${repoFullName}`, repoFullName, access, createdBy: null, createdAt: '2026-08-01T00:00:00.000Z' }
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

async function render(node: React.ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(node))
}

// The menu is body-portaled (the breadcrumb it sits in clips its overflow), so it is not under `container`.
const choices = () => Array.from(document.body.querySelectorAll<HTMLButtonElement>('[data-repo-choice]'))

describe('resolveWorkspaceRepoScope', () => {
  it('keeps the parameter while the grants are still loading, so a cold visit lands on the right root', () => {
    expect(resolveWorkspaceRepoScope('acme/infra', undefined)).toBe('acme/infra')
  })

  it('answers with the grant’s own casing, so the URL and the menu agree on one spelling', () => {
    expect(resolveWorkspaceRepoScope('ACME/Infra', [grant('acme/infra')])).toBe('acme/infra')
  })

  it('falls back to the workspace for a link that outlived its grant', () => {
    expect(resolveWorkspaceRepoScope('acme/revoked', [grant('acme/infra')])).toBeNull()
    expect(resolveWorkspaceRepoScope('acme/anything', [])).toBeNull()
  })

  it('treats a blank parameter as the workspace', () => {
    expect(resolveWorkspaceRepoScope(null, [grant('acme/infra')])).toBeNull()
    expect(resolveWorkspaceRepoScope('   ', [grant('acme/infra')])).toBeNull()
  })
})

describe('workspaceRepoParamRewrite', () => {
  it('leaves the URL alone while the grants are still loading, and when it already agrees', () => {
    expect(workspaceRepoParamRewrite('acme/infra', 'acme/infra', undefined)).toBeUndefined()
    expect(workspaceRepoParamRewrite('acme/infra', 'acme/infra', [grant('acme/infra')])).toBeUndefined()
    expect(workspaceRepoParamRewrite(null, null, [grant('acme/infra')])).toBeUndefined()
  })

  it('canonicalizes a link written in another casing, so the URL matches the picker', () => {
    expect(workspaceRepoParamRewrite('ACME/Infra', 'acme/infra', [grant('acme/infra')])).toBe('acme/infra')
  })

  it('drops a link whose grant is gone, so a cold load stops retrying the dead scope', () => {
    expect(workspaceRepoParamRewrite('acme/revoked', null, [grant('acme/infra')])).toBeNull()
    expect(workspaceRepoParamRewrite('acme/anything', null, [])).toBeNull()
  })
})

describe('WorkspaceRepoPicker', () => {
  it('lists the workspace first, then every authorized repository with its access tier', async () => {
    await render(
      <WorkspaceRepoPicker
        primaryLabel="acme/primary-service"
        primaryIsRepo
        repos={[grant('acme/infra'), grant('example-co/shared-library', 'read')]}
        selectedRepo={null}
        onChange={vi.fn()}
      />
    )
    await act(async () => container?.querySelector('button')?.click())

    expect(choices().map((choice) => choice.textContent)).toEqual([
      'acme/primary-serviceworkspace',
      'acme/infrawrite',
      'example-co/shared-libraryread'
    ])
    // The workspace is the selected root until a repository is picked.
    expect(choices()[0]?.getAttribute('aria-checked')).toBe('true')
  })

  it('names the scratch workspace first when there is no repository behind it', async () => {
    await render(
      <WorkspaceRepoPicker
        primaryLabel="Scratch workspace"
        primaryIsRepo={false}
        repos={[grant('acme/infra')]}
        selectedRepo="acme/infra"
        onChange={vi.fn()}
      />
    )
    await act(async () => container?.querySelector('button')?.click())

    expect(choices()[0]?.textContent).toBe('Scratch workspaceworkspace')
    expect(choices()[1]?.getAttribute('aria-checked')).toBe('true')
    // The trigger names the root being browsed, not the workspace behind it.
    expect(container?.querySelector('button')?.textContent).toContain('acme/infra')
  })

  it('reports the picked repository and closes, and reports null for the workspace', async () => {
    const onChange = vi.fn()
    await render(
      <WorkspaceRepoPicker
        primaryLabel="acme/primary-service"
        primaryIsRepo
        repos={[grant('acme/infra')]}
        selectedRepo={null}
        onChange={onChange}
      />
    )
    await act(async () => container?.querySelector('button')?.click())
    await act(async () => choices()[1]?.click())
    expect(onChange).toHaveBeenCalledWith('acme/infra')
    expect(choices()).toHaveLength(0)

    await act(async () => container?.querySelector('button')?.click())
    await act(async () => choices()[0]?.click())
    expect(onChange).toHaveBeenLastCalledWith(null)
  })
})
