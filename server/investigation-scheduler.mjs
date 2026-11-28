import { listInvestigationWork, tryStartInvestigation } from './case-investigations.mjs';

export function createInvestigationScheduler({spaces, getLimit, env, send=fetch, options={}}) {
  const pending = new Set(), active = new Map();
  let ring = [];
  let activeRoles=0, timer, closed=false;

  function start(store, item) {
    let claim;
    const controller = item.kind === 'role' ? new AbortController() : null;
    const task = tryStartInvestigation(store,item,env,send,controller ? {
      ...options, signal:controller.signal,
      onRoleClaim(owned) { claim=owned; options.onRoleClaim?.(owned); },
    } : options);
    if (!task) return false;
    if (controller) {
      activeRoles++;
      active.set(task,{store,controller,claim});
    }
    pending.add(task);
    task.then(() => finish(true), () => {
      console.error('Не удалось обработать этап исследования');
      finish(false); // The periodic scan retries unexpected storage failures.
    });
    function finish(again) {
      pending.delete(task);
      if (active.delete(task)) activeRoles--;
      if (again) wake();
    }
    return true;
  }

  function dispatch() {
    timer=undefined;
    if (closed) return;
    const groups=new Map();
    const now=options.now?.() ?? Date.now();
    for (const {store,controller,claim} of active.values()) {
      const owned=store.db.prepare('SELECT lease,lease_until FROM case_investigation_role_state WHERE run_id=? AND role=?')
        .get(claim.runId,claim.role);
      if (owned?.lease !== claim.lease || owned.lease_until <= now) controller.abort();
    }
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
    // Keep waiting cases in order across completions. A stream of new signals joins at the tail.
    ring = ring.filter(key => groups.has(key));
    const waiting = new Set(ring);
    for (const key of groups.keys()) {
      if (!waiting.has(key)) ring.push(key);
    }
    const limit=getLimit();
    while (activeRoles < limit && ring.length) {
      const key=ring.shift();
      const items=groups.get(key);
      const {store,work}=items.shift();
      start(store,work);
      if (items.length) ring.push(key);
    }
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
    for (const {controller} of active.values()) controller.abort();
    await Promise.allSettled([...pending]);
  }
  return {wake,close};
}
