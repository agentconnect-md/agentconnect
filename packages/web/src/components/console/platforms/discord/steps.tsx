// No 'use client' here: rendered only inside ModalProvider's tree (the client boundary).

import { Icon } from '@/components/ui'
import { BrowserBar, MiniScreen, type WalkthroughStep } from '../wizard-chrome'

// Discord's Developer Portal walkthrough stops after token copy. AgentConnect handles
// Message Content Intent during install.
export const DISCORD_STEPS: WalkthroughStep[] = [
  {
    label: 'New app',
    caption: (
      <>
        <span className="font-medium text-(--text-secondary)">New Application</span>&#32;&rarr; name it, accept the
        developer terms, then Create.
      </>
    ),
    screen: (
      <MiniScreen
        frameClass="border-[#e3e5e8] bg-[#f2f3f5]"
        bar={<BrowserBar url="discord.com/developers/applications" />}
      >
        <div className="absolute inset-0 bg-[#f2f3f5] px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-sans text-[10px] font-bold leading-normal text-[#313338]">Applications</span>
            <span className="rounded bg-[#5865f2] px-1.5 py-[3px] font-sans text-[8.5px] font-semibold leading-normal text-white">
              New Application
            </span>
          </div>
          <div className="mt-2 rounded-md border border-[#e3e5e8] bg-white p-2 shadow-(--shadow-md)">
            <div className="font-sans text-[10.5px] font-bold leading-normal text-[#313338]">Create a new app</div>
            <div className="mt-1.5 font-sans text-[8px] font-semibold uppercase leading-normal tracking-wide text-[#5c5e66]">
              Name <span className="text-[#d83c3e]">*</span>
            </div>
            <div className="mt-1 rounded border border-[#c4c9ce] bg-white px-2 py-1 font-sans text-[9.5px] leading-normal text-[#313338]">
              my-agent
            </div>
            <div className="mt-1.5 flex items-start gap-1.5">
              <span className="mt-[1px] flex h-2.5 w-2.5 flex-none items-center justify-center rounded-[3px] bg-[#5865f2] text-white">
                <Icon name="check" size={8} strokeWidth={3} />
              </span>
              <span className="font-sans text-[8px] leading-snug text-[#5c5e66]">
                By clicking Create, you agree to the Discord Developer Terms of Service.
              </span>
            </div>
            <div className="mt-1.5 flex justify-end gap-1.5">
              <span className="rounded px-2 py-[3px] font-sans text-[9px] font-semibold leading-normal text-[#4e5058]">
                Cancel
              </span>
              <span className="relative rounded bg-[#5865f2] px-2.5 py-[3px] font-sans text-[9px] font-semibold leading-normal text-white">
                Create
                <span className="pointer-events-none absolute -inset-[3px] step-pulse rounded ring-2 ring-[#5865f2]" />
              </span>
            </div>
          </div>
        </div>
      </MiniScreen>
    )
  },
  {
    label: 'Copy token',
    caption: (
      <>
        <span className="font-medium text-(--text-secondary)">Bot</span>&#32;&rarr; Reset Token, then copy it — Discord
        shows the token only once.
      </>
    ),
    screen: (
      <MiniScreen
        frameClass="border-[#e3e5e8] bg-white"
        bar={<BrowserBar url="discord.com/developers/applications/…/bot" />}
      >
        <div className="absolute inset-0 flex bg-white">
          <div className="w-[74px] flex-none border-r border-[#e3e5e8] bg-[#f2f3f5] px-1.5 py-2">
            {['General Info', 'Installation', 'OAuth2', 'Bot'].map((n) => (
              <div
                key={n}
                className={`truncate rounded px-1.5 py-1 font-sans text-[8.5px] leading-normal ${
                  n === 'Bot' ? 'bg-white font-bold text-[#313338]' : 'text-[#5c5e66]'
                }`}
              >
                {n}
              </div>
            ))}
          </div>
          <div className="min-w-0 flex-1 px-2.5 py-2">
            <div className="font-sans text-[10.5px] font-bold leading-normal text-[#313338]">Bot</div>
            <div className="mt-1.5 rounded border border-[#b7e2c4] bg-[#e7f6ec] px-1.5 py-1 font-sans text-[8px] leading-snug text-[#1a7f45]">
              A new token was generated! Copy it now — it won&rsquo;t be shown again.
            </div>
            <div className="mt-2 font-sans text-[9px] font-bold leading-normal text-[#313338]">Token</div>
            <div className="mono mt-1 truncate text-[9px] leading-normal text-[#5c5e66] blur-[2.5px]">
              MTIzNDU2Nzg5MDEyMzQ1Njc4.Gabcde.fghijklmnopqrstuvwxyz
            </div>
            <div className="mt-1.5 flex gap-1.5">
              <span className="relative rounded bg-[#5865f2] px-2.5 py-[3px] font-sans text-[9px] font-semibold leading-normal text-white">
                Copy
                <span className="pointer-events-none absolute -inset-[3px] step-pulse rounded ring-2 ring-[#5865f2]" />
              </span>
              <span className="rounded bg-[#6d6f78] px-2.5 py-[3px] font-sans text-[9px] font-semibold leading-normal text-white">
                Reset Token
              </span>
            </div>
          </div>
        </div>
      </MiniScreen>
    )
  }
]
