import { describe, expect, it } from 'vitest'
import {
  CARD_CHROME_H,
  CARD_GAP_H,
  DASH_ROW_H,
  dashboardRowBudget,
  MAX_AGENT_ROWS,
  MAX_CRON_ROWS,
  MIN_RIGHT_COLUMN_ROWS
} from './dashboard-rows'

/** What the browser will lay out, in px, for a given budget. */
const leftHeight = (rows: number) => CARD_CHROME_H + rows * DASH_ROW_H
const rightHeight = (agentRows: number, cronRows: number) =>
  CARD_CHROME_H + agentRows * DASH_ROW_H + CARD_GAP_H + (CARD_CHROME_H + cronRows * DASH_ROW_H)

/** Leftover viewport height that holds exactly `rows` whole left-card rows. */
const heightFor = (rows: number) => CARD_CHROME_H + rows * DASH_ROW_H

const FULL = { sessions: 20, agents: MAX_AGENT_ROWS, crons: MAX_CRON_ROWS }

describe('dashboardRowBudget', () => {
  it('lands both columns on the same line whenever the data can reach it', () => {
    // Every viewport from "right column at its floor" up to the content ceiling.
    for (let rows = MIN_RIGHT_COLUMN_ROWS; rows <= 12; rows++) {
      const b = dashboardRowBudget({ availableHeight: heightFor(rows), ...FULL })

      expect(b.aligned).toBe(true)
      expect(leftHeight(b.sessionRows)).toBe(rightHeight(b.agentRows, b.cronRows))
      // …and never taller than the viewport it was measured against.
      expect(leftHeight(b.sessionRows)).toBeLessThanOrEqual(heightFor(rows))
    }
  })

  it('spends a roomy viewport on the full content, not on stretch', () => {
    const b = dashboardRowBudget({ availableHeight: heightFor(30), ...FULL })

    expect(b).toMatchObject({ sessionRows: 8, agentRows: 4, cronRows: 3, aligned: true })
  })

  it('thins both right-hand cards as the window tightens, schedules first', () => {
    const rowsAt = (rows: number) => {
      const b = dashboardRowBudget({ availableHeight: heightFor(rows), ...FULL })
      return [b.agentRows, b.cronRows, b.sessionRows]
    }

    expect(rowsAt(8)).toEqual([4, 3, 8])
    expect(rowsAt(7)).toEqual([4, 2, 7]) // a schedule goes first
    expect(rowsAt(6)).toEqual([3, 2, 6]) // then an agent, rather than a second schedule
    expect(rowsAt(5)).toEqual([2, 2, 5])
    expect(rowsAt(4)).toEqual([2, 1, 4]) // only now does either list reach one row
    expect(rowsAt(3)).toEqual([1, 1, 3])
  })

  it('refuses to shrink the right column to match a thin session list', () => {
    // A quiet org on a full-height window still gets all four agents and three
    // schedules — trimming them would chase an alignment the left card can't reach.
    const b = dashboardRowBudget({ availableHeight: heightFor(10), sessions: 2, agents: 6, crons: 5 })

    expect(b).toMatchObject({ agentRows: MAX_AGENT_ROWS, cronRows: MAX_CRON_ROWS })
  })

  describe('sparse orgs — fewer sessions than the right column can go', () => {
    // The right column floors at one agent row + one schedule row, which is
    // MIN_RIGHT_COLUMN_ROWS left rows. Nothing shorter can square up, so the budget
    // reports it instead of pretending.
    it.each([0, 1, 2])('reports %i sessions as unaligned', (sessions) => {
      const b = dashboardRowBudget({ availableHeight: heightFor(8), sessions, agents: 4, crons: 3 })

      expect(b.aligned).toBe(false)
      // The card renders what it has; Home keeps it at that natural height.
      expect(leftHeight(Math.max(1, sessions))).toBeLessThan(rightHeight(b.agentRows, b.cronRows))
    })

    it('squares up again at the first session count that can', () => {
      const b = dashboardRowBudget({
        availableHeight: heightFor(MIN_RIGHT_COLUMN_ROWS),
        sessions: MIN_RIGHT_COLUMN_ROWS,
        agents: 4,
        crons: 3
      })

      expect(b).toMatchObject({ sessionRows: MIN_RIGHT_COLUMN_ROWS, aligned: true })
      expect(leftHeight(b.sessionRows)).toBe(rightHeight(b.agentRows, b.cronRows))
    })

    it('counts an empty agent or schedule list as its placeholder row', () => {
      const b = dashboardRowBudget({ availableHeight: heightFor(8), sessions: 20, agents: 0, crons: 0 })

      expect(b).toMatchObject({ sessionRows: 3, agentRows: 1, cronRows: 1, aligned: true })
      expect(leftHeight(b.sessionRows)).toBe(rightHeight(b.agentRows, b.cronRows))
    })
  })

  it('starts at the content ceiling before the viewport has been measured', () => {
    // First paint / no scroll container: no cap, so the cards open at their maximum
    // and only shrink once a real height arrives.
    const b = dashboardRowBudget({ availableHeight: null, ...FULL })

    expect(b).toMatchObject({ sessionRows: 8, agentRows: 4, cronRows: 3 })
  })

  it('never goes below the right column floor, however short the window', () => {
    const b = dashboardRowBudget({ availableHeight: 1, ...FULL })

    expect(b).toMatchObject({ sessionRows: MIN_RIGHT_COLUMN_ROWS, agentRows: 1, cronRows: 1 })
  })
})
