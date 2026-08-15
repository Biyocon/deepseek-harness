// Biyocon brandmark (symbol only). The source PNG preserves the brand blue;
// it does not ride currentColor so the mark stays on-brand in both themes.

import type { IconProps } from './icons/props.ts'

/**
 * Render the Biyocon brandmark.
 * @param props.size - bounding-box height in px (default 24; width keeps the source aspect ratio).
 * @param props.className - extra class for layout placement.
 * @returns the brandmark image (aria-hidden decorative brand art).
 */
export function BrandMark({ size = 24, className }: IconProps) {
  return (
    <img
      src="/biyocon-brandmark.png"
      alt=""
      height={size}
      className={className}
      style={{ width: 'auto', display: 'block' }}
      aria-hidden="true"
    />
  )
}
