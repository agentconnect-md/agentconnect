import { describe, expect, it } from 'vitest'
import {
  appendCoordinate,
  appendCoordinateTs,
  isAppendCoordinate,
  nextAppendCoordinate
} from '../src/session/append-coordinate.js'

describe('append coordinate', () => {
  it('round-trips its mint time', () => {
    expect(appendCoordinateTs(appendCoordinate(1700000000000))).toBe(1700000000000)
  })

  // The shape has to be unmistakable, because it shares a field with platform thread ids.
  it('is distinguishable from every platform thread id', () => {
    for (const real of ['1700000000.123456', '1234567890123456789', 'tg:42', 'dm', 'C1', ''])
      expect(isAppendCoordinate(real)).toBe(false)
    expect(isAppendCoordinate(undefined)).toBe(false)
    expect(isAppendCoordinate('append:1')).toBe(true)
  })

  it('reads a malformed payload as no coordinate rather than as zero', () => {
    for (const bad of ['append:', 'append:abc', 'append:-1', 'append:1.5'])
      expect(appendCoordinateTs(bad)).toBeUndefined()
  })

  it('mints from the clock when there is nothing in force', () => {
    expect(nextAppendCoordinate(undefined, 1000)).toBe('append:1000')
  })

  // A clock moved backwards must not mint below the coordinate in force: the rotation
  // would report success while every later message still resolved to the old coordinate.
  it('mints above the coordinate in force even when the clock went backwards', () => {
    expect(nextAppendCoordinate('append:5000', 1000)).toBe('append:5001')
    expect(nextAppendCoordinate('append:5000', 9000)).toBe('append:9000')
  })

  it('falls back to the clock when the coordinate in force is malformed', () => {
    expect(nextAppendCoordinate('append:nonsense', 1000)).toBe('append:1000')
  })
})
