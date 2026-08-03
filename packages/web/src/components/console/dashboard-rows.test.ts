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
    for (let rows = MIN_RIGHT_COLUMN_ROWS; rows <= 8; rows++) {
      const b = dashboardRowBudget({ availableHeight: heightFor(rows), ...FULL })

      expect(b.aligned).toBe(true)
      expect(leftHeight(b.sessionRows)).toBe(rightHeight(b.agentRows, b.cronRows))
      // …and never taller than the viewport it was measured against.
      expect(leftHeight(b.sessionRows)).toBeLessThanOrEqual(heightFor(rows))
    }
  })

  it('spends a taller viewport on extra Recent rows once the right column is content-exhausted', () => {
    // FULL's right column has nothing beyond the baseline caps, so a portrait
    // window pours the rest of its height into sessions instead of a dead strip.
    const b = dashboardRowBudget({ availableHeight: heightFor(30), ...FULL })

    expect(b).toMatchObject({ sessionRows: 20, agentRows: 4, cronRows: 3, aligned: false })
  })

  it('lifts the right-column caps toward real content on a taller viewport, keeping alignment', () => {
    const b = dashboardRowBudget({ availableHeight: heightFor(12), sessions: 20, agents: 10, crons: 8 })

    expect(b.aligned).toBe(true)
    expect(b.sessionRows).toBe(12)
    expect(b.agentRows + b.cronRows).toBe(11)
    expect(b.agentRows).toBeGreaterThan(MAX_AGENT_ROWS)
    expect(b.cronRows).toBeGreaterThan(MAX_CRON_ROWS)
    expect(leftHeight(b.sessionRows)).toBe(rightHeight(b.agentRows, b.cronRows))
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

  it('trims to meet a short session list on a roomy window', () => {
    // The viewport has room for 8 rows, but the card can only draw what exists, so
    // the right column comes down to meet it rather than towering over it.
    const rowsAt = (sessions: number) => {
      const b = dashboardRowBudget({ availableHeight: heightFor(8), ...FULL, sessions })
      return [b.agentRows, b.cronRows, b.sessionRows]
    }

    expect(rowsAt(8)).toEqual([4, 3, 8])
    expect(rowsAt(7)).toEqual([4, 2, 7])
    expect(rowsAt(5)).toEqual([2, 2, 5])
    expect(rowsAt(3)).toEqual([1, 1, 3])
  })

  it('squares up for every session count a trim can reach, on a roomy window', () => {
    for (let sessions = MIN_RIGHT_COLUMN_ROWS; sessions <= 8; sessions++) {
      const b = dashboardRowBudget({ availableHeight: heightFor(20), ...FULL, sessions })

      expect(b.aligned).toBe(true)
      expect(b.sessionRows).toBeLessThanOrEqual(sessions)
      expect(leftHeight(b.sessionRows)).toBe(rightHeight(b.agentRows, b.cronRows))
    }
  })

  it('refuses to shrink the right column for a session list it cannot meet — and still grows it', () => {
    // Two sessions can never reach the right column's two-card floor, so trimming
    // would cost this org two of its four agents and still not line up. The tall
    // window instead spends its height on the agents/schedules that DO exist.
    const b = dashboardRowBudget({ availableHeight: heightFor(10), sessions: 2, agents: 6, crons: 5 })

    expect(b).toMatchObject({ agentRows: 5, cronRows: 4, aligned: false })
    expect(b.agentRows).toBeGreaterThanOrEqual(MAX_AGENT_ROWS)
    expect(b.cronRows).toBeGreaterThanOrEqual(MAX_CRON_ROWS)
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

    it('counts an empty agent or schedule list as its placeholder row, spending the rest on Recent', () => {
      const b = dashboardRowBudget({ availableHeight: heightFor(8), sessions: 20, agents: 0, crons: 0 })

      // Nothing to grow on the right (two placeholder rows), so the height goes
      // to the sessions that DO exist rather than a dead strip.
      expect(b).toMatchObject({ sessionRows: 8, agentRows: 1, cronRows: 1, aligned: false })
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
