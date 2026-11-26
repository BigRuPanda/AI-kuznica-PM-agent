import { readFile, writeFile } from 'node:fs/promises';

// The generator emits comma-free values. Keep exactly the event times used by the UI.
async function rows(name) {
  const csv = await readFile(new URL(name, import.meta.url), 'utf8');
  const [header, ...lines] = csv.trimEnd().split(/\r?\n/);
  const fields = header.split(',');
  return lines.map(line => Object.fromEntries(line.split(',').map((value, i) => [fields[i], value])));
}

const releases = {};
const defaultEvents = { 'R-001': 'checkout_started', 'R-002': 'invoice_page_viewed' };
for (const row of await rows('releases.csv')) {
  releases[row.release_id] = { title: row.title, launch: Date.parse(row.activated_at), exposureEvent: row.exposure_event || defaultEvents[row.release_id], orders: [] };
}
const events = await rows('events.csv');
const soleInvoice = new Map();
for (const event of events) {
  if (!event.order_id || !event.invoice_id) continue;
  const key = event.release_id + '/' + event.order_id;
  if (!soleInvoice.has(key)) soleInvoice.set(key, event.invoice_id);
  else if (soleInvoice.get(key) !== event.invoice_id) soleInvoice.set(key, null);
}
const orders = new Map();
for (const event of events) {
  const release = releases[event.release_id];
  const invoiceId = event.invoice_id || soleInvoice.get(event.release_id + '/' + event.order_id);
  const subject = release.exposureEvent === 'invoice_page_viewed' && invoiceId
    ? 'invoice/' + invoiceId : 'order/' + event.order_id;
  const key = event.release_id + '/' + subject;
  let record = orders.get(key);
  if (!record) {
    const order = [event.customer_segment, null, null, null, 0, null, null, null, null, null, invoiceId || null];
    record = { order, firstViews: new Map() };
    orders.set(key, record);
    release.orders.push(order);
  }
  const { order, firstViews } = record;
  const at = Date.parse(event.event_at) - release.launch;
  if (event.event_type === release.exposureEvent && ['old','new'].includes(event.ui_version)) {
    firstViews.set(event.ui_version, Math.min(at, firstViews.get(event.ui_version) ?? Infinity));
  }
  switch (event.event_type) {
    case 'checkout_started': order[1] = Math.min(order[1] ?? Infinity, at); break;
    case 'invoice_issued': order[2] = Math.min(order[2] ?? Infinity, at); break;
    case 'payment_received': order[3] = at; order[4] = Number(event.amount_rub); break;
    case 'subscription_due': order[5] = at; break;
    case 'subscription_renewed': order[6] = at; break;
  }
}
for (const {order, firstViews} of orders.values()) {
  const [first, second] = [...firstViews].sort((a,b) => a[1]-b[1]);
  if (first) [order[7], order[8]] = first;
  if (second) order[9] = second[1];
}
await writeFile(new URL('../prototype/data.js', import.meta.url),
  'globalThis.releaseDemo = ' + JSON.stringify(releases) + ';\n');
