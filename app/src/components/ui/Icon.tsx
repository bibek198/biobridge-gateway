// Inline technical icons (16 px grid, 1.5 px stroke). No icon library, so the app works offline.

const PATHS = {
  overview: "M2 2h5v5H2zM9 2h5v3H9zM9 7h5v7H9zM2 9h5v5H2z",
  devices: "M3 3h10v7H3zM6 13h4M8 10v3",
  live: "M1 8h3l2-5 3 10 2-5h4",
  alert: "M8 2l6.5 11.5h-13zM8 6.5v3.5M8 11.8v.4",
  clock: "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM8 4.5V8l2.5 1.5",
  cpu: "M4.5 4.5h7v7h-7zM6.5 6.5h3v3h-3zM6 1.5v3M10 1.5v3M6 11.5v3M10 11.5v3M1.5 6h3M1.5 10h3M11.5 6h3M11.5 10h3",
  record: "M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3zM8 6.3a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4z",
  pipeline: "M1.5 4.5h4v7h-4zM10.5 4.5h4v7h-4zM5.5 8h5M8.5 6l2 2-2 2",
  add: "M8 3v10M3 8h10",
  plusBox: "M2.5 2.5h11v11h-11zM8 5v6M5 8h6",
  descriptor: "M4 1.5h5.5L12.5 4.5v10h-8.5zM9.5 1.5v3h3M6 8h4.5M6 10.5h4.5",
  shield: "M8 1.5l5.5 2v4.2c0 3.2-2.3 5.6-5.5 6.8-3.2-1.2-5.5-3.6-5.5-6.8V3.5zM5.6 8l1.7 1.7L10.6 6.4",
  check: "M3 8.5l3 3 7-7",
  cross: "M4 4l8 8M12 4l-8 8",
  warn: "M8 2l6.5 11.5h-13zM8 6.5v3.5M8 11.8v.4",
  info: "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM8 7v4.5M8 4.6v.4",
  dot: "M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  sun: "M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1",
  moon: "M13 9.8A5.5 5.5 0 0 1 6.2 3a5.5 5.5 0 1 0 6.8 6.8z",
  collapse: "M10 3L5 8l5 5",
  expand: "M6 3l5 5-5 5",
  pause: "M5 3.5v9M11 3.5v9",
  play: "M5 3l8 5-8 5z",
  download: "M8 2v8.5M4.5 7L8 10.5 11.5 7M2.5 13.5h11",
  upload: "M8 10.5V2M4.5 5.5L8 2l3.5 3.5M2.5 13.5h11",
  trash: "M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4",
  link: "M6.5 9.5l3-3M5 7.5L3.5 9a2.1 2.1 0 0 0 3 3L8 10.5M11 8.5L12.5 7a2.1 2.1 0 0 0-3-3L8 5.5",
  usb: "M8 1.5v10M8 14.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM8 5l-3 2v2M8 7l3-2V3.5M4 9h2M10 2.5h2v2h-2z",
  ble: "M4.5 5l7 6L8 14V2l3.5 3-7 6",
  sim: "M2 2.5h12v8H2zM5 13.5h6M4.5 8l2-2.5 2 2.5 2-3",
  chevron: "M6 3l5 5-5 5",
  back: "M10 3L5 8l5 5",
  filter: "M2 3h12L9.5 8.5V13l-3-1.5v-3z",
  search: "M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.3 10.3L14 14",
  replay: "M3 8a5 5 0 1 0 1.5-3.5M3 2.5V5h2.5",
  sparkle: "M8 1.5l1.4 4.1 4.1 1.4-4.1 1.4L8 12.5l-1.4-4.1L2.5 7l4.1-1.4z",
  bytes: "M2 4h12M2 8h12M2 12h12M5.5 2v12M10.5 2v12",
  stop: "M4 4h8v8H4z",
  external: "M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v4h-9v-9h4",
  copy: "M5.5 5.5h8v8h-8zM2.5 10.5v-8h8",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className, title }: { name: IconName; size?: number; className?: string; title?: string }) {
  return (
    <svg
      className={`icon ${className ?? ""}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title && <title>{title}</title>}
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The BioBridge mark: two sensor nodes bridged onto one timeline. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.5" y="2.5" width="27" height="27" rx="5" strokeWidth={1.4} opacity={0.5} />
      <path d="M7 20c3-7 6-7 9 0s6 7 9 0" opacity={0.55} />
      <path d="M6 12h4l2-4 3 8 2-4h9" />
      <circle cx="7" cy="23.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="25" cy="23.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}
