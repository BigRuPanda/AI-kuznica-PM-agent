import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ChatMenu, type ChatAction } from './chat-menu';
import { Icon } from './icons';
import type { Thread } from './team-data';

type Placement = { top: number; left: number; width: number; wrap: boolean };

export function ChatThreadRow({ thread, current, onSelect, onAction, menuTrigger }: {
  thread: Thread;
  current: boolean;
  onSelect: () => void;
  onAction: (thread: Thread, action: ChatAction) => void;
  menuTrigger?: RefObject<HTMLButtonElement | null>;
}) {
  const [hovered, setHovered] = useState(false);
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [touched, setTouched] = useState(false);
  const [placement, setPlacement] = useState<Placement>();
  const slot = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const measurement = useRef<HTMLSpanElement>(null);
  const highlighted = !touched && (hovered || keyboardFocused || menuOpen);
  const { wrap, ...position } = placement ?? {};

  useLayoutEffect(() => {
    const anchor = slot.current;
    const list = anchor?.closest('.thread-list');
    const item = row.current;
    const title = label.current;
    const words = measurement.current;
    if (!highlighted || !anchor || !list || !item || !title || !words) {
      setPlacement(undefined);
      return;
    }
    const align = () => {
      const origin = anchor.getBoundingClientRect();
      const viewport = list.getBoundingClientRect();
      if (origin.top < viewport.top - 1 || origin.bottom > viewport.bottom + 1) {
        setPlacement(undefined);
        return;
      }
      const chrome = item.getBoundingClientRect().width - title.getBoundingClientRect().width;
      const naturalWidth = Math.ceil(words.scrollWidth + chrome);
      if (naturalWidth <= origin.width + 1) {
        setPlacement(undefined);
        return;
      }
      const width = Math.min(naturalWidth, document.documentElement.clientWidth - origin.left - 12);
      const wrap = naturalWidth > width;
      setPlacement(previous => previous?.top === origin.top && previous.left === origin.left &&
        previous.width === width && previous.wrap === wrap ? previous : { top: origin.top, left: origin.left, width, wrap });
    };
    const observer = new ResizeObserver(align);
    observer.observe(anchor);
    list.addEventListener('scroll', align, { passive: true });
    window.addEventListener('scroll', align, { passive: true });
    window.addEventListener('resize', align);
    align();
    return () => {
      observer.disconnect();
      list.removeEventListener('scroll', align);
      window.removeEventListener('scroll', align);
      window.removeEventListener('resize', align);
    };
  }, [highlighted, thread.title, thread.canRename, thread.canDelete]);

  return (
    <div ref={slot} className="thread-slot">
      <div ref={row} className="thread-row" data-expanded={!!placement} style={position}
        onPointerEnter={event => {
          if (event.pointerType === 'touch') return;
          setTouched(false);
          setHovered(true);
        }}
        onPointerDownCapture={event => {
          if (event.pointerType === 'touch' && !placement) setTouched(true);
        }}
        onKeyDownCapture={event => { if (event.key === 'Tab') setTouched(false); }}
        onPointerLeave={() => setHovered(false)}
        onFocus={event => setKeyboardFocused(event.target.matches(':focus-visible'))}
        onBlur={event => {
          if (event.currentTarget.contains(event.relatedTarget)) return;
          setKeyboardFocused(false);
          setTouched(false);
        }}>
        <a aria-current={current ? 'page' : undefined} href={'#chats/' + thread.id}
          onClick={event => {
            if (event.detail > 0) setKeyboardFocused(false);
            onSelect();
          }}>
          <span className="thread-icon"><Icon name={thread.scope === 'group' ? 'people' : 'chat'} /></span>
          <span ref={label} className="thread-title" data-wrap={wrap} title={placement ? undefined : thread.title}>
            {thread.title}
          </span>
          {highlighted && <span ref={measurement} className="sr thread-title-measure" aria-hidden="true">{thread.title}</span>}
        </a>
        <ChatMenu thread={thread} onAction={onAction} onOpenChange={setMenuOpen} triggerRef={menuTrigger} />
      </div>
    </div>
  );
}
