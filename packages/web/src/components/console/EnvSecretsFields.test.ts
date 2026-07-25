import { describe, expect, it } from 'vitest'
import {
  envRecordFromRows,
  envRowsFromEnv,
  envSecretsError,
  secretRowsFromKeys,
  secretsPatchFromRows,
  type SecretDraft
} from './EnvSecretsFields'

const newSecret = (k: string, v: string): SecretDraft => ({ k, origK: null, v, editing: true })

describe('secret validation and patching', () => {
  // Regression: `envSecretsError` and `secretsPatchFromRows` must agree on which
  // rows are "abandoned". Existing secret values are write-only, so an existing
  // row is always blank-valued; when validation dropped every blank row, clearing
  // an existing secret's NAME passed the check while the patch builder read the
  // now-missing original key as a deletion — silently destroying a credential the
  // UI can never recover.
  it('rejects a cleared name on an existing secret instead of deleting it', () => {
    const rows = secretRowsFromKeys(['GITHUB_TOKEN'])
    rows[0] = { ...rows[0]!, k: '' }

    const error = envSecretsError([], rows)
    expect(error).not.toBeNull() // null here means the save would go through
    expect(error).toMatch(/not a valid secret name/)
    // Why validation has to catch it: the patch builder would delete the secret.
    expect(secretsPatchFromRows(rows, ['GITHUB_TOKEN'])).toEqual({ GITHUB_TOKEN: null })
  })

  it('treats untouched existing secrets as a no-op', () => {
    const rows = secretRowsFromKeys(['GITHUB_TOKEN', 'PAGERDUTY_KEY'])
    expect(envSecretsError([], rows)).toBeNull()
    expect(secretsPatchFromRows(rows, ['GITHUB_TOKEN', 'PAGERDUTY_KEY'])).toEqual({})
  })

  it('deletes a secret the user actually removed', () => {
    const rows = secretRowsFromKeys(['GITHUB_TOKEN', 'PAGERDUTY_KEY']).filter((r) => r.origK !== 'PAGERDUTY_KEY')
    expect(envSecretsError([], rows)).toBeNull()
    expect(secretsPatchFromRows(rows, ['GITHUB_TOKEN', 'PAGERDUTY_KEY'])).toEqual({ PAGERDUTY_KEY: null })
  })

  it('replaces a secret whose value was re-entered', () => {
    const rows = secretRowsFromKeys(['GITHUB_TOKEN'])
    rows[0] = { ...rows[0]!, v: 'ghp_new' }
    expect(envSecretsError([], rows)).toBeNull()
    expect(secretsPatchFromRows(rows, ['GITHUB_TOKEN'])).toEqual({ GITHUB_TOKEN: 'ghp_new' })
  })

  it('requires a value when an existing secret is renamed', () => {
    const rows = secretRowsFromKeys(['GITHUB_TOKEN'])
    rows[0] = { ...rows[0]!, k: 'GH_TOKEN' }
    expect(envSecretsError([], rows)).toMatch(/Enter a value/)
  })

  it('ignores a fully blank new row (an abandoned "Add secret")', () => {
    const rows = [...secretRowsFromKeys(['GITHUB_TOKEN']), newSecret('', '')]
    expect(envSecretsError([], rows)).toBeNull()
    expect(secretsPatchFromRows(rows, ['GITHUB_TOKEN'])).toEqual({})
  })

  it('rejects duplicate secret names', () => {
    expect(envSecretsError([], [newSecret('API_KEY', 'a'), newSecret('API_KEY', 'b')])).toBe('Duplicate secret names')
  })

  it('rejects a new secret with no value', () => {
    expect(envSecretsError([], [newSecret('API_KEY', '')])).toMatch(/Enter a value/)
  })
})

describe('variable validation and records', () => {
  it('rejects an invalid variable name', () => {
    expect(envSecretsError([{ k: '9BAD', v: 'x', editing: false }], [])).toMatch(/not a valid variable name/)
  })

  it('rejects duplicate variable names', () => {
    expect(
      envSecretsError(
        [
          { k: 'LOG_LEVEL', v: 'info', editing: false },
          { k: 'LOG_LEVEL', v: 'debug', editing: false }
        ],
        []
      )
    ).toBe('Duplicate variable names')
  })

  it('round-trips variables and drops unnamed rows', () => {
    const rows = [...envRowsFromEnv([{ k: 'LOG_LEVEL', v: 'info' }]), { k: '', v: '', editing: true }]
    expect(envSecretsError(rows, [])).toBeNull()
    expect(envRecordFromRows(rows)).toEqual({ LOG_LEVEL: 'info' })
  })
})
