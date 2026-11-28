import { useEffect, useRef, useState } from 'react';
import { Dialog } from './dialog';
import { metricName } from './measurement';
import { jump, post } from './team-data';

type Option = { product: string; metrics: string[] };
type Selection = { product: string; metric: string };
type Result = { caseId: string } | { caseId: null; options: Option[] };

export function ReleaseCaseLink({ releaseId, caseId, className }: {
  releaseId: string; caseId: string | null; className?: string;
}) {
  const [options, setOptions] = useState<Option[]>([]);
  const [selection, setSelection] = useState<Selection>({ product: '', metric: '' });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);

  function chooseProduct(option?: Option) {
    setSelection({ product: option?.product ?? '', metric: option?.metrics.length === 1 ? option.metrics[0] : '' });
  }

  async function create(scope?: Selection) {
    const current = ++request.current;
    setPending(true);
    setError('');
    try {
      const result = await post<Result>('ensure-release-case', { releaseId, ...scope });
      if (current !== request.current) return;
      if (result.caseId !== null) {
        jump('case/' + result.caseId);
      } else if (result.options.length) {
        setOptions(result.options);
        chooseProduct(result.options.length === 1 ? result.options[0] : undefined);
      } else {
        setError('В данных релиза пока нет подходящего продукта и метрики для исследования.');
      }
    } catch (err) {
      if (current === request.current) setError((err as Error).message);
    } finally {
      if (current === request.current) setPending(false);
    }
  }

  if (caseId) return <a className={className} href={'#case/' + caseId}>Открыть разбор</a>;
  const selected = options.find(option => option.product === selection.product);
  return <>
    <button className={className} type="button" disabled={pending} onClick={() => void create()}>
      {pending ? 'Создаём разбор…' : 'Создать разбор'}
    </button>
    {!options.length && error && <p role="alert">{error}</p>}
    {!!options.length && <Dialog title="Создать разбор релиза" close={() => {
      request.current++;
      setOptions([]);
      setPending(false);
      setError('');
    }}>
      <form onSubmit={event => {
        event.preventDefault();
        void create(selection);
      }}>
        <label>Продукт
          <select required value={selection.product} onChange={event =>
            chooseProduct(options.find(option => option.product === event.target.value))}>
            <option value="" disabled>Выберите продукт</option>
            {options.map(option => <option key={option.product} value={option.product}>
              {option.product === 'ЛК' ? 'Личный кабинет' : option.product}
            </option>)}
          </select>
        </label>
        <label>Метрика
          <select required disabled={!selected} value={selection.metric} onChange={event =>
            setSelection({ ...selection, metric: event.target.value })}>
            <option value="" disabled>Выберите метрику</option>
            {selected?.metrics.map(metric => <option key={metric} value={metric}>{metricName(metric)}</option>)}
          </select>
        </label>
        {error && <p role="alert">{error}</p>}
        <button className="primary" disabled={pending || !selection.metric}>Создать разбор</button>
      </form>
    </Dialog>}
  </>;
}
