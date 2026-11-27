import React, { useState } from 'react';
import { describeMeasurement, MeasurementFields, measurementPayload, metricName, valueLabel } from './measurement';
import { post, type InvestigationRun, type Measurement, type MeasurementAgreement, type Signal } from './team-data';

type Agreement = { measurement: Measurement; agreement: MeasurementAgreement };
type Props = {
  run: InvestigationRun; signal: Signal; metric: string; product: string; recovery: number;
  previous?: Agreement; reload: () => Promise<unknown>;
};

export function AgreedMeasurement({ measurement, agreement }: Agreement) {
  const unit = measurement.unit;
  const control = [measurement.control, measurement.controlSegment, measurement.controlSourceId].filter(Boolean).join(' · ');
  return <>
    <p>{describeMeasurement(measurement)}</p>
    <dl className="comparison-dates">
      <div><dt>Базовый период</dt><dd>{measurement.baselineFrom} — {measurement.baselineThrough}</dd></div>
      <div><dt>Значение базы</dt><dd>{valueLabel(agreement.baseline.value)} {unit}</dd></div>
      {measurement.targetMode === 'baseline_percent' && <div><dt>Цель в единицах метрики</dt>
        <dd>{measurement.comparison === 'lte' ? '≤' : '≥'} {valueLabel(agreement.target)} {unit}</dd>
      </div>}
      <div><dt>Контрольный ряд</dt><dd>{control || 'Не задан'}</dd></div>
      {control && <div><dt>Значение базы контроля</dt>
        <dd>{valueLabel(agreement.controlBaseline?.value)} {unit} · допуск изменения ±{valueLabel(agreement.tolerance)}%</dd>
      </div>}
    </dl>
  </>;
}

export function InvestigationMeasurement({ run, signal, metric, product, recovery, previous, reload }: Props) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const agreed = previous?.agreement.signalRevision === run.revision ? previous : undefined;
  const initial: Measurement = agreed?.measurement || {
    metric, product, comparison: 'gte', targetMode: 'baseline_percent', targetValue: recovery,
    control: run.measurementContext?.control,
    baselineFrom: signal.baselineFrom || run.measurementContext?.baselineFrom,
    baselineThrough: signal.baselineThrough || run.measurementContext?.baselineThrough,
    minDenominator: signal.minDenominator,
  };
  return <section className="investigation-measurement">
    <h4>Критерий проверки эффекта</h4>
    {agreed && !editing ? <>
      <AgreedMeasurement {...agreed} />
      <button type="button" onClick={() => setEditing(true)}>Изменить критерий</button>
    </> : <>
      {previous && !agreed && <p role="status">Сигнал уточнён. Согласуйте критерий для новой версии.</p>}
      <p>{[metricName(metric), product, signal.segment, signal.sourceId].filter(Boolean).join(' · ')}</p>
      <form aria-busy={busy} onSubmit={async event => {
        event.preventDefault();
        if (busy) return;
        const { measurement } = measurementPayload(event.currentTarget);
        setBusy(true);
        setError('');
        try {
          await post('investigation-measurement', {
            caseId: run.caseId, runId: run.id, expectedAgreementId: previous?.agreement.id || null, measurement,
          });
          await reload();
          setEditing(false);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}>
        <fieldset disabled={busy}>
          <MeasurementFields required requireBaseline signal={{ ...signal, metric }} initial={initial} />
          <div className="actions">
            <button>Согласовать критерий</button>
            {editing && <button type="button" onClick={() => { setEditing(false); setError(''); }}>Отменить</button>}
          </div>
        </fieldset>
        {error && <p role="alert">{error}</p>}
      </form>
    </>}
  </section>;
}
