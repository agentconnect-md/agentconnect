import { describe, expect, it } from 'vitest'
import {
  MemoryStorePathError,
  memoryPathSegments,
  memoryStoreLeafPath,
  memoryStoreParent,
  memoryStorePath
} from './paths.js'

describe('memoryPathSegments', () => {
  it('splits plain components and folds empty and dot segments', () => {
    expect(memoryPathSegments('memory/./topics//deploys.md')).toEqual(['memory', 'topics', 'deploys.md'])
    expect(memoryPathSegments('')).toEqual([])
    expect(memoryPathSegments('.')).toEqual([])
    expect(memoryPathSegments('a\\b')).toEqual(['a', 'b'])
  })

  it('refuses what the daemon refuses: absolute paths, `..`, NUL', () => {
    for (const rel of ['/etc/passwd', '\\\\host\\share', 'C:\\memory', 'c:/memory', '../x', 'a/../../b', 'a\0b']) {
      expect(() => memoryPathSegments(rel)).toThrow(MemoryStorePathError)
    }
  })
})

describe('memoryStorePath', () => {
  it('joins the root and the relative path into one stored key', () => {
    expect(memoryStorePath('memory', 'MEMORY.md')).toBe('memory/MEMORY.md')
    expect(memoryStorePath('channels/x/memory', '')).toBe('channels/x/memory')
    expect(memoryStorePath('.', 'memory')).toBe('memory')
    expect(memoryStorePath('.', '')).toBe('')
  })

  it('applies the containment rules to the root too', () => {
    expect(() => memoryStorePath('/abs', 'x')).toThrow(MemoryStorePathError)
    expect(() => memoryStorePath('memory/..', 'x')).toThrow(MemoryStorePathError)
  })

  it('a leaf op refuses the tree root itself', () => {
    expect(memoryStoreLeafPath('memory', '')).toBe('memory')
    expect(() => memoryStoreLeafPath('.', '')).toThrow('a file name is required')
  })

  it('names a parent', () => {
    expect(memoryStoreParent('memory/topics/x.md')).toBe('memory/topics')
    expect(memoryStoreParent('x.md')).toBe('')
  })
})
