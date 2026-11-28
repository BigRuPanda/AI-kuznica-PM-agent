const sources = [
  ['sales','salesVersions','$.week_start'],
  ['metrics','metricVersions','$.date'],
  ['releases','releaseVersions','$.release_date'],
  ['backlog','backlogVersions','$.created_date'],
  ['dictionary','dictionaryVersions',null],
];

export function checkReleaseSourceVersions(db, snapshot, through) {
  const read = db.prepare('SELECT DISTINCT version FROM facts WHERE kind=? AND ' +
    '(json_extract(body,?) IS NULL OR json_extract(body,?)<=?)');
  for (const [kind,key,date] of sources) {
    const allowed = snapshot[key];
    if (allowed && read.all(kind,date,date,through).some(row=>!allowed.includes(row.version)))
      throw Error('В выбранном срезе нет подтверждённых версий для нового расчёта. Откройте актуальный разбор релиза.');
  }
}

export function checkReleaseReferencePeriod(ref, {from,through}) {
  const after = Date.parse(through) + 86400000;
  const before = Date.parse(from);
  const end = ref.cut || ref.asOf || ref.through;
  const start = ref.base || ref.from;
  const points = Array.isArray(ref.points) ? ref.points : [];
  if (end && end > through || from && start && start < from ||
      ref.ranges?.some(r=>r.to > after || from && r.from < before) ||
      points.some(p=>p.date > through || from && p.date < from))
    throw Error('Выбранный материал выходит за границы среза релиза.');
}
