export const checkoutReleaseTitle = 'Проверка обновления оформления заказа';
export const invoiceReleaseTitle = 'Проверка нового экрана счетов';

const dayMs = 86400000;
const hourMs = 3600000;
const releases = [
  {
    id: 'R-001', title: checkoutReleaseTitle, launch: Date.parse('2026-10-05T07:00:00Z'),
    description: 'Изменили порядок полей в оформлении заказа.',
    audience: 'Компании, начавшие оформление заказа', question: 'Как изменилась доля оплат?',
    target: 0, exposure: 'checkout_started',
    // Checkout day, customer segment, first interface, and optional days from invoice to payment.
    orders: [
      [-7, 'new', 'old', 1], [-6, 'new', 'old'],
      [-6, 'returning', 'old', 1], [-5, 'returning', 'old', 1],
      [-4, 'returning', 'old', 2], [-3, 'returning', 'old', 1],
      [0, 'new', 'new', 1], [1, 'new', 'new', 2], [2, 'new', 'new'], [3, 'new', 'new'],
      [0, 'returning', 'old', 1], [2, 'returning', 'new', 2],
    ],
  },
  {
    id: 'R-002', title: invoiceReleaseTitle, launch: Date.parse('2026-11-02T07:00:00Z'),
    description: 'Изменили расположение сведений о счёте.',
    audience: 'Компании, получившие счёт', question: 'Как изменилась доля оплаченных счетов?',
    target: 1, exposure: 'invoice_page_viewed',
    // A fifth column records a later visit to the other interface before payment.
    orders: [
      [-6, 'new', 'old', 1], [-5, 'returning', 'old', 2],
      [-3, 'new', 'old'], [-2, 'returning', 'old', 1],
      [0, 'new', 'new', 1, 'old'], [1, 'new', 'new', 2],
      [2, 'returning', 'new', 4], [3, 'returning', 'new'],
      [0, 'new', 'old', 5, 'new'], [4, 'returning', 'old'],
    ],
  },
];

function orderEvents(release, order, index) {
  const [day, segment, firstVersion, paymentDelay, nextVersion] = order;
  const key = `${release.id}-${index + 1}`;
  const prefix = [release.id, `company-${key}`, `order-${key}`, `invoice-${key}`, segment];
  const event = (type, hour, version = '', amount = '') => [
    ...prefix, type, new Date(release.launch + day * dayMs + hour * hourMs).toISOString(), version, amount,
  ].join(',');
  const checkoutVersion = release.exposure === 'checkout_started' ? firstVersion : '';
  const events = [event('checkout_started', 0, checkoutVersion), event('invoice_issued', 1)];
  if (release.exposure === 'invoice_page_viewed') events.push(event('invoice_page_viewed', 2, firstVersion));
  if (nextVersion) events.push(event(release.exposure, 3, nextVersion));
  if (paymentDelay !== undefined) events.push(event('payment_received', 1 + paymentDelay * 24, '', 100 + index * 25));
  return events;
}

export const releaseMetricsCsv = [
  'release_id,company_id,order_id,invoice_id,customer_segment,event_type,event_at,ui_version,amount_rub',
  ...releases.flatMap(release => release.orders.flatMap((order, index) => orderEvents(release, order, index))),
  '',
].join('\n');

export function seedReleaseMetrics(store) {
  const { dataset } = store.importCSV({
    name: 'Тестовые события релизов', csv: releaseMetricsCsv, completeThrough: '2026-11-16T07:00:00Z',
  });
  store.tx(() => {
    const insert = store.db.prepare('INSERT INTO releases (id, body) VALUES (?, ?)');
    for (const { orders, ...release } of releases) {
      insert.run(release.id, JSON.stringify({ ...release, dataset, sourceKey: release.id }));
    }
  });
}
