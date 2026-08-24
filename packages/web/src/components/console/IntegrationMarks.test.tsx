// @vitest-environment happy-dom
/**
 * The Agents list integration cluster.
 *
 * Two properties, both found wanting in live testing. The hook-kind marks carried a
 * hover title ("GitLab events") that no other mark in this cluster has, so one icon in
 * a row of otherwise silent icons popped a tooltip. And the mark itself was picked by a
 * chain of equality tests ending in the generic webhook glyph, so an unmapped code host
 * would render as a webhook — the same shape of bug that hid GitLab elsewhere.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOOK_KINDS } from '@agentconnect.md/protocol'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// Real marks are anonymous <svg> paths; these stubs name which one rendered.
vi.mock('@/components/marks', () => ({
  GithubMark: () => <span data-mark="github" />,
  GitlabMark: () => <span data-mark="gitlab" />,
  PlatformMark: ({ platform }: { platform: string }) => <span data-mark={platform} />
}))

const { IntegrationMarks } = await import('./IntegrationMarks')

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render(node: React.ReactNode) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(node)
  })
  return host
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

describe('IntegrationMarks', () => {
  it('gives every hook kind its own mark', async () => {
    // Walk the whole vocabulary: a new code host must not reuse the webhook glyph.
    for (const kind of HOOK_KINDS) {
      const node = await render(<IntegrationMarks integrations={[]} hookKinds={[kind]} />)
      expect(node.querySelector(`[data-mark="${kind}"]`)).not.toBeNull()
      if (root) await act(async () => root?.unmount())
      host?.remove()
    }
  })

  it('shows no hover title on any mark, hook kinds included', async () => {
    const node = await render(
      <IntegrationMarks integrations={[{ id: 'i1', platform: 'slack' }]} hookKinds={[...HOOK_KINDS]} />
    )

    expect(node.querySelectorAll('[title]')).toHaveLength(0)
    // The cluster still rendered — an empty tree would pass the assertion above.
    // Three marks fit; the platform sits first and the hook kinds fill the rest.
    expect(node.querySelector('[data-mark="slack"]')).not.toBeNull()
    expect(node.querySelectorAll('[data-mark]')).toHaveLength(3)
  })
})
