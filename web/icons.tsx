import type {ReactNode} from 'react';

const shapes:Record<string,ReactNode>={
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
