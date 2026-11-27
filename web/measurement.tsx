import React, { useEffect, useId, useState } from 'react';
import { num, post, type Measurement, type Monitoring, type WatchSample } from './team-data';

const names: Record<string, string> = {
  orders_index: 'Индекс заказов', lk_reco_ctr: 'CTR рекомендаций',
  cfg_completion_rate: 'Завершение подбора', cfg_reach_rate: 'Охват конфигуратора',
};
export const metricName = (key: string) => names[key] || key;
export function describeMeasurement(m: Measurement) {
  const unit = m.targetMode === 'baseline_percent' ? '% от базы' : m.metric === 'orders_index' ? 'п. индекса' : '%';
  return [metricName(m.metric), m.product, m.segment, m.sourceId,
    (m.comparison === 'lte' ? '≤ ' : '≥ ') + valueLabel(m.targetValue) + ' ' + unit].filter(Boolean).join(' · ');
}
export const valueLabel = (value: number | null | undefined) =>
  value == null ? '—' : value.toLocaleString('ru-RU', { maximumFractionDigits: 6 });
const counts = (sample?: WatchSample) =>
  sample?.n != null && sample.d != null ? num(sample.n) + ' / ' + num(sample.d) : '';

export function WatchSummary({ plan, result }: Monitoring) {
  const m = plan.measurement;
  const unit = result.unit || 'п. индекса';
  const ctrl = result.ctrl == null ? '—' : valueLabel(result.ctrl) + '%';
  const proofs = [
    ['База продукта', plan.baseline], ['Окно продукта', result.sample],
    ['База контроля', plan.controlBaseline], ['Окно контроля', result.peer],
  ] as const;
  return <>
    <p role="status">{result.state}</p>
    {result.reason && <p>{result.reason}</p>}
    <dl className="comparison-dates">
      {plan.revision != null && <div><dt>Версия проверки</dt><dd>{plan.revision}</dd></div>}
      {plan.signalRevision != null && <div><dt>Версия сигнала</dt><dd>{plan.signalRevision}</dd></div>}
      <div><dt>Дата выкладки</dt><dd>{plan.deployed}</dd></div>
      {result.start && <div><dt>Окно наблюдения</dt><dd>{result.start} — {result.end}</dd></div>}
      {m && <div><dt>Базовый период</dt><dd>{m.baselineFrom} — {m.baselineThrough}</dd></div>}
      {m && <div><dt>Ряд продукта</dt><dd>{[m.product, m.segment, result.sample?.sourceId || m.sourceId].filter(Boolean).join(' · ')}</dd></div>}
      {(m || !result.reason) && <div>
        <dt>{metricName(result.metric || 'orders_index')} · цель / факт, {unit}</dt>
        <dd>{m && (m.comparison === 'lte' ? '≤ ' : '≥ ')}{valueLabel(plan.target)} / {valueLabel(result.actual)}</dd>
      </div>}
      {counts(result.sample) && <div><dt>Числитель / знаменатель</dt><dd>{counts(result.sample)}</dd></div>}
      {m && <div><dt>Значение базы, {unit}</dt><dd>{valueLabel(plan.baseline?.value)}{counts(plan.baseline) && ' · ' + counts(plan.baseline)}</dd></div>}
      {plan.control && <div><dt>Изменение контроля · {plan.control}{m?.controlSegment && ' · ' + m.controlSegment}</dt>
        <dd>{ctrl}{plan.tolerance != null && ' · допуск ±' + valueLabel(plan.tolerance) + '%'}
          {m && <small>{[result.peer?.sourceId || m.controlSourceId, counts(result.peer)].filter(Boolean).join(' · ')}</small>}
        </dd>
      </div>}
      {m && !plan.control && <div><dt>Контрольный ряд</dt><dd>Не задан</dd></div>}
      <div><dt>{plan.control ? 'Полные недели, продукт / контроль' : 'Полные недели, продукт'}</dt>
        <dd>{result.weeks}{plan.control && ' / ' + result.controlWeeks} из 4</dd>
      </div>
    </dl>
    {proofs.some(([, sample]) => sample?.sources?.length) && <details>
      <summary>Источники проверки</summary>
      {proofs.map(([label, sample]) => sample?.sources?.length ? <div key={label}>
        <strong>{label}</strong>
        {sample.definitionId && <small>Определение · {sample.definitionId}</small>}
        {sample.sources.map(source => <small key={source}>{source}</small>)}
      </div> : null)}
    </details>}
  </>;
}

// Collect only fields belonging to this editor; the parent form keeps its legacy shape.
export function measurementPayload(form: HTMLFormElement) {
  const fields = new FormData(form), result: Record<string, string | number> = {};
  for (const [key, val] of fields.entries()) if (key.startsWith('kpi.')) {
    const value = String(val).trim();
    if (value) result[key.slice(4)] = value;
  }
  const data: Record<string, unknown> = Object.fromEntries([...fields].filter(([key]) => !key.startsWith('kpi.')));
  if (result.metric) {
    result.targetValue = Number(result.targetValue);
    if (result.minDenominator) result.minDenominator = Number(result.minDenominator);
    data.measurement = result;
  }
  return data;
}

type Series = { product: string; metric: string; segment: string; sourceId?: string; definitionId?: string };
export function MeasurementFields({ required = false, initialMetric = '', product, signal, initial, legacyWatch = false,
  requireBaseline = false }: {
  required?: boolean; initialMetric?: string; product?: string; signal?: Partial<Series>;
  initial?: Measurement; legacyWatch?: boolean; requireBaseline?: boolean;
}) {
  const preferred = initial?.metric || signal?.metric || initialMetric;
  const [metric, setMetric] = useState(Object.hasOwn(names, preferred) ? preferred : '');
  const [mode, setMode] = useState<Measurement['targetMode']>(initial?.targetMode || 'absolute');
  const [catalog, setCatalog] = useState<Series[]>([]), [error, setError] = useState('');
  const uid = useId();
  useEffect(() => {
    if (!metric) return;
    let open = true;
    post<{metrics:Series[];ordersIndex:{products:string[]}}>('metrics').then(r => {
      if (open) setCatalog([...r.metrics,...r.ordersIndex.products.map(product=>({metric:'orders_index',product,segment:'all'}))]);
    }).catch(e => { if (open) setError(e.message) });
    return () => { open = false };
  }, [metric]);
  const series = catalog.filter(row => row.metric === metric);
  function choices(field: 'product' | 'segment' | 'sourceId' | 'definitionId') {
    return <datalist id={uid + field}>{[...new Set(series.map(r => r[field]).filter(Boolean))].map(value => <option key={value} value={value} />)}</datalist>;
  }
  const baselineFields = <>
    <label>Начало базы<input type="date" name="kpi.baselineFrom" defaultValue={initial?.baselineFrom} required={requireBaseline} /></label>
    <label>Конец базы<input type="date" name="kpi.baselineThrough" defaultValue={initial?.baselineThrough} required={requireBaseline} /></label>
    {metric !== 'orders_index' && !signal && <label>Определение метрики<input name="kpi.definitionId" defaultValue={initial?.definitionId} list={uid+'definitionId'} /></label>}
    <label>Контрольный продукт<input name="kpi.control" defaultValue={initial?.control} list={uid+'product'} /></label>
    {metric !== 'orders_index' && <>
      <label>Сегмент контроля<input name="kpi.controlSegment" defaultValue={initial?.controlSegment} list={uid+'segment'} /></label>
      <label>Источник контроля<input name="kpi.controlSourceId" defaultValue={initial?.controlSourceId} list={uid+'sourceId'} /></label>
      <label>Определение контроля<input name="kpi.controlDefinitionId" defaultValue={initial?.controlDefinitionId} list={uid+'definitionId'} /></label>
    </>}
  </>;
  return <>
    {signal?.metric ? <input type="hidden" name="kpi.metric" value={signal.metric} /> : <label>Целевая метрика
      <select name="kpi.metric" required={required} value={metric} onChange={e => setMetric(e.target.value)}>
        <option value="">{legacyWatch && !required ? 'Индекс заказов · восстановление к базе' : 'Выберите показатель'}</option>
        {Object.entries(names).map(([key,label]) => <option key={key} value={key}>{label}</option>)}
      </select>
    </label>}
    {legacyWatch && !metric && !required && <label>Целевой процент от базы
      <input name="percent" type="number" min="1" max="300" defaultValue="90" required />
    </label>}
    {metric && <>
      {error && <p role="alert">{error}</p>}
      {choices('product')}{choices('segment')}{choices('sourceId')}{choices('definitionId')}
      {!signal?.metric && <>
        <label>Продукт в источнике<input name="kpi.product" defaultValue={initial?.product || product} list={uid+'product'} placeholder="Продукт разбора" /></label>
        {metric !== 'orders_index' && <>
          <label>Сегмент ряда<input name="kpi.segment" defaultValue={initial?.segment || 'all'} list={uid+'segment'} required /></label>
          <label>Источник ряда<input name="kpi.sourceId" defaultValue={initial?.sourceId} list={uid+'sourceId'} placeholder="Автовыбор при единственном источнике" /></label>
        </>}
      </>}
      <label>Условие успеха<select name="kpi.comparison" defaultValue={initial?.comparison}><option value="gte">Не меньше</option><option value="lte">Не больше</option></select></label>
      <label>Тип цели<select name="kpi.targetMode" value={mode} onChange={e=>setMode(e.target.value as Measurement['targetMode'])}><option value="absolute">Значение метрики</option><option value="baseline_percent">Процент от базы</option></select></label>
      <label>Целевое значение, {mode === 'baseline_percent' || metric !== 'orders_index' ? '%' : 'п. индекса'}<input name="kpi.targetValue" type="number" min="0" max={mode === 'absolute' && metric !== 'orders_index' ? 100 : undefined} step="any" defaultValue={initial?.targetValue} required /></label>
      {metric !== 'orders_index' && <label>Минимальный знаменатель за окно<input type="number" name="kpi.minDenominator" min="1" defaultValue={initial?.minDenominator} placeholder={signal ? 'Из правила сигнала' : '1'} /></label>}
      {requireBaseline ? baselineFields : <details><summary>Базовый период и контроль</summary>
        <p>{signal ? 'По умолчанию используется базовый период сигнала.' : 'По умолчанию база охватывает четыре полные недели перед выкладкой.'}</p>
        {baselineFields}
      </details>}
    </>}
  </>;
}
