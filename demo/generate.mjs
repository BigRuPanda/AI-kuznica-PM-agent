import { writeFile } from 'node:fs/promises';

// All timestamps in the CSVs are UTC. Release activation is 10:00 Moscow time.
const day = 86400000;
const minute = 60000;
const releases = [
  ['R-001', 'Новая форма заказа', '2026-10-05T07:00:00.000Z', 'checkout_started'],
  ['R-002', 'Кнопка «Скачать счёт»', '2026-11-02T07:00:00.000Z', 'invoice_page_viewed'],
];
const events = [];
let orderNumber = 0;

function addCohort(release, after, segment, size, paidCount, view = after ? 'new' : 'old') {
  const [releaseId, , launch] = release;
  const isInvoiceDemo = releaseId === 'R-002';
  const start = Date.parse(launch) - (after ? 0 : 7 * day);
  for (let index = 0; index < size; index++) {
    orderNumber++;
    const checkout = start + Math.floor(index * (7 * day - 90 * minute) / size);
    const paid = Math.floor((index + 1) * paidCount / size) > Math.floor(index * paidCount / size);
    const kind = segment === 'returning' && index % 3 === 1 ? 'renewal' : 'purchase';
    const invoice = checkout + 15 * minute;
    const paidAt = invoice + (1 + index % 6) * day;
    const due = invoice + 4 * day;
    const amount = 1000 + index % 19 * 250;
    function event(time, type, version = '', rub = '') {
      events.push([releaseId, 'C' + orderNumber, 'O' + orderNumber, 'I' + orderNumber,
        segment, kind, new Date(time).toISOString(), type, version, rub]);
    }
    event(checkout, 'checkout_started', isInvoiceDemo ? 'new' : view);
    event(invoice, 'invoice_issued');
    if (isInvoiceDemo) {
      event(invoice + minute, 'invoice_page_viewed', view);
      if (after && index % 10 === 3) {
        event(invoice + 12 * 60 * minute, 'invoice_page_viewed', view === 'old' ? 'new' : 'old');
      }
    }
    if (kind === 'renewal') event(due, 'subscription_due');
    if (paid) {
      event(paidAt, 'payment_received', '', amount);
      if (kind === 'renewal') event(paidAt, 'subscription_renewed');
    }
  }
}

addCohort(releases[0], false, 'new', 400, 20);
addCohort(releases[0], false, 'returning', 600, 120);
addCohort(releases[0], true, 'new', 600, 30);
addCohort(releases[0], true, 'returning', 400, 80);
// Equal-sized invoice cohorts make the change visible within each segment.
for (const segment of ['new', 'returning']) {
  addCohort(releases[1], false, segment, 100, 40);
  addCohort(releases[1], true, segment, 40, 24, 'new');
  addCohort(releases[1], true, segment, 60, 31, 'old');
}

async function save(name, header, rows) {
  const csv = [header, ...rows].map(row => row.map(value => {
    const field = String(value);
    return /[",\n\r]/.test(field) ? '"' + field.replaceAll('"', '""') + '"' : field;
  }).join(',')).join('\n') + '\n';
  await writeFile(new URL(name, import.meta.url), csv);
}

await save('releases.csv', ['release_id', 'title', 'activated_at', 'exposure_event'], releases);
events.sort((a, b) => a[6].localeCompare(b[6]));
await save('events.csv', ['release_id', 'company_id', 'order_id', 'invoice_id', 'customer_segment',
  'purchase_type', 'event_at', 'event_type', 'ui_version', 'amount_rub'], events);
console.log(`Демонстрационные данные готовы: ${orderNumber} заказов, ${events.length} событий.`);
