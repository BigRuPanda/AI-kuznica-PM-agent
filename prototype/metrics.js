(() => {
  const DAY = 86400000;
  const metrics = [
    ['Конверсия из оформления в оплату', '%', 'Оплатившие компании / начавшие оформление'],
    ['Доля оплаченных счетов', '%', 'Счета, оплаченные за семь суток / выставленные счета'],
    ['Сумма оплат', '₽', 'Сумма поступивших оплат в рублях'],
    ['Средний чек', '₽', 'Сумма оплат / число оплаченных заказов'],
    ['Своевременные продления', '%', 'Подписки, продлённые к сроку / подписки с наступившим сроком']
  ];

  // A company can start several orders. Anchor its seven-day window to its first
  // eligible checkout in the period and count at most one successful company.
  function calculate(orders, segment, fromDay, untilDay, asOfDay) {
    const from = fromDay * DAY, until = untilDay * DAY, asOf = asOfDay * DAY;
    const rows = metrics.map(() => ({ n: 0, d: 0, pending: 0, bothViews: [] }));
    const inWindow = time => time !== null && time >= from && time < until && time <= asOf;
    const companies = new Map();
    for (const order of orders) {
      const [group, start, issued, paid, amount, due, renewed, firstVersion, firstView, secondView] = order;
      if (segment !== 'all' && segment !== group) continue;
      const bothSeen = (firstVersion === 'old' || firstVersion === 'new') && Number.isFinite(firstView)
        && Number.isFinite(secondView) && firstView <= secondView && secondView <= asOf
        && (paid === null || secondView < paid);
      if(inWindow(start)){
        const key=order[11] || order;
        let company=companies.get(key);
        if(!company){company={start,paid:null,both:null};companies.set(key,company);}
        company.start=Math.min(company.start,start);
        if(paid!==null&&paid>=start&&paid<=asOf)company.paid=Math.min(company.paid??Infinity,paid);
        if(bothSeen)company.both=order;
      }
      if (inWindow(issued)) {
        const row = rows[1];
        if (bothSeen) row.bothViews.push(order);
        if (issued + 7 * DAY > asOf) row.pending++;
        else {
          row.d++;
          if (paid !== null && paid >= issued && paid <= issued + 7 * DAY) row.n++;
        }
      }
      if (inWindow(paid)) {
        rows[2].n += amount; rows[2].d++;
        rows[3].n += amount; rows[3].d++;
        if (bothSeen) { rows[2].bothViews.push(order); rows[3].bothViews.push(order); }
      }
      if (inWindow(due)) {
        rows[4].d++;
        if (bothSeen) rows[4].bothViews.push(order);
        if (renewed !== null && renewed <= due) rows[4].n++;
      }
    }
    for(const company of companies.values()){
      if(company.both)rows[0].bothViews.push(company.both);
      if(company.start+7*DAY>asOf)rows[0].pending++;
      else{
        rows[0].d++;
        if(company.paid!==null&&company.paid<=company.start+7*DAY)rows[0].n++;
      }
    }
    return rows.map((r, i) => {
      let value = null;
      if (i === 2 && from < asOf) value = r.n;
      else if (r.d) value = r.n / r.d * (metrics[i][1] === '%' ? 100 : 1);
      return { ...r, value };
    });
  }

  function series(orders, days, asOf, firstSeen = -Infinity) {
    function calc(a, b) {
      const rows = calculate(orders, 'all', a, b, asOf);
      // Before any exposure there is no version population, including for revenue.
      if (firstSeen >= b * DAY || firstSeen > asOf * DAY) rows[2].value = null;
      return rows;
    }
    return { before: calc(-7, 0), after: calc(0, 7), days, daily: days.map(d => calc(d, d + 1)) };
  }
  function partition(orders, asOf) {
    const groups = {old:[], new:[], unknown:[]};
    const firstSeen = {old:Infinity, new:Infinity};
    for (const order of orders) {
      const version = order[7], observed = order[8];
      if ((version === 'old' || version === 'new') && Number.isFinite(observed) && observed <= asOf * DAY
          && (order[3] === null || observed <= order[3])) {
        groups[version].push(order);
        firstSeen[version] = Math.min(firstSeen[version],observed);
      } else groups.unknown.push(order);
    }
    return {groups,firstSeen};
  }
  function snapshot(release, segment, asOf, firstDay = -7) {
    const orders = release.orders.filter(order => segment === 'all' || order[0] === segment);
    const days = Array.from({ length: Math.max(0,asOf-firstDay) }, (_, i) => i + firstDay);
    const {groups,firstSeen}=partition(orders,asOf);
    const result = series(orders, days, asOf);
    result.hasVersion = groups.old.length + groups.new.length > 0;
    result.byVersion = {
      old:series(groups.old, days, asOf, firstSeen.old),
      new:series(groups.new, days, asOf, firstSeen.new),
      unknown:series(groups.unknown, days, asOf)
    };
    return result;
  }
  globalThis.releaseMetrics = { DAY, metrics, calculate, snapshot, partition };
})();
