import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Icon } from './icons';
import type { Thread } from './team-data';

export type ChatAction = 'rename' | 'delete';

export function ChatMenu({ thread, onAction, onOpenChange, triggerRef }: {
  thread: Thread;
  onAction: (thread: Thread, action: ChatAction) => void;
  onOpenChange?: (open: boolean) => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  if (!thread.canRename && !thread.canDelete) return null;
  return (
    <ChatPopupMenu label="Действия чата" triggerLabel={'Действия чата «' + thread.title + '»'} triggerContent={<Icon name="more" />}
      triggerClass="thread-menu-trigger" onOpenChange={onOpenChange} triggerRef={triggerRef}>
      {close => <>
        {thread.canRename && (
          <button type="button" role="menuitem" onClick={() => { close(); onAction(thread, 'rename'); }}><Icon name="edit" />Переименовать</button>
        )}
        {thread.canDelete && (
          <button type="button" role="menuitem" className="thread-menu-delete" onClick={() => { close(); onAction(thread, 'delete'); }}>
            <Icon name="trash" />Удалить чат
          </button>
        )}
      </>}
    </ChatPopupMenu>
  );
}

export function ChatPopupMenu({ label, triggerLabel = label, triggerContent, triggerClass, triggerRef, menuClass = '', hint, onOpenChange, children }: {
  label: string;
  triggerLabel?: string;
  triggerContent: ReactNode;
  triggerClass: string;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  menuClass?: string;
  onOpenChange?: (open: boolean) => void;
  hint?: string;
  children: (close: () => void) => ReactNode;
}) {
  const id = useId();
  const ownTrigger = useRef<HTMLButtonElement>(null);
  const trigger = triggerRef ?? ownTrigger;
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

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={triggerClass}
        aria-label={triggerLabel}
        title={hint ? undefined : label}
        data-ui-hint={hint}
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
        {triggerContent}
      </button>
      <div
        ref={popup}
        id={id}
        popover="auto"
        role="menu"
        aria-label={label}
        className={'thread-menu ' + menuClass}
        onToggle={(event) => {
          const active = event.newState === 'open';
          setOpen(active);
          onOpenChange?.(active);
        }}
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
        {children(close)}
      </div>
    </>
  );
}
