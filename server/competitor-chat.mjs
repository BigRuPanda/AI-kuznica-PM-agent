import { marketOffers, releaseDecision } from './release-decision.mjs';
import { checkOffer } from './competitor-check.mjs';
import { requestsOffline } from './web-search.mjs';

export function competitorQuestion(question) {
  if (requestsOffline(question) || /(?:не проверяй|на дату|на момент|по состоянию на\s+(?!сегодня)|\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{2,4})/iu.test(question)) return false;
  return /(?:проверь|проверить|сверь|сверить|обнови|актуальн|сейчас|сегодня)/iu.test(question) &&
    /(?:цен[ауые]|предложени|карточк[ауи]|лицензи|артикул)/iu.test(question) &&
    /конкурент|продавц|allsoft|аллсофт|[a-z0-9-]+\.(?:ru|com)\b|артикул/iu.test(question);
}

export async function competitorAnswer(store, user, b, env, send, shared) {
  const question = b.question.toLowerCase();
  const today = new Date().toISOString().slice(0, 10);
  const decision = b.caseId ? releaseDecision(store.db, user, { caseId: b.caseId }, shared) : null;
  const domains = question.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:ru|com)\b/g) || [];
  const all = marketOffers(store.db, null, today);
  const named = [...new Set(all.map(o => o.merchant))].filter(m => question.includes(m.split('.')[0].toLowerCase()) ||
    (m === 'allsoft.ru' && question.includes('аллсофт')));
  const sku = /\b(?=[a-z0-9-]*[a-z])(?=[a-z0-9-]*\d)[a-z0-9-]{7,32}\b/i.exec(question)?.[0];
  const product = /kaspersky|каспер/u.test(question) ? 'Kaspersky' : /astra|астр/u.test(question) ? 'Astra' : null;
  const source = product || (!sku && decision?.product);
  const offers = (source ? marketOffers(store.db, source, today) : all).filter(o =>
    (!domains.length || domains.includes(o.merchant)) && (!named.length || named.includes(o.merchant)) &&
    (!sku || o.sku?.toLowerCase() === sku));
  const offer = offers[0];
  if (!offer) return { text: 'В исследовании нет такой позиции. Для свободного поиска напишите «Найди в интернете» и укажите товар.', mode: 'conversation' };
  if (!source && !sku && new Set(offers.map(o => o.product)).size > 1)
    return { text: 'Какое предложение проверить? Укажите артикул или семейство продукта и продавца.', mode: 'clarification' };
  const result = await checkOffer(store.db, offer, env, send);
  return { mode: 'competitor-check', steps: ['competitor_check'], webSearchCount: result.searchRequests,
    text: [offer.merchant + ' · ' + offer.product, result.text, result.searchNote,
      'Веб-проверка ' + new Date(result.checkedAt).toLocaleDateString('ru-RU') + '. Запросов к Яндексу: ' + result.searchRequests + '.'].filter(Boolean).join('\n'),
    readSources: [{ url: '#knowledge-source/' + offer.version + '/' + encodeURIComponent(offer.loc), label: offer.file + ' · ' + offer.loc },
      ...(result.url ? [{ url: result.url, label: 'Карточка продавца · ' + offer.merchant }] : [])] };
}
