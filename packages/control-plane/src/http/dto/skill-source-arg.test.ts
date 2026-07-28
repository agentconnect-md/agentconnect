/**
 * `SkillSourceArg` acceptance (docs/designs/shared-skills.md).
 *
 * A skill source is org metadata: it travels inline on every referring AgentSpec
 * and `GET /agents/:id/skill-sources` shows it to anyone who can view an agent
 * that enables it, ACROSS the source's own sharing. That only holds if the string
 * cannot carry a secret, so the schema — not a convention — enforces it.
 */
import { describe, it, expect } from 'vitest'
import { CreateSkillSourceBody } from './index.js'

const accepts = (source: string) => CreateSkillSourceBody.safeParse({ name: 'kit', source }).success

describe('SkillSourceArg', () => {
  it('rejects every place a credential can hide in a source string', () => {
    for (const bad of [
      'https://user:pw@git.example.test/ops/skills.git', // userinfo password
      'https://ghp_tokenlike@github.com/example-org/kit', // token AS the username
      'https://user:p@ss@git.example.test/ops/skills.git', // password containing "@"
      'https://git.example.test/ops/skills.git?access_token=tokenlike', // query
      'https://git.example.test/ops/skills.git#tokenlike', // fragment
      'https://good.example\\user:token@127.0.0.1/repo', // backslash authority ambiguity
      '--flag-not-a-source' // pre-existing guard: never an npx option
    ]) {
      expect({ bad, accepted: accepts(bad) }).toEqual({ bad, accepted: false })
    }
  })

  it('still accepts every credential-free form the CLI takes', () => {
    for (const good of [
      'example-org/example-ai-kit', // shorthand
      'git@github.com:example-org/example-kit.git', // scp-like: no "://", no userinfo
      'ssh://git@git.example.test/ops/skills.git', // "git" is a role, not a secret
      'https://github.com/example-org/kit/tree/main/skills' // ref + subdir form
    ]) {
      expect({ good, accepted: accepts(good) }).toEqual({ good, accepted: true })
    }
  })
})
