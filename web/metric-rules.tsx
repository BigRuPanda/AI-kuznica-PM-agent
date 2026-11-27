import React, { useEffect, useId, useState } from 'react';
import { post } from './team-data';

type RuleConfig = {
  metric: string; product: string; segment: string; sourceId: string; releaseId: string; enabled: boolean;
  threshold: number; minDenominator: number; minBaselineNumerator: number; confirmations: number;
};
type Rule = {config: RuleConfig; title: string; unit: string; detail: string; week: string; releaseId?: string};
type Monitoring = {
  rules: Rule[];
  releases: {id:string; date:string; description:string}[];
  series: {metric:string; product:string; segment:string; sourceId:string}[];
};

function RuleForm({rule, monitor, save}: {
  rule: Rule; monitor: Monitoring; save: (config: RuleConfig) => Promise<void>;
}) {
  const cfg = rule.config;
  const [busy, wait] = useState(false);
  const [error, fail] = useState('');
  const [product, setProduct] = useState(cfg.product);
  const [segment, setSegment] = useState(cfg.segment);
  const [source, setSource] = useState(cfg.sourceId);
  const id = useId();
  const choices = monitor.series.filter(row => row.metric === cfg.metric);
  const productChoices = choices.filter(row => row.product === product.trim());
  const originalRow = product.trim() === cfg.product && segment.trim() === cfg.segment;
  const sources = [...new Set([originalRow ? cfg.sourceId : '', ...productChoices
    .filter(row => segment.trim() === 'all' || row.segment === segment.trim()).map(row => row.sourceId)].filter(Boolean))];
  return <form onSubmit={async e => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const field = (key: string) => String(data.get(key) || '');
    wait(true); fail('');
    try {
      await save({metric:cfg.metric, product:field('product'), segment:field('segment'),
        sourceId:field('sourceId'), releaseId:field('releaseId'), enabled:data.has('enabled'),
        threshold:Number(field('threshold')), minDenominator:Number(field('minDenominator')),
        minBaselineNumerator:Number(field('minBaselineNumerator')), confirmations:Number(field('confirmations'))});
    } catch (err) { fail((err as Error).message); } finally { wait(false); }
  }}>
    <label><input type="checkbox" name="enabled" defaultChecked={cfg.enabled}/> Включить мониторинг</label>
    <label>Продукт<input list={id+'-products'} name="product" value={product} required
      onChange={e => setProduct(e.currentTarget.value)}/></label>
    <datalist id={id+'-products'}>{[...new Set(choices.map(row=>row.product))].map(p=><option key={p} value={p}/>)}</datalist>
    <label>Сегмент<input list={id+'-segments'} name="segment" value={segment} required
      onChange={e => setSegment(e.currentTarget.value)}/></label>
    <datalist id={id+'-segments'}>{[...new Set(['all',...productChoices.map(row=>row.segment)])].map(s=><option key={s} value={s}/>)}</datalist>
    <label>Источник наблюдений<select name="sourceId" value={sources.includes(source) ? source : ''} onChange={e=>setSource(e.currentTarget.value)}>
      <option value="">Единственный доступный источник</option>
      {sources.map(s=><option key={s}>{s}</option>)}
    </select></label>
    <label>Релиз для четырёхнедельной базы<select name="releaseId" defaultValue={cfg.releaseId}>
      <option value="">Последний релиз метрики{!cfg.releaseId && rule.releaseId ? ' · ' + rule.releaseId : ''}</option>
      {monitor.releases.map(r=><option key={r.id} value={r.id}>{r.id} · {r.date} · {r.description}</option>)}
    </select></label>
    <label>Падение более, {rule.unit}<input required type="number" name="threshold" min="0.000001" max="100" step="any" defaultValue={cfg.threshold}/></label>
    <label>Минимальный знаменатель за каждую неделю<input required type="number" name="minDenominator" min="1" defaultValue={cfg.minDenominator}/></label>
    <label>Минимум целевых событий за 4 недели базы<input required type="number" name="minBaselineNumerator" min="0" defaultValue={cfg.minBaselineNumerator}/></label>
    <label>Недель подряд для уведомления<input required type="number" name="confirmations" min="1" max="12" defaultValue={cfg.confirmations}/></label>
    {error && <p role="alert">{error}</p>}
    <button disabled={busy}>Сохранить правило</button>
  </form>;
}

export function MetricRules({admin, refresh}: {admin:boolean; refresh:()=>Promise<void>}) {
  const [monitor, setMonitor] = useState<Monitoring|null>(null);
  const [error, fail] = useState('');
  const [notice,say] = useState('');
  useEffect(() => {
    let here = true;
    post<Monitoring>('metric-rule-status').then(result=>{ if(here) setMonitor(result); })
      .catch(err=>{ if(here) fail(err.message); });
    return ()=>{here=false;};
  },[]);
  return <section className="paper">
    <h3>Мониторинг продуктовых метрик</h3>
    {error && <p role="alert">{error}</p>}
    {monitor?.rules.map(rule=><details key={rule.config.metric}>
      <summary>{rule.title} · {rule.detail}</summary>
      {rule.week && <p>Последняя проверенная неделя с {rule.week}</p>}
      {admin && <RuleForm key={JSON.stringify(rule.config)} monitor={monitor} rule={rule} save={async config=>{
        setMonitor(await post<Monitoring>('metric-rules',config)); say('Правило сохранено.'); await refresh();
      }}/>}
    </details>)}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
