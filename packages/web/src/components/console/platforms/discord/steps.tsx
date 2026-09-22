// No 'use client' here: rendered only inside ModalProvider's tree (the client boundary).

import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { BrowserBar, MiniScreen, type WalkthroughStep } from '../wizard-chrome'

type DiscordStepsTranslator = ReturnType<typeof useTranslations<'Platforms.discord.steps'>>

// Discord's Developer Portal walkthrough stops after token copy. AgentConnect handles
// Message Content Intent during install. Built per locale so every chip label, caption
// and mock screen string follows the console language.
export function discordWalkthroughSteps(t: DiscordStepsTranslator): WalkthroughStep[] {
  return [
    {
      label: t('newApp.label'),
      caption: t.rich('newApp.caption', {
        action: (chunks) => <span className="font-medium text-(--text-secondary)">{chunks}</span>
      }),
      screen: (
        <MiniScreen
          frameClass="border-[#e3e5e8] bg-[#f2f3f5]"
          bar={<BrowserBar url="discord.com/developers/applications" />}
        >
          <div className="absolute inset-0 bg-[#f2f3f5] px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-sans text-[10px] font-bold leading-normal text-[#313338]">
                {t('newApp.screenTitle')}
              </span>
              <span className="rounded bg-[#5865f2] px-1.5 py-[3px] font-sans text-[8.5px] font-semibold leading-normal text-white">
                {t('newApp.screenAction')}
              </span>
            </div>
            <div className="mt-2 rounded-md border border-[#e3e5e8] bg-white p-2 shadow-(--shadow-md)">
              <div className="font-sans text-[10.5px] font-bold leading-normal text-[#313338]">
                {t('newApp.cardTitle')}
              </div>
              <div className="mt-1.5 font-sans text-[8px] font-semibold uppercase leading-normal tracking-wide text-[#5c5e66]">
                {t('newApp.nameLabel')} <span className="text-[#d83c3e]">*</span>
              </div>
              <div className="mt-1 rounded border border-[#c4c9ce] bg-white px-2 py-1 font-sans text-[9.5px] leading-normal text-[#313338]">
                {t('newApp.nameValue')}
              </div>
              <div className="mt-1.5 flex items-start gap-1.5">
                <span className="mt-[1px] flex h-2.5 w-2.5 flex-none items-center justify-center rounded-[3px] bg-[#5865f2] text-white">
                  <Icon name="check" size={8} strokeWidth={3} />
                </span>
                <span className="font-sans text-[8px] leading-snug text-[#5c5e66]">{t('newApp.terms')}</span>
              </div>
              <div className="mt-1.5 flex justify-end gap-1.5">
                <span className="rounded px-2 py-[3px] font-sans text-[9px] font-semibold leading-normal text-[#4e5058]">
                  {t('newApp.cancel')}
                </span>
                <span className="relative rounded bg-[#5865f2] px-2.5 py-[3px] font-sans text-[9px] font-semibold leading-normal text-white">
                  {t('newApp.create')}
                  <span className="pointer-events-none absolute -inset-[3px] step-pulse rounded ring-2 ring-[#5865f2]" />
                </span>
              </div>
            </div>
          </div>
        </MiniScreen>
      )
    },
    {
      label: t('copyToken.label'),
      caption: t.rich('copyToken.caption', {
        action: (chunks) => <span className="font-medium text-(--text-secondary)">{chunks}</span>
      }),
      screen: (
        <MiniScreen
          frameClass="border-[#e3e5e8] bg-white"
          bar={<BrowserBar url="discord.com/developers/applications/…/bot" />}
        >
          <div className="absolute inset-0 flex bg-white">
            <div className="w-[74px] flex-none border-r border-[#e3e5e8] bg-[#f2f3f5] px-1.5 py-2">
              {[
                t('copyToken.navGeneral'),
                t('copyToken.navInstallation'),
                t('copyToken.navOauth2'),
                t('copyToken.navBot')
              ].map((n) => (
                <div
                  key={n}
                  className={`truncate rounded px-1.5 py-1 font-sans text-[8.5px] leading-normal ${
                    n === t('copyToken.navBot') ? 'bg-white font-bold text-[#313338]' : 'text-[#5c5e66]'
                  }`}
                >
                  {n}
                </div>
              ))}
            </div>
            <div className="min-w-0 flex-1 px-2.5 py-2">
              <div className="font-sans text-[10.5px] font-bold leading-normal text-[#313338]">
                {t('copyToken.title')}
              </div>
              <div className="mt-1.5 rounded border border-[#b7e2c4] bg-[#e7f6ec] px-1.5 py-1 font-sans text-[8px] leading-snug text-[#1a7f45]">
                {t('copyToken.generated')}
              </div>
              <div className="mt-2 font-sans text-[9px] font-bold leading-normal text-[#313338]">
                {t('copyToken.tokenLabel')}
              </div>
              <div className="mono mt-1 truncate text-[9px] leading-normal text-[#5c5e66] blur-[2.5px]">
                {t('copyToken.tokenSample')}
              </div>
              <div className="mt-1.5 flex gap-1.5">
                <span className="relative rounded bg-[#5865f2] px-2.5 py-[3px] font-sans text-[9px] font-semibold leading-normal text-white">
                  {t('copyToken.copy')}
                  <span className="pointer-events-none absolute -inset-[3px] step-pulse rounded ring-2 ring-[#5865f2]" />
                </span>
                <span className="rounded bg-[#6d6f78] px-2.5 py-[3px] font-sans text-[9px] font-semibold leading-normal text-white">
                  {t('copyToken.reset')}
                </span>
              </div>
            </div>
          </div>
        </MiniScreen>
      )
    }
  ]
}
