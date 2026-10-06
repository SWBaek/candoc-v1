import type { SVGProps } from 'react';

const paths = {
  settings: <><path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z" /><circle cx="12" cy="12" r="3" /></>,
  chat: <><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H6l-4 2 2-5v-5.5A8.5 8.5 0 0 1 12.5 3 8.5 8.5 0 0 1 21 11.5Z" /><path d="M8 10h8M8 14h5" /></>,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  document: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M8 13h8M8 17h6" /></>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z" /><path d="m8 12 3 3 5-6" /></>,
  pages: <><rect x="7" y="3" width="13" height="16" rx="2" /><path d="M16 22H5a2 2 0 0 1-2-2V7" /></>,
  layout: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M3 9h18M9 9v12" /></>,
  order: <><path d="M5 5h14M5 12h10M5 19h8M18 10v11m-3-3 3 3 3-3" /></>,
  heading: <><path d="M5 5v14M19 5v14M5 12h14" /></>,
  link: <><path d="m10 14 4-4m-5 6-2 2a4 4 0 0 1-5-5l4-4a4 4 0 0 1 5 0m2-1 2-2a4 4 0 0 1 5 5l-4 4a4 4 0 0 1-5 0" /></>,
  paragraph: <><path d="M5 5h14M5 10h14M5 15h14M5 20h9" /></>,
  list: <><path d="M9 6h12M9 12h12M9 18h12M3 6h1M3 12h1M3 18h1" /></>,
  table: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M3 15h18M10 4v16" /></>,
  type: <><path d="M4 5h16M12 5v15M8 20h8M4 5v3M20 5v3" /></>,
  compare: <><rect x="3" y="4" width="7" height="16" rx="2" /><rect x="14" y="4" width="7" height="16" rx="2" /></>,
  record: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V2h6v2M9 10h6M9 15h6" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M15 4v16" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5" /></>,
  moon: <><path d="M20.5 13A8.7 8.7 0 0 1 11 3.5 8.7 8.7 0 1 0 20.5 13Z" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 17h.01" /></>,
  chevron: <path d="m6 9 6 6 6-6" />,
} as const;

export type IconName = keyof typeof paths;
export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}
