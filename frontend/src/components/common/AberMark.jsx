import React, { useId } from 'react'

// The Aber emblem: streams meeting the sea under an open sky. A 64-unit square, circle centre
// (32,32), radius 28. The rim and the sea are filled; the streams, the horizon and the current are
// cut out through a mask, so the emblem takes currentColor and sits on any ground.
//
// Two cuts. `full` is for 48px and up. `small` drops the current and widens the streams, because a
// 2.2-unit cut is under one device pixel at 16px. frontend/public/favicon.svg and docs/assets/ carry
// the same paths.

const RIM = 'M4 32A28 28 0 0 1 60 32H55A23 23 0 0 0 9 32Z'
const SEA = 'M4 32A28 28 0 0 0 60 32Z'
const HORIZON = 'M37 33H62'
// A stream runs level from the left edge, then is drawn into the mouth at (37,33).
const stream = (x0, y) => `M${x0} ${y}C${x0 + 20} ${y} 26 33 37 33`

const CUTS = {
  full: {
    width: 2.2,
    lines: [HORIZON, stream(2, 36.5), stream(3, 41.5), stream(5, 46.5), 'M13 55.5C27 55.5 44 50 59 43'],
  },
  small: {
    width: 2.6,
    lines: [HORIZON, stream(2, 37.2), stream(3, 42.6), stream(6, 48)],
  },
}

export function AberMark({ size = 28 }) {
  // useId's colons are not valid in the url(#…) reference the mask is applied through.
  const maskId = `aber-mark-${useId().replace(/:/g, '')}`
  const { width, lines } = CUTS[size >= 48 ? 'full' : 'small']

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
    >
      {/* Mask luminance, not colour: white keeps the shape, black cuts it away. */}
      <mask id={maskId}>
        <rect width="64" height="64" fill="white" />
        <g fill="none" stroke="black" strokeWidth={width} strokeLinecap="round">
          {lines.map((d) => <path key={d} d={d} />)}
        </g>
      </mask>
      <g fill="currentColor" mask={`url(#${maskId})`}>
        <path d={RIM} />
        <path d={SEA} />
      </g>
    </svg>
  )
}
