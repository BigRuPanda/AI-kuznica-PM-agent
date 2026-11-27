import { productFamily } from './evidence.mjs';
import { sellerUrl } from './competitor-check.mjs';
const citation = row => ({ file: row.file, loc: row.loc, version: row.version });
function mentions(text, product) {
  if (!text) return false;
  const words = String(text).toLowerCase().replace(/каспер[а-яё]*/gu, 'kaspersky')
    .replace(/астр[а-яё]*/gu, 'astra').match(/[\p{L}\p{N}]+/gu) || [];
  const needle = productFamily(product);
  return (' ' + words.join(' ') + ' ').includes(' ' + product.toLowerCase() + ' ') || words.includes(needle);
}

export function marketOffers(db, product, asOf) {
  // A document contains structured columns in addition to the searchable text. Read only active versions.
  const docs = db.prepare(`SELECT file, version, body FROM documents WHERE version IN
    (SELECT DISTINCT version FROM facts WHERE kind='competitor')`).all();
  const active = new Set(db.prepare("SELECT version,loc FROM facts WHERE kind='competitor'").all().map(r=>JSON.stringify([r.version,r.loc])));
  const offers = docs.flatMap(doc => JSON.parse(doc.body).facts
    .filter(f => active.has(JSON.stringify([doc.version,f.loc])) && f.comparison && (!product || mentions(f.comparison.product, product)) && f.comparison.checked <= asOf)
    .map(f => {
      const url = [...(f.links || []).map(link => link.url), ...(f.text || '').split(' · ')].map(value => sellerUrl(value, f.comparison.merchant)).find(Boolean) || null;
      return { ...f.comparison, url, ...citation({ ...doc, loc: f.loc }) };
    }));
  const comparable = offer => offer.match !== 'Частично';
  offers.sort((a, b) => Number(comparable(b)) - Number(comparable(a)) || b.checked.localeCompare(a.checked) ||
    a.merchant.localeCompare(b.merchant) || a.loc.localeCompare(b.loc));
  return offers;
}
