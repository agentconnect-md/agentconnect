import { describe, expect, it } from 'vitest'
import { giteaProductOf } from './gitea-product'

describe('giteaProductOf', () => {
  it('reads the product a connection observed, and Gitea before any has', () => {
    expect(giteaProductOf([])).toBe('gitea')
    expect(giteaProductOf([{ instanceProduct: 'gitea', instanceVersion: null }])).toBe('gitea')
    expect(giteaProductOf([{ instanceProduct: 'forgejo', instanceVersion: '15.0.9+gitea-1.22.0' }])).toBe('forgejo')
  })
})
