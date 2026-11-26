import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './icons';
import type { Thread } from './team-data';

export type ChatAction = 'rename' | 'delete';

export function ChatMenu({ thread, onAction }: {
  thread: Thread;
  onAction: (thread: Thread, action: ChatAction) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      const menu = popup.current;
      if (menu?.matches(':popover-open')) menu.hidePopover();
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  if (!thread.canRename && !thread.canDelete) return null;

  function show(last = false) {
    const menu = popup.current;
    const anchor = trigger.current;
    if (!menu || !anchor) return;
    if (!menu.matches(':popover-open')) menu.showPopover();
    const bounds = anchor.getBoundingClientRect();
    const { clientWidth, clientHeight } = document.documentElement;
    const top = bounds.bottom + menu.offsetHeight + 12 <= clientHeight
      ? bounds.bottom + 4
      : Math.max(8, bounds.top - menu.offsetHeight - 4);
    const left = Math.max(8, Math.min(bounds.right - menu.offsetWidth, clientWidth - menu.offsetWidth - 8));
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';
    const items = menu.querySelectorAll<HTMLButtonElement>('button');
    items[last ? items.length - 1 : 0]?.focus({ preventScroll: true });
  }

  function close() {
    if (popup.current?.matches(':popover-open')) popup.current.hidePopover();
    trigger.current?.focus({ preventScroll: true });
  }

  function run(action: ChatAction) {
    close();
    onAction(thread, action);
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="thread-menu-trigger"
        aria-label={'Действия чата «' + thread.title + '»'}
        title="Действия чата"
        aria-haspopup="menu"
        aria-controls={id}
        aria-expanded={open}
        popoverTarget={id}
        onClick={(event) => {
          event.preventDefault();
          if (popup.current?.matches(':popover-open')) close();
          else show();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          show(event.key === 'ArrowUp');
        }}
      >
        <Icon name="more" />
      </button>
      <div
        ref={popup}
        id={id}
        popover="auto"
        role="menu"
        aria-label="Действия чата"
        className="thread-menu"
        onToggle={(event) => setOpen(event.newState === 'open')}
        onBlur={(event) => {
          if (event.relatedTarget !== trigger.current && !event.currentTarget.contains(event.relatedTarget)
            && event.currentTarget.matches(':popover-open')) {
            event.currentTarget.hidePopover();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
            return;
          }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus({ preventScroll: true });
        }}
      >
        {thread.canRename && (
          <button type="button" role="menuitem" onClick={() => run('rename')}><Icon name="edit" />Переименовать</button>
        )}
        {thread.canDelete && (
          <button type="button" role="menuitem" className="thread-menu-delete" onClick={() => run('delete')}>
            <Icon name="trash" />Удалить чат
          </button>
        )}
      </div>
    </>
  );
}
