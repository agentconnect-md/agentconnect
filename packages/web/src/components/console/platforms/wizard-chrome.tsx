// No 'use client' here: rendered only inside ModalProvider's tree (the client boundary).

import { useEffect, useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { useIsMobile } from '@/lib/use-is-mobile'
import type { WebWizardTransport } from './contract'

// Wizard chrome and copy shared by more than one platform module. Nothing here
// knows a platform id — a module passes its own vocabulary in (delivery labels,
// portal copy, walkthrough steps), which is exactly what keeps these pieces
// reusable without the chassis growing a platform branch.

/** The host messages a mode card can name. `region` is for Feishu's two clouds,
 *  which are one platform id; every other module has a single pair. */
export type IdentityCards = {
  create: string
  existing: string
}
export type IdentityCardKey =
  | 'Integrations.dialog.identityCards.slack.create'
  | 'Integrations.dialog.identityCards.slack.existing'
  | 'Integrations.dialog.identityCards.telegram.create'
  | 'Integrations.dialog.identityCards.telegram.existing'
  | 'Integrations.dialog.identityCards.discord.create'
  | 'Integrations.dialog.identityCards.discord.existing'
  | 'Integrations.dialog.identityCards.linear.create'
  | 'Integrations.dialog.identityCards.linear.existing'
  | 'Integrations.dialog.identityCards.feishuLark.create'
  | 'Integrations.dialog.identityCards.feishuLark.existing'
  | 'Integrations.dialog.identityCards.feishuFeishu.create'
  | 'Integrations.dialog.identityCards.feishuFeishu.existing'

/** The mode-card pair for a module with one brand. */
export function identityCards(platform: 'slack' | 'telegram' | 'discord' | 'linear' | 'lark' | 'feishu'): {
  create: IdentityCardKey
  existing: IdentityCardKey
} {
  // Lark and Feishu are one platform id with two clouds; the pair is the only
  // thing that differs, so the key segment is the only thing this maps.
  const segment =
    platform === 'lark' || platform === 'feishu' ? `feishu${platform === 'lark' ? 'Lark' : 'Feishu'}` : platform
  return {
    create: `Integrations.dialog.identityCards.${segment}.create` as IdentityCardKey,
    existing: `Integrations.dialog.identityCards.${segment}.existing` as IdentityCardKey
  }
}

/** The one-line "invite the bot" hint a chat module hands the host
 *  ({@link WebWizardFacet.inviteHint}); the phrasing is shared so several modules
 *  cannot drift into several different sentences. Returns the message and the
 *  values, never a sentence — the host resolves it for the active locale. */
/** A room noun for the hint. Linear's arm names an ISSUE it delegates to the app,
 *  which is why this is not just the two chat rooms. */
export type InviteHintTarget = 'channel' | 'group' | 'issue'

/** The host messages an invite hint can name — the two arms of its hint row. */
export type InviteHint = {
  key: 'Integrations.dialog.platformHints.listen' | 'Integrations.dialog.platformHints.mention'
  values: { target: InviteHintTarget; platform: string }
}

export function inviteBotHint(target: InviteHintTarget, platform: string, mention = false): InviteHint {
  return {
    key: mention ? 'Integrations.dialog.platformHints.mention' : 'Integrations.dialog.platformHints.listen',
    values: { target, platform }
  }
}

/**
 * The one-line delivery-mode note. It names the current inbound transport and,
 * when possible, offers a subtle underlined switch. HTTP is only offerable when
 * the deployment has public callback delivery; `locked` pins a flow that has
 * already created an app for one transport.
 *
 * `labels` is resolved copy. A module keeps its transport vocabulary as message
 * keys in {@link WebTransportAffordance.labels} — the declaration the registry
 * and its tests read — and its Body resolves them, so the host never spells a
 * platform's transport vocabulary.
 */
export function DeliveryLine({
  labels,
  transport,
  relayAvailable,
  locked,
  onSwitch
}: {
  labels: Record<WebWizardTransport, string>
  transport: WebWizardTransport
  relayAvailable: boolean
  locked: boolean
  onSwitch: (next: WebWizardTransport) => void
}) {
  const t = useTranslations('Platforms.chrome')
  const next = transport === 'http' ? 'socket' : 'http'
  // Switching TO http needs a connected relay; switching back to socket is always fine.
  const canSwitch = !locked && (next === 'socket' || relayAvailable)
  return (
    <div className="mt-[6px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
      {t('delivery.label')} <span className="text-(--text-secondary)">{labels[transport]}</span>.
      {canSwitch && (
        <>
          {' '}
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0 font-sans text-[11.5px] leading-normal text-(--text-tertiary) underline underline-offset-2 hover:text-(--text-secondary)"
            onClick={() => onSwitch(next)}
          >
            {t('delivery.switchTo', { transport: labels[next] })}
          </button>
        </>
      )}
    </div>
  )
}

// One step of a bot-setup walkthrough: the chip label, the mini-screen it shows, and the
// caption under it. Kept together so the three can't drift apart.
export type WalkthroughStep = { label: string; caption: React.ReactNode; screen: React.ReactNode }

// The walkthrough itself: step chips on top, one fixed-size mini-screen, a caption below.
// Auto-advances every ~3s; hovering or focusing a chip pins that step, leaving the row resumes
// the loop. Positioning is the caller's job — it is a popover on desktop and an inline panel on
// mobile, and the interval only runs while it is mounted (i.e. actually on screen).
function WalkthroughPanel({ steps }: { steps: WalkthroughStep[] }) {
  const [step, setStep] = useState(0)
  const [pinned, setPinned] = useState<number | null>(null)

  // Auto-advance only while nothing is pinned and the user hasn't asked for reduced motion.
  useEffect(() => {
    if (pinned !== null) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const t = setInterval(() => setStep((s) => (s + 1) % steps.length), 3200)
    return () => clearInterval(t)
  }, [pinned, steps.length])

  const shown = (pinned ?? step) % steps.length
  const pin = (i: number) => {
    setPinned(i)
    setStep(i)
  }

  return (
    <div className="rounded-xl border border-(--border-default) bg-(--surface-card) p-2 shadow-(--shadow-xl)">
      <div className="mb-2 flex gap-1" onMouseLeave={() => setPinned(null)}>
        {steps.map((s, i) => (
          <button
            key={s.label}
            type="button"
            aria-current={i === shown}
            onMouseEnter={() => pin(i)}
            onFocus={() => pin(i)}
            onBlur={() => setPinned(null)}
            onClick={() => pin(i)}
            className={`flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 font-sans text-[10px] font-semibold leading-normal transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand) ${
              i === shown
                ? 'bg-(--surface-inverse) text-white'
                : 'bg-(--surface-app) text-(--text-tertiary) hover:text-(--text-secondary)'
            }`}
          >
            <span className={`mono text-[9px] ${i === shown ? 'opacity-70' : 'opacity-60'}`}>{i + 1}</span>
            <span className="truncate">{s.label}</span>
          </button>
        ))}
      </div>
      {steps[shown]?.screen}
      <div className="mt-1.5 px-1 font-sans text-[10.5px] font-normal leading-[1.45] text-(--text-secondary)">
        {steps[shown]?.caption}
      </div>
    </div>
  )
}

// The disclosure around the walkthrough, rendered inside the `group relative` wrapper of a
// platform's portal button. Desktop: a popover above the button, revealed on hover AND on
// keyboard focus anywhere in the group (the OutputModeHelp pattern) — it stays `invisible`
// while closed so its chips are out of the tab order and can never eat the button's click.
// Mobile: hover doesn't exist and the modal body would clip a popover, so it becomes an
// explicit toggle with the panel expanding inline underneath.
export function BotSetupWalkthrough({ steps, label }: { steps: WalkthroughStep[]; label: string }) {
  const t = useTranslations('Platforms.chrome')
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const panelId = useId()

  if (isMobile) {
    return (
      <>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-(--border-default) bg-(--surface-card) py-[7px] font-sans text-[12px] font-semibold leading-normal text-(--text-secondary) transition-colors hover:border-(--border-strong) hover:bg-(--surface-hover)"
        >
          <Icon name="list-checks" size={13} />
          {open ? t('walkthrough.hide', { count: steps.length }) : t('walkthrough.show', { count: steps.length })}
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} />
        </button>
        {open && (
          <div id={panelId} className="mt-2">
            <WalkthroughPanel steps={steps} />
          </div>
        )}
      </>
    )
  }

  return (
    // The bottom padding bridges the gap to the button, so moving up onto the step chips never
    // drops the hover.
    <div
      role="group"
      aria-label={label}
      className="pointer-events-none invisible absolute bottom-full left-1/2 z-50 w-[320px] -translate-x-1/2 pb-2 opacity-0 transition-[opacity,visibility] group-hover:pointer-events-auto group-hover:visible group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:visible group-focus-within:opacity-100"
    >
      <WalkthroughPanel steps={steps} />
      <div className="pointer-events-none absolute bottom-[3px] left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 border-r border-b border-(--border-default) bg-(--surface-card)" />
    </div>
  )
}

// One mini-screen: a title bar plus a fixed-height body, so every step of a walkthrough is
// exactly the same size and the popover never jumps as it advances.
export function MiniScreen({
  frameClass,
  bar,
  children
}: {
  frameClass: string
  bar: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className={`overflow-hidden rounded-lg border ${frameClass}`}>
      {bar}
      <div className="relative h-[196px]">{children}</div>
    </div>
  )
}

// A browser chrome strip for previews of web consoles (matches the Slack config-token preview).
export function BrowserBar({ url }: { url: string }) {
  return (
    <div className="flex items-center gap-1.5 border-b border-[#e3e5e8] bg-[#f2f3f5] px-2.5 py-1.5">
      <span className="h-2 w-2 flex-none rounded-full bg-[#e0605a]" />
      <span className="h-2 w-2 flex-none rounded-full bg-[#e8b13a]" />
      <span className="h-2 w-2 flex-none rounded-full bg-[#4aa564]" />
      <span className="ml-1 min-w-0 truncate font-mono text-[9px] leading-normal text-[#5c5e66]">{url}</span>
    </div>
  )
}

/**
 * The "create a new bot" pane shape shared by the single-token platforms
 * (Telegram, Discord): an external portal link with its hover walkthrough, a
 * one-line setup instruction, optional setup warning, and one bot-token field.
 * `children` is the platform's own tail under the field — Telegram's Privacy
 * Mode status, Discord's ready-made invite.
 */
export function TokenGuidePane({
  mark,
  step1,
  step1Warning,
  linkHref,
  linkLabel,
  steps,
  walkthroughLabel,
  tokenPlaceholder,
  tokenValue,
  tokenInvalid,
  onTokenChange,
  children
}: {
  mark: React.ReactNode
  step1: string
  step1Warning?: string | undefined
  linkHref: string
  linkLabel: string
  steps: WalkthroughStep[]
  walkthroughLabel: string
  tokenPlaceholder: string
  tokenValue: string
  tokenInvalid: boolean
  onTokenChange: (next: string) => void
  children?: React.ReactNode
}) {
  const t = useTranslations('Platforms.chrome')
  return (
    <div className="mb-4 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px]">
      <div className="mb-3 flex gap-[10px]">
        <span className="mono mt-[1px] flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
          1
        </span>
        <div className="min-w-0 flex-1">
          <div className="mb-2 font-sans text-[12.5px] font-medium leading-[1.45] text-(--text-secondary)">{step1}</div>
          <div className="group relative">
            <a
              href={linkHref}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-[38px] items-center justify-center gap-2 rounded-md bg-(--surface-inverse) font-sans text-[13px] font-semibold leading-normal text-white no-underline"
            >
              <span className="imark h-[18px] w-[18px] border-0 bg-transparent">{mark}</span>
              {linkLabel}
              <Icon name="external-link" size={14} />
            </a>
            <BotSetupWalkthrough steps={steps} label={walkthroughLabel} />
          </div>
          {step1Warning && (
            <div className="mt-2 font-sans text-[12px] font-medium leading-[1.5] text-(--status-error)">
              {step1Warning}
            </div>
          )}
        </div>
      </div>
      <div className="mt-[14px] mb-[11px] flex items-center gap-[10px] border-t border-dashed border-(--border-default) pt-[13px]">
        <span className="mono flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
          2
        </span>
        <span className="font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
          {t('token.prompt')}
        </span>
      </div>
      <div className="pl-[30px]">
        <div className="fld">
          <span className="fldlbl">{t('token.label')}</span>
          <input
            className={`inp mn ${tokenInvalid ? 'border-(--status-error)' : ''}`}
            placeholder={tokenPlaceholder}
            value={tokenValue}
            onChange={(e) => onTokenChange(e.target.value)}
          />
        </div>
        {children}
      </div>
    </div>
  )
}
