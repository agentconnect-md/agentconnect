'use client'

// An organization's domains and single sign-on (organization-sso.md §4.1, §4.3): the Domains and Connection cards, and the New members card.

import { useEffect, useState, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Button, Icon } from '@/components/ui'
import { LoadingState } from '@/components/marks'
import { ConfirmationDialog } from '@/components/console/ConfirmationDialog'
import OrgSsoConnectionModal from '@/components/console/modals/OrgSsoConnectionModal'
import OrgSsoDomainModal from '@/components/console/modals/OrgSsoDomainModal'
import {
  activateOrgSsoConnection,
  ApiError,
  deactivateOrgSsoConnection,
  enforceOrgSsoConnection,
  fetchOrgSso,
  releaseOrgSsoDomain,
  removeOrgSsoConnection,
  setOrgMemberSource,
  startOrgSsoTest,
  stopEnforcingOrgSsoConnection,
  verifyOrgSsoDomain,
  type OrgMemberSource,
  type OrgSsoConnectionDto,
  type OrgSsoDomainDto,
  type OrgSsoStateDto
} from '@/lib/api'
import { currentUser, loginWithSso } from '@/lib/auth'
import { writeFlowState } from '@/lib/flow-state'
import { canStashSsoTest, clearSsoTest, refusalDetail, stashSsoTest } from '@/lib/organization-sso'
import { consoleKeys } from '@/lib/swr-keys'

const ROW = 'border-b border-(--border-subtle) px-4 py-3 last:border-b-0'
const LINE = 'flex flex-wrap items-center gap-[10px]'
const MUTED = 'font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)'

/** What the last action on a domain row found; shown on the row until the next one. */
type DomainProblem = 'not_found' | 'mismatch' | 'lookup_failed' | 'taken' | 'in_use'

type Dialog =
  | { kind: 'addDomain' }
  | { kind: 'connection' }
  | { kind: 'test' }
  | { kind: 'activate' }
  | { kind: 'deactivate' }
  | { kind: 'enforce' }
  | { kind: 'stopEnforcing' }
  | { kind: 'remove' }
  | { kind: 'verify'; domain: OrgSsoDomainDto }

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function CopyValue({ value }: { value: string }) {
  const t = useTranslations('Settings.sso')
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable: the value stays selectable */
    }
  }
  return (
    <button
      type="button"
      className="iconbtn h-7 w-7 border-transparent bg-transparent"
      title={t('copy')}
      aria-label={t('copy')}
      onClick={() => void copy()}
    >
      <Icon name={copied ? 'check' : 'copy'} size={14} />
    </button>
  )
}

/** The DNS record that proves control of a domain. */
function DnsRecord({ record }: { record: OrgSsoDomainDto['record'] }) {
  const t = useTranslations('Settings.sso.record')
  const key =
    'w-[46px] flex-none font-mono text-[10.5px] font-semibold uppercase leading-normal tracking-[.06em] text-(--text-tertiary)'
  const value =
    'min-w-0 flex-1 truncate font-mono text-[12px] font-normal leading-normal text-(--text-primary) select-all'
  const line =
    'flex min-w-0 items-center gap-[10px] border-b border-(--border-subtle) py-[7px] pr-2 pl-3 last:border-b-0'
  return (
    <div className="mt-3 rounded-md border border-(--border-subtle) bg-(--surface-sunken)">
      <div className={line}>
        <span className={key}>{t('type')}</span>
        <span className={value}>{record.type}</span>
      </div>
      <div className={line}>
        <span className={key}>{t('name')}</span>
        <span className={value}>{record.name}</span>
        <CopyValue value={record.name} />
      </div>
      <div className={line}>
        <span className={key}>{t('value')}</span>
        <span className={value}>{record.value}</span>
        <CopyValue value={record.value} />
      </div>
    </div>
  )
}

function DomainRow({
  domain,
  bound,
  problem,
  isOwner,
  busy,
  onVerify,
  onRemove
}: {
  domain: OrgSsoDomainDto
  /** A connection is active: addresses on this domain sign in only through it. */
  bound: boolean
  problem: DomainProblem | undefined
  isOwner: boolean
  busy: boolean
  onVerify: () => void
  onRemove: () => void
}) {
  const t = useTranslations('Settings.sso')
  const verified = domain.status === 'verified'
  // The daily re-check found the record gone; the domain stays verified and bound until an owner acts.
  const recordMissing = verified && domain.lastCheckOk === false
  const needsRecord = !verified || recordMissing
  const problemText =
    problem === 'not_found'
      ? t('problem.notFound')
      : problem === 'mismatch'
        ? t('problem.mismatch')
        : problem === 'lookup_failed'
          ? t('problem.lookupFailed')
          : problem === 'taken'
            ? t('problem.taken')
            : problem === 'in_use'
              ? t('problem.inUse')
              : null

  return (
    <div className={ROW}>
      <div className={LINE}>
        <span className="font-mono text-[13px] font-medium leading-normal break-all">{domain.domain}</span>
        {verified ? (
          <span className="badge bg-(--status-online-soft) text-(--status-online)">{t('status.verified')}</span>
        ) : (
          <span className="badge bg-(--status-paused-soft) text-(--status-paused)">{t('status.pending')}</span>
        )}
        {recordMissing && (
          <span className="inline-flex items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--status-paused)">
            <Icon name="triangle-exclamation-point" size={14} />
            {t('recordMissing')}
          </span>
        )}
        {problemText && !recordMissing && (
          <span
            className="inline-flex items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--status-error)"
            role="alert"
          >
            <Icon name="circle-exclamation-point" size={14} />
            {problemText}
          </span>
        )}
        {verified && bound && (
          <span className="inline-flex items-center gap-[5px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
            <Icon name="link" size={13} />
            {t('bound')}
          </span>
        )}
        {isOwner && (
          <span className="ml-auto flex items-center gap-2">
            {needsRecord && (
              <Button size="xs" disabled={busy} onClick={onVerify}>
                {t('verify')}
              </Button>
            )}
            <button
              type="button"
              className="iconbtn h-7 w-7"
              title={t('removeDomain')}
              aria-label={t('removeDomain')}
              disabled={busy}
              onClick={onRemove}
            >
              <Icon name="trash" size={14} />
            </button>
          </span>
        )}
      </div>
      {isOwner && needsRecord && <DnsRecord record={domain.record} />}
    </div>
  )
}

function ConnectionRow({
  connection,
  isOwner,
  open
}: {
  connection: OrgSsoConnectionDto
  isOwner: boolean
  open: (dialog: Dialog) => void
}) {
  const t = useTranslations('Settings.sso')
  const active = connection.status === 'active'
  return (
    <div className={ROW}>
      <div className={LINE}>
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-subtle) bg-(--surface-sunken) text-(--text-secondary)">
          <Icon name="key-round" size={15} />
        </span>
        <span className="font-sans text-[13.5px] font-semibold leading-normal">
          {connection.protocol === 'oidc' ? 'OIDC' : 'SAML'}
        </span>
        {connection.needsConfiguration ? (
          <span className="badge bg-(--status-error-soft) text-(--status-error)">{t('status.needsConfiguration')}</span>
        ) : (
          <>
            {active && connection.enforcedAt && (
              <span className="badge bg-(--status-online-soft) text-(--status-online)">{t('status.enforced')}</span>
            )}
            {active && !connection.enforcedAt && (
              <span className="badge bg-(--status-online-soft) text-(--status-online)">{t('status.active')}</span>
            )}
            {!active && connection.tested && (
              <span className="badge bg-(--status-info-soft) text-(--status-info)">{t('status.tested')}</span>
            )}
            {!connection.tested && (
              <span className="badge bg-(--surface-sunken) text-(--text-secondary)">{t('status.notTested')}</span>
            )}
          </>
        )}
        {isOwner && (
          <span className="ml-auto flex items-center gap-2 max-desktop:ml-0 max-desktop:w-full">
            {connection.needsConfiguration ? (
              <Button size="xs" onClick={() => open({ kind: 'connection' })}>
                {t('reconfigure')}
              </Button>
            ) : (
              <>
                {!connection.tested && (
                  <Button size="xs" onClick={() => open({ kind: 'test' })}>
                    {t('testSignIn')}
                  </Button>
                )}
                {!active && connection.tested && (
                  <Button size="xs" onClick={() => open({ kind: 'activate' })}>
                    {t('activate')}
                  </Button>
                )}
                <Button variant="secondary" size="xs" onClick={() => open({ kind: 'connection' })}>
                  {t('edit')}
                </Button>
                {active && connection.tested && !connection.enforcedAt && (
                  <Button size="xs" onClick={() => open({ kind: 'enforce' })}>
                    {t('enforce')}
                  </Button>
                )}
                {active && connection.enforcedAt && (
                  <Button variant="secondary" size="xs" onClick={() => open({ kind: 'stopEnforcing' })}>
                    {t('stopEnforcing')}
                  </Button>
                )}
                {active && (
                  <Button variant="secondary" size="xs" onClick={() => open({ kind: 'deactivate' })}>
                    {t('deactivate')}
                  </Button>
                )}
              </>
            )}
          </span>
        )}
      </div>
    </div>
  )
}

/** How new members arrive: an owner picks, everyone else reads the choice. */
function MemberSourceRow({
  source,
  isOwner,
  busy,
  onPick
}: {
  source: OrgMemberSource
  isOwner: boolean
  busy: boolean
  onPick: (next: OrgMemberSource) => void
}) {
  const t = useTranslations('Settings.sso.memberSource')
  const options: readonly OrgMemberSource[] = ['invite', 'domain']
  return (
    <div className={ROW}>
      {isOwner ? (
        <div className="pillbar self-start" role="radiogroup" aria-label={t('label')}>
          {options.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={source === option}
              disabled={busy}
              className={source === option ? 'pill on whitespace-nowrap' : 'pill whitespace-nowrap'}
              onClick={() => source !== option && onPick(option)}
            >
              {t(option)}
            </button>
          ))}
        </div>
      ) : (
        <span className="font-sans text-[13px] font-medium leading-normal">{t(source)}</span>
      )}
    </div>
  )
}

function DomainList({ domains }: { domains: readonly OrgSsoDomainDto[] }) {
  return (
    <div className="mb-[14px] rounded-md border border-(--border-subtle)">
      {domains.map((domain) => (
        <div
          key={domain.id}
          className="border-b border-(--border-subtle) px-3 py-2 font-mono text-[13px] font-medium leading-normal break-all text-(--text-primary) last:border-b-0"
        >
          {domain.domain}
        </div>
      ))}
    </div>
  )
}

const strong = (chunks: ReactNode) => <b className="font-semibold text-(--text-primary)">{chunks}</b>

export function OrganizationSsoCard({ orgId, isOwner }: { orgId: string; isOwner: boolean }) {
  const t = useTranslations('Settings.sso')
  const pathname = usePathname()
  const {
    data: state,
    error: loadError,
    mutate
  } = useSWR<OrgSsoStateDto>(consoleKeys.orgSso(orgId), ([, id]) => fetchOrgSso(id as string))
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [pending, setPending] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [problems, setProblems] = useState<Record<string, DomainProblem>>({})
  const [rowBusy, setRowBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    setDialog(null)
    setProblems({})
    setActionError(null)
  }, [orgId])

  const open = (next: Dialog) => {
    setDialogError(null)
    setPending(false)
    setDialog(next)
  }
  const close = () => setDialog(null)
  const refresh = () => void mutate()
  // A sign-in started here comes back to the Single sign-on tab.
  const returnTo = `${pathname}?tab=sso#single-sign-on`

  const domains = state?.domains ?? []
  const connection = state?.connection ?? null
  const verified = domains.filter((domain) => domain.status === 'verified')
  const active = connection?.status === 'active' && !connection.needsConfiguration

  const setProblem = (id: string, problem: DomainProblem | null) =>
    setProblems((current) => {
      const { [id]: _dropped, ...rest } = current
      return problem ? { ...rest, [id]: problem } : rest
    })

  const verify = async (domain: OrgSsoDomainDto) => {
    setRowBusy(domain.id)
    setActionError(null)
    try {
      const result = await verifyOrgSsoDomain(domain.id, orgId)
      setProblem(domain.id, result.check === 'ok' ? null : result.check)
      await mutate()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SSO_DOMAIN_TAKEN') setProblem(domain.id, 'taken')
      else setActionError(message(e))
    } finally {
      setRowBusy(null)
    }
  }

  const remove = async (domain: OrgSsoDomainDto) => {
    setRowBusy(domain.id)
    setActionError(null)
    try {
      await releaseOrgSsoDomain(domain.id, orgId)
      setProblem(domain.id, null)
      await mutate()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SSO_DOMAIN_IN_USE') setProblem(domain.id, 'in_use')
      else setActionError(message(e))
    } finally {
      setRowBusy(null)
    }
  }

  // A confirmed action: the dialog stays up while it runs and shows what the Control Plane refused.
  const confirm = async (run: () => Promise<void>) => {
    setPending(true)
    setDialogError(null)
    try {
      await run()
      close()
    } catch (e) {
      setDialogError(message(e))
      setPending(false)
    } finally {
      refresh()
    }
  }

  // Enforcing needs this session to have signed in through the connection; the sign-in returns to this card.
  const signInThrough = async (connectorId: string) => {
    setPending(true)
    setDialogError(null)
    try {
      writeFlowState('returnTo', returnTo)
      clearSsoTest()
      await loginWithSso(connectorId, currentUser()?.email ?? undefined)
    } catch (e) {
      setDialogError(message(e))
      setPending(false)
    }
  }

  const startTest = async () => {
    if (!connection) return
    setPending(true)
    setDialogError(null)
    try {
      if (!canStashSsoTest()) throw new Error(t('testDialog.storageBlocked'))
      const test = await startOrgSsoTest(orgId)
      stashSsoTest({
        nonce: test.nonce,
        returnTo,
        expiresAt: test.expiresAt
      })
      // The page leaves for the identity provider and lands on the sign-in callback.
      await loginWithSso(test.connectorId)
    } catch (e) {
      clearSsoTest()
      setDialogError(message(e))
      setPending(false)
    }
  }

  // Nothing to show a member who cannot act on an empty card.
  if (!isOwner && state && domains.length === 0 && !connection) return null
  // A deployment that stopped declaring organization SSO answers 404; the card goes with it.
  if (loadError instanceof ApiError && loadError.status === 404) return null
  if (!isOwner && loadError) return null

  const email = currentUser()?.email

  return (
    <>
      <div className="card mt-[18px]" id="single-sign-on">
        <div className="cardhead justify-between">
          <span className="cardtitle">{t('domains')}</span>
          {isOwner && state && (
            <Button variant="secondary" size="xs" onClick={() => open({ kind: 'addDomain' })}>
              <Icon name="plus" size={14} />
              {t('addDomain.open')}
            </Button>
          )}
        </div>

        {state === undefined && !loadError ? (
          <LoadingState size={22} padding={20} />
        ) : state === undefined ? (
          <div className="px-4 py-[15px] font-sans text-[12.5px] font-normal leading-normal text-(--status-error)">
            {t('loadError')}
          </div>
        ) : domains.length === 0 ? (
          <div className={ROW}>
            <span className={MUTED}>{t('noDomains')}</span>
          </div>
        ) : (
          domains.map((domain) => (
            <DomainRow
              key={domain.id}
              domain={domain}
              bound={active}
              problem={problems[domain.id]}
              isOwner={isOwner}
              busy={rowBusy === domain.id}
              onVerify={() =>
                active && domain.status === 'pending' ? open({ kind: 'verify', domain }) : void verify(domain)
              }
              onRemove={() => void remove(domain)}
            />
          ))
        )}

        {actionError && (
          <div
            className="border-t border-(--border-subtle) px-4 py-3 font-sans text-[12px] font-normal leading-normal text-(--status-error)"
            role="alert"
          >
            {actionError}
          </div>
        )}
      </div>

      {state && (connection || verified.length > 0) && (
        <div className="card mt-[18px]" id="sso-connection">
          <div className="cardhead">
            <span className="cardtitle">{t('connection')}</span>
          </div>
          {connection ? (
            <ConnectionRow connection={connection} isOwner={isOwner} open={open} />
          ) : (
            <div className={ROW}>
              <div className={LINE}>
                <span className={MUTED}>{t('noConnection')}</span>
                {isOwner && (
                  <span className="ml-auto flex items-center gap-2">
                    <Button size="xs" onClick={() => open({ kind: 'connection' })}>
                      {t('setUpConnection')}
                    </Button>
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {dialog?.kind === 'addDomain' && <OrgSsoDomainModal orgId={orgId} onClose={close} onAdded={refresh} />}
      {dialog?.kind === 'connection' && (
        <OrgSsoConnectionModal
          orgId={orgId}
          connection={connection}
          onClose={close}
          onSaved={refresh}
          onRemove={() => open({ kind: 'remove' })}
        />
      )}
      {dialog?.kind === 'remove' && connection && (
        <ConfirmationDialog
          title={t('removeDialog.title')}
          confirmLabel={t('connectionDialog.remove')}
          busy={pending}
          busyLabel={t('removeDialog.removing')}
          error={dialogError}
          destructive
          onConfirm={() =>
            void confirm(async () => {
              await removeOrgSsoConnection(orgId)
              // A domain row that said the connection kept it no longer has one.
              setProblems({})
            })
          }
          onClose={close}
        >
          {active && <DomainList domains={verified} />}
          {t.rich(active ? 'removeDialog.bodyActive' : 'removeDialog.body', { b: strong })}
        </ConfirmationDialog>
      )}
      {dialog?.kind === 'test' && connection && (
        <ConfirmationDialog
          title={t('testDialog.title')}
          confirmLabel={t('testSignIn')}
          busy={pending}
          busyLabel={t('testDialog.starting')}
          error={dialogError}
          onConfirm={() => void startTest()}
          onClose={close}
        >
          {email ? t.rich('testDialog.body', { email, b: strong }) : t.rich('testDialog.bodyNoEmail', { b: strong })}
        </ConfirmationDialog>
      )}
      {dialog?.kind === 'activate' && connection && (
        <ConfirmationDialog
          title={t('activateDialog.title')}
          confirmLabel={t('activate')}
          busy={pending}
          busyLabel={t('activateDialog.activating')}
          error={dialogError}
          onConfirm={() =>
            void confirm(async () => {
              try {
                await activateOrgSsoConnection(orgId)
              } catch (e) {
                if (!(e instanceof ApiError && e.code === 'SSO_DOMAIN_CHECK_FAILED')) throw e
                const domains = refusalDetail(e.message, 'could not be confirmed for ')
                throw new Error(t('activateDialog.domainCheckFailed', { domains }))
              }
            })
          }
          onClose={close}
        >
          <DomainList domains={verified} />
          {t.rich('activateDialog.body', { b: strong })}
        </ConfirmationDialog>
      )}
      {dialog?.kind === 'deactivate' && connection && (
        <ConfirmationDialog
          title={t('deactivateDialog.title')}
          confirmLabel={t('deactivate')}
          busy={pending}
          busyLabel={t('deactivateDialog.deactivating')}
          error={dialogError}
          destructive
          onConfirm={() =>
            void confirm(async () => {
              await deactivateOrgSsoConnection(orgId)
            })
          }
          onClose={close}
        >
          <DomainList domains={verified} />
          {t('deactivateDialog.body')}
        </ConfirmationDialog>
      )}
      {dialog?.kind === 'enforce' && connection && (
        <ConfirmationDialog
          title={t('enforceDialog.title')}
          busy={pending}
          busyLabel={t('enforceDialog.working')}
          error={dialogError}
          {...(state?.enforce === 'ready'
            ? {
                confirmLabel: t('enforce'),
                onConfirm: () =>
                  void confirm(async () => {
                    await enforceOrgSsoConnection(orgId)
                  })
              }
            : state?.enforce === 'sign_in_required'
              ? {
                  confirmLabel: t('enforceDialog.signIn'),
                  onConfirm: () => void signInThrough(connection.connectorId)
                }
              : {})}
          onClose={close}
        >
          <DomainList domains={verified} />
          {state?.enforce === 'outside_domains'
            ? t.rich('enforceDialog.outsideDomains', { b: strong })
            : state?.enforce === 'sign_in_required'
              ? t.rich('enforceDialog.signInFirst', { b: strong })
              : t.rich('enforceDialog.body', { b: strong })}
        </ConfirmationDialog>
      )}
      {dialog?.kind === 'stopEnforcing' && connection && (
        <ConfirmationDialog
          title={t('stopEnforcingDialog.title')}
          confirmLabel={t('stopEnforcing')}
          busy={pending}
          busyLabel={t('enforceDialog.working')}
          error={dialogError}
          onConfirm={() =>
            void confirm(async () => {
              await stopEnforcingOrgSsoConnection(orgId)
            })
          }
          onClose={close}
        >
          {t.rich('stopEnforcingDialog.body', { b: strong })}
        </ConfirmationDialog>
      )}
      {dialog?.kind === 'verify' && connection && (
        <ConfirmationDialog
          title={t('verifyDialog.title', { domain: dialog.domain.domain })}
          confirmLabel={t('verify')}
          onConfirm={() => {
            const { domain } = dialog
            close()
            void verify(domain)
          }}
          onClose={close}
        >
          {t.rich('verifyDialog.body', { domain: dialog.domain.domain, b: strong })}
        </ConfirmationDialog>
      )}
    </>
  )
}

/** The deployment's own SSO connector sets how members arrive; the organization only reads it. */
export function DeploymentMemberSourceCard({ source }: { source: OrgMemberSource }) {
  const t = useTranslations('Settings.sso')
  return (
    <div className="card mt-[18px]" id="new-members">
      <div className="cardhead">
        <span className="cardtitle">{t('memberSource.label')}</span>
        <span className="badge bg-(--surface-sunken) text-(--text-secondary)">{t('deploymentMemberSource.setBy')}</span>
      </div>
      <div className={ROW}>
        <span className="font-sans text-[13px] font-medium leading-normal">
          {t(`deploymentMemberSource.${source}`)}
        </span>
      </div>
    </div>
  )
}

/** How new members arrive; shown once a domain is verified, beside the other membership cards. */
export function OrganizationMemberSourceCard({ orgId, isOwner }: { orgId: string; isOwner: boolean }) {
  const t = useTranslations('Settings.sso')
  const { data: state, mutate } = useSWR<OrgSsoStateDto>(consoleKeys.orgSso(orgId), ([, id]) =>
    fetchOrgSso(id as string)
  )
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)

  useEffect(() => {
    setConfirming(false)
    setError(null)
  }, [orgId])

  const verified = (state?.domains ?? []).filter((domain) => domain.status === 'verified')
  if (!state || verified.length === 0) return null

  // Opening the organization to its domains is confirmed; returning to invitations takes effect at once.
  const pick = async (next: OrgMemberSource) => {
    if (next === 'domain') {
      setDialogError(null)
      setBusy(false)
      setConfirming(true)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await setOrgMemberSource(next, orgId)
      await mutate()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  const allow = async () => {
    setBusy(true)
    setDialogError(null)
    try {
      await setOrgMemberSource('domain', orgId)
      setConfirming(false)
    } catch (e) {
      setDialogError(message(e))
    } finally {
      setBusy(false)
      void mutate()
    }
  }

  return (
    <div className="card mt-[18px]" id="new-members">
      <div className="cardhead">
        <span className="cardtitle">{t('memberSource.label')}</span>
      </div>
      <MemberSourceRow source={state.memberSource} isOwner={isOwner} busy={busy} onPick={(next) => void pick(next)} />
      {error && (
        <div
          className="border-t border-(--border-subtle) px-4 py-3 font-sans text-[12px] font-normal leading-normal text-(--status-error)"
          role="alert"
        >
          {error}
        </div>
      )}
      {confirming && (
        <ConfirmationDialog
          title={t('joinDialog.title')}
          confirmLabel={t('joinDialog.confirm')}
          busy={busy}
          busyLabel={t('connectionDialog.saving')}
          error={dialogError}
          onConfirm={() => void allow()}
          onClose={() => setConfirming(false)}
        >
          <DomainList domains={verified} />
          {t('joinDialog.body')}
        </ConfirmationDialog>
      )}
    </div>
  )
}
