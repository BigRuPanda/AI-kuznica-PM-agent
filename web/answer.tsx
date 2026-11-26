import {Fragment} from 'react';

// Render the small Markdown subset used in analytical answers as escaped React text.
function inline(text:string){
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((s,i)=>
    s.startsWith('**')?<strong key={i}>{s.slice(2,-2)}</strong>:s.startsWith('`')?<code key={i}>{s.slice(1,-1)}</code>:<Fragment key={i}>{s}</Fragment>);
}
export function Answer({text,compact=false}:{text:string;compact?:boolean}){
  if(compact&&text.length>240&&!/^\s*\|/m.test(text)){
    const first=text.trim().split(/\n\s*\n|(?<=[.!?])\s+(?=[А-ЯЁA-Z])/u)[0];
    const rest=text.trim().slice(first.length).trim();
    if(rest&&!first.startsWith('|'))return <><Answer text={first}/><details className="message-detail"><summary>Подробнее</summary><Answer text={rest}/></details></>;
  }
  return <div className="prose">{text.trim().split(/\n\s*\n/).map((block,i)=>{
    const lines=block.trim().split('\n'),cells=(s:string)=>s.trim().replace(/^\||\|$/g,'').split('|').map(v=>v.trim());
    if(lines.length>2&&lines[0].startsWith('|')&&/^\|?[:\s|-]+\|?$/.test(lines[1]))
      return <div className="table-scroll" key={i}><table className="numbers"><thead><tr>{cells(lines[0]).map((v,j)=><th key={j}>{inline(v)}</th>)}</tr></thead><tbody>{lines.slice(2).map((row,j)=><tr key={j}>{cells(row).map((v,k)=><td key={k}>{inline(v)}</td>)}</tr>)}</tbody></table></div>;
    return <p key={i}>{inline(block)}</p>;
  })}</div>;
}
