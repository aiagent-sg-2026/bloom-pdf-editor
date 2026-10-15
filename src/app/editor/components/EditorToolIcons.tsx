import React from 'react';

export interface CustomIconProps {
  size?: number;
  className?: string;
}

/**
 * 1. SELECT / CURSOR (Sky Blue Accent)
 */
export function SelectToolIcon({ size = 20, className = '' }: CustomIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <defs>
        <linearGradient id="select_grad" x1="4" y1="3" x2="20" y2="19" gradientUnits="userSpaceOnUse">
          <stop stopColor="#38BDF8" />
          <stop offset="1" stopColor="#0284C7" />
        </linearGradient>
      </defs>
      {/* Pointer Body */}
      <path
        d="M4.5 3.5L10.8 20.2C11.0 20.7 11.7 20.7 11.9 20.2L14.7 14.1L20.8 11.3C21.3 11.1 21.3 10.4 20.8 10.2L4.5 3.5Z"
        fill="url(#select_grad)"
        fillOpacity="0.25"
        stroke="url(#select_grad)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Arrow Shaft Accent */}
      <path
        d="M13.5 13.5L19 19"
        stroke="url(#select_grad)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="19" cy="19" r="1.2" fill="#38BDF8" />
    </svg>
  );
}

/**
 * 2. EDIT TEXT (Royal Blue Accent)
 */
export function TextToolIcon({ size = 20, className = '' }: CustomIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <defs>
        <linearGradient id="text_grad" x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse">
          <stop stopColor="#60A5FA" />
          <stop offset="1" stopColor="#2563EB" />
        </linearGradient>
      </defs>
      {/* Top Crossbar */}
      <path
        d="M4.5 7V4.8C4.5 4.36 4.86 4 5.3 4H18.7C19.14 4 19.5 4.36 19.5 4.8V7"
        stroke="url(#text_grad)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Vertical Stem */}
      <path
        d="M12 4V19.5"
        stroke="url(#text_grad)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      {/* Serif Base */}
      <path
        d="M8.5 19.5H15.5"
        stroke="url(#text_grad)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      {/* Text Cursor Indicator Box */}
      <rect x="18" y="11" width="3" height="8" rx="1" fill="#60A5FA" opacity="0.9" />
    </svg>
  );
}

/**
 * 3. HIGHLIGHT (Amber / Yellow Accent)
 */
export function HighlightToolIcon({ size = 20, className = '' }: CustomIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <defs>
        <linearGradient id="hl_grad" x1="8" y1="3" x2="20" y2="15" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FBBF24" />
          <stop offset="1" stopColor="#D97706" />
        </linearGradient>
      </defs>
      {/* Highlighter Cap / Body */}
      <path
        d="M15.2 3.8L20.2 8.8L14.2 14.8L9.2 9.8L15.2 3.8Z"
        fill="url(#hl_grad)"
        fillOpacity="0.25"
        stroke="url(#hl_grad)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Chisel Felt Tip */}
      <path
        d="M9.2 9.8L5.2 13.8V16.8H8.2L14.2 10.8"
        fill="url(#hl_grad)"
        fillOpacity="0.5"
        stroke="url(#hl_grad)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Translucent Highlight Glow Stroke */}
      <rect x="2.5" y="19" width="11" height="3" rx="1.5" fill="#FBBF24" opacity="0.95" />
    </svg>
  );
}

/**
 * 4. DRAW / FREEHAND PENCIL (Purple / Violet Accent)
 */
export function DrawToolIcon({ size = 20, className = '' }: CustomIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <defs>
        <linearGradient id="draw_grad" x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse">
          <stop stopColor="#C084FC" />
          <stop offset="1" stopColor="#9333EA" />
        </linearGradient>
      </defs>
      {/* Pencil Shaft & Tip */}
      <path
        d="M16.5 3.5L20.5 7.5L9 19H5V15L16.5 3.5Z"
        fill="url(#draw_grad)"
        fillOpacity="0.25"
        stroke="url(#draw_grad)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Pencil Band Joint */}
      <path
        d="M14 6L18 10"
        stroke="url(#draw_grad)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {/* Drawing Line Stroke Underneath */}
      <path
        d="M11 19.5H20.5"
        stroke="#C084FC"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * 5. ERASER (Vibrant Eraser Pink Accent #FF66C4 / #EC4899)
 */
export function EraseToolIcon({ size = 20, className = '' }: CustomIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <defs>
        <linearGradient id="erase_grad" x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FF66C4" />
          <stop offset="1" stopColor="#EC4899" />
        </linearGradient>
      </defs>
      {/* Rubber Eraser Block Body */}
      <path
        d="M7 21L2.7 16.7C1.8 15.8 1.8 14.3 2.7 13.4L12.3 3.8C13.2 2.9 14.7 2.9 15.6 3.8L20.2 8.4C21.1 9.3 21.1 10.8 20.2 11.7L13 18.9L7 21Z"
        fill="url(#erase_grad)"
        fillOpacity="0.25"
        stroke="url(#erase_grad)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Eraser Paper Sleeve / Grip Band Divider */}
      <path
        d="M7.5 8.5L15.5 16.5"
        stroke="url(#erase_grad)"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      {/* Ground Surface Wiping Line */}
      <path
        d="M7 21H21.5"
        stroke="#FF66C4"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * 6. STAMP / WATERMARK (Bloom Coral / Crimson Accent)
 */
export function WatermarkToolIcon({ size = 20, className = '' }: CustomIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <defs>
        <linearGradient id="stamp_grad" x1="4" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse">
          <stop stopColor="#68D5C5" />
          <stop offset="1" stopColor="#176B65" />
        </linearGradient>
      </defs>
      {/* Wooden Handle & Mount */}
      <path
        d="M12 3C10.3 3 9 4.3 9 6C9 7.2 9.7 8.3 10.7 8.7L9.2 13H5C4.4 13 4 13.4 4 14V16.2H20V14C20 13.4 19.6 13 19 13H14.8L13.3 8.7C14.3 8.3 15 7.2 15 6C15 4.3 13.7 3 12 3Z"
        fill="url(#stamp_grad)"
        fillOpacity="0.25"
        stroke="url(#stamp_grad)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Rubber Ink Plate */}
      <path
        d="M4 20H20"
        stroke="url(#stamp_grad)"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <circle cx="12" cy="6" r="1.2" fill="#68D5C5" />
    </svg>
  );
}

/**
 * 7. SIGNATURE (Blue Accent #60A5FA / #2563EB)
 */
export function SignToolIcon({ size = 20, className = '' }: CustomIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <defs>
        <linearGradient id="sign_grad" x1="4" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse">
          <stop stopColor="#60A5FA" />
          <stop offset="1" stopColor="#2563EB" />
        </linearGradient>
      </defs>
      {/* Pen Shaft */}
      <path
        d="M16.8 3.8L20.2 7.2L8.8 18.6H5.4V15.2L16.8 3.8Z"
        fill="url(#sign_grad)"
        fillOpacity="0.25"
        stroke="url(#sign_grad)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Signature Fluid Curve Stroke */}
      <path
        d="M3.5 21C6.2 21 7.8 19.2 10.5 19.2C13.2 19.2 14.8 21.5 17.5 21.5H20.5"
        stroke="#60A5FA"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * 8. SECURITY / PROTECT (Emerald Green Accent #34D399 / #059669)
 */
export function SecurityToolIcon({ size = 20, className = '' }: CustomIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <defs>
        <linearGradient id="sec_grad" x1="5" y1="3" x2="19" y2="21" gradientUnits="userSpaceOnUse">
          <stop stopColor="#34D399" />
          <stop offset="1" stopColor="#059669" />
        </linearGradient>
      </defs>
      {/* Security Shield Outline */}
      <path
        d="M12 3.5L19 6.5V12C19 16.5 16 20.5 12 21.5C8 20.5 5 16.5 5 12V6.5L12 3.5Z"
        fill="url(#sec_grad)"
        fillOpacity="0.25"
        stroke="url(#sec_grad)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Keyhole / Lock Pin Accent */}
      <path
        d="M12 8.5V13"
        stroke="#34D399"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="12" cy="15.8" r="1.2" fill="#34D399" />
    </svg>
  );
}
