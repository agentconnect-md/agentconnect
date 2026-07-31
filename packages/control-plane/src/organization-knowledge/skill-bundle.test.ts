import { describe, expect, it } from 'vitest'
import { unzipSync } from 'fflate'
import { packageSkillBundle, SkillBundleValidationError } from './skill-bundle.js'

const manifest = `---
name: deploy-helper
description: Deploy the service safely.
---

# Deploy helper
`

describe('packageSkillBundle', () => {
  it('produces a deterministic official one-root .skill ZIP', () => {
    const files = [
      { path: 'scripts/deploy.sh', encoding: 'utf8' as const, content: '#!/bin/sh\necho deploy\n' },
      { path: 'SKILL.md', encoding: 'utf8' as const, content: manifest }
    ]
    const first = packageSkillBundle(files, 'deploy-helper')
    const second = packageSkillBundle([...files].reverse(), 'deploy-helper')

    expect(first.digest).toBe(second.digest)
    expect(first.manifest).toMatchObject({ name: 'deploy-helper', description: 'Deploy the service safely.' })
    expect(Object.keys(unzipSync(first.archive)).sort()).toEqual([
      'deploy-helper/SKILL.md',
      'deploy-helper/scripts/deploy.sh'
    ])
  })

  it('accepts canonical base64 assets', () => {
    const bundle = packageSkillBundle([
      { path: 'SKILL.md', encoding: 'utf8', content: manifest },
      { path: 'assets/pixel.bin', encoding: 'base64', content: Buffer.from([0, 1, 2, 255]).toString('base64') }
    ])
    expect(bundle.fileCount).toBe(2)
    expect(unzipSync(bundle.archive)['deploy-helper/assets/pixel.bin']).toEqual(new Uint8Array([0, 1, 2, 255]))
  })

  it.each(['../escape', '/absolute', 'scripts\\bad.sh', 'a/../../bad'])('rejects unsafe path %s', (path) => {
    expect(() =>
      packageSkillBundle([
        { path: 'SKILL.md', encoding: 'utf8', content: manifest },
        { path, encoding: 'utf8', content: 'bad' }
      ])
    ).toThrow(SkillBundleValidationError)
  })

  it('bounds paths by encoded bytes rather than JavaScript character count', () => {
    expect(() =>
      packageSkillBundle([
        { path: 'SKILL.md', encoding: 'utf8', content: manifest },
        { path: `assets/${'界'.repeat(90)}.txt`, encoding: 'utf8', content: 'too wide' }
      ])
    ).toThrow('unsafe skill file path')
  })

  it('requires SKILL.md name to match the suggested skill', () => {
    expect(() => packageSkillBundle([{ path: 'SKILL.md', encoding: 'utf8', content: manifest }], 'other')).toThrow(
      'SKILL.md name must match suggestion title'
    )
  })
})
