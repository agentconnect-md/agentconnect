// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GithubPrivateReposNotice,
  GithubRepositoryField,
  GithubRepositoryOption,
  RepositoryAccessField,
  WorkspaceModeField
} from './WorkspaceFormFields'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

async function render(element: ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(element))
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  delete window.__AC_ENV
})

describe('WorkspaceFormFields', () => {
  it('keeps missing private repositories informational and links to Profile', async () => {
    await render(<GithubPrivateReposNotice profileHref="/acme/profile#sign-in-methods" />)

    expect(container?.textContent).toContain('Public repositories are shown.')
    const link = container?.querySelector('a')
    expect(link?.textContent).toBe('Link your GitHub profile')
    expect(link?.getAttribute('href')).toBe('/acme/profile#sign-in-methods')
    expect(container?.querySelector('[class*="status-error"]')).toBeNull()
  })

  it('uses one workspace source picker for create and edit flows', async () => {
    window.__AC_ENV = { FEATURE_FLAGS: 'git-url' }
    const onChange = vi.fn()
    await render(<WorkspaceModeField value="scratch" onChange={onChange} />)

    // Both code hosts are always offered; a deployment that configures neither
    // says so in the pane the tile opens, never by dropping the tile. The fourth
    // tile clones any other Git server with no credential at all.
    const buttons = Array.from(container?.querySelectorAll('button') ?? [])
    expect(buttons.map((button) => button.textContent)).toEqual(['Scratch', 'GitHub', 'GitLab', 'Git URL'])
    // The tiles are compact chips, so each one's one-line description is its tooltip.
    expect(buttons.map((button) => button.getAttribute('title'))).toEqual([
      'Fresh empty directory.',
      'Clone a repo on a branch.',
      'Clone a project on a branch.',
      'Clone any Git server anonymously.'
    ])
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false'])
    // The accent style alone says which tile is on — no check glyph crowds the chip.
    expect(buttons[0]?.className).toContain('ptile on')
    expect(container?.innerHTML).not.toContain('lucide-check')

    await act(async () => buttons[1]?.click())
    expect(onChange).toHaveBeenCalledWith('github')
    await act(async () => buttons[2]?.click())
    expect(onChange).toHaveBeenCalledWith('gitlab')
    await act(async () => buttons[3]?.click())
    expect(onChange).toHaveBeenCalledWith('giturl')
  })

  it('offers the Git URL tile only where the git-url flag is on', async () => {
    window.__AC_ENV = {}
    await render(<WorkspaceModeField value="scratch" onChange={vi.fn()} />)

    const labels = Array.from(container?.querySelectorAll('button') ?? []).map((button) => button.textContent)
    expect(labels).toEqual(['Scratch', 'GitHub', 'GitLab'])
  })

  it('keeps the Git URL tile for a workspace already on one, flag or not', async () => {
    window.__AC_ENV = {}
    await render(<WorkspaceModeField value="giturl" onChange={vi.fn()} />)

    const buttons = Array.from(container?.querySelectorAll('button') ?? [])
    expect(buttons.map((button) => button.textContent)).toEqual(['Scratch', 'GitHub', 'GitLab', 'Git URL'])
    expect(buttons[3]?.getAttribute('aria-pressed')).toBe('true')
  })

  it('returns the shared repository access vocabulary', async () => {
    const onChange = vi.fn()
    await render(
      <RepositoryAccessField
        repositorySelected
        value="read"
        open
        onToggle={() => undefined}
        onClose={() => undefined}
        onChange={onChange}
      />
    )

    const writeButton = Array.from(container?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.startsWith('Read & write')
    )
    expect(writeButton?.textContent).toContain('Push, open PRs & run GitHub Actions')

    await act(async () => writeButton?.click())
    expect(onChange).toHaveBeenCalledWith('write')
  })

  it('keeps a portalled repository menu open while its list scrolls', async () => {
    const onClose = vi.fn()
    await render(
      <div className="modalbody">
        <GithubRepositoryField
          value="agentconnect-md/agentconnect"
          loading={false}
          open
          query=""
          onToggle={() => undefined}
          onClose={onClose}
          onQueryChange={() => undefined}
        >
          <GithubRepositoryOption
            fullName="agentconnect-md/agentconnect"
            description="Repository"
            onSelect={() => undefined}
          />
        </GithubRepositoryField>
      </div>
    )

    const menu = document.body.querySelector('.fmenu')
    await act(async () => menu?.dispatchEvent(new Event('scroll')))
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => container?.querySelector('.modalbody')?.dispatchEvent(new Event('scroll')))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
