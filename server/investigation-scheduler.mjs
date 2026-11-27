import { listInvestigationWork, tryStartInvestigation } from './case-investigations.mjs';

export function createInvestigationScheduler({spaces, getLimit, env, send=fetch, options={}}) {
  const pending = new Set(), lastTurn = new Map();
  let activeRoles=0, turn=0, timer, closed=false;

  function start(store, item) {
    const task = tryStartInvestigation(store,item,env,send,options);
    if (!task) return false;
    if (item.kind === 'role') activeRoles++;
    pending.add(task);
    task.then(() => finish(true), () => {
      console.error('Не удалось обработать этап исследования');
      finish(false); // The periodic scan retries unexpected storage failures.
    });
    function finish(again) {
      pending.delete(task);
      if (item.kind === 'role') activeRoles--;
      if (again) wake();
    }
    return true;
  }

  function dispatch() {
    timer=undefined;
    if (closed) return;
    const groups=new Map();
    const now=options.now?.() ?? Date.now();
    for (const [spaceId,store] of spaces) {
      for (const work of listInvestigationWork(store,env,now)) {
        if (work.kind === 'prepare') {
          start(store,work);
          continue;
        }
        const key=JSON.stringify([spaceId,work.caseId]);
        if (!groups.has(key)) groups.set(key,[]);
        groups.get(key).push({store,work});
      }
    }
    const ring=[...groups.keys()].sort((a,b)=>(lastTurn.get(a) || 0)-(lastTurn.get(b) || 0));
    const limit=getLimit();
    while (activeRoles < limit && ring.length) {
      const key=ring.shift();
      const items=groups.get(key);
      const {store,work}=items.shift();
      if (start(store,work)) lastTurn.set(key,++turn);
      if (items.length) ring.push(key);
    }
    if (!pending.size && !groups.size) lastTurn.clear();
  }

  function wake() {
    if (closed || timer) return;
    timer=setImmediate(() => {
      try { dispatch(); }
      catch { console.error('Не удалось проверить очередь исследований'); }
    });
  }
  async function close() {
    closed=true;
    clearImmediate(timer);
    await Promise.allSettled([...pending]);
  }
  return {wake,close};
}
