import { BRAND } from '../core/brand.js';

/**
 * The brand mark: "law + glass". A navy tile with lines of text and a magnifying lens over the
 * lower-right lines, where one line reads thicker as if magnified. The geometry is the same as
 * public/favicon.svg (keep them in step). Colors are fixed rather than themed: the tile is
 * navy and the lens light in both color schemes, and the thin light outline keeps the tile
 * visible on the navy masthead.
 */
export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg
      role="img"
      aria-label={BRAND.displayName}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
    >
      <rect
        x="0.5"
        y="0.5"
        width="31"
        height="31"
        rx="7.5"
        fill="#0f3b6e"
        stroke="#7fb2e0"
        strokeOpacity="0.55"
      />
      <path
        d="M6.5 9h15M6.5 14h9M6.5 19.5h6"
        stroke="#e6f0fa"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <circle
        cx="20"
        cy="19"
        r="6.2"
        fill="#0f3b6e"
        stroke="#8ec5f2"
        strokeWidth="2.4"
      />
      <path
        d="M16.6 19h6.8"
        stroke="#ffffff"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M24.6 23.6l3.4 3.4"
        stroke="#8ec5f2"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
