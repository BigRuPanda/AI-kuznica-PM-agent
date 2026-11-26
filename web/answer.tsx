import { Fragment, type ReactNode } from 'react';
import { hiddenDemoPage } from './tracking-visibility';

function inline(text: string, openMaterial?: (id: string) => void): ReactNode[] {
  const pattern =
    /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\((?:https?:\/\/|#)[^\s)]+\)|(?:https?:\/\/[^\s<>]*\/)?#material\/[a-f0-9]{64})/gi;
  return text.split(pattern).map((part, i) => {
    if (/^(\*\*|__)[^\n]+\1$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2)
      return <em key={i}>{part.slice(1, -1)}</em>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    const link = part.match(/^\[([^\]]+)\]\(((?:https?:\/\/|#)[^\s)]+)\)$/i);
    const href = link?.[2] || part;
    const material = href.match(/#material\/([a-f0-9]{64})$/i);
    const local =
      href.startsWith('#') || (typeof location !== 'undefined' && href.startsWith(location.origin + '/'));
    if (link && local && hiddenDemoPage(href)) return <Fragment key={i}>{link[1]}</Fragment>;
    if (link || (material && local))
      return (
        <a
          key={i}
          href={href}
          rel="noreferrer"
          onClick={(e) => {
            if (material && local && openMaterial && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
              e.preventDefault();
              openMaterial(material[1]);
            }
          }}
        >
          {link?.[1] || 'Открыть материал'}
        </a>
      );
    return <Fragment key={i}>{part}</Fragment>;
  });
}
export function Answer({
  text,
  compact = false,
  openMaterial,
}: {
  text: string;
  compact?: boolean;
  openMaterial?: (id: string) => void;
}) {
  const lines = text.trim().replace(/\r\n?/g, '\n').split('\n');
  if (compact && text.length > 240 && lines.length === 1) {
    const end = text.search(/(?<=[.!?])\s+(?=[А-ЯЁA-Z])/u);
    if (end > 0)
      return (
        <>
          <Answer text={text.slice(0, end)} openMaterial={openMaterial} />
          <details className="message-detail">
            <summary>Подробнее</summary>
            <Answer text={text.slice(end)} openMaterial={openMaterial} />
          </details>
        </>
      );
  }
  const blocks: ReactNode[] = [];
  const list = /^\s*([-*+]|\d+[.)])\s+(.+)/;
  const cells = (s: string) =>
    s
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((v) => v.trim());
  const table = (i: number) =>
    lines[i]?.trim().startsWith('|') && /^\s*\|?\s*:?-{2,}[:\s|-]*$/.test(lines[i + 1] || '');
  for (let i = 0; i < lines.length; ) {
    const key = i,
      line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={key}>
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    if (table(i)) {
      const headers = cells(line),
        rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={key} className="table-scroll">
          <table className="numbers">
            <thead>
              <tr>
                {headers.map((v, k) => (
                  <th key={k}>{inline(v, openMaterial)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, j) => (
                <tr key={j}>
                  {r.map((v, k) => (
                    <td key={k}>{inline(v, openMaterial)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const match = list.exec(line);
    if (match) {
      const Tag = /\d/.test(match[1]) ? 'ol' : 'ul',
        items = [];
      while (i < lines.length) {
        const item = list.exec(lines[i]);
        if (!item || /\d/.test(item[1]) !== (Tag === 'ol')) break;
        i++;
        const content = [item[2]];
        while (i < lines.length && /^\s+\S/.test(lines[i]) && !list.test(lines[i]))
          content.push(lines[i++].trim());
        items.push(<li key={i}>{inline(content.join(' '), openMaterial)}</li>);
      }
      blocks.push(<Tag key={key}>{items}</Tag>);
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      blocks.push(<h4 key={key}>{inline(line.replace(/^#+\s+/, ''), openMaterial)}</h4>);
      i++;
      continue;
    }
    const paragraph = [lines[i++]];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !list.test(lines[i]) &&
      !table(i) &&
      !/^(?:#{1,6}\s|```)/.test(lines[i])
    )
      paragraph.push(lines[i++]);
    blocks.push(<p key={key}>{inline(paragraph.join('\n'), openMaterial)}</p>);
  }
  return (
    <div className="prose">
      {compact && text.length > 240 && blocks.length > 1 ? (
        <>
          {blocks[0]}
          <details>
            <summary>Подробнее</summary>
            {blocks.slice(1)}
          </details>
        </>
      ) : (
        blocks
      )}
    </div>
  );
}
