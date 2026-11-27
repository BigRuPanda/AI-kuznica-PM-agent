import React, { useEffect, useState } from 'react';
import { num, post } from './team-data';

type Option = {id:string; title:string; segments:string[]; note?:string; prospective?:boolean};
type Example = {taskId:string; releaseId?:string; metric:string; segment:string; condition?:string; asOf?:string};
type Options = {metrics:Option[]; tasks:{id:string; title:string; metrics:string[]; releaseIds:string[]}[];
  releases:{id:string; title:string; date:string; metrics:string[]}[]; examples:{cart?:Example; retro?:Example}; controls:string[]};
type Source = {file:string; loc:string; version:string};
type MetricRow = Source & {date:string; value:number};
type Release = Source & {id:string; date:string; title:string};
type Period = {from:string; through:string; value:number|null; count:number; expected:number; sources:MetricRow[];
  unit:string|null; total?:number; numerator?:number; denominator?:number};
export type ObservationPlan = {version:number; kind?:'archive-observation'; revision?:number;
  metric:string; title:string; segment:string; deployed:string|null; releaseId:string|null; sources?:Source[];
  taskId:string|null; baselineWeeks:number; observationWeeks:number; direction:string; condition:string|null; target:number|null;
  metricNote?:string; baselineNote?:string; control?:string};
export type Observation = {state:string; reason?:string; plan:ObservationPlan; asOf:string; baseline?:Period; observed?:Period; unit?:string;
  breaks?:Release[]; context?:Release[]; checkAfter?:string; change?:number;
  control?:{product:string; baseline:Period; observed:Period; relativeChange:number|null; tolerance:number};
  rollout?:{id:string; date:string; title?:string; sources:Source[]}; rolloutSources?:Source[]};

function SourceLink({item}:{item:Source}) {
  return <a href={'#knowledge-source/'+item.version+'/'+encodeURIComponent(item.loc)}>{item.file} · {item.loc}</a>;
}
function Periods({rows}:{rows:readonly (readonly [string, Period|undefined])[]}) {
  return <>{rows.map(([title,r]) => r && <div key={title}>
    <p><b>{title}</b> · {r.from} — {r.through} · {num(r.value)} {r.unit} · наблюдений {r.count} из {r.expected}
      {r.total != null && ' · всего ' + num(r.total)}
      {r.numerator != null && ' · числитель / знаменатель ' + num(r.numerator) + ' / ' + num(r.denominator)}</p>
    {r.sources.length > 0 && <details><summary>Исходные строки</summary><ul>{r.sources.map(s =>
      <li key={s.version+s.loc}>{s.date} · {num(s.value)} · <SourceLink item={s}/></li>)}</ul></details>}
  </div>)}</>;
}
export function ObservationResult({value}:{value:Observation}) {
  const plan = value.plan;
  const sources = [...new Map([...(plan?.sources || []), ...(value.rollout?.sources || []), ...(value.rolloutSources || [])]
    .map(s => [s.version + s.loc, s])).values()];
  return <section aria-label="Результат проверки">
    <p><strong>{value.state}</strong></p>
    {value.reason && <p>{value.reason}</p>}
    {plan && <>
      <p>{[plan.taskId, plan.releaseId || value.rollout?.id, plan.title, plan.segment].filter(Boolean).join(' · ')}</p>
      <dl className="comparison-dates">
        <div><dt>Выкладка</dt><dd>{plan.deployed || value.rollout?.date || 'Дата не подтверждена'}</dd></div>
        <div><dt>База</dt><dd>{plan.baselineWeeks} нед. до выкладки</dd></div>
        <div><dt>Наблюдение</dt><dd>{plan.observationWeeks} нед. после выкладки</dd></div>
        {plan.control && <div><dt>Контроль</dt><dd>{plan.control}</dd></div>}
        <div><dt>Цель</dt><dd>{plan.target == null ? 'Числовая цель не задана' :
          (plan.direction === 'at-most' ? '≤ ' : '≥ ') + num(plan.target) + (value.unit ? ' ' + value.unit : '')}</dd></div>
      </dl>
      {plan.baselineNote && <p>{plan.baselineNote}</p>}
      {value.checkAfter && <p>Проверка после завершения окна {value.checkAfter}</p>}
      {plan.condition && <p>{plan.condition}</p>}
      {sources.map(s=><p key={s.version+s.loc}><SourceLink item={s}/></p>)}
    </>}
    <Periods rows={ [['База',value.baseline],['После выкладки',value.observed]] }/>
    {value.control && <>
      <Periods rows={ [['База контроля',value.control.baseline],['Контроль после выкладки',value.control.observed]] }/>
      {value.control.relativeChange != null && <p>Изменение контроля · {num(value.control.relativeChange)}%.
        Допустимое отклонение · {num(value.control.tolerance)}%.</p>}
    </>}
    {value.breaks?.map(s => <p key={s.version+s.loc}>{s.id} · {s.date} · {s.title} · <SourceLink item={s}/></p>)}
    {value.context?.map(s => <p key={s.version+s.loc}>{s.id} · {s.date} · {s.title}.
      В журнале изменений указаны другие метрики. <SourceLink item={s}/></p>)}
    {value.change != null && <p>Разница · {num(value.change)} {value.unit === '%' ? 'п. п.' : value.unit}.
      Сравнение показывает динамику ряда. Чтобы оценить вклад релиза, нужно учесть другие изменения и колебания трафика.</p>}
  </section>;
}

export function EffectPlan({caseId, saved, reload, archiveOnly, readOnly}:{
  caseId:string; saved:Observation|null; reload:()=>Promise<void>; archiveOnly?:boolean; readOnly?:boolean;
}) {
  const plan = saved?.plan;
  const [choices,setChoices] = useState<Options>();
  const [taskId,task] = useState(plan?.taskId || ''), [releaseId,release] = useState(plan?.releaseId || '');
  const [metric,setMetric] = useState(plan?.metric || 'orders_index'), [segment,setSegment] = useState(plan?.segment || '');
  const [control,setControl] = useState<string|undefined>(plan?.metric === 'orders_index' ? plan.control || '' : undefined);
  const [baselineWeeks,setBaselineWeeks] = useState(String(plan?.baselineWeeks || 4));
  const [observationWeeks,setObservationWeeks] = useState(String(plan?.observationWeeks || 4));
  const [target,setTarget] = useState(plan?.target == null ? '' : String(plan.target));
  const [direction,setDirection] = useState(plan?.direction || 'at-least');
  const [condition,setCondition] = useState(plan?.condition || ''), [asOf,setAsOf] = useState('');
  const [result,preview] = useState<Observation|null>(null), [error,fail] = useState(''), [busy,setBusy] = useState(false);
  useEffect(() => {
    if (readOnly) return;
    let active=true;
    post<Options>('watch-options',{caseId}).then(x=> {if (active) setChoices(x);})
      .catch(e=>{if (active) fail(e.message);});
    return ()=>{active=false;};
  },[caseId, readOnly]);
  const taskRow = choices?.tasks.find(t => t.id===taskId);
  const releases = choices?.releases.filter(r => !taskRow || taskRow.releaseIds.includes(r.id)) || [];
  const metricRow = choices?.metrics.find(m => m.id===metric);
  const segments = metricRow?.segments || [];
  const defaultControl = choices?.controls.length === 1 ? choices.controls[0] : '';
  function chooseMetric(id:string) {setMetric(id); setSegment('');}
  function chooseTask(id:string) {
    const t=choices?.tasks.find(t=>t.id===id);
    task(id); release(''); preview(null);
    const linked=t?.metrics.find(m=>choices?.metrics.some(row=>row.id===m));
    if (linked) chooseMetric(linked);
  }
  async function run(input:object, check:boolean) {
    setBusy(true); fail(''); preview(null);
    try {
      const value = await post<Observation>(check ? 'effect-preview' : 'watch',{caseId, ...input});
      if (check) preview(value); else await reload();
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function applyExample(example:Example, check:boolean) {
    task(example.taskId); release(example.releaseId || ''); setMetric(example.metric); setSegment(example.segment);
    setBaselineWeeks('4'); setObservationWeeks('4'); setTarget(''); setDirection('at-least');
    setCondition(example.condition || ''); setAsOf(example.asOf || '');
    preview(null); fail('');
    if (check) void run({...example, baselineWeeks:4, observationWeeks:4}, true);
  }
  async function submit(e:React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const check = ((e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement)?.value === 'preview';
    const input = {taskId:taskId||undefined,releaseId:releaseId||undefined,metric,segment:segments.includes(segment)?segment:segments[0],
      control:metric === 'orders_index' ? control ?? defaultControl : undefined,
      deployed: (!taskId && !releaseId && form.get('deployed')) || undefined,
      baselineWeeks:Number(baselineWeeks),observationWeeks:Number(observationWeeks),
      target:target ? Number(target) : null,direction,condition,asOf:check ? asOf || undefined : undefined };
    await run(input,check);
  }
  const cart = choices?.examples.cart, retro = choices?.examples.retro;
  const linkedRollout = taskId === saved?.plan.taskId ? saved.rollout : undefined;
  return <>
    {saved && <ObservationResult value={saved}/>}
    {error && <p className="error" role="alert">{error}</p>}
    {cart && <button type="button" disabled={busy} onClick={()=>applyExample(cart,true)}>Подготовить наблюдение по T-08</button>}
    {retro && <button type="button" disabled={busy} onClick={()=>applyExample(retro,true)}>Рассчитать пример Astra · R-02</button>}
    {result && <><h4>{result.plan?.deployed || result.rollout ? 'Расчёт на ' + result.asOf : 'План проверки'}</h4><ObservationResult value={result}/></>}
    {!readOnly && choices && <form onSubmit={submit} onChange={()=>preview(null)}>
      <label>Задача из исходного бэклога<select value={taskId} onChange={e=>chooseTask(e.target.value)}>
        <option value="">Без привязки</option>{choices.tasks.map(t=><option key={t.id} value={t.id}>{t.id} · {t.title}</option>)}</select></label>
      <label>Выкладка из источника<select value={releaseId} onChange={e=>{const id=e.target.value; release(id);
        const linked=releases.find(r=>r.id===id)?.metrics.find(m=>choices.metrics.some(row=>row.id===m)); if (linked) chooseMetric(linked);}}>
        <option value="">{linkedRollout ? linkedRollout.id + ' · ' + linkedRollout.date + ' (по связке с задачей)' :
          'Дата не подтверждена'}</option>{releases.map(r=><option key={r.id} value={r.id}>{r.id} · {r.date} · {r.title}</option>)}</select></label>
      {!archiveOnly && !taskId && !releaseId && <label>Когда изменение вышло<input type="date" name="deployed" defaultValue={!plan?.releaseId ? plan?.deployed || '' : ''}/></label>}
      <label>Метрика проверки<select value={metric} onChange={e=>chooseMetric(e.target.value)}>{choices.metrics.map(m=><option key={m.id} value={m.id}>{m.title}</option>)}</select></label>
      {metricRow?.note && <p>{metricRow.note}</p>}
      {segments.length ? <label>Разрез<select value={segments.includes(segment)?segment:segments[0]} onChange={e=>setSegment(e.target.value)}>
        {segments.map(s=><option key={s}>{s}</option>)}</select></label> : <p>Для выбранного продукта пока нет наблюдений по этому показателю.</p>}
      {metric === 'orders_index' && choices.controls.length > 0 && <label>Контрольное семейство
        <select value={control ?? defaultControl} onChange={e=>setControl(e.target.value)}>
          <option value="">Без контроля</option>{choices.controls.map(product=><option key={product}>{product}</option>)}
        </select>
      </label>}
      {metricRow?.prospective && <p>Разрезы взяты из визитов на страницу семейства. Ряд метрики появится после проверки события.</p>}
      <label>Недель до выкладки<input type="number" min="1" max="12" required value={baselineWeeks} onChange={e=>setBaselineWeeks(e.target.value)}/></label>
      <label>Недель после выкладки<input type="number" min="1" max="12" required value={observationWeeks} onChange={e=>setObservationWeeks(e.target.value)}/></label>
      <label>Критерий цели<select value={direction} onChange={e=>setDirection(e.target.value)}><option value="at-least">Не ниже</option><option value="at-most">Не выше</option></select></label>
      <label>Значение цели, если согласовано<input type="number" step="any" value={target} onChange={e=>setTarget(e.target.value)}/></label>
      <label>Условие повторной проверки<input maxLength={400} value={condition} onChange={e=>setCondition(e.target.value)} placeholder="Например, после проверки регистрации события"/></label>
      <button disabled={busy} value="save">Сохранить наблюдение</button>
      <label>Оценить по данным на дату<input type="date" value={asOf} onChange={e=>setAsOf(e.target.value)}/></label>
      <button disabled={busy} value="preview">Рассчитать без сохранения</button>
    </form>}
  </>;
}
