// No 'use client' here: rendered only inside ModalProvider's tree (the client boundary).

import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { BrowserBar, MiniScreen, type WalkthroughStep } from '../wizard-chrome'

type FeishuStepsTranslator = ReturnType<typeof useTranslations<'Platforms.feishu.steps'>>

// Feishu's console (and Lark's, which is the same product on a different host) walked through
// the same way: create the self-built app, then copy the credential pair off "Credentials &
// Basic Info". It stops there on purpose — the remaining app-level settings (bot capability,
// Long Connection events, scopes, publishing) are the setup checklist further down the pane,
// and repeating them here would only duplicate it. Built per region so every label and
// the address bar say Feishu / open.feishu.cn or Lark / open.larksuite.com; built per locale
// so every chip label, caption and mock screen string follows the console language.
export function feishuWalkthroughSteps(
  t: FeishuStepsTranslator,
  brand: 'Feishu' | 'Lark',
  host: string
): WalkthroughStep[] {
  const nav = [
    t('idSecret.navCredentials'),
    t('idSecret.navCollaborators'),
    t('idSecret.navFeatures'),
    t('idSecret.navBot')
  ]
  const navItem = (name: string, active: string) => (
    <div
      key={name}
      className={`truncate rounded px-1.5 py-1 font-sans text-[8px] leading-normal ${
        name === active ? 'bg-[#e8f0ff] font-bold text-[#3370ff]' : 'text-[#646a73]'
      }`}
    >
      {name}
    </div>
  )
  return [
    {
      label: t('createApp.label'),
      caption: t.rich('createApp.caption', {
        brand,
        customApp: (chunks) => <span className="font-medium text-(--text-secondary)">{chunks}</span>
      }),
      screen: (
        <MiniScreen frameClass="border-[#dee0e3] bg-[#f5f6f7]" bar={<BrowserBar url={`${host}/app`} />}>
          <div className="absolute inset-0 bg-[#f5f6f7] px-3 py-2.5">
            <div className="font-sans text-[10px] font-bold leading-normal text-[#1f2329]">{t('createApp.title')}</div>
            <div className="mt-2 rounded-md border border-[#dee0e3] bg-white p-2 shadow-(--shadow-md)">
              <div className="font-sans text-[9.5px] font-bold leading-normal text-[#1f2329]">
                {t('createApp.customApp')}
              </div>
              <div className="mt-0.5 font-sans text-[8px] leading-snug text-[#646a73]">{t('createApp.note')}</div>
              <div className="mt-1.5 font-sans text-[8px] font-semibold leading-normal text-[#646a73]">
                {t('createApp.appName')}
              </div>
              <div className="mt-1 rounded border border-[#dee0e3] bg-white px-2 py-1 font-sans text-[9.5px] leading-normal text-[#1f2329]">
                {t('createApp.appNameValue')}
              </div>
              <div className="mt-1.5 flex justify-end gap-1.5">
                <span className="rounded px-2 py-[3px] font-sans text-[9px] font-semibold leading-normal text-[#646a73]">
                  {t('createApp.cancel')}
                </span>
                <span className="relative rounded bg-[#3370ff] px-2.5 py-[3px] font-sans text-[9px] font-semibold leading-normal text-white">
                  {t('createApp.create')}
                  <span className="pointer-events-none absolute -inset-[3px] step-pulse rounded ring-2 ring-[#3370ff]" />
                </span>
              </div>
            </div>
          </div>
        </MiniScreen>
      )
    },
    {
      label: t('idSecret.label'),
      caption: t.rich('idSecret.caption', {
        credentials: (chunks) => <span className="font-medium text-(--text-secondary)">{chunks}</span>
      }),
      screen: (
        <MiniScreen frameClass="border-[#dee0e3] bg-white" bar={<BrowserBar url={`${host}/app/…/baseinfo`} />}>
          <div className="absolute inset-0 flex bg-white">
            <div className="w-[88px] flex-none border-r border-[#dee0e3] bg-white px-1.5 py-2">
              <div className="px-1.5 pb-1 font-sans text-[7.5px] font-semibold uppercase leading-normal tracking-wide text-[#8f959e]">
                {t('idSecret.basicInfo')}
              </div>
              {nav.slice(0, 2).map((n) => navItem(n, t('idSecret.navCredentials')))}
              <div className="mt-1 px-1.5 pb-1 font-sans text-[7.5px] font-semibold uppercase leading-normal tracking-wide text-[#8f959e]">
                {t('idSecret.features')}
              </div>
              {nav.slice(2).map((n) => navItem(n, t('idSecret.navCredentials')))}
            </div>
            <div className="min-w-0 flex-1 px-2.5 py-2">
              <div className="font-sans text-[10.5px] font-bold leading-normal text-[#1f2329]">
                {t('idSecret.credentials')}
              </div>
              <div className="mt-2 font-sans text-[8px] font-semibold leading-normal text-[#646a73]">
                {t('idSecret.appId')}
              </div>
              <div className="mt-1 flex items-center gap-1.5">
                <span className="mono min-w-0 flex-1 truncate text-[9px] leading-normal text-[#1f2329]">
                  {t('idSecret.appIdSample')}
                </span>
                <span className="relative flex-none text-[#3370ff]">
                  <Icon name="copy" size={10} />
                  <span className="pointer-events-none absolute -inset-[3px] step-pulse rounded ring-2 ring-[#3370ff]" />
                </span>
              </div>
              <div className="mt-2 font-sans text-[8px] font-semibold leading-normal text-[#646a73]">
                {t('idSecret.appSecret')}
              </div>
              <div className="mt-1 flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate font-sans text-[9px] leading-normal tracking-tight text-[#1f2329]">
                  {t('idSecret.secretSample')}
                </span>
                <span className="flex flex-none items-center gap-1 text-[#3370ff]">
                  <Icon name="copy" size={10} />
                  <Icon name="eye" size={10} />
                  <Icon name="refresh-cw" size={10} />
                </span>
              </div>
              <div className="mt-2 font-sans text-[8px] leading-snug text-[#646a73]">{t('idSecret.masked')}</div>
            </div>
          </div>
        </MiniScreen>
      )
    }
  ]
}
