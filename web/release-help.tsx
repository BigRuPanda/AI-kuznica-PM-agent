export const releaseCutHelp = 'Показывает данные, доступные к выбранной дате.';

export function ReleaseHelp({ text }: { text: string }) {
  return <span className="release-help" role="img" aria-label={text} title={text}>?</span>;
}
