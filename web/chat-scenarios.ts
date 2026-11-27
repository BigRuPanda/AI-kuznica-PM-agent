export type ScenarioDraft = { text: string; scenarioId: string | null };
export const chatScenarios = [
  {
    id: 'demand', label: 'Найти упущенный спрос',
    prompt: 'Найди по конкурентному исследованию возможность для Store: товар есть в ассортименте, покупатели его ищут, а конкуренты заметнее в поиске. Покажи конкретные запросы, частоту и позиции со ссылками на источник. Сверь с бэклогом и предложи одну задачу или дополнение к существующей.',
  },
  {
    id: 'triage', label: 'Выбрать, что проверить сегодня',
    prompt: 'Посмотри открытые сигналы и выбери один, с которого стоит начать сегодня. Покажи, что изменилось, как долго это продолжается и насколько полны данные. Объясни, почему этот сигнал важнее остальных, и предложи первый шаг проверки.',
  },
  {
    id: 'funnel', label: 'Найти потери в воронке',
    prompt: 'Проверь воронку подбора для продукта, который мы обсуждаем. Покажи объём на каждом измеренном шаге и единицу измерения, где потеря самая большая и отличается ли она на телефонах и компьютерах. Отметь шаги, для которых не хватает событий. Если продукт ещё не назван, уточни его.',
  },
  {
    id: 'hypothesis', label: 'Проверить гипотезу',
    prompt: 'Проверь гипотезу из нашей переписки по метрикам, интервью и релизам. Если гипотеза ещё не сформулирована, попроси меня её назвать. Приведи самое сильное свидетельство в её пользу и самое сильное возражение со ссылками на источники. Какую одну проверку стоит провести, чтобы решить, брать ли задачу в работу?',
  },
  {
    id: 'release', label: 'Проверить эффект релиза',
    prompt: 'Сравни целевую метрику до и после релиза, проверь контроль и полноту периода. Если из переписки неясно, о каком релизе идёт речь, уточни его. Сопоставь результат с согласованным критерием успеха, если он задан. Порекомендуй завершить наблюдение, продолжить его или пересмотреть гипотезу. Если данных пока мало, укажи, чего ждём.',
  },
] as const;

export function selectScenario(draft: ScenarioDraft, scenarioId: string): ScenarioDraft {
  const next = chatScenarios.find(s => s.id === scenarioId);
  if (!next || (draft.text && scenarioId === draft.scenarioId)) return draft;
  const previous = chatScenarios.find(s => s.id === draft.scenarioId);
  let detail = draft.text;
  if (previous && detail.startsWith(previous.prompt)) {
    detail = detail.slice(previous.prompt.length).replace(/^\n\n/, '');
  }
  return {text: detail ? next.prompt + '\n\n' + detail : next.prompt, scenarioId};
}

// Old drafts are plain textarea strings, including arbitrary JSON copied by users.
const storagePrefix = '\u0000pm-scenario-v1\n';

export function serializeScenarioDraft(draft: ScenarioDraft): string {
  if (draft.scenarioId === null && !draft.text.startsWith(storagePrefix)) return draft.text;
  return storagePrefix + JSON.stringify(draft);
}

export function loadScenarioDraft(stored: string | null, pendingText: string): ScenarioDraft {
  const text = stored || pendingText;
  if (stored?.startsWith(storagePrefix)) {
    try {
      const value = JSON.parse(stored.slice(storagePrefix.length));
      if (typeof value?.text === 'string') {
        const scenario = chatScenarios.find(s => s.id === value.scenarioId);
        return {text: value.text, scenarioId: scenario?.id ?? null};
      }
    } catch { /* Keep an unrecognized record as editable text. */ }
  }
  return {text, scenarioId: null};
}
