import type { ReactNode } from "react";

export const ICONS: Record<string, ReactNode> = {
  edit: <path d="M4 20l4-1 12-12-3-3L5 16zM14 7l3 3" />,
  up: <path d="M6 15l6-6 6 6" />,
  ai: (
    <>
      <path d="M12 3.5l1.8 4.5 4.5 1.8-4.5 1.8L12 16.1l-1.8-4.5-4.5-1.8 4.5-1.8z" />
      <path d="M18.5 14.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </>
  ),
  media: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7.5 4v16M16.5 4v16M3 9h4.5M3 15h4.5M16.5 9H21M16.5 15H21" />
    </>
  ),
  chapters: (
    <>
      <path d="M9 6h11M9 12h11M9 18h8" />
      <path d="M4 5h1.5v2H4zM4 11h1.5v2H4zM4 17h1.5v2H4z" />
    </>
  ),
  subtitles: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 15h5M14.5 15H17M7 11h2.5M12 11h5" />
    </>
  ),
  voice: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </>
  ),
  history: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" />
      <path d="M3.5 4.5V8H7" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  select: (
    <>
      <path d="M6 3.5l12 7.5-5.2 1.3L10 18z" />
    </>
  ),
  snap: (
    <>
      <path d="M6 4v16M18 4v16" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </>
  ),
  roll: <path d="M12 3v18M8 7l-4 5 4 5M16 7l4 5-4 5" />,
  blade: (
    <>
      <circle cx="6" cy="6.5" r="2.5" />
      <circle cx="6" cy="17.5" r="2.5" />
      <path d="M8.2 7.8L20 19M8.2 16.2L20 5" />
    </>
  ),
  flag: (
    <>
      <path d="M5.5 21V4M5.5 4.5h11l-2.2 4 2.2 4h-11" />
    </>
  ),
  undo: (
    <>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </>
  ),
  redo: (
    <>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </>
  ),
  magnet: (
    <>
      <path d="M5 4h4.5v7.5a2.5 2.5 0 0 0 5 0V4H19v7.5a7 7 0 0 1-14 0z" />
      <path d="M5 8h4.5M14.5 8H19" />
    </>
  ),
  play: (
    <>
      <path d="M7.5 4.5l12 7.5-12 7.5z" fill="currentColor" />
    </>
  ),
  pause: (
    <>
      <path d="M8 5v14M16 5v14" strokeWidth="3" />
    </>
  ),
  back: (
    <>
      <path d="M18.5 19L9.5 12l9-7z" fill="currentColor" />
      <path d="M5.5 5v14" />
    </>
  ),
  fwd: (
    <>
      <path d="M5.5 19l9-7-9-7z" fill="currentColor" />
      <path d="M18.5 5v14" />
    </>
  ),
  export: (
    <>
      <path d="M12 15V3.5M7.5 8L12 3.5 16.5 8" />
      <path d="M5 13.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-5.5" />
    </>
  ),
  down: (
    <>
      <path d="M6 9l6 6 6-6" />
    </>
  ),
  right: (
    <>
      <path d="M9 6l6 6-6 6" />
    </>
  ),
  left: (
    <>
      <path d="M15 6l-6 6 6 6" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.3-4.3" />
    </>
  ),
  check: (
    <>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </>
  ),
  close: (
    <>
      <path d="M6 6l12 12M18 6L6 18" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9.5" rx="2" />
      <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  volume: (
    <>
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
      <path d="M16 9a4.2 4.2 0 0 1 0 6M18.5 6.5a7.8 7.8 0 0 1 0 11" />
    </>
  ),
  send: (
    <>
      <path d="M4.5 11.5L20 4l-6.5 16-2.6-6.9z" />
      <path d="M10.9 13.1L20 4" />
    </>
  ),
  grid: (
    <>
      <path d="M5.5 4h4A1.5 1.5 0 0 1 11 5.5v4A1.5 1.5 0 0 1 9.5 11h-4A1.5 1.5 0 0 1 4 9.5v-4A1.5 1.5 0 0 1 5.5 4zM14.5 4h4A1.5 1.5 0 0 1 20 5.5v4a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 13 9.5v-4A1.5 1.5 0 0 1 14.5 4zM5.5 13h4a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 9.5 20h-4A1.5 1.5 0 0 1 4 18.5v-4A1.5 1.5 0 0 1 5.5 13zM14.5 13h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5v-4a1.5 1.5 0 0 1 1.5-1.5z" />
    </>
  ),
  list: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" strokeWidth="2" />
    </>
  ),
  folder: (
    <>
      <path d="M3 7.5A2 2 0 0 1 5 5.5h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </>
  ),
  star: (
    <>
      <path d="M12 4l2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  wand: (
    <>
      <path d="M4.5 19.5l10-10 1.5 1.5-10 10z" />
      <path d="M15 3v2.5M15 9.5V12M19.5 7H17M13 7h-2.5M18 4l-1.5 1.5" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11.5A8 8 0 1 0 17.7 17" />
      <path d="M20 4.5v7h-7" />
    </>
  ),
  fit: (
    <>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" />
      <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" />
    </>
  ),
  text: (
    <>
      <path d="M5 6.5V4.5h14v2M12 4.5v15M9 19.5h6" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-1 1.6-2.1-.5-1.3.4-2.4 1.7-2.4H18a2.5 2.5 0 0 0 2.5-2.5A8.5 8.5 0 0 0 12 3.5z" />
      <circle cx="8" cy="11" r="1" />
      <circle cx="11.5" cy="7.5" r="1" />
      <circle cx="16" cy="9" r="1" />
    </>
  ),
  motion: (
    <>
      <path d="M4 12h3M3 8h5M4 16h3" />
      <circle cx="15" cy="12" r="5.5" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15.5V4M7.5 8.5L12 4l4.5 4.5M4.5 19.5h15" />
    </>
  ),
  more: (
    <>
      <path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth="2.5" />
    </>
  ),
  target: (
    <>
      <path d="M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  wave: (
    <>
      <path d="M3 12h1.5M7 8.5v7M10.5 5v14M14 8v8M17.5 10v4M21 12h-1" />
    </>
  ),
  file: (
    <>
      <path d="M14 3.5H6.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V9z" />
      <path d="M14 3.5V9h5.5" />
    </>
  ),
  filePlus: (
    <>
      <path d="M14 3.5H6.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V9z" />
      <path d="M14 3.5V9h5.5M12 12v6M9 15h6" />
    </>
  ),
  folderOpen: (
    <>
      <path d="M3 18V7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1.5" />
      <path d="M3 18l2.6-6.4A2 2 0 0 1 7.5 10.5H20a1 1 0 0 1 .9 1.4L18.6 17.7a2 2 0 0 1-1.8 1.3H4a1 1 0 0 1-1-1z" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.5h.01" strokeWidth="2" />
    </>
  ),
  stop: (
    <>
      <path d="M8.5 6.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z" fill="currentColor" />
    </>
  ),
  alignLeft: (
    <>
      <path d="M4 6h16M4 10h10M4 14h16M4 18h10" />
    </>
  ),
  alignCenter: (
    <>
      <path d="M4 6h16M7 10h10M4 14h16M7 18h10" />
    </>
  ),
  alignRight: (
    <>
      <path d="M4 6h16M10 10h10M4 14h16M10 18h10" />
    </>
  ),
  chevronUpDown: (
    <>
      <path d="M8 10l4-4 4 4M8 14l4 4 4-4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  replace: (
    <>
      <path d="M4 7h11l-3-3M20 17H9l3 3" />
    </>
  ),
  inOut: (
    <>
      <path d="M7 5H5v14h2M17 5h2v14h-2" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  bot: (
    <>
      <rect x="5" y="8" width="14" height="11" rx="3" />
      <path d="M12 4.5V8M9.5 13h.01M14.5 13h.01" strokeWidth="2" />
      <path d="M3 13v2M21 13v2" />
    </>
  ),
  scissorsRange: (
    <>
      <path d="M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4" />
    </>
  ),
  split: (
    <>
      <path d="M12 4v16M8 8l-3 4 3 4M16 8l3 4-3 4" />
    </>
  ),
  merge: (
    <>
      <path d="M5 12h14M9 8l3 4-3 4M15 8l-3 4 3 4" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2" />
    </>
  ),
  keyboard: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" strokeWidth="1.8" />
    </>
  ),
  sparkLine: (
    <>
      <path d="M3 17l5-6 4 3 4-7 5 6" />
    </>
  ),
};
