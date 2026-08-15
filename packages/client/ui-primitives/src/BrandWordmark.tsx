// Biyocon Harness brand wordmark. The source PNG preserves the brand blue;
// it does not ride currentColor so the wordmark stays on-brand in both themes.

import type { IconProps } from './icons/props.ts'

/**
 * Render the full Biyocon wordmark.
 * @param props.size - height in px (default 24; width keeps the source aspect ratio).
 * @param props.className - extra class for layout placement.
 * @returns the wordmark image (aria-hidden decorative brand art).
 */
export function BrandWordmark({ size = 24, className }: IconProps) {
  return (
    <img
      src="/biyocon-wordmark.png"
      alt=""
      height={size}
      className={className}
      style={{ width: 'auto', display: 'block' }}
      aria-hidden="true"
    />
  )
}
