// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ listMemoryFileHistory: vi.fn() }))

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      readonly status = 500
    ) {
      super(message)
    }
  },
  listMemoryFileHistory: mocks.listMemoryFileHistory
}))

import { ManagedMemoryHistory } from './ManagedMemoryHistory'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

beforeEach(() => {
  mocks.listMemoryFileHistory.mockReset()
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container?.querySelectorAll('button') ?? []).find((candidate) =>
    candidate.textContent?.includes(label)
  )
}

describe('ManagedMemoryHistory', () => {
  it('loads lazily, exposes expandable snapshots, and pages older changes', async () => {
    const nextCursor = '11111111-1111-4111-8111-111111111111'
    mocks.listMemoryFileHistory
      .mockResolvedValueOnce({
        events: [
          {
            path: 'notes.md',
            event: 'update',
            before: 'shared line\nold value\n',
            after: 'shared line\nnew value\n',
            at: '2026-07-26T10:00:00.000Z',
            scope: 'agent',
            source: 'dream'
          },
          {
            path: 'notes.md',
            event: 'add',
            after: 'version one',
            at: '2026-07-26T09:00:00.000Z',
            scope: 'agent',
            source: 'tool'
          }
        ],
        nextCursor
      })
      .mockResolvedValueOnce({
        events: [
          {
            path: 'notes.md',
            event: 'update',
            before: 'draft',
            after: 'version one',
            at: '2026-07-25T10:00:00.000Z',
            scope: 'agent',
            source: 'distill',
            truncated: true
          }
        ],
        nextCursor: null
      })

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<ManagedMemoryHistory agentId="agent-1" path="notes.md" />)
    })

    expect(mocks.listMemoryFileHistory).not.toHaveBeenCalled()
    const disclosure = button('Change history')
    expect(disclosure?.getAttribute('aria-expanded')).toBe('false')

    await act(async () => disclosure?.click())

    expect(disclosure?.getAttribute('aria-expanded')).toBe('true')
    expect(mocks.listMemoryFileHistory).toHaveBeenNthCalledWith(1, 'agent-1', 'notes.md', { limit: 5 })
    expect(container.querySelectorAll('details')).toHaveLength(2)
    expect(container.textContent).toContain('Line changes')
    expect(container.textContent).toContain('Dream adoption')
    const firstEvent = container.querySelector('details')
    expect(
      Array.from(firstEvent?.querySelectorAll('[data-diff-kind]') ?? []).map((row) =>
        row.getAttribute('data-diff-kind')
      )
    ).toEqual(['context', 'delete', 'add'])
    expect(firstEvent?.textContent).toContain('old value')
    expect(firstEvent?.textContent).toContain('new value')

    await act(async () => button('Load older changes')?.click())

    expect(mocks.listMemoryFileHistory).toHaveBeenNthCalledWith(2, 'agent-1', 'notes.md', {
      cursor: nextCursor,
      limit: 5
    })
    expect(container.querySelectorAll('details')).toHaveLength(3)
    expect(container.textContent).toContain('Automatic distillation')
    expect(container.textContent).toContain('Long snapshots were shortened')
  })

  it('shows an empty state without eagerly reopening on collapse', async () => {
    mocks.listMemoryFileHistory.mockResolvedValue({ events: [], nextCursor: null })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<ManagedMemoryHistory agentId="agent-1" path="MEMORY.md" />)
    })

    const disclosure = button('Change history')
    await act(async () => disclosure?.click())
    expect(container.textContent).toContain('No recorded changes for this file yet.')
    await act(async () => disclosure?.click())
    await act(async () => disclosure?.click())
    expect(mocks.listMemoryFileHistory).toHaveBeenCalledTimes(1)
  })

  it('explains legacy update rows that have no before snapshot', async () => {
    mocks.listMemoryFileHistory.mockResolvedValue({
      events: [
        {
          path: 'MEMORY.md',
          event: 'update',
          after: '# Adopted memory\n',
          at: '2026-07-26T09:00:00.000Z',
          scope: 'agent',
          source: 'dream'
        }
      ],
      nextCursor: null
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<ManagedMemoryHistory agentId="agent-1" path="MEMORY.md" />)
    })

    await act(async () => button('Change history')?.click())

    expect(container.textContent).toContain('The before snapshot was not recorded for this older change.')
    expect(container.textContent).toContain('# Adopted memory')
  })
})
