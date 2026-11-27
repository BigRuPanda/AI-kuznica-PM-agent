import { ChatPopupMenu } from './chat-menu';
import { chatScenarios } from './chat-scenarios';
import { Icon } from './icons';

export function ChatScenarioMenu({onSelect}: {onSelect: (scenarioId: string) => void}) {
  return (
    <ChatPopupMenu label="Сценарии" triggerContent={<>Сценарии <Icon name="down" /></>}
      triggerClass="scenario-trigger" menuClass="scenario-menu">
      {close => chatScenarios.map(scenario => (
        <button type="button" role="menuitem" key={scenario.id} onClick={() => {
          close();
          onSelect(scenario.id);
        }}>{scenario.label}</button>
      ))}
    </ChatPopupMenu>
  );
}
