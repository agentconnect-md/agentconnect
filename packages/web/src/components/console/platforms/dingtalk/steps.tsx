// No 'use client' here: rendered only inside ModalProvider's tree (the client boundary).

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { BrowserBar, MiniScreen, type WalkthroughStep } from '../wizard-chrome'

type DingTalkStepsTranslator = ReturnType<typeof useTranslations<'Platforms.dingtalk.steps'>>

const HOST = 'open-dev.dingtalk.com'

// The developer console's highlighted control in each mock screen.
function Pulse({ children }: { children: ReactNode }) {
  return (
    <span className="relative rounded bg-[#007fff] px-2.5 py-[3px] font-sans text-[9px] font-semibold leading-normal text-white">
      {children}
      <span className="pointer-events-none absolute -inset-[3px] step-pulse rounded ring-2 ring-[#007fff]" />
    </span>
  )
}

function Label({ children }: { children: ReactNode }) {
  return <div className="mt-2 font-sans text-[8px] font-semibold leading-normal text-[#5f6266]">{children}</div>
}

function Input({ children }: { children: ReactNode }) {
  return (
    <div className="mt-1 rounded border border-[#e5e6eb] bg-white px-2 py-1 font-sans text-[9.5px] leading-normal text-[#171a1d]">
      {children}
    </div>
  )
}

// An app page: the console's left navigation with one entry current, and that entry's page.
function AppPage({ nav, active, children }: { nav: string[]; active: string; children: ReactNode }) {
  return (
    <div className="absolute inset-0 flex bg-white">
      <div className="w-[84px] flex-none border-r border-[#e5e6eb] bg-[#f5f6f7] px-1.5 py-2">
        {nav.map((n) => (
          <div
            key={n}
            className={`truncate rounded px-1.5 py-1 font-sans text-[8px] leading-normal ${
              n === active ? 'bg-[#e6f2ff] font-bold text-[#007fff]' : 'text-[#5f6266]'
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

// The developer console from a new internal app to its credentials; built per locale so every label follows the console language.
export function dingTalkWalkthroughSteps(t: DingTalkStepsTranslator): WalkthroughStep[] {
  const strong = (chunks: ReactNode) => <span className="font-medium text-(--text-secondary)">{chunks}</span>
  const nav = [t('nav.credentials'), t('nav.robot'), t('nav.permissions'), t('nav.versions')]
  const title = (text: string) => (
    <div className="font-sans text-[10.5px] font-bold leading-normal text-[#171a1d]">{text}</div>
  )
  return [
    {
      label: t('createApp.label'),
      caption: t.rich('createApp.caption', { action: strong }),
      screen: (
        <MiniScreen frameClass="border-[#e5e6eb] bg-[#f5f6f7]" bar={<BrowserBar url={`${HOST}/fe/app`} />}>
          <div className="absolute inset-0 bg-[#f5f6f7] px-3 py-2.5">
            <div className="font-sans text-[10px] font-bold leading-normal text-[#171a1d]">{t('createApp.title')}</div>
            <div className="mt-2 rounded-md border border-[#e5e6eb] bg-white p-2 shadow-(--shadow-md)">
              {title(t('createApp.cardTitle'))}
              <Label>
                {t('createApp.nameLabel')} <span className="text-[#ff5219]">*</span>
              </Label>
              <Input>{t('createApp.nameValue')}</Input>
              <Label>{t('createApp.descriptionLabel')}</Label>
              <Input>{t('createApp.descriptionValue')}</Input>
              <div className="mt-2 flex justify-end">
                <Pulse>{t('createApp.save')}</Pulse>
              </div>
            </div>
          </div>
        </MiniScreen>
      )
    },
    {
      label: t('robot.label'),
      caption: t.rich('robot.caption', { action: strong }),
      screen: (
        <MiniScreen frameClass="border-[#e5e6eb] bg-white" bar={<BrowserBar url={`${HOST}/fe/app/…`} />}>
          <AppPage nav={nav} active={t('nav.robot')}>
            {title(t('robot.title'))}
            <Label>
              {t('robot.previewLabel')} <span className="text-[#ff5219]">*</span>
            </Label>
            <div className="mt-1 flex h-9 w-14 items-center justify-center rounded border border-dashed border-[#c9cdd4] text-[#007fff]">
              <Icon name="image" size={12} />
            </div>
            <Label>{t('robot.modeLabel')}</Label>
            <div className="mt-1 flex items-center gap-2.5 font-sans text-[9px] leading-normal text-[#171a1d]">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full border-[3px] border-[#007fff]" />
                {t('robot.stream')}
              </span>
              <span className="flex items-center gap-1 text-[#5f6266]">
                <span className="h-2 w-2 rounded-full border border-[#c9cdd4]" />
                {t('robot.http')}
              </span>
            </div>
            <div className="mt-2.5">
              <Pulse>{t('robot.publish')}</Pulse>
            </div>
          </AppPage>
        </MiniScreen>
      )
    },
    {
      label: t('permissions.label'),
      caption: t.rich('permissions.caption', { action: strong }),
      screen: (
        <MiniScreen frameClass="border-[#e5e6eb] bg-white" bar={<BrowserBar url={`${HOST}/fe/app/…`} />}>
          <AppPage nav={nav} active={t('nav.permissions')}>
            {title(t('nav.permissions'))}
            <div className="mt-1.5 flex items-center gap-1 rounded border border-[#e5e6eb] px-1.5 py-1 font-sans text-[9px] leading-normal text-[#171a1d]">
              <Icon name="search" size={9} className="text-[#5f6266]" />
              Card
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-1.5 border-b border-[#f0f1f2] pb-1.5">
              <span className="mono min-w-0 truncate text-[8.5px] leading-normal text-[#171a1d]">
                Card.Instance.Write
              </span>
              <Pulse>{t('permissions.apply')}</Pulse>
            </div>
          </AppPage>
        </MiniScreen>
      )
    },
    {
      label: t('publish.label'),
      caption: t.rich('publish.caption', { action: strong }),
      screen: (
        <MiniScreen frameClass="border-[#e5e6eb] bg-white" bar={<BrowserBar url={`${HOST}/fe/app/…`} />}>
          <AppPage nav={nav} active={t('nav.versions')}>
            {title(t('publish.title'))}
            <Label>{t('publish.versionLabel')}</Label>
            <Input>1.0.0</Input>
            <Label>{t('publish.visibilityLabel')}</Label>
            <Input>{t('publish.visibilityValue')}</Input>
            <div className="mt-2.5">
              <Pulse>{t('publish.save')}</Pulse>
            </div>
          </AppPage>
        </MiniScreen>
      )
    },
    {
      label: t('credentials.label'),
      caption: t.rich('credentials.caption', { action: strong }),
      screen: (
        <MiniScreen frameClass="border-[#e5e6eb] bg-white" bar={<BrowserBar url={`${HOST}/fe/app/…`} />}>
          <AppPage nav={nav} active={t('nav.credentials')}>
            {title(t('credentials.title'))}
            <Label>Client ID</Label>
            <div className="mt-1 flex items-center gap-1.5">
              <span className="mono min-w-0 flex-1 truncate text-[9px] leading-normal text-[#171a1d]">
                dingxxxxxxxxxxxxxxxx
              </span>
              <span className="relative flex-none text-[#007fff]">
                <Icon name="copy" size={10} />
                <span className="pointer-events-none absolute -inset-[3px] step-pulse rounded ring-2 ring-[#007fff]" />
              </span>
            </div>
            <Label>Client Secret</Label>
            <div className="mt-1 flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate font-sans text-[9px] leading-normal tracking-tight text-[#171a1d]">
                ••••••••••••••••
              </span>
              <span className="flex flex-none items-center gap-1 text-[#007fff]">
                <Icon name="copy" size={10} />
                <Icon name="eye" size={10} />
              </span>
            </div>
          </AppPage>
        </MiniScreen>
      )
    }
  ]
}
