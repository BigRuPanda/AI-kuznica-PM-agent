import {useLayoutEffect,useId,useRef,type ReactNode} from 'react';
import {createPortal} from 'react-dom';

type Dismiss = (after?: () => void) => void;

export function Dialog({title,close,wide=false,children}:{title:string;close:()=>void;wide?:boolean;children:ReactNode | ((dismiss: Dismiss) => ReactNode)}){
  const ref=useRef<HTMLDialogElement>(null), animation=useRef<Animation>(null), titleId=useId();
  useLayoutEffect(()=>{
    const dialog=ref.current!;
    const trigger=document.activeElement instanceof HTMLElement?document.activeElement:null;
    dialog.showModal();
    return ()=>{
      animation.current?.cancel();
      dialog.close();
      if(trigger?.isConnected)trigger.focus({preventScroll:true});
    };
  },[]);
  const dismiss: Dismiss = (after) => {
    const dialog = ref.current;
    if (!dialog || animation.current) return;
    const finish = () => {
      close();
      after?.();
    };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !dialog.animate) {
      finish();
      return;
    }
    const style = getComputedStyle(dialog);
    dialog.dataset.closing = '';
    animation.current = dialog.animate(
      [{ opacity: style.opacity, transform: style.transform }, { opacity: 0, transform: 'translateY(6px) scale(.99)' }],
      { duration: 190, easing: 'ease-in-out', fill: 'forwards' },
    );
    void animation.current.finished.then(finish, () => {});
  };
  return createPortal(<dialog ref={ref} aria-labelledby={titleId} className={'modal'+(wide?' chart-dialog':'')}
    onCancel={e=>{e.preventDefault();dismiss();}}
    onClick={e=>{if(e.target===e.currentTarget){const b=e.currentTarget.getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)dismiss();}}}>
    <header className="dialog-head"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button close" onClick={()=>dismiss()} aria-label="Закрыть">×</button></header>
    {typeof children === 'function' ? children(dismiss) : children}
  </dialog>,document.body);
}
