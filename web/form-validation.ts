type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const warningId = 'pm-field-warning';

function isField(target: EventTarget | null): target is Field {
  return target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
}

function message(field: Field) {
  const validity = field.validity;
  if (validity.valueMissing) {
    if (field instanceof HTMLSelectElement) return 'Выберите вариант.';
    if (field instanceof HTMLInputElement && field.type === 'file') return 'Выберите файл.';
    return 'Заполните это поле.';
  }
  if (!(field instanceof HTMLSelectElement)) {
    if (validity.tooShort) return 'Минимальная длина — ' + field.minLength + ' симв.';
    if (validity.tooLong) return 'Максимальная длина — ' + field.maxLength + ' симв.';
  }
  if (field instanceof HTMLInputElement) {
    if (validity.rangeUnderflow) return 'Минимальное значение — ' + field.min + '.';
    if (validity.rangeOverflow) return 'Максимальное значение — ' + field.max + '.';
    if (validity.badInput && field.type === 'number') return 'Введите число.';
    if (validity.typeMismatch && field.type === 'email') return 'Введите корректный email.';
  }
  return field.validationMessage || 'Проверьте значение.';
}

export function styleFormValidation() {
  let pending = false;
  let active: { field: Field; warning: HTMLElement; invalid: string | null } | undefined;

  function clear() {
    if (!active) return;
    const { field, warning, invalid } = active;
    warning.remove();
    const describedBy = field.getAttribute('aria-describedby')?.split(/\s+/).filter((id) => id && id !== warningId);
    if (describedBy?.length) field.setAttribute('aria-describedby', describedBy.join(' '));
    else field.removeAttribute('aria-describedby');
    if (invalid == null) field.removeAttribute('aria-invalid');
    else field.setAttribute('aria-invalid', invalid);
    active = undefined;
  }

  document.addEventListener('invalid', (event) => {
    const field = event.target;
    if (!isField(field) || !field.form) return;
    event.preventDefault();
    if (pending) return;
    pending = true;
    // A single submission may dispatch one invalid event per field.
    window.setTimeout(() => {
      pending = false;
      if (!field.isConnected || field.validity.valid) return;
      clear();
      const warning = document.createElement('span');
      warning.className = 'field-warning';
      warning.id = warningId;
      warning.setAttribute('role', 'alert');
      const anchor = field.closest('.composer-row, .compose-field, label') || field;
      anchor.after(warning);
      active = { field, warning, invalid: field.getAttribute('aria-invalid') };
      field.setAttribute('aria-invalid', 'true');
      field.setAttribute('aria-describedby', [field.getAttribute('aria-describedby'), warningId].filter(Boolean).join(' '));
      warning.textContent = message(field);
      field.focus();
      warning.scrollIntoView({ block: 'nearest' });
    }, 0);
  }, true);

  function update(event: Event) {
    if (!active || event.target !== active.field) return;
    if (active.field.validity.valid) clear();
    else {
      const next = message(active.field);
      if (active.warning.textContent !== next) active.warning.textContent = next;
    }
  }

  document.addEventListener('input', update, true);
  document.addEventListener('change', update, true);
  for (const event of ['submit', 'reset']) {
    document.addEventListener(event, (change) => {
      if (active && change.target === active.field.form) clear();
    }, true);
  }
  window.addEventListener('hashchange', clear);
}
