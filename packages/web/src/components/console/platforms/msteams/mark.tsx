// No 'use client': every consumer (`PlatformMark`, the module tree) is already inside a client boundary.

import { useId } from 'react'
import { DEFAULT_MARK_FILL_PCT, squareMarkBox } from '@/components/mark-box'

// Microsoft Teams' current app icon as published (theSVG color set, MIT); the bundled logo set carries only the retired one.
const BACK = 'M22 20h12a6 6 0 0 1 6 6v10a6 6 0 0 1-12 0V26a6 6 0 0 0-6-6'
const FRONT = 'M8 24a6 6 0 0 1 6-6h8a6 6 0 0 1 6 6v12a6 6 0 0 0 6 6H18c-5.523 0-10-4.477-10-10z'
const SMALL_HEAD = 'M33 18a5 5 0 1 0 0-10a5 5 0 0 0 0 10'
const LARGE_HEAD = 'M18 16a6 6 0 1 0 0-12a6 6 0 0 0 0 12'
const LETTER = 'M15.48 28.105h-2.448v7.466h-2.065v-7.466H8.52V26.43h6.96z'

// [offset, color, opacity]
type Stop = readonly [number, string, number?]

// The source's radial gradients, by name: their transform and stops, verbatim.
const RADIAL: readonly (readonly [string, string, readonly Stop[]])[] = [
  [
    'back',
    'matrix(13.4784 0 0 33.2694 39.797 22.174)',
    [
      [0, '#a98aff'],
      [0.14, '#8c75ff'],
      [0.565, '#5f50e2'],
      [0.9, '#3c2cb8']
    ]
  ],
  [
    'front',
    'rotate(68.154 -7.716 14.713)scale(32.752 33.1231)',
    [
      [0, '#85c2ff'],
      [0.69, '#7588ff'],
      [1, '#6459fe']
    ]
  ],
  [
    'frontGlow',
    'rotate(113.326 8.093 17.645)scale(19.2186 15.4273)',
    [
      [0, '#bd96ff'],
      [0.687, '#bd96ff', 0]
    ]
  ],
  [
    'smallHead',
    'matrix(0 -10 12.6216 0 33 11.571)',
    [
      [0.268, '#6868f7'],
      [1, '#3923b1']
    ]
  ],
  [
    'smallHeadLight',
    'rotate(40.052 -.03 44.872)scale(7.14629 10.3363)',
    [
      [0.271, '#a1d3ff'],
      [0.813, '#a1d3ff', 0]
    ]
  ],
  [
    'smallHeadGlow',
    'rotate(-41.658 32.118 -43.42)scale(8.51275 20.8824)',
    [
      [0, '#e3acfd'],
      [0.816, '#9fa2ff', 0]
    ]
  ],
  [
    'largeHead',
    'matrix(0 -12 15.146 0 18 8.286)',
    [
      [0.268, '#8282ff'],
      [1, '#3923b1']
    ]
  ],
  [
    'largeHeadLight',
    'rotate(40.052 -3.155 21.416)scale(8.57554 12.4035)',
    [
      [0.271, '#a1d3ff'],
      [0.813, '#a1d3ff', 0]
    ]
  ],
  [
    'largeHeadGlow',
    'rotate(-41.658 20.382 -26.516)scale(10.2153 25.0589)',
    [
      [0, '#e3acfd'],
      [0.816, '#9fa2ff', 0]
    ]
  ],
  [
    'tile',
    'rotate(45 -25.763 16.328)scale(22.6274)',
    [
      [0.047, '#688eff'],
      [0.947, '#230f94']
    ]
  ],
  [
    'tileEdge',
    'matrix(0 11.2 -13.0702 0 12 32.6)',
    [
      [0.571, '#6965f6', 0],
      [1, '#8f8fff']
    ]
  ]
]

function stops(list: readonly Stop[]) {
  return list.map(([offset, color, opacity]) => (
    <stop key={offset} offset={offset} stopColor={color} {...(opacity === undefined ? {} : { stopOpacity: opacity })} />
  ))
}

/** Microsoft Teams' brand mark ({@link WebPlatformModule.Mark}): full-bleed artwork, so it takes the 80% cap; ids are per instance. */
export function MsTeamsMark({ fillPct = DEFAULT_MARK_FILL_PCT }: { fillPct?: number }) {
  // Only id-safe characters, so `url(#…)` resolves whatever form React's ids take.
  const id = `msteams${useId().replace(/[^A-Za-z0-9_-]/g, '')}`
  const url = (name: string) => `url(#${id}-${name})`
  return (
    // The source's 36×38 box, widened to a square so the glyph sits centred.
    <svg viewBox="3 4 38 38" style={squareMarkBox(fillPct)} fill="none" aria-hidden>
      <defs>
        {RADIAL.map(([name, transform, list]) => (
          <radialGradient
            key={name}
            id={`${id}-${name}`}
            cx="0"
            cy="0"
            r="1"
            gradientTransform={transform}
            gradientUnits="userSpaceOnUse"
          >
            {stops(list)}
          </radialGradient>
        ))}
        <linearGradient id={`${id}-frontShade`} x1="20.594" x2="20.594" y1="18" y2="42" gradientUnits="userSpaceOnUse">
          {stops([
            [0.801, '#6864f6', 0],
            [1, '#5149de']
          ])}
        </linearGradient>
      </defs>
      <path fill={url('back')} d={BACK} />
      <path fill={url('front')} d={FRONT} />
      <path fill={url('frontShade')} fillOpacity=".7" d={FRONT} />
      <path fill={url('frontGlow')} fillOpacity=".7" d={FRONT} />
      <path fill={url('smallHead')} d={SMALL_HEAD} />
      <path fill={url('smallHeadLight')} fillOpacity=".46" d={SMALL_HEAD} />
      <path fill={url('smallHeadGlow')} fillOpacity=".4" d={SMALL_HEAD} />
      <path fill={url('largeHead')} d={LARGE_HEAD} />
      <path fill={url('largeHeadLight')} fillOpacity=".6" d={LARGE_HEAD} />
      <path fill={url('largeHeadGlow')} fillOpacity=".5" d={LARGE_HEAD} />
      <rect width="16" height="16" x="4" y="23" fill={url('tile')} rx="3.25" />
      <rect width="16" height="16" x="4" y="23" fill={url('tileEdge')} fillOpacity=".7" rx="3.25" />
      <path fill="#fff" d={LETTER} />
    </svg>
  )
}
