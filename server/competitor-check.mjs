import { boundedBody, parseWeb, searchConfigured, yandexSearch } from './web-search.mjs';

// Only public seller sites in the organizer research are eligible for direct requests.
const merchants = new Set(['allsoft.ru', 'softmagazin.ru', 'syssoft.ru', 'xcom-shop.ru',
  'snabsoft.ru', 'iesoft.ru', 'cryptostore.ru', 'migsoft.ru', 'komus.ru', 'market.yandex.ru']);
const domain = host => String(host || '').toLowerCase().replace(/^www\./, '');
export function sellerUrl(value, merchant, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, base);
    const allowed = domain(merchant);
    if (merchants.has(allowed) && domain(url.hostname) === allowed && url.protocol === 'https:' &&
        !url.username && !url.password && !url.port) return url.href;
  } catch { /* Missing or invalid URL in the spreadsheet or on the seller page. */ }
  return null;
}

async function sellerPage(url, merchant, env, send) {
  const signal = AbortSignal.timeout(8500);
  for (let redirects = 0; redirects < 4; redirects++) {
    const response = await send(url, { signal, redirect: 'manual', headers: { Accept: 'text/html' } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      url = location && sellerUrl(location, merchant, url);
      if (!url) throw Error('Магазин перенаправил запрос за пределы своего сайта.');
      continue;
    }
    if (!response.ok || !/text\/html|application\/xhtml/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel();
      throw Error('Карточка недоступна или требует входа.');
    }
    const bytes = await boundedBody(response, 2_000_000);
    const encoding = /charset=["']?([\w-]+)/i.exec(response.headers.get('content-type') + ' ' + bytes.subarray(0, 2500).toString('ascii'))?.[1];
    const html = new TextDecoder(encoding || 'utf-8').decode(bytes);
    return { ...await parseWeb('html', Buffer.from(html), env), url };
  }
  throw Error('Слишком много перенаправлений.');
}

function comparison(offer, page) {
  const title = [page.title, page.name].filter(Boolean).join(' ');
  const titleCodes = [...new Set(title.match(/\b(?=[A-Z0-9-]*[0-9])(?=[A-Z0-9-]*[A-Z])[A-Z0-9-]{7,32}\b/g) || [])];
  const found = page.sku || (titleCodes.length === 1 ? titleCodes[0] : '');
  const result = { url: page.url, title: page.title, foundSku: found || null };
  if (!offer.sku || !found) return { ...result, status: 'unconfirmed', text: 'В карточке или в исследовании отсутствует однозначный артикул.' };
  if (found.toUpperCase() !== offer.sku.toUpperCase())
    return { ...result, status: 'mismatch', text: 'В исследовании указан ' + offer.sku + ', на странице продавца — ' + found + '. Цена исходного артикула не подтверждена.' };
  const detail = [title, page.description].join(' ').toLowerCase().replace(/ё/g,'е');
  const license = String(offer.license || '').toLowerCase().replace(/^[/\s]+/, '');
  const stem = license.replace(/(?:ая|ый|ое|ая версия)$/u, '').trim();
  const terms = String(offer.terms || '');
  const duration = terms.match(/(\d+)\s*(год|лет|года|мес)/iu);
  const range = terms.match(/(?:от\s*)?(\d+)\s*(?:до|[-–—])\s*(\d+)/iu);
  const durationOk = duration && new RegExp('(?:^|\\D)' + duration[1] + '\\s*' +
    (duration[2].startsWith('мес') ? 'мес' : '(?:год|лет)'), 'iu').test(detail);
  const rangeOk = range && new RegExp('(?:^|\\D)' + range[1] + '\\s*(?:до|[-–—])\\s*' + range[2] + '(?!\\d)', 'u').test(detail);
  const selected = Array.isArray(page.offers) ? (page.offers.length === 1 ? page.offers[0] : null) : page.offers;
  let price = null;
  if (selected?.['@type'] === 'Offer' && selected.priceCurrency === 'RUB') price = Number(selected.price);
  else if (domain(offer.merchant) === 'allsoft.ru' && page.itemCurrency === 'RUB' && titleCodes.length === 1)
    price = Number(page.itemPrice);
  const unit = /за (?:одну )?(копию|лицензию|комплект|пакет|устройство)/iu.exec(detail)?.[0];
  if (!stem || !detail.includes(stem) || !durationOk || !rangeOk || !unit || !Number.isFinite(price) || !(price > 0) ||
      /(?:цена|стоимость)\s+от\s+\d/iu.test(detail))
    return { ...result, status: 'unconfirmed', text: 'Артикул совпал. Точную цену, единицу продажи и условия лицензии вместе подтвердить не удалось.' };
  return { ...result, status: 'confirmed', price, unit, text: 'Подтверждено предложение ' + found + ' — ' +
    price.toLocaleString('ru-RU') + ' ₽ ' + unit + '. ' + offer.license.replace(/^[/\s]+/, '') + ', ' + terms + '.' };
}

const running = new WeakMap();
export function savedOfferCheck(db, offer) {
  const saved = db.prepare('SELECT body FROM competitor_checks WHERE version=? AND loc=?').get(offer.version, offer.loc);
  return saved ? JSON.parse(saved.body) : null;
}

export async function checkOffer(db, offer, env, send) {
  const prior = savedOfferCheck(db, offer);
  if (prior && Date.now() - Date.parse(prior.checkedAt) < (prior.status === 'confirmed' ? 3600000 : 60000)) return prior;
  if (!running.has(db)) running.set(db, new Map());
  const pending = running.get(db), key = JSON.stringify([offer.version, offer.loc]);
  if (pending.has(key)) return pending.get(key);
  const promise = inspectOffer(offer, env, send).then(result => {
    db.prepare('INSERT OR REPLACE INTO competitor_checks(version,loc,body) VALUES(?,?,?)')
      .run(offer.version, offer.loc, JSON.stringify(result));
    return result;
  }).finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

async function inspectOffer(offer, env, send) {
  const merchant = domain(offer.merchant), visited = new Set();
  const checkedAt = new Date().toISOString(), observations = [];
  let searchRequests = 0, searchNote = '';
  const finish = evidence => ({ ...evidence, checkedAt, searchRequests, searchNote, observations });
  const inspect = async url => {
    if (!url || visited.has(url) || visited.size >= 5) return null;
    visited.add(url);
    let result;
    try { result = comparison(offer, await sellerPage(url, merchant, env, send)); }
    catch { result = { status: 'unavailable', url, text: 'Страницу продавца не удалось прочитать.' }; }
    observations.push(result);
    return result.status === 'confirmed' ? result : null;
  };
  if (!merchants.has(merchant)) return finish({ status: 'unavailable', text: 'Прямое чтение сайта этого продавца пока не поддерживается.' });
  let match = await inspect(offer.url);
  if (match) return finish(match);
  if (merchant === 'allsoft.ru' && offer.sku) {
    try {
      const catalog = await sellerPage('https://allsoft.ru/search/?q=' + encodeURIComponent(offer.sku), merchant, env, send);
      // Some shops redirect an exact search straight to the product.
      const candidates = [catalog.url, ...catalog.links.map(([href]) => sellerUrl(href, merchant, catalog.url))]
        .filter(url => url && /\/software\/vendors\/.+\/\d+\/?(?:[?#]|$)/.test(url));
      for (const url of [...new Set(candidates)].slice(0, 2)) {
        match = await inspect(url);
        if (match) return finish(match);
      }
    } catch { /* The Yandex fallback can still find a public card. */ }
  }
  if (offer.sku && searchConfigured(env)) {
    const queries = ['site:' + merchant + ' "' + offer.sku + '"', 'site:' + merchant + ' ' + offer.sku + ' ' + offer.product];
    for (const query of queries) {
      if (visited.size >= 5) break;
      searchRequests++;
      let hits;
      try { hits = await yandexSearch(query, env, send); }
      catch (err) { searchNote = err.message; break; }
      for (const { url } of hits.slice(0, 2)) {
        match = await inspect(sellerUrl(url, merchant));
        if (match) return finish(match);
      }
    }
  } else if (offer.sku) searchNote = 'Резервный поиск Яндекса не подключён.';
  const best = observations.find(item => item.status === 'mismatch') || observations.find(item => item.status === 'unconfirmed') || observations[0];
  return finish(best || { status: 'unavailable', text: 'Сопоставимую публичную карточку найти не удалось.' });
}
