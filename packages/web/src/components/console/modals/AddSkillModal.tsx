// No 'use client' here: rendered only by ModalProvider (the client boundary).

import type { ReactNode } from 'react'
import { Button, Icon } from '@/components/ui'

export default function AddSkillModal({ onClose }: { onClose: () => void }) {
  const opts: { icon: string; on: boolean; title: string; desc: ReactNode }[] = [
    {
      icon: 'git-branch',
      on: true,
      title: 'From a repo',
      desc: (
        <>
          Index a <span className="mono text-[11px]">.agent/skills</span> folder or docs directory.
        </>
      )
    },
    {
      icon: 'sparkles',
      on: false,
      title: 'Extract from sessions',
      desc: 'Turn a repeated, successful workflow into a reusable skill (admin only).'
    },
    { icon: 'upload', on: false, title: 'Upload files', desc: 'Add markdown runbooks or specs as a knowledge source.' }
  ]
  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
          <Icon name="book-open" size={17} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Add skill or knowledge</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <div className="flex flex-col gap-[10px]">
          {opts.map((o) => (
            <div key={o.title} className={o.on ? 'ptile on items-start' : 'ptile items-start'}>
              <span
                className={
                  o.on
                    ? 'flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--brand) bg-(--surface-card)'
                    : 'flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--surface-sunken)'
                }
              >
                <Icon name={o.icon} size={16} color={o.on ? 'var(--brand)' : 'var(--text-tertiary)'} />
              </span>
              <div className="flex-1">
                <div className="font-sans text-[13px] font-semibold leading-normal">{o.title}</div>
                <div className="mt-[2px] font-sans text-[12px] font-normal leading-[1.4] text-(--text-tertiary)">
                  {o.desc}
                </div>
              </div>
              {o.on && (
                <span className="mt-[3px] h-[14px] w-[14px] flex-none rounded-full border-4 border-(--brand) bg-(--surface-card)" />
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onClose}>Continue</Button>
      </div>
    </>
  )
}
