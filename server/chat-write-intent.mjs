const commands = /[!?;\n]+|\.+(?=\s|$)|\s+(?:и|затем|потом|но)\s+(?=(?:не\s+)?(?:добавь|дополни|запиши|сохрани|создай|заведи|подготовь|закрепи|измени|убери|назначь|отслеживай|покажи|закрой|учти|запомни|прочитай|проверь|сверь|поищи|найди|расскажи|сравни|опубликуй|поделись|начни|запусти|возобнови))/iu;
const advice = /^(?:как |нужно ли|можно ли|стоит ли|что будет|умеешь ли|should |how )/iu;
const reading = /^(?:(?:пожалуйста|для меня)[,\s]+)?(?:подготовь|составь|собери|сделай)\s+(?:мне\s+)?(?:кратк\p{L}+\s+)?(?:список|перечень|обзор|сводку|вывод|анализ|отч[её]т|справку)(?=$|[\s,.:])/iu;
const negation = /(?:^|[\s,])(?:не\s+(?:нужно\s+|надо\s+)?(?:созда|дела|завод|оформ|подготав|добав|дополня|сохраня|записыва|закреп|меня|измен|убира|назнач|отслеж|публику|отправ|рассыла|закры|заверша|запомина|учитыва)|do not |don't )/iu;

const requestPrefix = /^(?:пожалуйста[,\s]+|для меня[,\s]+|для\s+(?:confluence|redmine)[,\s]+|хочу\s+(?=поделиться)|в\s+(?:этом|текущем)\s+разборе[,\s]+)+/iu;
const topic = /\s+(?:о(?:б|бо)?|про|по|на тему|на основе|из|со ссылкой на|с описанием|с цитатой)\s+/iu;
const noDelivery = /(?:,\s*|\s+(?:но|и)\s+)(?:пока\s+)?(?:никому\s+)?не\s+(?:отправляй|публикуй|рассылай)(?=$|[\s,.:])/iu;

const requests = {
  'create-case': /(?:создай|заведи|оформи|начни|create)\s+(?:(?:мне|пожалуйста|(?:нов|личн|отдельн)\p{L}*|a|new|personal|separate)\s+){0,4}(?:разбор|расследование|case)(?=$|[\s,.:])|сохрани\s+(?:(?:отдельн|нов|личн)\p{L}*\s+)+(?:разбор|расследование)/iu,
  append_case: /(?:добавь|дополни|сохрани|запиши|зафиксируй|append|save)\s+.{0,75}(?:заметк|(?<!\p{L})в\s+(?:(?:этот|текущий)\s+)?разбор|note)/iu,
  set_view: /(?:закрепи|оставь|измени|убери|верни|pin)\s+.{0,75}(?:вид|экран|карточ|сводк|график)|добавь\s+.{0,75}(?:на экран|в (?:мой |личный )?вид)/iu,
  draft: /(?:измени|обнови|прокомментируй|назначь|подготовь|составь|заведи|создай|оформи|сделай|запиши|добавь|create|prepare|change)\s+.{0,180}(?:redmine|задач|заявк|тикет|issue)|(?:подготовь|создай|составь|оформи)\s+(?:мне\s+)?черновик\s+для\s+qa(?=$|[\s,.:])/iu,
  prepare_publish: /(?:подготовь|собери)\s+.{0,95}(?:публикац|предпросмотр|preview)|(?:опубликуй|поделись|поделиться|отправь|share|publish)\s+.{0,95}(?:публикац|команд|предпросмотр|preview)/iu,
  page_draft: /(?:создай|собери|подготовь|обнови|измени|опубликуй|добавь|create|prepare|update)\s+.{0,180}(?:confluence|страниц|page)/iu,
  feedback: /(?:запомни|учти|исправь|отметь|сохрани|remember|correct)\s+.{0,100}(?:поправк|исправлен|уточнен|уточнён|источник|correction)/iu,
  watch: /(?:назначь|сохрани|начни|запусти|установи)\s+.{0,55}наблюден|(?:^|\s)(?:отслеживай|проследи|monitor|watch)(?=$|[\s,.:])|проверь через \d+/iu,
  decide: /(?:закрой|заверши|возобнови|поменяй статус|измени статус|close|reopen)\s+.{0,85}(?:разбор|расследование|case)/iu,
};
const directRequests = Object.entries(requests).map(([op,pattern])=>[op,new RegExp('^(?:'+pattern.source+')',pattern.flags)]);

function writeClauses(question) {
  const matching = [];
  const clauses = question.replace(/«[^»]*»|"[^"]*"|`[^`]*`/gu, ' ').split(commands);
  for (const raw of clauses) {
    const clause = raw.trim();
    const command = clause.replace(requestPrefix,'');
    if (!command || advice.test(command) || reading.test(command)) continue;
    const deferredDelivery = noDelivery.exec(command);
    const preparation = deferredDelivery && command.slice(0, deferredDelivery.index);
    const deferred = negation.test(command);
    if (deferred && (!preparation || negation.test(preparation) ||
        !/^(?:подготовь|составь|собери|сделай|оформи)\s/iu.test(preparation))) continue;
    const request = deferred ? preparation : command;
    const head = request.split(topic,1)[0];
    const match = text => directRequests.filter(([,pattern])=>pattern.test(text)).map(([op])=>op);
    const main = match(head);
    const ops = (main.length || head===request ? main : match(request))
      .filter(op=>!deferred || op==='draft' || op==='page_draft');
    if (ops.length) matching.push({clause,ops});
  }
  return matching;
}

export function chatWriteRequests(question) {
  const counts = new Map();
  for (const {clause,ops} of writeClauses(question)) {
    const quantity = clause.match(/(?:^|\s)([1-9]\d*|две|два|три|четыре)\s+(?:отдельн\p{L}*\s+)?(?:заметк|черновик|задач|страниц)/iu)?.[1];
    const count = ops.length === 1 && quantity
      ? ({две:2, два:2, три:3, четыре:4}[quantity.toLowerCase()] || Number(quantity))
      : 1;
    for (const op of ops) counts.set(op, (counts.get(op) || 0) + count);
  }
  return [...counts].map(([op,count]) => ({op,count}));
}

export function chatWriteCase(question, currentCaseId, op) {
  const targets = new Set();
  const clarify = () => Error('Откройте нужный разбор или укажите ссылку на него.');
  for (const {clause,ops} of writeClauses(question)) {
    if (!ops.includes(op)) continue;
    const current = /(?:^|\s)(?:в|к)\s+(?:текущ\p{L}*|этот|этом|эту|этой)\s+(?:разбор|карточк)/iu.test(clause);
    const destinations = [...clause.matchAll(/(?:^|[\s,])(?:в|к)\s+(?:(?:другой|другую|этот|эту)\s+)?(?:(?:разбор|карточку|карточке)\s+)?(?:https?:\/\/[^\s#]+)?#case\/([\w-]+)/giu)];
    const mentions = clause.split(topic,1)[0].matchAll(/#case\/([\w-]+)/gu);
    const links = [...new Set([...(destinations.length ? destinations : mentions)].map(([,id])=>id))];
    if (!current && links.length > 1 || current && destinations.some(([,id])=>id!==currentCaseId)) throw clarify();
    const other = /(?:^|\s)(?:в|к)\s+(?:другой|другую|другом)\s+(?:разбор|карточк)/iu.test(clause);
    const target = current ? currentCaseId : links[0] || (other ? null : currentCaseId);
    if (!target) throw clarify();
    targets.add(target);
  }
  if (targets.size !== 1) throw clarify();
  return [...targets][0];
}
