// @vitest-environment happy-dom
/**
 * Gitea's half of the review surface. One claim, both directions: Gitea's run
 * state is a COMMIT STATUS, so the status switch writes `status` — the mode the
 * Control Plane accepts for a Gitea repository — and a stored `status` value
 * reads back as the same Details tile a `check` value reads as on the other
 * hosts (gitea-integration.md §10.4).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodeHostReviewSettingsValue } from '@/lib/code-host-review-settings'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { GiteaReviewSettings } = await import('./GiteaReviewSettings')

let root: Root | undefined
let host: HTMLDivElement | undefined

const onReviewPolicyChange = vi.fn()
const onReportingModeChange = vi.fn()

async function render(value: CodeHostReviewSettingsValue, layout: 'disclosure' | 'format' = 'format') {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <GiteaReviewSettings
        value={value}
        onReviewPolicyChange={onReviewPolicyChange}
        onReportingModeChange={onReportingModeChange}
        layout={layout}
        defaultExpanded
      />
    )
  })
}

const formatTile = (id: string) => document.querySelector<HTMLButtonElement>(`[data-review-format="${id}"]`)
const statusCheckbox = () =>
  Array.from(document.querySelectorAll('label')).find((label) => label.textContent?.includes('Commit status'))
    ?.firstElementChild as HTMLInputElement | undefined
const presetNamed = (label: string) =>
  Array.from(document.querySelectorAll('button')).find((button) => button.textContent === label)

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  onReviewPolicyChange.mockClear()
  onReportingModeChange.mockClear()
})

describe('GiteaReviewSettings', () => {
  it('reads a stored commit-status value back as the Details tile', async () => {
    await render({ reviewPolicy: 'full', reportingMode: 'status' })
    expect(formatTile('details')?.getAttribute('aria-pressed')).toBe('true')
    expect(formatTile('custom')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('names the switch a commit status and writes that mode when it is turned on', async () => {
    await render({ reviewPolicy: 'off', reportingMode: 'off' })
    await act(async () => formatTile('custom')?.click())
    const box = statusCheckbox()
    expect(box).toBeDefined()
    expect(box?.checked).toBe(false)

    await act(async () => box?.click())
    // The one mode a Gitea repository accepts — a run note is refused there.
    expect(onReportingModeChange).toHaveBeenCalledWith('status')
    expect(onReportingModeChange).not.toHaveBeenCalledWith('check')
  })

  it('shows a stored commit status as the switch already on', async () => {
    await render({ reviewPolicy: 'off', reportingMode: 'status' })
    await act(async () => formatTile('custom')?.click())
    expect(statusCheckbox()?.checked).toBe(true)

    await act(async () => statusCheckbox()?.click())
    expect(onReportingModeChange).toHaveBeenCalledWith('off')
  })

  it('writes the commit status from the agent page’s Details preset too', async () => {
    await render({ reviewPolicy: 'off', reportingMode: 'off' }, 'disclosure')
    await act(async () => presetNamed('Details')?.click())
    expect(onReviewPolicyChange).toHaveBeenCalledWith('full')
    expect(onReportingModeChange).toHaveBeenCalledWith('status')
  })
})
