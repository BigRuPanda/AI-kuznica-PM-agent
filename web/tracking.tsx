import React, { useEffect, useState } from 'react';
import { post } from './team-data';
import type { Home } from './team-data';

type Action = (fn: () => Promise<void>) => void;
type Link = { key: string; url: string };
type Hit = Link & { title: string };
type Option = { id: string; name: string };
type Options = { priorities: Option[]; assignees: Option[]; trackers: Option[] };
type Task = Hit & {
  description: string;
  priority: string;
  status: string;
  assignee: string;
  priorityId: string;
  assigneeId: string;
  statusId: string;
  statuses: Option[];
  comments: { author: string; text: string }[];
};
type Page = Hit & { version: number; text: string; links: { url: string; title: string }[] };
export type Integration = {
  service: string;
  local?: boolean;
  url?: string;
  scope?: string;
  edition?: string;
  connected: boolean;
};
export type TrackerPreview = {
  id: string;
  kind: 'issue' | 'page';
  caseId: string;
  state: string;
  title: string;
  key?: string;
  destination: string;
  diff: { field: string; before: string; after: string }[];
  revision?: string;
  conflict?: string;
  sourceUrl?: string;
  version?: number;
  latestPage?: Page;
  reason?: string;
  receipt?: Link;
  issue?: Link;
  external?: string;
};

function Value({ text }: { text: string }) {
  return (
    <>
      {text.split(/(https?:\/\/[^\s<>]+|#demo-(?:issue|page)\/[\w%.-]+)/g).map((s, i) =>
        /^(https?:\/\/|#demo-)/.test(s) ? (
          <a key={i} href={s}>
            {s}
          </a>
        ) : (
          s
        ),
      )}
    </>
  );
}
function TaskContents({ task }: { task: Task }) {
  return (
    <>
      <p>{[task.status, task.priority, task.assignee].filter(Boolean).join(' · ')}</p>
      <p className="tracker-text">
        <Value text={task.description} />
      </p>
      {task.comments.map((c, i) => (
        <p key={i}>
          <b>{c.author}</b> <Value text={c.text} />
        </p>
      ))}
    </>
  );
}
function PageContents({ page }: { page: Page }) {
  return (
    <>
      <small>Версия {page.version}</small>
      <p className="tracker-text">{page.text}</p>
      {page.links.map((l, i) => (
        <p key={i}>
          <a href={l.url}>{l.title || l.url}</a>
        </p>
      ))}
    </>
  );
}
export function DemoObject({ id, service }: { id: string; service: string }) {
  const [task, setTask] = useState<Task>(),
    [page, setPage] = useState<Page>(),
    [error, fail] = useState('');
  useEffect(() => {
    let active = true;
    const key = decodeURIComponent(id);
    const request =
      service === 'demo-page'
        ? post<Page>('page_read', { key, local: true }).then((p) => {
            if (active) setPage(p);
          })
        : post<Task>('issue_read', { key, local: true }).then((t) => {
            if (active) setTask(t);
          });
    request.catch((e) => {
      if (active) fail(e.message);
    });
    return () => {
      active = false;
    };
  }, [id, service]);
  return (
    <section className="paper">
      <small>Локальное демо · {service === 'demo-page' ? 'Confluence' : 'Redmine'}</small>
      <h1>{page?.title || task?.title || 'Загрузка'}</h1>
      {error && <p role="alert">{error}</p>}
      {task && <TaskContents task={task} />} {page && <PageContents page={page} />}
    </section>
  );
}
export function PreviewCard({
  item,
  action,
  reload,
}: {
  item: TrackerPreview;
  action: Action;
  reload: () => Promise<void>;
}) {
  const [current, setCurrent] = useState(item),
    [busy, setBusy] = useState(false);
  useEffect(() => setCurrent(item), [item]);
  const p = current;
  return (
    <article className="excerpt tracker-preview">
      <small>
        {p.destination} · {p.kind === 'page' ? 'Страница' : 'Задача'} {p.key}
      </small>
      <h4>{p.sourceUrl ? <a href={p.sourceUrl}>{p.title}</a> : p.title}</h4>
      {!!p.version && p.state !== 'done' && <small>Исходная версия {p.version}</small>}
      {p.state !== 'done' && (
        <>
          {p.conflict && <p role="alert">{p.conflict}</p>}
          {p.latestPage && (
            <details open={p.state === 'obsolete'}>
              <summary>Свежая версия страницы</summary>
              <PageContents page={p.latestPage} />
            </details>
          )}
          {p.state === 'obsolete' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const fragment = new FormData(e.currentTarget).get('fragment');
                action(async () => {
                  setCurrent(await post('tracker-revise', { id: p.id, revision: p.revision, fragment }));
                  await reload();
                });
              }}
            >
              <label>
                Текст свежей версии для замены
                <textarea name="fragment" required maxLength={10000} />
              </label>
              <button>Обновить сравнение</button>
            </form>
          )}
          {p.diff.map((d, i) => (
            <div className="tracker-diff" key={i}>
              <b>{d.field}</b>
              {d.before && <del>{d.before}</del>}
              <ins>{d.after || 'Очистить'}</ins>
            </div>
          ))}
        </>
      )}
      {p.receipt && (
        <a href={p.receipt.url}>
          {p.kind === 'page' ? 'Открыть страницу' : 'Открыть задачу'} · {p.receipt.key}
        </a>
      )}
      {!p.receipt && p.external && <small>{p.external}</small>}
      {p.issue && (
        <p>
          <a href={p.issue.url}>Связанная задача · {p.issue.key}</a>
        </p>
      )}
      {p.state !== 'done' && p.reason && (
        <p role="status">
          {p.receipt ? 'Страница сохранена. Обратная ссылка: ' : ''}
          {p.reason}
        </p>
      )}
      {!['done', 'obsolete'].includes(p.state) && (
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            action(async () => {
              setBusy(true);
              try {
                await post('confirm', { id: p.id, revision: p.revision });
              } finally {
                try {
                  setCurrent(await post<TrackerPreview>('tracker-preview', { id: p.id }));
                  await reload();
                } finally {
                  setBusy(false);
                }
              }
            })
          }
        >
          {p.state === 'uncertain'
            ? 'Сверить результат'
            : p.receipt
              ? 'Завершить связь'
              : 'Подтвердить запись'}
        </button>
      )}
    </article>
  );
}
export function ChatTrackerPreview({ id, action }: { id: string; action: Action }) {
  const [p, set] = useState<TrackerPreview>(),
    [error, fail] = useState('');
  useEffect(() => {
    let active = true;
    post<TrackerPreview>('tracker-preview', { id })
      .then((v) => {
        if (active) set(v);
      })
      .catch((e) => {
        if (active) fail(e.message);
      });
    return () => {
      active = false;
    };
  }, [id]);
  return p ? (
    <PreviewCard
      item={p}
      action={action}
      reload={async () => {
        set(await post('tracker-preview', { id }));
      }}
    />
  ) : (
    <small>{error || 'Загрузка предпросмотра'}</small>
  );
}
function SelectField({
  name,
  label,
  values,
  value,
  empty,
}: {
  name: string;
  label: string;
  values: Option[];
  value?: string;
  empty?: string;
}) {
  return (
    <label>
      {label}
      <select name={name} defaultValue={value || ''}>
        <option value="">{empty || 'По умолчанию'}</option>
        {values.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
    </label>
  );
}
function Search({
  service,
  query,
  onPick,
  action,
}: {
  service: 'issue' | 'page';
  query: string;
  onPick: (key: string) => Promise<void>;
  action: Action;
}) {
  const [q, setQuery] = useState(query),
    [hits, setHits] = useState<Hit[]>();
  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          action(async () =>
            setHits((await post<{ items: Hit[] }>(service + '_search', { query: q })).items),
          );
        }}
      >
        <label>
          {service === 'issue' ? 'Поиск задач' : 'Поиск страниц'}
          <input value={q} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <button>{service === 'issue' ? 'Найти похожие задачи' : 'Найти страницы'}</button>
      </form>
      {hits?.length === 0 && <p>Совпадений нет</p>}
      {hits?.map((h) => (
        <button key={h.key} onClick={() => action(() => onPick(h.key))}>
          {h.key} · {h.title}
        </button>
      ))}
    </>
  );
}
function IssueForm({
  caseId,
  product,
  action,
  reload,
  onIssue,
}: {
  caseId: string;
  product: string;
  action: Action;
  reload: () => Promise<void>;
  onIssue: (i: Hit) => void;
}) {
  const [task, setTask] = useState<Task>(),
    [options, setOptions] = useState<Options>(),
    [error, fail] = useState('');
  useEffect(() => {
    let active = true;
    post<Options>('issue_options')
      .then((v) => {
        if (active) setOptions(v);
      })
      .catch((e) => {
        if (active) fail(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <>
      <Search
        service="issue"
        query={product}
        action={action}
        onPick={async (key) => {
          const i = await post<Task>('issue_read', { key });
          setTask(i);
          onIssue(i);
        }}
      />
      {task && (
        <>
          <h4>
            {task.key} · {task.title}
          </h4>
          <TaskContents task={task} />
          <button onClick={() => setTask(undefined)}>Создать отдельную задачу</button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {options && (
        <form
          key={task?.key || 'new'}
          onSubmit={(e) => {
            e.preventDefault();
            const fields = Object.fromEntries(new FormData(e.currentTarget));
            const changed = Object.fromEntries(
              Object.entries(fields).filter(([k, v]) =>
                task ? (v || k === 'description' || k === 'assigneeId') && v !== task[k as keyof Task] : v,
              ),
            );
            action(async () => {
              await post('draft', { caseId, key: task?.key, ...changed });
              await reload();
            });
          }}
        >
          <label>
            Заголовок
            <input
              name="title"
              defaultValue={task?.title || 'Проверить путь покупки · ' + product}
              required
              maxLength={240}
            />
          </label>
          <label>
            Описание
            <textarea name="description" defaultValue={task?.description} maxLength={4000} />
          </label>
          {!task && <SelectField name="trackerId" label="Тип задачи" values={options.trackers} />}
          <SelectField
            name="priorityId"
            label="Приоритет"
            values={options.priorities}
            value={task?.priorityId}
          />
          <SelectField
            name="assigneeId"
            label="Исполнитель"
            values={
              task?.assigneeId && !options.assignees.some((a) => a.id === task.assigneeId)
                ? [...options.assignees, { id: task.assigneeId, name: task.assignee }]
                : options.assignees
            }
            value={task?.assigneeId}
            empty="Без назначения"
          />
          {task && (
            <>
              <SelectField
                name="statusId"
                label="Статус"
                values={task.statuses}
                value={task.statusId}
                empty="Оставить текущий"
              />
              <label>
                Комментарий
                <textarea name="comment" maxLength={4000} />
              </label>
            </>
          )}
          <button>Подготовить черновик задачи</button>
        </form>
      )}
    </>
  );
}
function PageForm({
  caseId,
  title,
  conclusion,
  issueKey,
  action,
  reload,
}: {
  caseId: string;
  title: string;
  conclusion: string;
  issueKey: string;
  action: Action;
  reload: () => Promise<void>;
}) {
  const [page, setPage] = useState<Page>();
  return (
    <>
      <Search
        service="page"
        query=""
        action={action}
        onPick={async (key) => setPage(await post('page_read', { key }))}
      />
      {page && (
        <>
          <h4>{page.title}</h4>
          <PageContents page={page} />
          <button onClick={() => setPage(undefined)}>Создать отдельную страницу</button>
        </>
      )}
      <form
        key={page?.key || 'new'}
        onSubmit={(e) => {
          e.preventDefault();
          const b = Object.fromEntries(new FormData(e.currentTarget));
          action(async () => {
            if (page && b.title === page.title) delete b.title;
            await post('page_draft', { ...b, caseId, key: page?.key, baseVersion: page?.version });
            await reload();
          });
        }}
      >
        <label>
          Название страницы
          <input name="title" defaultValue={page?.title || title} maxLength={255} required />
        </label>
        {page && (
          <label>
            Фрагмент для замены
            <textarea name="fragment" placeholder="Оставьте пустым, чтобы добавить текст в конец страницы" />
          </label>
        )}
        <label>
          Текст публикации
          <textarea name="content" defaultValue={page ? undefined : conclusion} maxLength={30000} />
        </label>
        <label>
          Номер связанной задачи
          <input name="issueKey" defaultValue={issueKey} placeholder="Необязательно" />
        </label>
        <button>Подготовить публикацию в Confluence</button>
      </form>
    </>
  );
}
export function Tracking({
  headingRef,
  caseId,
  product,
  title,
  conclusion,
  home,
  drafts,
  action,
  reload,
}: {
  caseId: string;
  product: string;
  title: string;
  conclusion: string;
  home: Home;
  headingRef?: React.Ref<HTMLHeadingElement>;
  drafts: TrackerPreview[];
  action: Action;
  reload: () => Promise<void>;
}) {
  const [tab, select] = useState<'redmine' | 'confluence'>('redmine'),
    [picked, pick] = useState('');
  const [links, setLinks] = useState<Hit[]>([]),
    [linkError, setLinkError] = useState('');
  const confirmed = drafts.map((d) => d.receipt?.url || '').join('|');
  useEffect(() => {
    let active = true;
    post<{ items: Hit[] }>('case_links', { caseId })
      .then((r) => {
        if (active) {
          setLinks(r.items);
          setLinkError('');
        }
      })
      .catch((e) => {
        if (active) setLinkError(e.message);
      });
    return () => {
      active = false;
    };
  }, [caseId, confirmed]);
  const otherLinks = links.filter(
    (link) => !drafts.some((d) => d.receipt?.url === link.url || d.issue?.url === link.url),
  );
  const site = home.integrations[tab];
  const latest = drafts.find((d) => d.kind === 'issue' && d.state === 'done')?.receipt;
  return (
    <section className="paper task-panel">
      <h3 ref={headingRef} tabIndex={-1}>Задачи и документация</h3>
      <div className="toolbar">
        {(['redmine', 'confluence'] as const).map((t) => (
          <button aria-pressed={t === tab} key={t} onClick={() => select(t)}>
            {t === 'redmine' ? 'Redmine' : 'Confluence'}
          </button>
        ))}
      </div>
      <p className="muted">{site.local ? 'Локальное демо' : site.scope + ' · ' + site.url}</p>
      {!site.local && !site.connected ? (
        <a href="#settings">Подключить личный доступ</a>
      ) : tab === 'redmine' ? (
        <IssueForm
          caseId={caseId}
          product={product}
          action={action}
          reload={reload}
          onIssue={(i) => pick(i.key)}
        />
      ) : (
        <PageForm
          caseId={caseId}
          title={title}
          conclusion={conclusion}
          issueKey={picked || latest?.key || ''}
          action={action}
          reload={reload}
        />
      )}
      {linkError && <p role="status">{linkError}</p>}
      {otherLinks.length > 0 && (
        <>
          <h4>Связанные задачи и страницы</h4>
          {otherLinks.map((l) => (
            <p key={l.url}>
              <a href={l.url}>
                {l.title} · {l.key}
              </a>
            </p>
          ))}
        </>
      )}
      {drafts.map((d) => (
        <PreviewCard key={d.id} item={d} action={action} reload={reload} />
      ))}
    </section>
  );
}
export function Connections({
  home,
  action,
  refresh,
}: {
  home: Home;
  action: Action;
  refresh: () => Promise<void>;
}) {
  const [notice, say] = useState('');
  if (home.user.role === 'judge')
    return (
      <section className="paper">
        <h3>Redmine и Confluence</h3>
        <p>Задачи и страницы сохраняются в вашем демонстрационном пространстве.</p>
      </section>
    );
  return (
    <section className="paper">
      <h3>Подключения</h3>
      {(['redmine', 'confluence'] as const).map((service) => {
        const site = home.integrations[service],
          name = service === 'redmine' ? 'Redmine' : 'Confluence';
        async function access(actionName: string, token?: string) {
          const r = await post<{ authorize?: string }>('integration-access', {
            service,
            action: actionName,
            token,
          });
          if (r.authorize) {
            location.assign(r.authorize);
            return;
          }
          say(
            name +
              ' · ' +
              { check: 'Доступ подтверждён', connect: 'Подключено', disconnect: 'Доступ отключён' }[
                actionName
              ],
          );
          await refresh();
        }
        return (
          <section key={service}>
            <h4>{name}</h4>
            {home.user.role === 'admin' && (
              <details>
                <summary>Адрес и назначение команды</summary>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const b = Object.fromEntries(new FormData(e.currentTarget));
                    action(async () => {
                      await post('integration-config', { service, ...b });
                      await refresh();
                      say('Настройки ' + name + ' сохранены');
                    });
                  }}
                >
                  <label>
                    Адрес сервиса
                    <input type="url" name="url" defaultValue={site.url} placeholder="https://" />
                  </label>
                  <label>
                    {service === 'redmine' ? 'Идентификатор проекта' : 'Ключ пространства'}
                    <input name="scope" defaultValue={site.scope} />
                  </label>
                  {service === 'confluence' && (
                    <label>
                      Редакция
                      <select name="edition" defaultValue={site.edition || 'dc'}>
                        <option value="dc">Data Center</option>
                        <option value="cloud">Cloud</option>
                      </select>
                    </label>
                  )}
                  <button>Сохранить настройки команды</button>
                </form>
              </details>
            )}
            <p>
              {site.local
                ? 'Локальное демо'
                : site.scope +
                  ' · ' +
                  (site.connected ? 'Личный доступ подключён' : 'Требуется личный доступ')}
            </p>
            {!site.local && (
              <>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const form = e.currentTarget,
                      token = String(new FormData(form).get('token') || '');
                    form.reset();
                    action(() => access('connect', token));
                  }}
                >
                  {site.edition !== 'cloud' && (
                    <label>
                      Персональный {service === 'redmine' ? 'API-ключ' : 'токен'}
                      <input type="password" name="token" autoComplete="new-password" required />
                    </label>
                  )}
                  <button>{site.connected ? 'Заменить подключение' : 'Подключить ' + name}</button>
                </form>
                {site.connected && (
                  <div className="toolbar">
                    <button onClick={() => action(() => access('check'))}>Проверить доступ</button>
                    <button onClick={() => action(() => access('disconnect'))}>
                      Отключить личный доступ
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        );
      })}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
