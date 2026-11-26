import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Answer } from './answer';
import { Dialog } from './dialog';
import {
  RangeChart,
  rangeLabel,
  type Attachment,
  type GraphSelection,
  type Point,
  type WindowRange,
} from './range-chart';
import { seriesPath } from './trend';
import { jump, num, post, type Home } from './team-data';
import './materials.css';

export type MaterialRef = { id: string; kind: 'chart' | 'report'; title: string; shared?: boolean };
type Plot = {
  title: string;
  unit: string;
  step: number;
  base: Omit<GraphSelection, 'series' | 'ranges'>;
  lines: { key: string; points: (Point & { source?: string })[] }[];
};
type Section = { title: string; text?: string; columns?: string[]; rows?: string[][]; sources?: string[] };
type Material = MaterialRef & {
  product?: string;
  summary?: string;
  analysis?: string;
  ranges?: WindowRange[];
  plot?: Plot;
  sections?: Section[];
  children?: MaterialRef[];
  findings?: string[];
  pins: string[];
};
export type ChatAttachment = { material: MaterialRef; range?: Attachment };
const colors = ['#16766b', '#ad4f31', '#5c6592', '#927028'];
const day = (at: number) =>
  new Date(at).toLocaleDateString('ru-RU', {
    timeZone: 'UTC',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
export const materialHref = (id: string) => '#material/' + id;
const url = (id: string) => location.origin + '/' + materialHref(id);
export function pastedMaterial(text: string) {
  for (const token of text.split(/\s+/)) {
    try {
      const link = new URL(token, location.href);
      if (
        (token.startsWith('#material/') || /^https?:\/\//.test(token)) &&
        link.origin === location.origin &&
        /^#material\/[a-f0-9]{64}$/i.test(link.hash)
      )
        return link.hash.slice(10);
    } catch {
      /* Ordinary message text. */
    }
  }
}
type Controller = {
  load: (id: string, preview?: boolean) => Promise<Material>;
  open: (id: string) => void;
  attach: (m: MaterialRef, range?: Attachment) => void;
  listen: (fn: (a: ChatAttachment) => void) => () => void;
  pin: (m: Material) => void;
  caseId?: string;
  revision: number;
};
const Context = createContext<Controller | null>(null);
export function useMaterials() {
  const c = useContext(Context);
  if (!c) throw Error('Материалы недоступны');
  return c;
}
export function MaterialsProvider({
  home,
  caseId,
  refresh,
  children,
}: {
  home: Home | null;
  caseId?: string;
  refresh: () => Promise<void>;
  children: ReactNode;
}) {
  const [stack, setStack] = useState<string[]>([]),
    [picker, setPicker] = useState<Material | null>(null),
    [target, setTarget] = useState(''),
    [product, setProduct] = useState(''),
    [revision, bump] = useState(0),
    [error, fail] = useState(''),
    [busy, setBusy] = useState(false);
  const cache = useRef(new Map<string, Promise<Material>>()),
    listener = useRef<((a: ChatAttachment) => void) | null>(null);
  const createRequest = useRef('');
  const load = useCallback((id: string, preview = false) => {
    const key = preview ? 'preview/' + id : id;
    let pending = cache.current.get(id) || cache.current.get(key);
    if (!pending) {
      pending = post<Material>('material', { id, preview }).catch((e) => {
        cache.current.delete(key);
        throw e;
      });
      cache.current.set(key, pending);
    }
    return pending;
  }, []);
  const listen = useCallback((fn: (a: ChatAttachment) => void) => {
    listener.current = fn;
    return () => {
      if (listener.current === fn) listener.current = null;
    };
  }, []);
  const open = useCallback((id: string) => {
    setStack((s) => (s.at(-1) === id ? s : [...s, id]));
  }, []);
  async function attach(m: MaterialRef, range?: Attachment) {
    const value = { material: { id: m.id, kind: m.kind, title: m.title, shared: m.shared }, range };
    setStack([]);
    if (listener.current) listener.current(value);
    else {
      const { id } = await post<{ id: string }>('thread', { title: m.title });
      sessionStorage.setItem('pm-material-draft/' + id, JSON.stringify(value));
      jump('chats/' + id);
    }
  }
  async function changePin(m: Material, destination: string) {
    if (busy) return;
    setBusy(true);
    fail('');
    try {
      await post(
        'pin-material',
        destination === 'new'
          ? { id: m.id, createRequest: createRequest.current, product }
          : { id: m.id, caseId: destination, remove: m.pins.includes(destination) },
      );
      cache.current.delete(m.id);
      cache.current.delete('preview/' + m.id);
      bump((v) => v + 1);
      setPicker(null);
      if (destination === 'new') await refresh();
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const value: Controller = {
    load,
    open,
    listen,
    caseId,
    revision,
    attach: (m, r) => {
      void attach(m, r).catch((e) => fail(e.message));
    },
    pin: (m) => {
      if (caseId) void changePin(m, caseId);
      else {
        setPicker(m);
        setProduct(m.product || home?.products[0] || '');
        createRequest.current = crypto.randomUUID();
        setTarget(m.pins[0] || home?.cases[0]?.id || 'new');
      }
    },
  };
  return (
    <Context.Provider value={value}>
      {children}
      {error && (
        <div className="material-notice" role="alert">
          {error} <button onClick={() => fail('')}>Закрыть</button>
        </div>
      )}
      {stack.length > 0 && (
        <Dialog title="Материал из переписки" wide close={() => setStack([])}>
          {stack.length > 1 && (
            <button onClick={() => setStack((s) => s.slice(0, -1))}>← К предыдущему материалу</button>
          )}
          <MaterialDetail key={stack.at(-1)} id={stack.at(-1)!} />
        </Dialog>
      )}
      {picker && (
        <Dialog title="Выберите разбор" close={() => setPicker(null)}>
          <label className="material-picker">
            Разбор
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {home?.cases.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                  {picker.pins.includes(c.id) ? ' · добавлено' : ''}
                </option>
              ))}
              <option value="new">Создать новый разбор</option>
            </select>
          </label>
          {target === 'new' && !picker.product && (
            <label className="material-picker">
              Продукт нового разбора
              <input value={product} onChange={(e) => setProduct(e.target.value)} required />
            </label>
          )}
          <button
            disabled={busy || (target === 'new' && !product.trim())}
            onClick={() => void changePin(picker, target)}
          >
            {picker.pins.includes(target) ? 'Убрать с экрана' : 'Добавить в разбор'}
          </button>
        </Dialog>
      )}
    </Context.Provider>
  );
}
function useMaterial(id: string, preview = false) {
  const { load, revision } = useMaterials(),
    [data, set] = useState<Material | null>(null),
    [error, fail] = useState('');
  useEffect(() => {
    let valid = true;
    fail('');
    load(id, preview)
      .then((m) => {
        if (valid) set(m);
      })
      .catch((e) => {
        if (valid) fail(e.message);
      });
    return () => {
      valid = false;
    };
  }, [id, load, revision, preview]);
  return { m: data?.id === id ? data : null, error };
}
export function MiniPlot({ plot }: { plot: Pick<Plot, 'unit' | 'step' | 'lines'> }) {
  const all = plot.lines.flatMap((s) => s.points),
    values = all.map((p) => p.value).filter((v): v is number => v != null && Number.isFinite(v));
  if (!values.length) return <small>Нет наблюдений</small>;
  const first = Math.min(...all.map((p) => p.at)),
    last = Math.max(...all.map((p) => p.at)),
    lo = Math.min(...values),
    hi = Math.max(...values);
  return (
    <span className="material-spark">
      <svg viewBox="0 0 280 55" preserveAspectRatio="none" aria-hidden="true">
        {plot.lines.map((s, i) => {
          const points: Point[] = [];
          for (const p of s.points) {
            const prev = points.at(-1);
            if (prev && p.at - prev.at > plot.step) points.push({ at: prev.at + plot.step, value: null });
            points.push(p);
          }
          const { path, isolated } = seriesPath(
            points,
            (j) => 4 + ((points[j].at - first) / Math.max(1, last - first)) * 272,
            (v) => (hi === lo ? 27 : 49 - ((v - lo) / (hi - lo)) * 43),
          );
          return (
            <g key={s.key} stroke={colors[i % colors.length]}>
              <path d={path} fill="none" strokeWidth="2.4" vectorEffect="non-scaling-stroke" />
              {isolated.map((p) => (
                <circle key={p.x} cx={p.x} cy={p.y} r="2.5" fill={colors[i % colors.length]} />
              ))}
            </g>
          );
        })}
      </svg>
      <span className="material-dates">
        {day(first)} — {day(last)} · {plot.unit}
      </span>
      {plot.lines.map((s, i) => {
        const known = s.points.filter((p) => p.value != null);
        return (
          <span className="material-legend" key={s.key}>
            <i style={{ background: colors[i % colors.length] }} />
            {s.key} · {num(known[0]?.value)} → {num(known.at(-1)?.value)}
          </span>
        );
      })}
    </span>
  );
}
function Pin({ m }: { m: Material }) {
  const c = useMaterials();
  const added = c.caseId ? m.pins.includes(c.caseId) : m.pins.length > 0;
  return (
    <button onClick={() => c.pin(m)}>
      {added
        ? c.caseId
          ? 'Добавлено · убрать с экрана'
          : 'Добавлено · выбрать разбор'
        : 'Добавить в разбор'}
    </button>
  );
}
export function MaterialCard({ item }: { item: MaterialRef }) {
  const c = useMaterials(),
    { m, error } = useMaterial(item.id, true);
  return (
    <div className={'material-card ' + item.kind}>
      <a
        className="material-preview"
        href={materialHref(item.id)}
        aria-haspopup="dialog"
        onClick={(e) => {
          if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
            e.preventDefault();
            c.open(item.id);
          }
        }}
      >
        <strong>{item.title}</strong>
        {item.kind === 'chart' && m?.plot ? <MiniPlot plot={m.plot} /> : null}
        <span>{item.kind === 'chart' ? 'Раскрыть график' : 'Открыть разбор'} ↗</span>
      </a>
      {error && <small role="alert">{error}</small>}
      {m && <Pin m={m} />}
    </div>
  );
}
export function MaterialDetail({ id }: { id: string }) {
  const c = useMaterials(),
    { m, error } = useMaterial(id),
    [copied, setCopied] = useState('');
  if (!m) return <p role="status">{error || 'Открываем сохранённый материал…'}</p>;
  const p = m.plot;
  return (
    <article className="material-detail">
      <h2>{m.title}</h2>
      {m.summary && <Answer text={m.summary} openMaterial={c.open} />}
      {p && (
        <>
          <RangeChart
            title={p.title}
            unit={p.unit}
            step={p.step}
            release={p.base.source === 'release'}
            initial={m.ranges}
            lines={p.lines.map((s, i) => ({ ...s, name: s.key, color: colors[i % colors.length] }))}
            pick={(series, ranges) => ({
              label:
                p.title + ' · ' + ranges.map((r) => rangeLabel(r, p.base.source === 'release')).join(' / '),
              selection: { ...p.base, series, ranges },
            })}
            attach={(a) => c.attach(m, a)}
          />
          <details>
            <summary>Исходные значения и покрытие</summary>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Дата</th>
                    <th>Ряд</th>
                    <th>{p.unit}</th>
                    <th>Источник</th>
                  </tr>
                </thead>
                <tbody>
                  {p.lines.flatMap((s) =>
                    s.points.map((v) => (
                      <tr key={s.key + v.at}>
                        <td>{day(v.at)}</td>
                        <td>{s.key}</td>
                        <td>
                          {num(v.value)}
                          {v.partial ? ' · неполный период' : ''}
                        </td>
                        <td>{v.source || 'Сохранённый расчёт'}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
      {!!m.children?.length && (
        <div className="material-children">
          {m.children.map((r) => (
            <MaterialCard item={r} key={r.id} />
          ))}
        </div>
      )}
      {m.analysis && m.analysis !== m.summary && <Answer text={m.analysis} openMaterial={c.open} />}
      {!!m.findings?.length && (
        <ul>
          {m.findings.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
      {m.sections?.map((s, i) => (
        <section key={i}>
          <h3>{s.title}</h3>
          {s.text && <p>{s.text}</p>}
          {!!s.rows?.length && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {s.columns?.map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {s.rows.map((r, j) => (
                    <tr key={j}>
                      {r.map((v, k) => (
                        <td key={k}>{v}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!!s.sources?.length && (
            <details>
              <summary>Источники · {s.sources.length}</summary>
              {s.sources.map((v, k) => (
                <div key={k}>{v}</div>
              ))}
            </details>
          )}
        </section>
      ))}
      <footer>
        <Pin m={m} />
        <button onClick={() => c.attach(m)}>Приложить к сообщению</button>
        <button
          onClick={() => {
            navigator.clipboard
              ?.writeText(url(m.id))
              .then(() => setCopied('Ссылка скопирована'))
              .catch(() => setCopied(url(m.id))) || setCopied(url(m.id));
          }}
        >
          Скопировать ссылку
        </button>
        <a href={materialHref(m.id)} target="_blank" rel="noreferrer">
          Открыть по ссылке ↗
        </a>
        <small role="status">{copied}</small>
      </footer>
    </article>
  );
}
export function PinnedMaterials({ caseId }: { caseId: string }) {
  const { revision } = useMaterials(),
    [items, set] = useState<MaterialRef[]>([]),
    [error, fail] = useState('');
  useEffect(() => {
    let valid = true;
    post<{ items: MaterialRef[] }>('case-materials', { caseId })
      .then((r) => {
        if (valid) set(r.items);
      })
      .catch((e) => {
        if (valid) fail(e.message);
      });
    return () => {
      valid = false;
    };
  }, [caseId, revision]);
  return (
    <>
      {error && <p role="alert">{error}</p>}
      {items.map((m) => (
        <section className="paper" key={m.id}>
          <MaterialCard item={m} />
        </section>
      ))}
    </>
  );
}
