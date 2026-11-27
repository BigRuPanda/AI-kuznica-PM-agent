import React from 'react';
import { changeLabel, signalBaseline, signalEvidenceWeek, signalPeriod } from './case-periods';
import { num, type Signal, type SignalWeekEvidence } from './team-data';

const countLabels: Record<string, string> = {
  lk_reco_ctr: 'Визиты с кликом по рекомендации / визиты с показом блока',
  cfg_completion_rate: 'Визиты с завершением подбора / визиты с открытием конфигуратора',
};

function describeSource(id: string) {
  const metrika = /^metrika:([^:]+):(.+)$/.exec(id);
  return metrika ? `Счётчик ${metrika[1]} · отчёт ${metrika[2]}` : id;
}

function WeekEvidence({ sample }: { sample: SignalWeekEvidence }) {
  return <details>
    <summary>{signalEvidenceWeek(sample.week)} · {num(sample.n)} / {num(sample.d)}</summary>
    {sample.rows.map(row => <small key={[row.version, row.source, row.date, row.segment].join('/')}>
      {row.date} · {row.segment === 'all' ? 'Весь трафик' : row.segment} · {num(row.n)} / {num(row.d)}<br/>
      {row.source} · версия {row.version.slice(0, 12)}
      {row.sourceId?.startsWith('metrika:') && <> · {describeSource(row.sourceId)}</>}
    </small>)}
  </details>;
}

export function SignalEvidence({ signal }: { signal: Signal }) {
  const { evidence } = signal;
  return <div className="proof signal-evidence">
    <p>{signal.metric} · {signal.releaseId} · {signal.segment === 'all' ? 'Весь трафик' : signal.segment}<br/>
      {signal.sourceId && <>{describeSource(signal.sourceId)}<br/></>}
      {signal.definitionId && <>Определение показателя {signal.definitionId}</>}
    </p>
    <p>{countLabels[signal.metric || ''] || 'Числитель / знаменатель'}</p>
    <dl className="comparison-dates">
      <div><dt>База до релиза</dt><dd>{signalBaseline(signal)} · {num(signal.baseN)} / {num(signal.baseD)} = {num(signal.baseValue)}%</dd></div>
      <div><dt>Неделя сигнала</dt><dd>{signalPeriod(signal)} · {num(signal.n)} / {num(signal.d)} = {num(signal.value)}%</dd></div>
    </dl>
    <p>Изменение {changeLabel(signal.change, signal.changeUnit)}. Порог падения более {changeLabel(signal.threshold, signal.changeUnit).replace(/^\+/, '')}.</p>
    {evidence ? <>
      <p>Измерения по неделям</p>
      {evidence.baseline.map(sample => <WeekEvidence key={sample.week} sample={sample}/>)}
      <WeekEvidence sample={evidence.latest}/>
    </> : signal.source && <small>{signal.source}</small>}
  </div>;
}
