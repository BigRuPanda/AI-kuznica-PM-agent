import {useEffect,useId,useRef,type ReactNode} from 'react';
import {createPortal} from 'react-dom';

export function Dialog({title,close,wide=false,children}:{title:string;close:()=>void;wide?:boolean;children:ReactNode}){
  const ref=useRef<HTMLDialogElement>(null), titleId=useId();
  useEffect(()=>{
    const dialog=ref.current!;
    const trigger=document.activeElement instanceof HTMLElement?document.activeElement:null;
    dialog.showModal();
    return ()=>{
      dialog.close();
      if(trigger?.isConnected)trigger.focus({preventScroll:true});
    };
  },[]);
  return createPortal(<dialog ref={ref} aria-labelledby={titleId} className={'modal'+(wide?' chart-dialog':'')}
    onCancel={e=>{e.preventDefault();close();}}
    onClick={e=>{if(e.target===e.currentTarget){const b=e.currentTarget.getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)close();}}}>
    <header className="dialog-head"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button close" onClick={close} aria-label="Закрыть">×</button></header>
    {children}
  </dialog>,document.body);
}
