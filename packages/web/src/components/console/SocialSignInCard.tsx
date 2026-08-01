'use client'

import { useEffect, useId, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { Avatar, Button, Icon } from '@/components/ui'
import { SocialLoginMark } from '@/components/marks'
import { initialsFrom } from '@/lib/auth'
import {
  fetchMySocialAccount,
  resolveMySocialConnectorId,
  unlinkMySocialIdentity,
  type MySocialAccountDto,
  type MySocialIdentityDto
} from '@/lib/api'
import {
  LogtoAccountError,
  accountErrorMessage,
  createSocialState,
  createSocialVerification,
  requestEmailVerification,
  verifyEmailCode,
  writeSocialLinkFlow,
  type AccountNotice
} from '@/lib/logto-account'
import { rememberOwnershipProof, reusableOwnershipProof } from '@/lib/ownership-proof'
import { socialLoginProviders, type SocialLoginProvider } from '@/lib/social-login-providers'

const byTarget = (account: MySocialAccountDto, target: string): MySocialIdentityDto | undefined =>
  account.identities.find((identity) => identity.target === target)

/** Name the workspace the way its own members would. The `T…` id is a last
 *  resort — it is an id, not a name, and readers here manage their own accounts. */
const workspaceLabel = (workspace: NonNullable<MySocialIdentityDto['workspace']>): string =>
  workspace.name ?? (workspace.domain ? `${workspace.domain}.slack.com` : workspace.teamId)

/**
 * Height a row's identity cell reserves, so the row is the same height whether it
 * is still loading, unlinked, or linked — the card used to grow as the first fetch
 * landed. Two text lines fit inside the avatar; only Slack adds a third, since the
 * CP populates `workspace` for that target alone.
 */
const detailReserve = (provider: SocialLoginProvider): string => (provider.target === 'slack' ? 'min-h-12' : 'min-h-8')

/** The same bare mark the sign-in page uses, at the same size. The box stays
 *  fixed-width so three differently-shaped marks still line the names up; it
 *  carries no plate, which was making one row of a list look like a tile. */
function ProviderMark({ provider }: { provider: SocialLoginProvider }) {
  return (
    <span className="flex h-7 w-7 items-center justify-center">
      <SocialLoginMark target={provider.target} size={18} />
    </span>
  )
}

function UnlinkDialog({
  provider,
  onConfirm,
  onClose
}: {
  provider: SocialLoginProvider
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const titleId = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  const submit = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await onConfirm()
    } catch (caught) {
      setError(accountErrorMessage(caught, { providerName: provider.name }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="scrim">
      <div className="modal max-w-[480px]" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modalhead">
          <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
            <Icon name="unlink" size={16} color="var(--brand)" />
          </span>
          <span id={titleId} className="flex-1 font-sans text-[16px] font-semibold leading-normal">
            Unlink {provider.name}
          </span>
          <button type="button" className="iconbtn" aria-label="Close" disabled={busy} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody">
          <p className="font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-secondary)">
            {provider.name} will no longer be available for signing in to this account.
          </p>
          {error ? (
            <div className="mt-3 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)" role="alert">
              {error}
            </div>
          ) : null}
        </div>
        <div className="modalfoot">
          <div className="flex-1" />
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Unlinking…' : `Unlink ${provider.name}`}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Proves the caller still owns THIS account before its sign-in methods change.
 * Logto requires that proof whenever the account has a security verification
 * method, and it must be collected BEFORE the provider round trip — on return
 * the identity is saved straight away, with no UI left to ask in.
 */
function VerifyAccountDialog({
  provider,
  email,
  onVerified,
  onClose
}: {
  provider: SocialLoginProvider
  email?: string
  onVerified: (currentVerificationRecordId: string, expiresAt: string) => Promise<void>
  onClose: () => void
}) {
  const titleId = useId()
  // Held together: the record is only reusable against the expiry Logto issued
  // with it, and that clock started when the code was sent.
  const [pending, setPending] = useState<{ verificationId: string; expiresAt: string }>()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  const submit = async () => {
    setBusy(true)
    setError(undefined)
    try {
      if (!email) {
        throw new LogtoAccountError('This account needs a verified email before sign-in methods can change.', 0)
      }
      if (!pending) {
        setPending(await requestEmailVerification(email))
        return
      }
      if (!code.trim()) {
        setError('Enter the verification code from your email.')
        return
      }
      await onVerified(await verifyEmailCode(email, pending.verificationId, code.trim()), pending.expiresAt)
    } catch (caught) {
      setError(accountErrorMessage(caught, { providerName: provider.name, linking: true }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="scrim">
      <div className="modal max-w-[480px]" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modalhead">
          <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
            <Icon name="shield-check" size={16} color="var(--brand)" />
          </span>
          <span id={titleId} className="flex-1 font-sans text-[16px] font-semibold leading-normal">
            Link {provider.name}
          </span>
          <button type="button" className="iconbtn" aria-label="Close" disabled={busy} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody">
          <p className="font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-secondary)">
            {pending
              ? `Enter the code sent to ${email ?? 'your email'}, then continue to ${provider.name}.`
              : `To protect your account, verify it's you with a code sent to ${email ?? 'your email'}.`}
          </p>
          {pending ? (
            // A short code, not prose: centred, spaced and monospaced so the
            // digits read as a group. `.inp` is the wrong shape here — it spans
            // the dialog for a handful of characters, and it defines no focus
            // style, so it falls back to the browser's own ring.
            <div className="mt-4 flex justify-center">
              <input
                aria-label="Verification code"
                className="w-[190px] rounded-lg border border-(--border-default) bg-(--surface-card) px-3 py-2.5 text-center indent-[0.32em] font-mono text-[19px] font-medium tracking-[0.32em] text-(--text-primary) outline-none focus:border-(--border-focus) focus:ring-[3px] focus:ring-(--brand-ring)"
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                onChange={(event) => setCode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submit()
                }}
              />
            </div>
          ) : null}
          {error ? (
            <div className="mt-3 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)" role="alert">
              {error}
            </div>
          ) : null}
        </div>
        <div className="modalfoot">
          <div className="flex-1" />
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Working…' : pending ? `Continue to ${provider.name}` : 'Send code'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * A secondary detail line that becomes a link when we can address the thing it
 * names. Falls back to plain text rather than a dead link — a provider that
 * gave us no handle (a GitHub identity with no login, a Slack workspace with no
 * domain) should still read normally.
 */
function ExternalLine({ href, mono = false, children }: { href?: string; mono?: boolean; children: ReactNode }) {
  const type = mono ? 'font-mono text-[11.5px]' : 'font-sans text-[11.5px]'
  const base = `block truncate ${type} font-normal leading-normal text-(--text-tertiary)`
  if (!href) return <div className={base}>{children}</div>
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`${base} hover:text-(--text-secondary) hover:underline`}
    >
      {children}
    </a>
  )
}

function Notice({ notice }: { notice: AccountNotice }) {
  return (
    <div
      className="border-b border-(--border-subtle) px-4 py-2.5 font-sans text-[12.5px] font-normal leading-normal text-(--status-error)"
      role="status"
    >
      {notice.message}
    </div>
  )
}

export default function SocialSignInCard({
  mobile = false,
  notice,
  onNotice
}: {
  mobile?: boolean
  notice?: AccountNotice
  onNotice: (notice: AccountNotice) => void
}) {
  const {
    data: account,
    error,
    isValidating,
    mutate
  } = useSWR('logto-account-sign-in-methods', fetchMySocialAccount, {
    // Provider rows are static; linked identity details load once per mount
    // and refresh only after an explicit retry or mutation.
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    shouldRetryOnError: false
  })
  const [pendingUnlink, setPendingUnlink] = useState<SocialLoginProvider>()
  const [pendingVerify, setPendingVerify] = useState<SocialLoginProvider>()
  const [busyProvider, setBusyProvider] = useState<SocialLoginProvider['target']>()
  const currentAccount = error ? undefined : account
  const linkedProviderCount = currentAccount
    ? socialLoginProviders().filter((provider) => byTarget(currentAccount, provider.target)).length
    : 0

  // Logto refuses an identity change the caller has not re-proven, so accounts
  // with a security verification method take the code detour first.
  const beginLink = (provider: SocialLoginProvider) => {
    if (currentAccount?.hasSecurityVerificationMethod) {
      // One code covers every link in its window, so a second provider in the
      // same sitting reuses the proof instead of asking again.
      const proof = reusableOwnershipProof()
      if (proof) {
        void startLink(provider, proof)
        return
      }
      setPendingVerify(provider)
      return
    }
    void startLink(provider)
  }

  const startLink = async (provider: SocialLoginProvider, currentVerificationRecordId?: string) => {
    setBusyProvider(provider.target)
    try {
      const state = createSocialState()
      // Two hops on purpose: only the CP can name the connector, and only the
      // browser can authorize it (the Account API is the side with a session).
      const { connectorId } = await resolveMySocialConnectorId(provider.target)
      const redirectUri = `${window.location.origin}/auth/social/callback`
      const { authorizationUri, verificationRecordId } = await createSocialVerification(connectorId, redirectUri, state)
      const stored = writeSocialLinkFlow({
        state,
        connectorId,
        verificationRecordId,
        redirectUri,
        ...(currentVerificationRecordId ? { currentVerificationRecordId } : {}),
        providerName: provider.name,
        returnTo: `${window.location.pathname}${window.location.search}`,
        createdAt: Date.now()
      })
      if (!stored) {
        throw new LogtoAccountError('This browser blocked the temporary account-linking state.', 0)
      }
      window.location.assign(authorizationUri)
    } catch (caught) {
      onNotice({
        message: accountErrorMessage(caught, { providerName: provider.name, linking: true })
      })
      setBusyProvider(undefined)
    }
  }

  const unlink = async (provider: SocialLoginProvider) => {
    await unlinkMySocialIdentity(provider.target)
    await mutate()
    setPendingUnlink(undefined)
  }

  const shell = mobile
    ? 'overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card) shadow-(--shadow-xs)'
    : 'card mt-[22px]'
  const header = mobile ? 'border-b border-(--border-subtle) px-4 py-3' : 'cardhead'

  return (
    <>
      <section id="sign-in-methods" className={shell} aria-label="Sign-in methods">
        <div className={header}>
          <div className={mobile ? '' : 'flex flex-col gap-0.5'}>
            <div className={mobile ? 'font-sans text-[14px] font-semibold leading-normal' : 'cardtitle'}>
              Sign-in methods
            </div>
            {!mobile ? (
              <div className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                Link more than one social account to the same AgentConnect profile.
              </div>
            ) : null}
          </div>
        </div>

        {notice ? <Notice notice={notice} /> : null}

        {!isValidating && (error || !account) ? (
          <div className="flex items-center justify-between gap-4 px-4 py-4">
            <span className="font-sans text-[13px] font-normal leading-normal text-(--status-error)">
              {accountErrorMessage(error)}
            </span>
            <Button variant="secondary" size="xs" onClick={() => void mutate()}>
              Retry
            </Button>
          </div>
        ) : null}

        <div aria-busy={isValidating}>
          {socialLoginProviders().map((provider, index) => {
            const details = currentAccount ? byTarget(currentAccount, provider.target) : undefined
            const workspace = details?.workspace
            const canUnlink = linkedProviderCount > 1
            return (
              <div
                key={provider.target}
                className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3.5 desktop:grid-cols-[170px_minmax(0,1fr)_auto] ${
                  index > 0 ? 'border-t border-(--border-subtle)' : ''
                }`}
              >
                <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-3">
                  <ProviderMark provider={provider} />
                  <span className="truncate font-sans text-[13.5px] font-semibold leading-normal">{provider.name}</span>
                </div>
                <div
                  className={`col-span-2 row-start-2 flex ${detailReserve(provider)} min-w-0 items-center desktop:col-span-1 desktop:col-start-2 desktop:row-start-1`}
                >
                  {currentAccount ? (
                    details ? (
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Avatar
                          src={details?.avatar}
                          initials={initialsFrom(details?.name ?? provider.name, details?.email)}
                          size={32}
                          fontSize={11}
                        />
                        <div className="min-w-0">
                          <div className="truncate font-sans text-[13px] font-medium leading-normal">
                            {details?.name ?? 'Linked'}
                          </div>
                          {details?.email ? (
                            <ExternalLine href={details.profileUrl} mono>
                              {details.email}
                            </ExternalLine>
                          ) : null}
                          {workspace ? (
                            <ExternalLine href={workspace.url}>{workspaceLabel(workspace)}</ExternalLine>
                          ) : null}
                        </div>
                      </div>
                    ) : (
                      <span className="font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
                        Not linked
                      </span>
                    )
                  ) : !error ? (
                    // First-load placeholder shaped like the identity that replaces it.
                    <div className="flex min-w-0 items-center gap-2.5" aria-hidden="true">
                      <span className="h-8 w-8 flex-none animate-pulse rounded-full bg-(--surface-active)" />
                      <span className="min-w-0">
                        <span className="block h-[11px] w-24 animate-pulse rounded-full bg-(--surface-active)" />
                        <span className="mt-[7px] block h-[9px] w-40 animate-pulse rounded-full bg-(--surface-active)" />
                        {provider.target === 'slack' ? (
                          <span className="mt-[7px] block h-[9px] w-20 animate-pulse rounded-full bg-(--surface-active)" />
                        ) : null}
                      </span>
                    </div>
                  ) : null}
                </div>
                <div className="col-start-2 row-start-1 flex items-center justify-end gap-1 desktop:col-start-3">
                  {currentAccount ? (
                    details ? (
                      canUnlink ? (
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={busyProvider !== undefined}
                          onClick={() => setPendingUnlink(provider)}
                        >
                          <span className="text-(--status-error)">Unlink</span>
                        </Button>
                      ) : null
                    ) : (
                      <Button
                        variant="secondary"
                        size="xs"
                        disabled={busyProvider !== undefined}
                        onClick={() => beginLink(provider)}
                      >
                        <Icon name="link" size={14} />
                        {busyProvider === provider.target ? 'Linking…' : 'Link'}
                      </Button>
                    )
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {pendingUnlink ? (
        <UnlinkDialog
          key={pendingUnlink.target}
          provider={pendingUnlink}
          onConfirm={() => unlink(pendingUnlink)}
          onClose={() => setPendingUnlink(undefined)}
        />
      ) : null}

      {pendingVerify ? (
        <VerifyAccountDialog
          key={pendingVerify.target}
          provider={pendingVerify}
          email={currentAccount?.primaryEmail}
          onVerified={async (currentVerificationRecordId, expiresAt) => {
            setPendingVerify(undefined)
            rememberOwnershipProof(currentVerificationRecordId, expiresAt)
            await startLink(pendingVerify, currentVerificationRecordId)
          }}
          onClose={() => setPendingVerify(undefined)}
        />
      ) : null}
    </>
  )
}
