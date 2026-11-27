import React, { useEffect, useId, useState } from 'react';
import { post } from './team-data';
import './metric-rules.css';

type RuleConfig = {
  metric: string; product: string; segment: string; sourceId: string; releaseId: string; enabled: boolean;
  threshold: number; minDenominator: number; minBaselineNumerator: number; confirmations: number;
};
const statuses = {
  disabled: 'Выключено', insufficient: 'Недостаточно данных', ok: 'В пределах порога',
  preliminary: 'Предварительный сигнал', confirmed: 'Отклонение подтверждено',
};
type Rule = {
  config: RuleConfig; title: string; unit: string; status: keyof typeof statuses;
  detail: string; week: string; releaseId?: string;
};
type Monitoring = {
  rules: Rule[];
  releases: {id:string; date:string; description:string}[];
  series: {metric:string; product:string; segment:string; sourceId:string}[];
};
const ruleDate = new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC' });
function formatRuleDate(value: string) {
  const day = Date.parse(value);
  return Number.isFinite(day) ? ruleDate.format(day) : '';
}

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
  return <form className="metric-rule-form" onSubmit={async e => {
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
    <fieldset>
      <legend>Продукт и источник</legend>
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
    </fieldset>
    <fieldset>
      <legend>База сравнения</legend>
      <label>Релиз для четырёхнедельной базы<select name="releaseId" defaultValue={cfg.releaseId}>
        <option value="">Последний релиз метрики{!cfg.releaseId && rule.releaseId ? ' · ' + rule.releaseId : ''}</option>
        {monitor.releases.map(r=><option key={r.id} value={r.id}>{r.id} · {r.date} · {r.description}</option>)}
      </select></label>
      <label>Минимальный знаменатель за каждую неделю<input required type="number" name="minDenominator" min="1" defaultValue={cfg.minDenominator}/></label>
      <label>Минимум целевых событий за 4 недели базы<input required type="number" name="minBaselineNumerator" min="0" defaultValue={cfg.minBaselineNumerator}/></label>
    </fieldset>
    <fieldset>
      <legend>Условия уведомления</legend>
      <label>Падение более, {rule.unit}<input required type="number" name="threshold" min="0.000001" max="100" step="any" defaultValue={cfg.threshold}/></label>
      <label>Недель подряд для уведомления<input required type="number" name="confirmations" min="1" max="12" defaultValue={cfg.confirmations}/></label>
      <label className="metric-rule-enabled"><input type="checkbox" name="enabled" defaultChecked={cfg.enabled}/> Включить мониторинг</label>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    <button disabled={busy}>Сохранить правило</button>
  </form>;
}

export function MetricRules({admin, refresh}: {admin:boolean; refresh:()=>Promise<void>}) {
  const heading = useId();
  const [monitor, setMonitor] = useState<Monitoring|null>(null);
  const [error, fail] = useState('');
  const [notice,say] = useState('');
  useEffect(() => {
    let here = true;
    post<Monitoring>('metric-rule-status').then(result=>{ if(here) setMonitor(result); })
      .catch(err=>{ if(here) fail(err.message); });
    return ()=>{here=false;};
  },[]);
  return <section className="paper metric-monitor" aria-labelledby={heading}>
    <h3 id={heading}>Мониторинг продуктовых метрик</h3>
    {error && <p role="alert">{error}</p>}
    {!monitor && !error && <p role="status">Загружаем правила…</p>}
    {monitor?.rules.map(rule => {
      const cfg = rule.config;
      const releaseId = rule.releaseId || cfg.releaseId;
      const release = monitor.releases.find(item => item.id === releaseId);
      const releaseDate = release ? formatRuleDate(release.date) : '';
      const threshold = cfg.threshold.toLocaleString('ru-RU', { maximumSignificantDigits: 15 });
      return <details key={cfg.metric} className="metric-rule">
        <summary>
          <span className="metric-rule-title">
            <strong>{rule.title}</strong>
            <span className="metric-rule-state" data-status={rule.status}>{statuses[rule.status]}</span>
          </span>
          <span className="metric-rule-caption">{rule.detail}</span>
          <span className="metric-rule-facts">
            <span><small>Релиз</small>{releaseId || 'Не выбран'}{releaseDate && ' · ' + releaseDate}</span>
            <span><small>Порог падения</small>{threshold} {rule.unit}</span>
            {rule.week && <span><small>Последняя проверенная неделя</small><time dateTime={rule.week}>{formatRuleDate(rule.week)}</time></span>}
          </span>
        </summary>
        {admin ? <RuleForm key={JSON.stringify(cfg)} monitor={monitor} rule={rule} save={async config=>{
          setMonitor(await post<Monitoring>('metric-rules',config)); say('Правило сохранено.'); await refresh();
        }}/>: <dl className="metric-rule-facts metric-rule-readonly">
          <div><dt>Продукт</dt><dd>{cfg.product}</dd></div>
          <div><dt>Сегмент</dt><dd>{cfg.segment === 'all' ? 'Весь трафик' : cfg.segment}</dd></div>
          <div><dt>Источник</dt><dd>{cfg.sourceId || 'Определяется по данным'}</dd></div>
          <div><dt>Недель подряд для уведомления</dt><dd>{cfg.confirmations}</dd></div>
        </dl>}
      </details>;
    })}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
