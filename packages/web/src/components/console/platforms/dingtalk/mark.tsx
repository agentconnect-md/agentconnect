// No 'use client' here: `PlatformMark` and the ModalProvider tree are already client boundaries.

import { DEFAULT_MARK_FILL_PCT, squareMarkBox } from '@/components/mark-box'

// The wing from Ant Design Icons' DingTalk circle (MIT), painted white so it stays white on a dark surface.
const WING =
  'M739 449.3c-1 4.2-3.5 10.4-7 17.8h.1l-.4.7c-20.3 43.1-73.1 127.7-73.1 127.7s-.1-.2-.3-.5l-15.5 26.8h74.5L575.1 810l32.3-128h-58.6l20.4-84.7c-16.5 3.9-35.9 9.4-59 16.8c0 0-31.2 18.2-89.9-35c0 0-39.6-34.7-16.6-43.4c9.8-3.7 47.4-8.4 77-12.3c40-5.4 64.6-8.2 64.6-8.2S422 517 392.7 512.5c-29.3-4.6-66.4-53.1-74.3-95.8c0 0-12.2-23.4 26.3-12.3s197.9 43.2 197.9 43.2s-207.4-63.3-221.2-78.7s-40.6-84.2-37.1-126.5c0 0 1.5-10.5 12.4-7.7c0 0 153.3 69.7 258.1 107.9c104.8 37.9 195.9 57.3 184.2 106.7'

/** DingTalk's brand mark ({@link WebPlatformModule.Mark}): its app icon, a white wing on a blue disc, so it takes the 80% cap. */
export function DingTalkMark({ fillPct = DEFAULT_MARK_FILL_PCT }: { fillPct?: number }) {
  return (
    <svg viewBox="64 64 896 896" style={squareMarkBox(fillPct)} aria-hidden>
      <circle cx="512" cy="512" r="448" fill="#007FFF" />
      <path fill="#fff" d={WING} />
    </svg>
  )
}
