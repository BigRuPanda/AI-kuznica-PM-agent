import {useCallback,useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Dialog} from './dialog';
import {post} from './team-data';
import './presentations.css';

type Version={id:string;created:number;status:'queued'|'running'|'ready'|'failed';notice?:string;personal:boolean};
type Preview=Version & {slides:string[]};
const stamp=(n:number)=>new Date(n).toLocaleString('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
const pending=(v:Version)=>v.status==='queued' || v.status==='running';

export function PresentationMaterials({caseId,actionSlot}:{caseId:string;actionSlot:HTMLElement|null}) {
  const [versions,list]=useState<Version[]>([]),[opened,open]=useState(''),[view,show]=useState<Preview|null>(null);
  const [slide,page]=useState(0),[error,fail]=useState(''),[creating,busy]=useState(false);
  const request=useRef<string|undefined>(undefined);
  const refresh=useCallback(()=>post<{items:Version[]}>('presentation-list',{caseId}).then(r=>r.items),[caseId]);
  useEffect(()=>{
    let active=true;
    const load=()=>refresh().then(items=>{if(active)list(items);}).catch(e=>{if(active)fail(e.message);});
    void load();
    return ()=>{active=false;};
  },[refresh]);
  const waiting=versions.some(pending);
  useEffect(()=>{
    if(!waiting) return;
    let active=true;
    const tick=window.setInterval(()=>refresh().then(items=>{if(active)list(items);}).catch(e=>{if(active)fail(e.message);}),1500);
    return ()=>{active=false;clearInterval(tick);};
  },[waiting,refresh]);
  const status=versions.find(v=>v.id===opened)?.status;
  useEffect(()=>{
    if(!opened) return;
    let active=true;
    post<Preview>('presentation-status',{id:opened}).then(v=>{if(active)show(v);}).catch(e=>{if(active)fail(e.message);});
    return ()=>{active=false;};
  },[opened,status]);
  const select=(id:string)=>{page(0);show(null);open(id);};
  const create=async()=>{
    if(creating) return;
    busy(true);fail('');
    request.current ||= crypto.randomUUID();
    try {
      const r=await post<{id:string}>('presentation-create',{caseId,request:request.current});
      const items=await refresh();
      list(items);select(r.id);request.current=undefined;
    } catch(e){fail(e instanceof Error?e.message:String(e));} finally {busy(false);}
  };
  const button=<button type="button" disabled={creating} onClick={create}>{creating?'Готовим снимок…':'Собрать презентацию'}</button>;
  return <>
    {actionSlot && createPortal(button,actionSlot)}
    {(!actionSlot || versions.length>0 || error) && <section className="paper presentation-materials">
    <div className="presentation-heading"><h3>Презентации разбора</h3>{!actionSlot && button}</div>
    {error && <p role="alert">{error}</p>}
    {versions.map(v=><button type="button" className="presentation-version" key={v.id} onClick={()=>select(v.id)}>
      <span>Отчёт на {stamp(v.created)}</span><small>{pending(v)?'Собирается…':v.status==='failed'?'Ошибка сборки':v.personal?'Личный':'Командный'}</small></button>)}</section>}
    {opened && <Dialog title="Презентация разбора" close={()=>open('')} wide>
      <div className="presentation-viewer">
        {!view || pending(view) ? <p role="status">{view?.status==='running'?'Qwen подбирает слайды по материалам разбора…':'Готовим презентацию…'} Можно закрыть окно и вернуться позже.</p> :
          view.status==='failed' ? <p role="alert">{view.notice}</p> : <>
            <div className="presentation-exports"><span>Версия от {stamp(view.created)}</span>
              <a download href={'/api/presentations/'+opened+'/pptx'}>Скачать PPTX</a>
              <a download href={'/api/presentations/'+opened+'/pdf'}>Скачать PDF</a></div>
            {view.notice && <p className="presentation-notice" role="status">{view.notice}</p>}
            <iframe title={'Слайд '+(slide+1)+' — '+view.slides[slide]} src={'/api/presentations/'+opened+'/preview?slide='+slide} />
            <nav aria-label="Слайды презентации">
              <button type="button" aria-label="Предыдущий слайд" disabled={!slide} onClick={()=>page(slide-1)}>←</button>
              <select aria-label="Выбрать слайд" value={slide} onChange={e=>page(Number(e.target.value))}>{view.slides.map((title,i)=><option key={i} value={i}>{i+1}. {title}</option>)}</select>
              <span>{slide+1} / {view.slides.length}</span>
              <button type="button" aria-label="Следующий слайд" disabled={slide+1>=view.slides.length} onClick={()=>page(slide+1)}>→</button>
            </nav></>}
      </div>
    </Dialog>}
  </>;
}
