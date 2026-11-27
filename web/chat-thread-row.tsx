import { useLayoutEffect, useRef, useState } from 'react';
import { ChatMenu, type ChatAction } from './chat-menu';
import { Icon } from './icons';
import type { Thread } from './team-data';

type Placement = { top: number; left: number; width: number };

export function ChatThreadRow({ thread, current, onSelect, onAction }: {
  thread: Thread;
  current: boolean;
  onSelect: () => void;
  onAction: (thread: Thread, action: ChatAction) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [touched, setTouched] = useState(false);
  const [placement, setPlacement] = useState<Placement>();
  const slot = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const highlighted = !touched && (hovered || focused || menuOpen);

  useLayoutEffect(() => {
    const anchor = slot.current;
    const list = anchor?.parentElement;
    const item = row.current;
    const title = label.current;
    const words = text.current;
    if (!highlighted || !anchor || !list || !item || !title || !words) {
      setPlacement(undefined);
      return;
    }
    const wide = matchMedia('(min-width: 821px)');
    const align = () => {
      const origin = anchor.getBoundingClientRect();
      const viewport = list.getBoundingClientRect();
      if (!wide.matches || origin.top < viewport.top - 1 || origin.bottom > viewport.bottom + 1) {
        setPlacement(undefined);
        return;
      }
      const chrome = item.getBoundingClientRect().width - title.getBoundingClientRect().width;
      const width = Math.min(Math.ceil(words.getBoundingClientRect().width + chrome),
        document.documentElement.clientWidth - origin.left - 12);
      if (width <= origin.width + 1) {
        setPlacement(undefined);
        return;
      }
      setPlacement(previous => previous?.top === origin.top && previous.left === origin.left && previous.width === width
        ? previous : { top: origin.top, left: origin.left, width });
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
      <div ref={row} className="thread-row" data-expanded={!!placement} style={placement}
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
        onFocus={() => setFocused(true)}
        onBlur={event => {
          if (event.currentTarget.contains(event.relatedTarget)) return;
          setFocused(false);
          setTouched(false);
        }}>
        <a aria-current={current ? 'page' : undefined} href={'#chats/' + thread.id} onClick={onSelect}
          onKeyDown={event => {
            const title = label.current;
            if (!placement || !title || title.scrollWidth <= title.clientWidth ||
                event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
                !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
            event.preventDefault();
            title.scrollBy({ left: event.key === 'ArrowLeft' ? -48 : 48 });
          }}>
          <span className="thread-icon"><Icon name={thread.scope === 'group' ? 'people' : 'chat'} /></span>
          <span ref={label} className="thread-title" title={placement ? undefined : thread.title}>
            <span ref={text} className="thread-title-text">{thread.title}</span>
          </span>
        </a>
        <ChatMenu thread={thread} onAction={onAction} onOpenChange={setMenuOpen} />
      </div>
    </div>
  );
}
