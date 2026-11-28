import {useState} from 'react';
import {api,metricNames} from './types';
import type {Journal,Release} from './types';
import {Dialog} from './dialog';
const localTime=(date:string)=>new Date(date+':00+03:00').toISOString();
export function DataForm({kind,journal,onDone,close}:{kind:'release'|'import';journal:Journal;onDone:(id?:string)=>void;close:()=>void}){
  const [pending,setPending]=useState(false),[error,setError]=useState(''),[file,setFile]=useState<File|null>(null),[dataset,setDataset]=useState(kind==='release'?journal.datasets[0]?.id||'':'');
  return <Dialog title={kind==='release'?'Добавить релиз':'Загрузить события'} close={close}><form onSubmit={async e=>{
    e.preventDefault();if(pending)return;const f=new FormData(e.currentTarget),get=(k:string)=>String(f.get(k)||'');setPending(true);setError('');
    try{
      if(kind==='release'){const r=await api<Release>('releases',{title:get('title'),description:get('description'),audience:get('audience'),question:get('question'),activatedAt:localTime(get('launch')),dataset,target:Number(get('target')),exposure:get('exposure'),sourceKey:get('sourceKey')});onDone(r.id);}
      else{if(!file)throw Error('Выберите CSV.');if(file.size>12_000_000)throw Error('Файл больше 12 МБ.');
        await api('import',{name:get('name')||file.name,dataset:dataset||undefined,completeThrough:get('complete')?localTime(get('complete')):undefined,csv:await file.text()});onDone();}
    }catch(ex){setError((ex as Error).message);}finally{setPending(false);}
  }}>
  <label>Набор данных<select required={kind==='release'} data-ui-hint={kind==='release' ? 'Выберите события, по которым считать метрики релиза.' : undefined} value={dataset} onChange={e=>setDataset(e.target.value)}>{kind==='import'&&<option value="">Новый набор</option>}{journal.datasets.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
  {kind==='import'?<>{!dataset&&<label>Название набора<input name="name" required maxLength={180}/></label>}<label>CSV с событиями<input required type="file" accept=".csv,text/csv" onChange={e=>setFile(e.target.files?.[0]||null)}/></label>
  <label>Данные полны по дату и время, МСК<input name="complete" type="datetime-local" data-ui-hint="До какого момента выгрузка содержит все события."/></label>
  <details><summary>Требования к CSV</summary><p>Обязательны event_type, event_at и order_id или invoice_id. Для неполной выгрузки дату можно оставить пустой.</p></details></>:
  <><label>Название<input name="title" required maxLength={180}/></label><label>Что изменилось<textarea name="description" required maxLength={1500}/></label>
  <label>Включение для пользователей, МСК<input type="datetime-local" required name="launch"/></label><label>Аудитория<input required name="audience"/></label>
  <label>Главный вопрос<input required name="question"/></label><label>Целевая метрика<select name="target">{metricNames.map((m,i)=><option value={i} key={m}>{m}</option>)}</select></label>
  <details><summary>Привязка событий</summary><label>Значение release_id в CSV<input name="sourceKey" placeholder="Все события набора"/></label><label>Событие показа версии<select name="exposure"><option value="checkout_started">Начало оформления</option><option value="invoice_page_viewed">Просмотр счёта</option></select></label></details></>}
  {error&&<p role="alert">{error}</p>}<button className="primary" disabled={pending}>{pending?'Сохранение…':kind==='release'?'Создать релиз':'Импортировать'}</button></form></Dialog>;
}
