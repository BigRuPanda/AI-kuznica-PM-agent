export function positionPopover(popup: HTMLElement, trigger: HTMLElement, boundary?: HTMLElement | null) {
  const bounds = trigger.getBoundingClientRect();
  const { clientWidth, clientHeight } = document.documentElement;
  const area = boundary?.getBoundingClientRect();
  const leftEdge = Math.max(8, area?.left ?? 8);
  const rightEdge = Math.min(clientWidth - 8, area?.right ?? clientWidth - 8);
  if (area) popup.style.maxWidth = Math.max(0, Math.floor(rightEdge - leftEdge)) + 'px';
  const top = bounds.bottom + popup.offsetHeight + 12 <= clientHeight
    ? bounds.bottom + 4
    : Math.max(8, bounds.top - popup.offsetHeight - 4);
  const left = Math.max(leftEdge, Math.min(bounds.right - popup.offsetWidth, rightEdge - popup.offsetWidth));
  popup.style.top = top + 'px';
  popup.style.left = left + 'px';
}
