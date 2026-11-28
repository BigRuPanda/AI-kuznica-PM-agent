import { apiConfigured, modelTimeout, providerCall } from './agent.mjs';
import { fmt, productFamily } from './evidence.mjs';

const normalize = q => q.trim().replace(/[?!.…]+$/u, '').trim();
const identity = /^(?:ты кто|кто (?:ты|вы)(?: такой| такая)?|ты (?:бот|агент)|что (?:ты|вы) умеешь?|чем (?:ты )?можешь помочь)$/iu;
const definition = /^(?:а\s+)?(?:кто (?:такой|такая|такие)|что (?:такое|означает)|как (?:называется|называют)|объясни (?:термин|понятие))\s+([\p{L}\p{N}][\p{L}\p{N} .«»"()\-]{0,78})$/iu;
const needsRecords = /(?:\sи\s|\s(?:котор|почему|зачем|како|сколько|наш|этот|эт[иа]|мо[йя]|их\s)|архив|источник|интервью|задач|тикет|релиз|таблиц|справочник|сигнал|показател|метрик|индекс заказ|воронк|\bctr\b|(?:^|\s)[TR]-\d|(?:cfg|lk)_)/iu;

export async function briefConversation(store, job, question, activeCase, env, send, history) {
  let q = normalize(question.replace(/[,!.?\s]+(?:ответь |пожалуйста,? )?(?:без интернета|без веб[- ]?поиска|не ищи в интернете)[.!?\s]*$/iu,''));
  const previous=history.at(-1)?.body;
  if (activeCase && previous?.referenceSubject && previous.caseId===activeCase.id) {
    if (/^(?:(?:я )?(?:про|о|об) )?(?:человек[ае]?|основател[яе]|компани[яюи]|разработчик[ае]?)$/iu.test(q)) {
      return {mode:'conversation',contextReset:true,text:'Карточка относится к продукту «'+activeCase.product+
        '». Для справки о разработчике и основателе включите «Поиск в интернете» и отправьте вопрос «Кто разработал '+activeCase.product+'?». Тогда к ответу будут приложены источники.'};
    }
    if (/^(?:(?:я )?(?:про|о) )?(?:сам )?продукт[е]?$/iu.test(q)) q='Что такое '+activeCase.product;
  }
  if (identity.test(q)) return {mode:'conversation',contextReset:true,text:'Я Signal, помощник продакта. Могу проверить показатели, найти источники в архиве и собрать разбор.'};
  if (/^(?:привет(?:ствую)?|здравствуйте|доброе утро|добрый (?:день|вечер))$/iu.test(q))
    return {mode:'conversation',steps:[],text:/^привет$/iu.test(q) ? 'Привет!' : 'Здравствуйте! Чем могу помочь?'};
  const general = /^(?:объясни|расскажи)(?: простыми словами| кратко| в двух словах)?[, ]+(?:зачем|как работает|почему важно|для чего)\s+(.{3,120})$/iu.exec(q);
  const subject = definition.exec(q)?.[1] || general?.[1];
  if (!subject || needsRecords.test(' '+subject) || general && /разбор|график|период|у нас|карточк|цифр|продаж|сравни (?:с|за)|наши|по нашим|сейчас|\d/iu.test(subject)) return null;
  const product = activeCase?.product;
  const related = product && (productFamily(subject)===productFamily(product) ||
    product.toLowerCase().split(/\s+/u).includes(subject.toLowerCase()));
  const context = related ? product : undefined;
  // A brand shared with a surname establishes a product in this case, not a biography.
  if (context && /кто так/iu.test(q) && !/\s/u.test(subject) &&
      subject.toLowerCase()!==product.toLowerCase()) {
    return {mode:'conversation',outcome:'clarification',contextReset:true,referenceSubject:subject,
      text:'В открытой карточке разбираем продукт «'+product+'». Вы спрашиваете про сам продукт, компанию-разработчика или человека с этой фамилией?'};
  }
  if (!apiConfigured(env)) return null;
  const jobRow=store.db.prepare('SELECT result FROM jobs WHERE id=?').get(job);
  const retry=Boolean(JSON.parse(jobRow?.result || '{}')?.briefUnavailable);
  const started = Date.now();
  let reason='Модель вернула незавершённый ответ.';
  try {
    const reply = await providerCall(env,[
      {role:'system',content:'Ответь по-русски двумя короткими предложениями. Для вопроса о методе объясни простыми словами, как он работает и какой вывод позволяет сделать. Не утверждай, что гипотеза уже подтверждена. Название продукта дано только для контекста. При неоднозначном вопросе попроси уточнить. Если не знаешь имени или должности, не угадывай. Не добавляй даты и статистику.'},
      {role:'user',content:JSON.stringify({question:q,product:context})},
    ],[],'auto',send,{timeout:modelTimeout(env,32_000),maxTokens:retry?56:90,temperature:0});
    store.db.prepare('INSERT INTO costs(job,model,elapsed,input,output) VALUES(?,?,?,?,?)')
      .run(job,env.LLM_MODEL || 'configured',Date.now()-started,reply.usage?.input??null,reply.usage?.output??null);
    const text=reply.content?.trim();
    if (text) {
      // When the local token budget is exhausted, keep whole sentences.
      const complete=text.match(/^[\s\S]*[.!?…](?=\s|$)/u)?.[0];
      if (complete) return {mode:'conversation',text:complete,contextReset:true};
      if (!reply.lengthLimited) return {mode:'conversation',text,contextReset:true};
    }
  } catch(error) { reason=error.message; }
  return {mode:'conversation',outcome:'failed',contextReset:true,briefUnavailable:true,retryExhausted:retry,
    text:reason+(retry?' Введите уточнение или включите поиск в интернете.':' Можно повторить короткий запрос.')};
}

// Only whole, general requests about the current case qualify. Specific investigations
// and requests with additional actions continue through the workspace agent.
export function caseBriefKind(question,product) {
  const q=normalize(question).replace(/^(?:а\s+|пожалуйста,?\s+)/iu,'');
  if (/^(?:что (?:стоит |нужно |можно )?проверить|что проверять дальше|какой следующий шаг)(?: (?:дальше|в (?:этом|текущем) разборе|по (?:этому|текущему) разбору))?$/iu.test(q)) return 'advice';
  const match=/^(?:подготовь|собери|сделай|составь) (?:краткий |продуктовый )?разбор(?: (?:по|для) (.+))?$/iu.exec(q);
  if (!match) return null;
  if (!match[1] || /^(?:этому продукту|текущему продукту|этой карточке)$/iu.test(match[1])) return 'report';
  const target=match[1].trim();
  return !/[?,;]|\sи\s/iu.test(target) && target.split(/\s+/u).length<=product.split(/\s+/u).length &&
    (target.toLowerCase()===product.toLowerCase() ||
    (!/\s/u.test(target) && productFamily(target)===productFamily(product))) ? 'report' : null;
}

export function caseBrief(c,view) {
  const summary=view.summary?.find(s=>s.product===c.product), control=view.summary?.find(s=>s.product!==c.product);
  const lines=[];
  if (summary && Number.isFinite(summary.before) && Number.isFinite(summary.after)) {
    lines.push('Средний индекс заказов «'+c.product+'» изменился с '+fmt(summary.before)+' до '+fmt(summary.after)+
      (Number.isFinite(summary.change)?' ('+fmt(summary.change)+'%)':'')+'.');
    if (view.base && view.pivot && view.cut) lines.push('База начинается с '+view.base+'. Переходная неделя '+view.pivot+' исключена из сравнения. Конец среза — '+view.cut+'.');
    if (control && Number.isFinite(control.before) && Number.isFinite(control.after))
      lines.push('В контрольном ряду «'+control.product+'» за те же периоды: '+fmt(control.before)+' → '+fmt(control.after)+'.');
    lines.push('Проверьте полноту последней недели и сохранение изменения на полных неделях. Затем сопоставьте начало изменения с датами релизов. Само совпадение дат не устанавливает причину.');
  } else {
    lines.push('Для «'+c.product+'» нет двух сопоставимых значений индекса. Проверьте покрытие периодов в исходной таблице.');
  }
  if (c.body.plan?.success) lines.push('Критерий проверки из карточки: '+c.body.plan.success);
  return {text:lines.join('\n\n'),mode:'analysis',product:c.product,caseId:c.id,
    calc:view.id,cards:['summary','trend'],outcome:'done',steps:['view']};
}
