/**
 * gh wrapper target-repo resolution (multi-repo authorization, #457).
 *
 * The regression that motivated the resolver: in a cross-repo review session the cwd is
 * an empty directory, so `gh api repos/acme/infra/…` and `gh pr view <url>` used to fall
 * all the way through to the WORKSPACE token and 404 on the repo they name outright.
 */
import { describe, expect, it, vi } from 'vitest'
import { resolveGhTargetRepo } from '../../src/cp/gh-target.js'

const noCwd = () => undefined
const argv = (line: string) => line.split(' ')

describe('resolveGhTargetRepo — the -R/--repo flag', () => {
  it('accepts all four spellings', () => {
    expect(resolveGhTargetRepo(argv('pr view 1 -R acme/infra'), {}, noCwd)).toEqual({ repo: 'acme/infra' })
    expect(resolveGhTargetRepo(argv('pr view 1 -Racme/infra'), {}, noCwd)).toEqual({ repo: 'acme/infra' })
    expect(resolveGhTargetRepo(argv('pr view 1 -R=acme/infra'), {}, noCwd)).toEqual({ repo: 'acme/infra' })
    expect(resolveGhTargetRepo(argv('pr view 1 --repo=acme/infra'), {}, noCwd)).toEqual({ repo: 'acme/infra' })
    expect(resolveGhTargetRepo(argv('pr view 1 --repo acme/infra'), {}, noCwd)).toEqual({ repo: 'acme/infra' })
  })

  it('takes the last one, matching gh pflag', () => {
    expect(resolveGhTargetRepo(argv('pr list -R acme/infra -R example-co/shared-library'), {}, noCwd)).toEqual({
      repo: 'example-co/shared-library'
    })
  })

  it('defers on a non-github host so the wrapper runs the real gh untouched', () => {
    expect(resolveGhTargetRepo(argv('pr view 1 -R gitlab.com/acme/infra'), {}, noCwd)).toEqual({ defer: true })
  })
})

describe('resolveGhTargetRepo — the target the command already carries', () => {
  it('reads the gh repo positional after value flags', () => {
    expect(resolveGhTargetRepo(argv('repo view --json nameWithOwner acme/infra'), {}, noCwd)).toEqual({
      repo: 'acme/infra'
    })
  })

  it('reads the repo out of a gh api endpoint path', () => {
    expect(resolveGhTargetRepo(argv('api repos/acme/infra/pulls/1'), {}, noCwd)).toEqual({ repo: 'acme/infra' })
    expect(resolveGhTargetRepo(argv('api -X GET repos/acme/infra'), {}, noCwd)).toEqual({ repo: 'acme/infra' })
    expect(resolveGhTargetRepo(argv('api --paginate repos/acme/infra/pulls/1/files'), {}, noCwd)).toEqual({
      repo: 'acme/infra'
    })
    expect(resolveGhTargetRepo(argv('api /repos/acme/infra'), {}, noCwd)).toEqual({ repo: 'acme/infra' })
    expect(resolveGhTargetRepo(argv('api https://api.github.com/repos/acme/infra'), {}, noCwd)).toEqual({
      repo: 'acme/infra'
    })
  })

  it('defers when the api endpoint is a full URL on another host', () => {
    expect(resolveGhTargetRepo(argv('api https://gitlab.example.test/x'), {}, noCwd)).toEqual({ defer: true })
  })

  it("leaves gh's own {owner}/{repo} placeholders and graphql to the later layers", () => {
    const env = { GH_REPO: 'example-co/shared-library' }
    expect(resolveGhTargetRepo(argv('api repos/{owner}/{repo}/pulls'), env, noCwd)).toEqual({
      repo: 'example-co/shared-library'
    })
    expect(resolveGhTargetRepo(['api', 'graphql', '-f', 'query=query{viewer{login}}'], env, noCwd)).toEqual({
      repo: 'example-co/shared-library'
    })
  })

  it('reads the repo out of a pull-request or issue URL', () => {
    expect(resolveGhTargetRepo(argv('pr view https://github.com/acme/infra/pull/7'), {}, noCwd)).toEqual({
      repo: 'acme/infra'
    })
    expect(resolveGhTargetRepo(argv('issue view https://github.com/acme/infra/issues/7'), {}, noCwd)).toEqual({
      repo: 'acme/infra'
    })
    expect(resolveGhTargetRepo(argv('pr view -w https://github.com/acme/infra/pull/7'), {}, noCwd)).toEqual({
      repo: 'acme/infra'
    })
  })

  it('ignores a URL that is a body or title value rather than the selector', () => {
    const env = { GH_REPO: 'example-co/shared-library' }
    const linked = 'https://github.com/acme/infra/pull/7'
    expect(resolveGhTargetRepo(['issue', 'comment', '5', '--body', linked], env, noCwd)).toEqual({
      repo: 'example-co/shared-library'
    })
    expect(resolveGhTargetRepo(['pr', 'create', '-t', linked, '--fill'], env, noCwd)).toEqual({
      repo: 'example-co/shared-library'
    })
  })

  it('leaves a repo that does not exist yet alone', () => {
    expect(resolveGhTargetRepo(argv('repo create acme/new-thing --private'), {}, noCwd)).toEqual({})
  })
})

describe('resolveGhTargetRepo — precedence', () => {
  it('runs flag over command over GH_REPO over the cwd remote', () => {
    const url = 'https://github.com/acme/infra/pull/7'
    const env = { GH_REPO: 'example-co/shared-library' }
    const cwd = () => 'https://github.com/example-co/checkout.git'
    expect(resolveGhTargetRepo(['pr', 'view', url, '-R', 'acme/flagged'], env, cwd)).toEqual({ repo: 'acme/flagged' })
    expect(resolveGhTargetRepo(['pr', 'view', url], env, cwd)).toEqual({ repo: 'acme/infra' })
    expect(resolveGhTargetRepo(['pr', 'view', '7'], env, cwd)).toEqual({ repo: 'example-co/shared-library' })
    expect(resolveGhTargetRepo(['pr', 'view', '7'], {}, cwd)).toEqual({ repo: 'example-co/checkout' })
  })

  it('never shells out for the cwd remote once an earlier layer answers', () => {
    const cwd = vi.fn(() => 'https://github.com/example-co/checkout.git')
    expect(resolveGhTargetRepo(argv('api repos/acme/infra/pulls/1'), {}, cwd)).toEqual({ repo: 'acme/infra' })
    expect(resolveGhTargetRepo(argv('pr view 1 -R acme/infra'), {}, cwd)).toEqual({ repo: 'acme/infra' })
    expect(resolveGhTargetRepo(argv('pr view 1'), { GH_REPO: 'acme/infra' }, cwd)).toEqual({ repo: 'acme/infra' })
    expect(cwd).not.toHaveBeenCalled()
  })

  it('resolves nothing when no layer names a repo (workspace token)', () => {
    expect(resolveGhTargetRepo(argv('pr list'), {}, noCwd)).toEqual({})
    expect(resolveGhTargetRepo([], {}, noCwd)).toEqual({})
  })
})
