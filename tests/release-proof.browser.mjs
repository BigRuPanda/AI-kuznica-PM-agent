import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const origin = 'https://release-proof.test';
const source = { version: 'archive1', file: 'История.xlsx', loc: 'Лист!A2' };
const baseline = { start: '2026-06-01', end: '2026-08-23', mean: 100, rows: [{ ...source, date: '2026-06-01', value: 100 }] };
const decision = {
  caseId: 'audit-1', product: 'Продукт', products: ['Продукт'], asOf: '2026-09-20', historical: false,
  release: { ...source, id: 'R 1/2', date: '2026-08-12', description: 'Новая карточка товара', metrics: [] }, releases: [], delivered: [],
  trend: { available: true, baseline, current: { start: '2026-08-24', end: '2026-09-20', mean: 90, rows: [] }, change: -10 },
  recommendation: { title: 'Проверить сбор событий', reason: 'Есть расхождение в журнале', next: 'Сверить события с заказами', uncertainty: 'Окно наблюдения четыре недели.' },
  competitor: { ...source, product: 'Годовая подписка', merchant: 'Другой магазин', license: 'Годовая', terms: 'Для новых клиентов', competitorPrice: 800, storePrice: 1000, checked: '2026-09-17', match: 'Частично', sku: '123' },
  customer: { ...source, loc: 'Интервью!B2', excerpt: 'Не нашёл годовую подписку', tags: 'подписка' },
  backlog: { ...source, id: 'TASK-42', title: 'Сверить журнал', status: 'New', description: null }, measurement: null, measurementIssue: true,
};
const first = { value: 20, n: 2, d: 10, pending: 0, both: 0 };
const last = { value: 40, n: 4, d: 10, pending: 0, both: 0 };
const context = { releaseId: decision.release.id, version: 'csv-version-attachment', day: 14, segment: 'all', metric: 0 };
const comparison = {
  title: 'Доля оплат', unit: '%', status: 'ready', reason: '', formula: 'Оплаты / оформления',
  series: { all: { before: first, after: last }, old: { before: first, after: first }, new: { before: first, after: last } },
};
const calculations = {
  compare: { op: 'compare_metric', result: comparison },
  breakdown: { op: 'breakdown', result: { all: comparison, new: comparison, returning: comparison } },
  chart: { op: 'build_chart', result: { title: 'Количество оплат', status: 'ready', formula: 'Число оплат', unit: 'шт.', spec: { end: 'payment' }, days: [-1, 0], daily: [{ value: 2, n: 2 }, { value: 4, n: 4 }], before: { value: 2, n: 2 }, after: { value: 4, n: 4 } } },
  funnel: { op: 'funnel', result: { definition: 'Оплаты по связанному заказу', missing: [], steps: [{ period: 'before', checkout: 10, invoiced: 8, paid: 2 }, { period: 'after', checkout: 10, invoiced: 9, paid: 4 }] } },
  interval: { op: 'interval', result: { title: 'Доля оплат', reason: 'Показатель вырос за два дня.', formula: 'Оплаты / оформления', unit: '%', start: -1, rows: [first, last] } },
};

test('release decisions and saved calculations present the result before its proof', async t => {
  const bundle = await build({
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
    stdin: { contents: `
      import { createRoot } from 'react-dom/client';
      import { ReleaseDecision } from './web/release-decision';
      import { CalculationPage } from './web/calculations';
      import './web/team.css';
      import './web/style.css';
      const id = location.pathname.slice(1);
      createRoot(document.getElementById('app')).render(id === 'decision'
        ? <ReleaseDecision action={fn => fn()} initialRelease="R 1/2" renderChat={() => null} />
        : <CalculationPage id={id} />);
    `, loader: 'tsx', resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
    bundle: true, write: false, outfile: 'release-proof.js', jsx: 'automatic',
    loader: { '.woff2': 'dataurl', '.png': 'dataurl' },
  });
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const browser = await chromium.launch({ executablePath: process.env.PM_BROWSER_PATH || (existsSync(edge) ? edge : undefined) });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'ru-RU', viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(origin + '/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/team/release_decision') {
      const { through } = route.request().postDataJSON();
      return route.fulfill({ json: through ? {
        ...decision, asOf: through, historical: true, measurementIssue: false, customer: null,
        recommendation: { ...decision.recommendation, uncertainty: 'Изменение индекса заказов само по себе не устанавливает влияние релиза.' },
      } : decision });
    }
    if (path === '/api/team/competitor_check') return route.fulfill({ json: null });
    if (path.startsWith('/api/calculations/')) {
      const id = path.split('/').at(-1);
      return route.fulfill({ json: { id, context, launch: Date.parse('2026-08-12T00:00:00+03:00'), ...calculations[id] } });
    }
    const asset = bundle.outputFiles.find(file => file.path.endsWith(path.slice(1)));
    if (asset) return route.fulfill({ contentType: path.endsWith('.js') ? 'text/javascript' : 'text/css', body: asset.text });
    return route.fulfill({ contentType: 'text/html', body: '<html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link href="/release-proof.css" rel="stylesheet"><main id="app"></main><script src="/release-proof.js"></script></html>' });
  });
  const checkWidths = async () => {
    for (const [width, theme] of [[390, 'light'], [900, 'dark'], [1440, 'light']]) {
      await page.setViewportSize({ width, height: 844 });
      await page.locator('html').evaluate((html, next) => { html.dataset.theme = next; }, theme);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      assert.ok(await page.locator('.table-scroll').evaluateAll(regions => regions.every(region =>
        region.getBoundingClientRect().right <= document.documentElement.clientWidth + 1)));
    }
    await page.setViewportSize({ width: 390, height: 844 });
  };

  await t.test('assessment leads with the recommendation and keeps the cited weekly and price data accessible', async () => {
    await page.goto(origin + '/decision');
    assert.deepEqual(errors, []);
    await page.getByRole('heading', { name: 'Разбор релиза' }).waitFor();
    const next = page.getByText('Сверить события с заказами', { exact: true });
    await next.waitFor();
    assert.equal(await page.getByRole('heading', { level: 2 }).first().textContent(), 'Проверить сбор событий');
    assert.equal(await page.getByRole('link', { name: /карточке релиза/ }).getAttribute('href'), '#release-detail/R%201%2F2');
    const interview = page.getByText('Интервью покупателей', { exact: true });
    const excerpt = page.getByText('«Не нашёл годовую подписку»');
    assert.equal(await excerpt.isVisible(), false);
    await interview.click();
    await excerpt.waitFor();
    const terms = page.getByText('Условия сравнения', { exact: true });
    const partialMatch = page.getByText(/частичная сопоставимость/);
    const license = page.getByText(/Артикул 123 · Годовая · Для новых клиентов/);
    assert.equal(await partialMatch.isVisible(), true);
    assert.equal(await license.isVisible(), false);
    await terms.click();
    await license.waitFor();
    assert.equal(await partialMatch.count(), 1);
    const backlog = page.getByText(/TASK-42 · Сверить журнал/);
    assert.equal(await backlog.isVisible(), false);
    await page.getByText('Бэклог и измерение', { exact: true }).click();
    await backlog.waitFor();
    const prices = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Продавец' }) });
    assert.equal(await prices.getByRole('row').count(), 3);
    await page.getByText('16 недель и исходные строки').click();
    const weeks = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Неделя' }) });
    assert.deepEqual(await weeks.getByRole('columnheader').allTextContents(), ['Неделя', 'Значение', 'Источник']);
    assert.equal(await weeks.getByRole('link').getAttribute('href'), '#knowledge-source/archive1/' + encodeURIComponent(source.loc));
    await checkWidths();
  });

  await t.test('historical order-index caveat is visible beside the comparison with its rows collapsed', async () => {
    await page.goto(origin + '/decision');
    await page.getByLabel('Дата среза').fill('2026-09-18');
    await page.getByRole('button', { name: 'Показать на дату' }).click();
    await page.getByText('Исторический срез · 18.09.2026').waitFor();
    const comparison = page.getByRole('heading', { name: 'Недельный индекс заказов' }).locator('..');
    assert.equal(await comparison.getByText(/не устанавливает влияние релиза/).isVisible(), true);
    assert.equal(await comparison.getByRole('table').count(), 0);
    await page.getByText('Интервью покупателей', { exact: true }).click();
    assert.equal(await page.getByText(/не устанавливает влияние релиза/).count(), 1);
  });

  await t.test('CSV comparison starts with the metric and retains version results and full data version', async () => {
    await page.goto(origin + '/compare');
    await page.getByRole('heading', { level: 1, name: 'Доля оплат', exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: /К релизу/ }).getAttribute('href'), '#release/R%201%2F2');
    await page.getByRole('table').getByRole('row').filter({ hasText: 'Новая версия' }).getByText('40%').waitFor();
    const version = page.getByText('csv-version-attachment', { exact: true });
    assert.equal(await version.isVisible(), false);
    await page.getByText('Формула и версия данных', { exact: true }).click();
    await version.waitFor();
    await checkWidths();
  });

  await t.test('segment breakdown, funnel and interval use result tables', async () => {
    await page.goto(origin + '/breakdown');
    const groups = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Сегмент' }) });
    await groups.getByRole('row').filter({ hasText: 'Новые клиенты' }).getByText('40%').waitFor();
    await page.goto(origin + '/funnel');
    const funnel = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Оплатили' }) });
    await funnel.getByRole('row').filter({ hasText: 'После запуска' }).getByRole('cell', { name: '4', exact: true }).waitFor();
    await page.goto(origin + '/interval');
    await page.getByText('Показатель вырос за два дня.').waitFor();
    await page.getByRole('table').getByRole('cell', { name: '40%', exact: true }).waitFor();
  });

  await t.test('saved custom chart keeps the day rows but places its formula below the result', async () => {
    await page.goto(origin + '/chart');
    await page.getByRole('heading', { level: 1, name: 'Количество оплат' }).waitFor();
    const formula = page.getByText('Число оплат', { exact: true });
    assert.equal(await formula.isVisible(), false);
    await page.getByText('Данные по дням', { exact: true }).click();
    await page.getByRole('table').getByRole('cell', { name: /4 оплаты/ }).waitFor();
    await page.getByText('Формула и версия данных', { exact: true }).click();
    await formula.waitFor();
  });
});
