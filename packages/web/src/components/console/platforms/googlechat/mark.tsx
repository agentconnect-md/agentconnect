// No 'use client' here: every consumer is already inside a client boundary —
// `PlatformMark` (components/marks.tsx) and the module tree under ModalProvider.

import { useId } from 'react'
import { DEFAULT_MARK_FILL_PCT, squareMarkBox } from '@/components/mark-box'

// Google Chat's 2026 app icon as published (theSVG color set, MIT); the icon libraries here carry only the monochrome glyph.
const BUBBLE =
  'M133 48c28.167 0 51 22.834 51 51c0 28.167-22.833 51-51 51H96.624l-34.857 23.064c-3.86 2.544-5.789 3.816-7.372 3.92a6 6 0 0 1-5.612-3.022C48 172.583 48 170.271 48 165.649V148.81C25.121 143.78 8 123.39 8 99c0-28.166 22.834-51 51-51z'
// The source masks with this outline in alpha mode; a clip path by the same outline paints identically.
const CLIP =
  'M133 48c28.167 0 51 22.834 51 51c0 28.167-22.833 51-51 51H96.722l-39.428 25.896c-3.99 2.62-9.294-.242-9.294-5.015V148.81C25.121 143.78 8 123.39 8 99c0-28.166 22.834-51 51-51z'

/** Google Chat's brand mark ({@link WebPlatformModule.Mark}); ids are per instance so two marks never share a gradient. */
export function GoogleChatMark({ fillPct = DEFAULT_MARK_FILL_PCT }: { fillPct?: number }) {
  // Only id-safe characters, so `url(#…)` resolves whatever form React's ids take.
  const id = `gchat${useId().replace(/[^A-Za-z0-9_-]/g, '')}`
  const clip = `${id}-clip`
  const glow = `${id}-glow`
  return (
    <svg viewBox="0 0 192 192" style={squareMarkBox(fillPct)} fill="none" aria-hidden>
      <defs>
        <clipPath id={clip}>
          <path d={CLIP} />
        </clipPath>
        <linearGradient id={glow} x1="96" x2="96" y1="28" y2="124" gradientUnits="userSpaceOnUse">
          <stop offset=".09" stopColor="#94d4ff" />
          <stop offset=".28" stopColor="#78c9ff" />
          <stop offset=".88" stopColor="#01ae58" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="160" height="96" x="16" y="28" fill="#00af57" rx="48" />
      <path fill="#0ebc5f" d={BUBBLE} />
      <g clipPath={`url(#${clip})`}>
        <rect width="160" height="96" x="16" y="28" fill="#0ebc5f" rx="48" />
        <rect width="160" height="96" x="16" y="28" fill={`url(#${glow})`} rx="48" />
        <path stroke="#fff" strokeLinecap="round" strokeWidth="12" d="M62 94s8.84 18 34 18s34-17.182 34-17.182" />
      </g>
    </svg>
  )
}
