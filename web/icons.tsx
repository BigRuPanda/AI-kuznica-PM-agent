import type {ReactNode} from 'react';

const shapes:Record<string,ReactNode>={
  sun:<><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></>,
  moon:<path d="M20.5 15.2A8.5 8.5 0 0 1 8.8 3.5 8.5 8.5 0 1 0 20.5 15.2Z"/>,
  overview:<><rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M8 15v2m4-6v6m4-9v9"/></>,
  chat:<path d="M20.5 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-3.5-.7L4 20l.7-4.5a8.5 8.5 0 1 1 15.8-4Z"/>,
  cases:<><rect x="5" y="4" width="14" height="16" rx="2"/><path d="M9 9h6m-6 3h6m-6 3h4"/></>,
  sources:<><ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v13a7 2.5 0 0 0 14 0v-13M5 12a7 2.5 0 0 0 14 0"/></>,
  panelLeft:<><rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M9 5v14"/></>,
  panelTop:<><rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 10h17"/></>,
  arrow:<path d="M4 12h15m-6-6 6 6-6 6"/>,
  down:<path d="m6 9 6 6 6-6"/>,
  arrowUp:<path d="M12 20V4m-6 6 6-6 6 6"/>,
  search:<><circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4 4"/></>,
  copy:<><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>,
  edit:<path d="M13.5 6.5 17.5 10.5M4 20l4.5-1 11-11a2.8 2.8 0 0 0-4-4l-11 11L4 20Z"/>,
  more:<path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3"/>,
  trash:<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5"/>,
  check:<path d="m5 12 4 4L19 6"/>,
  trend:<path d="M4 16l5-5 4 4 7-8m-5 0h5v5"/>,
  settings:<><path d="M10 3h4l.6 2.4 1.7 1 2.4-.7 2 3.5-1.8 1.8v2l1.8 1.8-2 3.5-2.4-.7-1.7 1L14 21h-4l-.6-2.4-1.7-1-2.4.7-2-3.5 1.8-1.8v-2L3.3 9.2l2-3.5 2.4.7 1.7-1L10 3Z"/><circle cx="12" cy="12" r="3"/></>,
  logout:<><path d="M11 4H5v16h6m1-8h8m-4-4 4 4-4 4"/></>,
  calendar:<><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18"/></>,
  people:<><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2m1-15a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2"/></>,
  plus:<path d="M12 4v16M4 12h16"/>,
  download:<><path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/></>,
  expand:<><path d="M14 3h7v7m0-7L10 14M10 4H4v16h16v-6"/></>,
  send:<><path d="m3 4 18 8-18 8 3-8-3-8Zm4 8h13"/></>,
  left:<path d="m14 6-6 6 6 6"/>,
  right:<path d="m10 6 6 6-6 6"/>,
  agent:<><path d="m10 4 2.1 5.9L18 12l-5.9 2.1L10 20l-2.1-5.9L2 12l5.9-2.1L10 4Z" fill="currentColor" stroke="none"/><path d="m18 2 1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Z" fill="currentColor" stroke="none"/></>,
};

export function Icon({name}:{name:keyof typeof shapes}){
  return <svg className="ui-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[name]}</svg>;
}
