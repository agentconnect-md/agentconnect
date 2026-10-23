// No 'use client' here: rendered only inside ModalProvider's tree (the client boundary).

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { BrowserBar, MiniScreen, type WalkthroughStep } from '../wizard-chrome'

type MsTeamsStepsTranslator = ReturnType<typeof useTranslations<'Platforms.msteams.steps'>>

const PORTAL = 'dev.teams.microsoft.com'
const SAMPLE_ID = '00000000-0000-0000-0000-000000000000'

// The portal's highlighted control in each mock screen.
function Pulse({ children }: { children: ReactNode }) {
  return (
    <span className="relative rounded bg-[#5b5fc7] px-2.5 py-[3px] font-sans text-[9px] font-semibold leading-normal text-white">
      {children}
      <span className="pointer-events-none absolute -inset-[3px] step-pulse rounded ring-2 ring-[#5b5fc7]" />
    </span>
  )
}

// A copy control the step points at, in the portal's or Entra's accent; literal class strings (STYLE.md §8).
const COPY_PULSE = {
  portal: { icon: 'text-[#5b5fc7]', ring: 'ring-[#5b5fc7]' },
  entra: { icon: 'text-[#0078d4]', ring: 'ring-[#0078d4]' }
} as const

function CopyPulse({ accent }: { accent: keyof typeof COPY_PULSE }) {
  return (
    <span className={`relative flex-none ${COPY_PULSE[accent].icon}`}>
      <Icon name="copy" size={10} />
      <span
        className={`pointer-events-none absolute -inset-[3px] step-pulse rounded ring-2 ${COPY_PULSE[accent].ring}`}
      />
    </span>
  )
}

function Label({ children }: { children: ReactNode }) {
  return <div className="mt-2 font-sans text-[8px] font-semibold leading-normal text-[#616161]">{children}</div>
}

function Input({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return (
    <div
      className={`mt-1 truncate rounded border border-[#d1d1d1] bg-white px-2 py-1 text-[9px] leading-normal text-[#242424] ${mono ? 'mono' : 'font-sans'}`}
    >
      {children}
    </div>
  )
}

function Title({ children }: { children: ReactNode }) {
  return <div className="font-sans text-[10.5px] font-bold leading-normal text-[#242424]">{children}</div>
}

// A bot's page in the portal: its left navigation with one entry current, and that entry's page.
function BotPage({ nav, active, children }: { nav: string[]; active: string; children: ReactNode }) {
  return (
    <div className="absolute inset-0 flex bg-white">
      <div className="w-[84px] flex-none border-r border-[#e0e0e0] bg-[#f5f5f5] px-1.5 py-2">
        {nav.map((n) => (
          <div
            key={n}
            className={`truncate rounded px-1.5 py-1 font-sans text-[8px] leading-normal ${
              n === active ? 'bg-[#e8ebfa] font-bold text-[#5b5fc7]' : 'text-[#616161]'
            }`}
          >
            {n}
          </div>
        ))}
      </div>
      <div className="min-w-0 flex-1 px-2.5 py-2">{children}</div>
    </div>
  )
}

/** The Developer Portal from a new bot to its credentials, then the tenant ID in Microsoft Entra; built per locale so every label follows the console language. */
export function msTeamsWalkthroughSteps(t: MsTeamsStepsTranslator, endpoint: string | null): WalkthroughStep[] {
  const strong = (chunks: ReactNode) => <span className="font-medium text-(--text-secondary)">{chunks}</span>
  const nav = [t('nav.configure'), t('nav.secrets')]
  const portal = (path: string, children: ReactNode) => (
    <MiniScreen frameClass="border-[#e0e0e0] bg-white" bar={<BrowserBar url={`${PORTAL}${path}`} />}>
      {children}
    </MiniScreen>
  )
  const configure = (focus: 'endpoint' | 'botId') =>
    portal(
      '/bots/…/configure',
      <BotPage nav={nav} active={t('nav.configure')}>
        <Title>{t('nav.configure')}</Title>
        <Label>{t('configure.botId')}</Label>
        <div className="mt-1 flex items-center gap-1.5">
          <span className="mono min-w-0 flex-1 truncate text-[8.5px] leading-normal text-[#242424]">{SAMPLE_ID}</span>
          {focus === 'botId' ? (
            <CopyPulse accent="portal" />
          ) : (
            <span className="flex-none text-[#5b5fc7]">
              <Icon name="copy" size={10} />
            </span>
          )}
        </div>
        <Label>{t('configure.endpoint')}</Label>
        <Input mono>{endpoint ?? 'https://…/msteams/messages'}</Input>
        <div className="mt-2.5">
          {focus === 'endpoint' ? (
            <Pulse>{t('configure.save')}</Pulse>
          ) : (
            <span className="rounded bg-[#5b5fc7] px-2.5 py-[3px] font-sans text-[9px] font-semibold leading-normal text-white">
              {t('configure.save')}
            </span>
          )}
        </div>
      </BotPage>
    )
  return [
    {
      label: t('newBot.label'),
      caption: t.rich('newBot.caption', { action: strong }),
      screen: portal(
        '/tools/bots',
        <div className="absolute inset-0 bg-[#f5f5f5] px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <Title>{t('newBot.title')}</Title>
            <span className="rounded bg-[#5b5fc7] px-1.5 py-[3px] font-sans text-[8.5px] font-semibold leading-normal text-white">
              + {t('newBot.newBot')}
            </span>
          </div>
          <div className="mt-2 rounded-md border border-[#e0e0e0] bg-white p-2 shadow-(--shadow-md)">
            <Title>{t('newBot.dialogTitle')}</Title>
            <Label>{t('newBot.nameLabel')}</Label>
            <Input>{t('newBot.nameValue')}</Input>
            <div className="mt-2 flex justify-end">
              <Pulse>{t('newBot.add')}</Pulse>
            </div>
          </div>
        </div>
      )
    },
    {
      label: t('endpoint.label'),
      caption: t.rich('endpoint.caption', { action: strong }),
      screen: configure('endpoint')
    },
    {
      label: t('secret.label'),
      caption: t.rich('secret.caption', { action: strong }),
      screen: portal(
        '/bots/…/client-secrets',
        <BotPage nav={nav} active={t('nav.secrets')}>
          <Title>{t('nav.secrets')}</Title>
          <div className="mt-1.5 inline-block rounded border border-[#d1d1d1] px-1.5 py-[3px] font-sans text-[8.5px] font-semibold leading-normal text-[#242424]">
            {t('secret.add')}
          </div>
          <div className="mt-2 rounded-md border border-[#e0e0e0] bg-white p-2 shadow-(--shadow-md)">
            <div className="font-sans text-[8.5px] leading-snug text-[#616161]">{t('secret.once')}</div>
            <div className="mt-1.5 flex items-center gap-1.5">
              <span className="mono min-w-0 flex-1 truncate text-[8.5px] leading-normal text-[#242424]">
                Ab1~xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
              </span>
              <CopyPulse accent="portal" />
            </div>
          </div>
        </BotPage>
      )
    },
    { label: t('botId.label'), caption: t.rich('botId.caption', { action: strong }), screen: configure('botId') },
    {
      label: t('tenant.label'),
      caption: t.rich('tenant.caption', { action: strong }),
      screen: (
        <MiniScreen
          frameClass="border-[#e0e0e0] bg-white"
          bar={<BrowserBar url="entra.microsoft.com/#view/…/RegisteredApps" />}
        >
          <div className="absolute inset-0 bg-white px-3 py-2.5">
            <Title>{t('newBot.nameValue')}</Title>
            <div className="mt-1 font-sans text-[8.5px] font-semibold leading-normal text-[#242424]">
              {t('tenant.essentials')}
            </div>
            <Label>{t('tenant.clientId')}</Label>
            <div className="mono mt-1 truncate text-[8.5px] leading-normal text-[#0078d4]">{SAMPLE_ID}</div>
            <Label>{t('tenant.tenantId')}</Label>
            <div className="mt-1 flex items-center gap-1.5">
              <span className="mono min-w-0 flex-1 truncate text-[8.5px] leading-normal text-[#242424]">
                {SAMPLE_ID}
              </span>
              <CopyPulse accent="entra" />
            </div>
          </div>
        </MiniScreen>
      )
    }
  ]
}
