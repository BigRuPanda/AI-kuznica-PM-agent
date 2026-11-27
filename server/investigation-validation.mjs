// These messages are returned to the model and may be displayed in the investigation journal.
// Only use schema paths, fixed constraints and application-authored messages here.
export class InvestigationValidationError extends Error {
  invalidModelResponse = true;
}

function describeIssue(issue) {
  const path = issue.path.join('.') || 'аргументы';
  const unit = issue.origin === 'array' ? 'элементов' : 'символов';
  if (issue.code === 'too_big') return `${path} — максимум ${issue.maximum} ${unit}`;
  if (issue.code === 'too_small') return `${path} — минимум ${issue.minimum} ${unit}`;
  if (issue.code === 'invalid_value') return `${path} — допустимые значения: ${issue.values.join(', ')}`;
  if (issue.code === 'invalid_type') return `${path} — требуется значение типа ${issue.expected}`;
  return `${path} — проверьте формат поля`;
}

export function parseInvestigationArguments(schema, value) {
  let decoded;
  try { decoded = JSON.parse(value); }
  catch { throw new InvestigationValidationError('Аргументы инструмента должны быть корректным JSON.'); }
  const result = schema.safeParse(decoded);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 3).map(describeIssue);
    throw new InvestigationValidationError(issues.join('. ') + '.');
  }
  return result.data;
}
