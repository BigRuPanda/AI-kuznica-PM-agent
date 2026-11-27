const origin = 'http://127.0.0.1:18092';
const reportPath = '/stat/v1/data';
const counter = '78101';
const token = 'pilot-replay';
const productName = 'Пилотный ЛК';
const firstDate = '2026-07-06';
const signalThrough = '2026-08-16';
const recoveryThrough = '2026-09-13';
const day = 86400000;
const report = {
  id:'lk_reco_ctr', numerator:'ym:s:goal1visits', denominator:'ym:s:goal2visits',
  unit:'ratio', dimensions:'ym:s:date,ym:s:deviceCategory',
};

export function pilotMetrikaEnv(env = {}, {product = productName, from = firstDate, through = signalThrough} = {}) {
  const origins = (env.LOCAL_HTTP_ORIGINS || '').split(',').map(part => part.trim()).filter(Boolean);
  return {
    ...env, DATA_PROFILE:'local', LOCAL_HTTP_ORIGINS:[...new Set([...origins, origin])].join(','),
    NOTIFICATION_CHANNELS:env.NOTIFICATION_CHANNELS || 'smtp',
    METRIKA_REPLAY_ORIGIN:origin, METRIKA_COUNTER_IDS:counter, METRIKA_TOKEN:token,
    METRIKA_REPORTS_JSON:JSON.stringify([{...report,product,date1:from,date2:through}]),
  };
}

function desktopClicks(date) {
  if (date <= '2026-08-02') return 8;
  if (date <= '2026-08-09') return 4;
  if (date <= signalThrough) return 3;
  return 6;
}

export function pilotMetrikaTransport(fallback = fetch) {
  return async (url, init) => {
    const request = new URL(url);
    if (request.origin !== origin || request.pathname !== reportPath) return fallback(url, init);
    const q = request.searchParams;
    const from = q.get('date1'), through = q.get('date2');
    const offset = Number(q.get('offset')), limit = Number(q.get('limit'));
    if (init?.headers?.Authorization !== 'OAuth ' + token || q.get('ids') !== counter ||
        q.get('metrics') !== [report.numerator, report.denominator].join(',') ||
        q.get('dimensions') !== report.dimensions || q.has('filters') ||
        !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(through) ||
        !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(through)) ||
        from < firstDate || through > recoveryThrough || from > through ||
        !Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1)
      return Response.json({ error:'Параметры запроса вне сценария пилота.' }, { status:400 });
    const data = [];
    for (let time = Date.parse(from); time <= Date.parse(through); time += day) {
      const date = new Date(time).toISOString().slice(0, 10);
      for (const [device, clicks] of [['desktop', desktopClicks(date)], ['mobile', 8]]) {
        data.push({ dimensions:[{ name:date }, { name:device }], metrics:[clicks, 100] });
      }
    }
    // A short page exercises the real connector's offset tracking on the local stand.
    return Response.json({ data:data.slice(offset - 1, offset - 1 + Math.min(limit, 25)),
      total_rows:data.length, total_rows_rounded:false, sampled:false, sample_share:1, data_lag:0 });
  };
}
