import type { RefObject } from 'react';
import { ChatMenu, type ChatAction } from './chat-menu';
import { Icon } from './icons';
import type { Thread } from './team-data';

export function ChatThreadRow({ thread, current, onSelect, onAction, menuTrigger }: {
  thread: Thread;
  current: boolean;
  onSelect: () => void;
  onAction: (thread: Thread, action: ChatAction) => void;
  menuTrigger?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div className="thread-row">
      <a aria-current={current ? 'page' : undefined} href={'#chats/' + thread.id} onClick={onSelect}>
        <span className="thread-icon"><Icon name={thread.scope === 'group' ? 'people' : 'chat'} /></span>
        <span className="thread-title">{thread.title}</span>
      </a>
      <ChatMenu thread={thread} onAction={onAction} triggerRef={menuTrigger} />
    </div>
  );
}
