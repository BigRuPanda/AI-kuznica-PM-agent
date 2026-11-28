import { ChatPopupMenu } from './chat-menu';
import { Icon } from './icons';
import type { Case } from './team-data';

const manualStates = ['Исследуем', 'Нужно решение', 'Завершено'] as const;
export type ManualCaseState = typeof manualStates[number];

export function CaseStatusMenu({ state, busy, releaseLinked, onSelect }: {
  state: Case['state'];
  busy: boolean;
  releaseLinked: boolean;
  onSelect: (state: ManualCaseState) => void;
}) {
  const label = 'Изменить статус';
  const manualCurrent = manualStates.some(option => option === state);
  return <ChatPopupMenu label={label} triggerLabel={label + '. Сейчас «' + state + '»'}
    triggerTitle={releaseLinked ? label : null} triggerClass="state case-status-trigger"
    triggerContent={<>{state}<Icon name="down" /></>} disabled={busy} menuClass="case-status-menu">
    {close => <>
      {!manualCurrent && <button type="button" role="menuitemradio" aria-checked="true" aria-disabled="true">
        {state}<Icon name="check" />
      </button>}
      {manualStates.map(option => (
        <button key={option} type="button" role="menuitemradio" aria-checked={option === state} onClick={() => {
          close();
          if (option !== state) onSelect(option);
        }}>
          {option}{option === state && <Icon name="check" />}
        </button>
      ))}
    </>}
  </ChatPopupMenu>;
}
