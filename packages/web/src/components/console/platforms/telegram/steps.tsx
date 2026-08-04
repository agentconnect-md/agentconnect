// No 'use client' here: rendered only inside ModalProvider's tree (the client boundary).

import { Icon } from '@/components/ui'
import { MiniScreen, type WalkthroughStep } from '../wizard-chrome'

// Telegram's own sheet chrome (fixed light/dark, independent of our theme).
function TelegramBar({ icon, title }: { icon: string; title: string }) {
  return (
    <div className="flex items-center gap-1.5 border-b border-[#2c2c2e] bg-[#f0f0f0] px-2.5 py-1.5">
      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#2f7fd8] text-white">
        <Icon name={icon} size={9} strokeWidth={2.25} />
      </span>
      <span className="font-sans text-[9.5px] font-bold leading-normal text-[#1d1c1d]">{title}</span>
    </div>
  )
}

export const TG_STEPS: WalkthroughStep[] = [
  {
    label: 'Find the bot',
    caption: (
      <>
        Search <span className="mono">@BotFather</span> in Telegram (the verified one) and open the chat.
      </>
    ),
    screen: (
      <MiniScreen
        frameClass="border-[#2c2c2e] bg-[#1c1c1d]"
        bar={<TelegramBar icon="search" title="Telegram — search" />}
      >
        <div className="absolute inset-0 bg-white px-3 py-2.5">
          <div className="flex items-center gap-1.5 rounded-md bg-[#f0f0f0] px-2 py-1.5">
            <Icon name="search" size={10} color="#8e8e93" />
            <span className="font-sans text-[10px] leading-normal text-[#1d1c1d]">@BotFather</span>
          </div>
          <div className="mt-2 mb-1 font-sans text-[8px] font-semibold uppercase leading-normal tracking-wide text-[#8e8e93]">
            Contacts and chats
          </div>
          <div className="relative flex items-center gap-2 rounded-md px-1.5 py-1.5">
            <span className="pointer-events-none absolute -inset-0.5 step-blink rounded-lg ring-2 ring-[#2f7fd8]" />
            <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-[#2f7fd8] text-white">
              <Icon name="bot" size={12} strokeWidth={2.25} />
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-1">
              <span className="truncate font-sans text-[10px] font-semibold leading-normal text-[#1d1c1d]">
                BotFather
              </span>
              <Icon name="badge-check" size={10} color="#2f7fd8" />
            </span>
            <span className="flex-none rounded-full bg-[#2f7fd8] px-2 py-[2px] font-sans text-[8.5px] font-bold leading-normal text-white">
              OPEN
            </span>
          </div>
          <div className="mt-1.5 mb-1 font-sans text-[8px] font-semibold uppercase leading-normal tracking-wide text-[#8e8e93]">
            Global search
          </div>
          {['@Botfagher_bot', '@botfather_tron_bot'].map((u) => (
            <div key={u} className="flex items-center gap-2 px-1.5 py-1">
              <span className="h-5 w-5 flex-none rounded-full bg-[#e6e6e6]" />
              <span className="mono truncate text-[9px] leading-normal text-[#8e8e93]">{u}</span>
            </div>
          ))}
          <div className="mt-1 font-sans text-[8.5px] leading-snug text-[#8e8e93]">
            Impostors are everywhere — take the verified one.
          </div>
        </div>
      </MiniScreen>
    )
  },
  {
    label: 'New bot',
    caption: (
      <>
        Tap <span className="font-medium text-(--text-secondary)">Start</span> &rarr;{' '}
        <span className="font-medium text-(--text-secondary)">New bot</span>, then pick a name and a username ending in{' '}
        <span className="mono">bot</span>.
      </>
    ),
    screen: (
      <MiniScreen frameClass="border-[#2c2c2e] bg-[#1c1c1d]" bar={<TelegramBar icon="bot" title="BotFather" />}>
        <div className="absolute inset-0 px-3 py-2.5">
          <div className="mb-1.5 flex justify-center">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#2c2c2e] text-[#8e8e93]">
              <Icon name="camera" size={13} />
            </span>
          </div>
          <div className="text-center font-sans text-[12px] font-bold leading-tight text-white">New bot</div>
          <div className="mt-0.5 mb-2 text-center font-sans text-[9px] leading-tight text-[#8e8e93]">
            Enter a name, description and username to create a new bot.
          </div>
          <div className="rounded-md bg-[#2c2c2e] px-2 py-1.5 font-sans text-[10px] leading-normal text-white">
            My Agent
          </div>
          <div className="mt-0.5 rounded-md bg-[#2c2c2e] px-2 py-1.5 font-sans text-[10px] leading-normal text-[#8e8e93]">
            About (Optional)
          </div>
          <div className="mt-1.5 rounded-md bg-[#2c2c2e] px-2 py-1.5 font-sans text-[10px] leading-normal text-[#8e8e93]">
            t.me/<span className="text-white">my_agent_bot</span>
          </div>
          <div className="mt-1 font-sans text-[8.5px] leading-normal text-[#4db34d]">my_agent_bot is available.</div>
        </div>
      </MiniScreen>
    )
  },
  {
    label: 'Copy token',
    caption: <>The bot&rsquo;s screen shows the API token — copy it and paste it below.</>,
    screen: (
      <MiniScreen frameClass="border-[#2c2c2e] bg-[#1c1c1d]" bar={<TelegramBar icon="bot" title="BotFather" />}>
        <div className="absolute inset-0 flex flex-col justify-center px-3 py-2.5">
          <div className="mb-1.5 flex justify-center">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#4caf50] font-sans text-[13px] font-bold leading-none text-white">
              M
            </span>
          </div>
          <div className="text-center font-sans text-[12px] font-bold leading-tight text-white">My Agent</div>
          <div className="mt-0.5 mb-2 text-center font-sans text-[9px] leading-tight text-[#8e8e93]">@my_agent_bot</div>
          <div className="rounded-md bg-[#2c2c2e] p-2">
            <div className="flex items-center gap-1.5">
              <Icon name="key-round" size={10} color="#8e8e93" />
              <span className="mono min-w-0 flex-1 truncate text-[9px] leading-normal text-[#8e8e93] blur-[2.5px]">
                123456789:AAEabcdefghijklmnopqrstuvwxyz
              </span>
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              <span className="relative rounded bg-[#2f7fd8] py-[3px] text-center font-sans text-[9px] font-semibold leading-normal text-white">
                Copy
                <span className="pointer-events-none absolute -inset-[3px] step-pulse rounded ring-2 ring-white" />
              </span>
              <span className="rounded bg-[#e0625a] py-[3px] text-center font-sans text-[9px] font-semibold leading-normal text-white">
                Revoke
              </span>
            </div>
          </div>
          <div className="mt-1.5 font-sans text-[8.5px] leading-snug text-[#8e8e93]">
            Access the API using this token. Keep it secret.
          </div>
        </div>
      </MiniScreen>
    )
  }
]
