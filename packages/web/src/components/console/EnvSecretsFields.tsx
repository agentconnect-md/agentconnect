// The "Secrets and variables" modal section (design `data-sec="envsecrets"`):
// a Variables list (plain config values) and a Secrets list (write-only), each
// with per-row inline editing — pencil to edit, trash to remove, "Add …" to
// append. Controlled: the parent (Add- / Edit-agent modal) owns the draft rows
// and derives the create payload / update patch from them via the helpers below.
//
// Organization-owned entries assigned to the agent appear ABOVE the editable rows
// in a read-only "From organization" group with no edit, replace, or remove
// controls (organization-secrets-and-variables.md §8.2) — only Organization
// settings can change them. A local row with the same key is KEPT and marked
// "Overridden by Organization" rather than removed, so unassigning the entry later
// makes it active again without re-entering its value.

import type { Dispatch, SetStateAction } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { OrganizationRowBadge } from '@/components/console/OrganizationEnvironmentRows'

// Env/secret key rule — mirrors the CP's AgentEnvBody / AgentSecretsPatchBody so a
// bad name fails inline instead of as a 400. Compact mono field chrome shared with
// the detail-page read-only cards.
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const KV_FIELD =
  'w-full min-w-0 rounded-md border border-(--border-default) bg-(--surface-card) px-[9px] font-mono text-[12px] font-medium text-(--text-primary) outline-none focus:border-(--border-focus) focus:ring-[3px] focus:ring-(--brand-ring)'
const KV_INPUT = `h-7 ${KV_FIELD}`
// Values may be multi-line (a PEM block, a kubeconfig, a JSON blob) — a single-line
// <input> collapses pasted newlines, so the value editor is a textarea.
const KV_VALUE = `min-h-14 resize-y py-[5px] leading-[1.5] ${KV_FIELD}`

export type EnvVarDraft = { k: string; v: string; editing: boolean }
// `origK` is the stored name of an existing secret (null for a freshly-added row).
// Secret values are write-only, so an existing row's value starts blank and is only
// sent when the user re-enters one.
export type SecretDraft = { k: string; origK: string | null; v: string; editing: boolean }

export function envRowsFromEnv(env: { k: string; v: string }[]): EnvVarDraft[] {
  return env.map((e) => ({ k: e.k, v: e.v, editing: false }))
}
export function secretRowsFromKeys(keys: string[]): SecretDraft[] {
  return keys.map((k) => ({ k, origK: k, v: '', editing: false }))
}

/** Full env record (env is replaced wholesale on the CP). */
export function envRecordFromRows(rows: EnvVarDraft[]): Record<string, string> {
  const kept = rows.map((r) => ({ k: r.k.trim(), v: r.v })).filter((r) => r.k)
  return Object.fromEntries(kept.map((r) => [r.k, r.v]))
}
/** Create-time secrets (all rows, initial set). */
export function secretsRecordFromRows(rows: SecretDraft[]): Record<string, string> {
  const kept = rows.map((r) => ({ k: r.k.trim(), v: r.v })).filter((r) => r.k)
  return Object.fromEntries(kept.map((r) => [r.k, r.v]))
}
/** Update-time secrets patch (key-by-key merge): set/replace revealed rows, delete
 *  any original key no longer present (removed or renamed away). */
export function secretsPatchFromRows(rows: SecretDraft[], existingKeys: string[]): Record<string, string | null> {
  const kept = rows.map((r) => ({ ...r, k: r.k.trim() })).filter((r) => !(r.origK === null && !r.k && !r.v))
  const patch: Record<string, string | null> = {}
  const keptKeys = new Set(kept.map((r) => r.k))
  for (const r of kept) if (r.v !== '') patch[r.k] = r.v
  for (const ok of existingKeys) if (!keptKeys.has(ok)) patch[ok] = null
  return patch
}

/** First validation error across both lists, or null. A message key under
 *  `Agents.dialog.errors` plus its interpolation values — the caller resolves it
 *  through `t`, so this stays testable and localizable without one. */
export interface EnvSecretsError {
  key:
    | 'invalidVariableName'
    | 'duplicateVariableNames'
    | 'invalidSecretName'
    | 'secretValueRequired'
    | 'duplicateSecretNames'
  values?: { name: string }
}

export function envSecretsError(envRows: EnvVarDraft[], secretRows: SecretDraft[]): EnvSecretsError | null {
  const envKept = envRows.map((r) => ({ k: r.k.trim(), v: r.v })).filter((r) => r.k || r.v)
  for (const r of envKept) if (!ENV_KEY.test(r.k)) return { key: 'invalidVariableName', values: { name: r.k } }
  if (new Set(envKept.map((r) => r.k)).size !== envKept.length) return { key: 'duplicateVariableNames' }
  // Same row-keeping rule as `secretsPatchFromRows`: only a fully blank NEW row is
  // an abandoned "Add secret" click. An EXISTING row must survive to the key check
  // below even when blank — its value is always blank (write-only), so dropping it
  // here would let a cleared name pass validation while the patch builder read the
  // missing original key as a deletion, silently destroying an unrecoverable secret.
  const secKept = secretRows.map((r) => ({ ...r, k: r.k.trim() })).filter((r) => !(r.origK === null && !r.k && !r.v))
  for (const r of secKept) {
    if (!ENV_KEY.test(r.k)) return { key: 'invalidSecretName', values: { name: r.k } }
    // A new row, or one renamed to a new key, must carry a value.
    if ((r.origK === null || r.k !== r.origK) && r.v === '')
      return { key: 'secretValueRequired', values: { name: r.k } }
  }
  if (new Set(secKept.map((r) => r.k)).size !== secKept.length) return { key: 'duplicateSecretNames' }
  return null
}

const ADD_LINK = 'lnk px-4 py-[10px] text-[12.5px]'
const ROW_EDIT = 'flex flex-col gap-[6px] border-b border-(--border-subtle) px-4 pt-[9px] pb-[11px]'
const ROW_VIEW = 'flex items-center gap-3 border-b border-(--border-subtle) px-4 py-[10px]'

/** Organization-owned rows, shown above the editable ones. Read-only by
 *  construction: this renders no pencil, trash, or input at all. */
function FromOrganizationGroup({
  rows,
  masked,
  manageHref
}: {
  rows: { k: string; v?: string }[]
  masked: boolean
  manageHref?: string
}) {
  const t = useTranslations('Agents.dialog.secretsFields')
  if (rows.length === 0) return null
  return (
    <div className="mt-[10px] overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-subtle)">
      <div className="flex items-center justify-between gap-3 border-b border-(--border-subtle) px-4 py-[7px]">
        <span className="font-sans text-[11px] font-semibold leading-normal tracking-wide text-(--text-tertiary) uppercase">
          {t('fromOrganization')}
        </span>
        {/* Owners get a way to change these; other members see the group only. */}
        {manageHref && (
          <a className="lnk text-[11.5px]" href={manageHref}>
            {t('manage')}
          </a>
        )}
      </div>
      {rows.map((row, i) => (
        <div
          key={i}
          className="flex items-center gap-3 border-b border-(--border-subtle) px-4 py-[9px] last:border-b-0"
        >
          <span className="flex min-w-0 flex-1 items-center gap-[7px]">
            {masked && <Icon name="lock" size={11} color="var(--text-tertiary)" className="flex-none" />}
            <span className="mono min-w-0 truncate text-[12px] text-(--text-primary)" title={row.k}>
              {row.k}
            </span>
            <OrganizationRowBadge />
          </span>
          <span
            className="mono min-w-0 flex-1 truncate text-right text-[12px] text-(--text-tertiary)"
            title={masked ? t('writeOnlyTitle') : row.v}
          >
            {masked ? '••••••••' : row.v}
          </span>
        </div>
      ))}
    </div>
  )
}

/** The note on a retained-but-inactive local row. */
function OverriddenNote() {
  const t = useTranslations('Agents.dialog.secretsFields')
  return (
    <span
      className="flex-none font-sans text-[11px] font-medium leading-normal text-(--text-tertiary)"
      title={t('overriddenTitle')}
    >
      {t('overriddenBy')}
    </span>
  )
}

export function EnvSecretsFields({
  envRows,
  setEnvRows,
  secretRows,
  setSecretRows,
  organizationVariables = [],
  organizationSecretKeys = [],
  organizationSettingsHref
}: {
  envRows: EnvVarDraft[]
  setEnvRows: Dispatch<SetStateAction<EnvVarDraft[]>>
  secretRows: SecretDraft[]
  setSecretRows: Dispatch<SetStateAction<SecretDraft[]>>
  /** Organization variables assigned to this agent — read-only here. */
  organizationVariables?: { k: string; v: string }[]
  /** Names of organization secrets assigned to this agent — read-only here. */
  organizationSecretKeys?: string[]
  /** Link to Organization settings; owners only (absent ⇒ explanatory text only). */
  organizationSettingsHref?: string
}) {
  const t = useTranslations('Agents.dialog.secretsFields')
  const patchEnv = (i: number, patch: Partial<EnvVarDraft>) =>
    setEnvRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const patchSec = (i: number, patch: Partial<SecretDraft>) =>
    setSecretRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  // A local row is inactive while ANY assigned entry claims its key, regardless of
  // which kind that entry is.
  const organizationKeys = new Set([...organizationVariables.map((e) => e.k), ...organizationSecretKeys])

  return (
    <div className="flex flex-col gap-[22px]">
      <div>
        <div className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
          {t('variables.title')}
        </div>
        <div className="mt-1 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          {t('variables.description')}
        </div>
        <FromOrganizationGroup rows={organizationVariables} masked={false} manageHref={organizationSettingsHref} />
        <div className="mt-[10px] overflow-hidden rounded-lg border border-(--border-subtle)">
          {envRows.map((r, i) =>
            r.editing ? (
              <div key={i} className={ROW_EDIT}>
                <div className="flex items-center gap-[6px]">
                  <input
                    className={KV_INPUT}
                    placeholder={t('variables.keyPlaceholder')}
                    value={r.k}
                    onChange={(e) => patchEnv(i, { k: e.target.value })}
                    aria-label={t('variables.nameAriaLabel')}
                    autoFocus
                  />
                  <button
                    type="button"
                    className="iconbtn h-7 w-7 flex-none"
                    title={t('done')}
                    onClick={() => patchEnv(i, { editing: false })}
                  >
                    <Icon name="check" size={13} />
                  </button>
                </div>
                <textarea
                  className={KV_VALUE}
                  placeholder={t('variables.valuePlaceholder')}
                  value={r.v}
                  onChange={(e) => patchEnv(i, { v: e.target.value })}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label={t('variables.valueAriaLabel')}
                />
              </div>
            ) : (
              <div key={i} className={ROW_VIEW}>
                <span className="mono min-w-0 flex-1 truncate text-[12px] text-(--text-primary)" title={r.k}>
                  {r.k || '—'}
                </span>
                {/* Retained, not removed: unassigning the organization entry makes
                    this value active again without re-entering it. */}
                {organizationKeys.has(r.k) && <OverriddenNote />}
                <span
                  className="mono min-w-0 flex-1 truncate text-right text-[12px] text-(--text-tertiary)"
                  title={r.v}
                >
                  {r.v}
                </span>
                <button
                  type="button"
                  className="iconbtn h-[26px] w-[26px] flex-none"
                  title={t('edit')}
                  onClick={() => patchEnv(i, { editing: true })}
                >
                  <Icon name="pencil" size={12} />
                </button>
                <button
                  type="button"
                  className="iconbtn h-[26px] w-[26px] flex-none"
                  title={t('remove')}
                  onClick={() => setEnvRows((rs) => rs.filter((_, j) => j !== i))}
                >
                  <Icon name="trash" size={12} />
                </button>
              </div>
            )
          )}
          <button
            type="button"
            className={ADD_LINK}
            onClick={() => setEnvRows((rs) => [...rs, { k: '', v: '', editing: true }])}
          >
            <Icon name="plus" size={13} />
            {t('variables.add')}
          </button>
        </div>
      </div>

      <div>
        <div className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
          {t('secrets.title')}
        </div>
        <div className="mt-1 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          {t('secrets.description')}
        </div>
        <FromOrganizationGroup
          rows={organizationSecretKeys.map((k) => ({ k }))}
          masked
          manageHref={organizationSettingsHref}
        />
        <div className="mt-[10px] overflow-hidden rounded-lg border border-(--border-subtle)">
          {secretRows.map((r, i) =>
            r.editing ? (
              <div key={i} className={ROW_EDIT}>
                <div className="flex items-center gap-[6px]">
                  <input
                    className={KV_INPUT}
                    placeholder={t('secrets.keyPlaceholder')}
                    value={r.k}
                    onChange={(e) => patchSec(i, { k: e.target.value })}
                    aria-label={t('secrets.nameAriaLabel')}
                    autoFocus
                  />
                  <button
                    type="button"
                    className="iconbtn h-7 w-7 flex-none"
                    title={t('done')}
                    onClick={() => patchSec(i, { editing: false })}
                  >
                    <Icon name="check" size={13} />
                  </button>
                </div>
                <textarea
                  className={KV_VALUE}
                  placeholder={r.origK !== null ? t('secrets.newValuePlaceholder') : t('secrets.valuePlaceholder')}
                  value={r.v}
                  onChange={(e) => patchSec(i, { v: e.target.value })}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label={t('secrets.valueAriaLabel')}
                />
              </div>
            ) : (
              <div key={i} className={ROW_VIEW}>
                <span className="flex min-w-0 flex-1 items-center gap-[7px]">
                  <Icon name="lock" size={11} color="var(--text-tertiary)" className="flex-none" />
                  <span className="mono min-w-0 truncate text-[12px] text-(--text-primary)" title={r.k}>
                    {r.k || '—'}
                  </span>
                  {organizationKeys.has(r.k) && <OverriddenNote />}
                </span>
                <span className="mono flex-none text-[12px] text-(--text-tertiary)">••••••••</span>
                <button
                  type="button"
                  className="iconbtn h-[26px] w-[26px] flex-none"
                  title={r.origK !== null ? t('secrets.replaceValue') : t('edit')}
                  onClick={() => patchSec(i, { editing: true, ...(r.origK !== null ? { v: '' } : {}) })}
                >
                  <Icon name="pencil" size={12} />
                </button>
                <button
                  type="button"
                  className="iconbtn h-[26px] w-[26px] flex-none"
                  title={t('remove')}
                  onClick={() => setSecretRows((rs) => rs.filter((_, j) => j !== i))}
                >
                  <Icon name="trash" size={12} />
                </button>
              </div>
            )
          )}
          <button
            type="button"
            className={ADD_LINK}
            onClick={() => setSecretRows((rs) => [...rs, { k: '', origK: null, v: '', editing: true }])}
          >
            <Icon name="plus" size={13} />
            {t('secrets.add')}
          </button>
        </div>
      </div>
    </div>
  )
}
