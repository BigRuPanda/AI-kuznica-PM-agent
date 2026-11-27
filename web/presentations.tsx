import {useCallback,useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Dialog} from './dialog';
import {post} from './team-data';
import './presentations.css';

type Version={id:string;created:number;status:'queued'|'running'|'ready'|'failed';notice?:string;personal:boolean};
type Preview=Version & {slides:string[]};
const stamp=(n:number)=>new Date(n).toLocaleString('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
const pending=(v:Version)=>v.status==='queued' || v.status==='running';

function Downloads({id}:{id:string}) {
  return <><a download href={'/api/presentations/'+id+'/pptx'}>Скачать PPTX</a>
    <a download href={'/api/presentations/'+id+'/pdf'}>Скачать PDF</a></>;
}

function PresentationDialog({id,status,close}:{id:string;status?:Version['status'];close:()=>void}) {
  const [view,show]=useState<Preview|null>(null),[slide,page]=useState(0),[error,fail]=useState('');
  useEffect(()=>{
    let active=true;
    post<Preview>('presentation-status',{id}).then(v=>{if(active)show(v);}).catch(e=>{if(active)fail(e.message);});
    return ()=>{active=false;};
  },[id,status]);
  return <Dialog title="Презентация разбора" close={close} wide>
    <div className="presentation-viewer">
      {error ? <p role="alert">{error}</p> : !view || pending(view) ? <p role="status">{view?.status==='running'?'Qwen подбирает слайды по материалам разбора…':'Готовим презентацию…'} Можно закрыть окно и вернуться позже.</p> :
        view.status==='failed' ? <p role="alert">{view.notice}</p> : <>
          <div className="presentation-exports"><span>Версия от {stamp(view.created)}</span><Downloads id={id} /></div>
          {view.notice && <p className="presentation-notice" role="status">{view.notice}</p>}
          <iframe title={'Слайд '+(slide+1)+' — '+view.slides[slide]} src={'/api/presentations/'+id+'/preview?slide='+slide} />
          <nav aria-label="Слайды презентации">
            <button type="button" aria-label="Предыдущий слайд" disabled={!slide} onClick={()=>page(slide-1)}>←</button>
            <select aria-label="Выбрать слайд" value={slide} onChange={e=>page(Number(e.target.value))}>{view.slides.map((title,i)=><option key={i} value={i}>{i+1}. {title}</option>)}</select>
            <span>{slide+1} / {view.slides.length}</span>
            <button type="button" aria-label="Следующий слайд" disabled={slide+1>=view.slides.length} onClick={()=>page(slide+1)}>→</button>
          </nav></>}
    </div>
  </Dialog>;
}

export function ChatPresentation({id}:{id:string}) {
  const [opened,open]=useState(false);
  return <><div className="presentation-exports"><button type="button" onClick={()=>open(true)}>Открыть презентацию</button>
    <Downloads id={id} /></div>{opened && <PresentationDialog id={id} status="ready" close={()=>open(false)} />}</>;
}

export function PresentationMaterials({caseId,actionSlot,versionFromChat}:{caseId:string;actionSlot:HTMLElement|null;versionFromChat?:string}) {
  const [versions,list]=useState<Version[]>([]),[opened,open]=useState('');
  const [error,fail]=useState(''),[creating,busy]=useState(false);
  const request=useRef<string|undefined>(undefined);
  const refresh=useCallback(()=>post<{items:Version[]}>('presentation-list',{caseId}).then(r=>r.items),[caseId]);
  useEffect(()=>{
    let active=true;
    const load=()=>refresh().then(items=>{if(active)list(items);}).catch(e=>{if(active)fail(e.message);});
    void load();
    return ()=>{active=false;};
  },[refresh,versionFromChat]);
  const waiting=versions.some(pending);
  useEffect(()=>{
    if(!waiting) return;
    let active=true;
    const tick=window.setInterval(()=>refresh().then(items=>{if(active)list(items);}).catch(e=>{if(active)fail(e.message);}),1500);
    return ()=>{active=false;clearInterval(tick);};
  },[waiting,refresh]);
  const status=versions.find(v=>v.id===opened)?.status;
  const create=async()=>{
    if(creating) return;
    busy(true);fail('');
    request.current ||= crypto.randomUUID();
    try {
      const r=await post<{id:string}>('presentation-create',{caseId,request:request.current});
      const items=await refresh();
      list(items);open(r.id);request.current=undefined;
    } catch(e){fail(e instanceof Error?e.message:String(e));} finally {busy(false);}
  };
  const button=<button type="button" disabled={creating} onClick={create}>{creating?'Готовим снимок…':'Собрать презентацию'}</button>;
  return <>
    {actionSlot && createPortal(button,actionSlot)}
    {(!actionSlot || versions.length>0 || error) && <section className="paper presentation-materials">
    <div className="presentation-heading"><h3>Презентации разбора</h3>{!actionSlot && button}</div>
    {error && <p role="alert">{error}</p>}
    {versions.map(v=><button type="button" className="presentation-version" key={v.id} onClick={()=>open(v.id)}>
      <span>Отчёт на {stamp(v.created)}</span><small>{pending(v)?'Собирается…':v.status==='failed'?'Ошибка сборки':v.personal?'Личный':'Командный'}</small></button>)}</section>}
    {opened && <PresentationDialog key={opened} id={opened} status={status} close={()=>open('')} />}
  </>;
}
