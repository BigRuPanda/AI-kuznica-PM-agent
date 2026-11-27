// Design coordinates are 96 px/in on a 13 1/3 by 7 1/2 inch slide.
export const W=1280, H=720;
export const ink='24262B', muted='565D67', accent='A20C33', pale='F5F1F2', rule='DAD9DA';
export const palette=[accent,'315F76','9B681E','526942','755777','447B75'];
const unitWidth=c=> /[ilI1.,:;!|'\sтг]/u.test(c) ? .35 : /[ШЩЖЮМW@%]/u.test(c) ? .91 : /[A-ZА-Я0-9]/u.test(c) ? .69 : .61;
function width(s,size) {return [...s].reduce((v,c)=>v+unitWidth(c)*size,0);}
export function wrap(text,size,available) {
  const out=[];
  for(const paragraph of String(text ?? '').split(/\r?\n/u)) {
    let line='';
    for(const word of paragraph.trim().split(/[^\S\u00a0\u202f]+/u)) {
      if(width(line+(line?' ':'')+word,size)<=available) {line+=(line?' ':'')+word;continue;}
      if(line) {out.push(line);line='';}
      for(const c of word) {if(line && width(line+c,size)>available) {out.push(line);line='';} line+=c;}
    }
    out.push(line);
  }
  return out;
}
function short(text,size,w,limit) {
  const lines=wrap(text,size,w);
  if(lines.length<=limit) return lines;
  const last=lines[limit-1].replace(/[.,:;\s]+$/u,'');
  return [...lines.slice(0,limit-1),last.slice(0,-1)+'…'];
}
const chunks=(a,n)=>Array.from({length:Math.ceil(a.length/n)},(_,i)=>a.slice(i*n,(i+1)*n));
const cellFont=19;
function colWidths(cols) {
  if(cols===1) return [1152];
  if(cols===2) return [325,827];
  if(cols===3) return [172,310,670];
  return Array(cols).fill(1152/cols);
}
function paginateTable(slide) {
  const pages=[];
  // Very wide tables repeat the identifying column on each horizontal panel.
  const panels=slide.columns.length<=5 ? [slide.columns.map((_,i)=>i)] :
    chunks(slide.columns.map((_,i)=>i).slice(1),4).map(ids=>[0,...ids]);
  for(const ids of panels) {
    const columns=ids.map(i=>slide.columns[i]), widths=colWidths(ids.length);
    const headerH=Math.max(48,...columns.map((v,i)=>wrap(v,cellFont,widths[i]-26).length*25+20));
    const capacity=Math.max(5,Math.floor((440-headerH-16)/25));
    let table=[], heights=[], refs=[], used=headerH;
    const flush=()=>{if(table.length) pages.push({...slide,columns,rows:table,widths,heights,headerH,refs:refs.length?refs:slide.refs});
      table=[];heights=[];refs=[];used=headerH;};
    slide.rows.forEach((r,ri)=>{
      const lines=ids.map((id,i)=>wrap(r[id],cellFont,widths[i]-26));
      const count=Math.max(...lines.map(v=>v.length));
      for(let offset=0;offset<count;offset+=capacity) {
        const cells=lines.map(v=>v.slice(offset,offset+capacity).join('\n'));
        const h=Math.max(48,Math.min(capacity,count-offset)*25+18);
        if(used+h>440) flush();
        table.push(cells);heights.push(h);used+=h;
        refs.push(...(slide.rowRefs?.[ri] || []));
      }
    });
    flush();
  }
  return pages;
}
function paginate(slide) {
  if(slide.kind==='table' || slide.kind==='log') return paginateTable(slide);
  if(slide.kind==='flow') return chunks(slide.steps,3).map(steps=>({...slide,steps}));
  if(slide.kind==='funnel') {
    const col=slide.columns.indexOf('Период');
    const periods=col<0?['']:[...new Set(slide.rows.map(r=>r[col]))];
    return periods.flatMap(p=>chunks(slide.rows.filter(r=>col<0 || r[col]===p),6)
      .map(rows=>({...slide,title:slide.title+(p?' · период '+p:''),rows})));
  }
  if(slide.kind==='chart') return chunks(slide.series,3).map(series=>({...slide,series}));
  if(slide.kind==='quote' || slide.kind==='finding') {
    return chunks(wrap(slide.body,32,1060),8).map(lines=>({...slide,body:lines.join('\n')}));
  }
  return [slide];
}
export function assembleDeck(input, selection) {
  const chosen=selection.map(({index,heading})=>({...input.candidates[index],title:heading || input.candidates[index].title}));
  const appendix=input.checks.length ? [{kind:'log',title:'Ход разбора',columns:['Дата','Этап','Результат'],
    rows:input.checks.map(s=>[s.date || 'Дата не записана',s.stage,s.result]),rowRefs:input.checks.map(s=>s.refs),refs:[]}] : [];
  const logical=[input.cover,...chosen,input.decision,...appendix];
  const refs=[...new Map(logical.flatMap(s=>[...(s.refs || []),...(s.rowRefs || []).flat()]).map(r=>[r.url,r])).values()];
  const pages=chosen.map(paginate);
  const slides=[input.cover,...pages.flatMap(group=>group.slice(0,1)),input.decision,
    ...appendix.flatMap(paginate).map((s,i)=>({...s,continuation:i>0})),
    ...pages.flatMap(group=>group.slice(1).map(s=>({...s,continuation:true})))];
  if(refs.length) {
    const groups=new Map();
    for(const ref of refs) {
      const cell=ref.label.match(/^(.*)!([A-Z]+\d+)$/u);
      const key=cell?ref.url.split('/')[1]+'/'+cell[1]:ref.url;
      if(!groups.has(key)) groups.set(key,{title:cell?cell[1]:ref.label,cells:[]});
      groups.get(key).cells.push({...ref,short:cell?cell[2]:null});
    }
    const rows=[...groups.values()].flatMap(g=>chunks(g.cells,9).map(cells=>({title:g.title,cells})));
    for(const group of chunks(rows,5)) slides.push({kind:'sources',title:'Источники разбора',groups:group,refs:[]});
  }
  return {product:input.product,title:input.title,created:input.created,state:input.state,slides};
}
export function chartData(series) {
  const labels=[...new Set(series.flatMap(s=>s.points.map(p=>p.label)))].sort();
  return {labels,series:series.map(s=>{const values=new Map(s.points.map(p=>[p.label,p.value]));
    return {name:s.name,values:labels.map(l=>values.get(l) ?? null)};})};
}
export function composeSlide(deck, index) {
  const s=deck.slides[index], objects=[];
  const rect=(x,y,w,h,color)=>objects.push({type:'rect',x,y,w,h,color});
  const text=(value,x,y,w,size,opt={})=>{
    const lines=opt.lines || short(value,size,w,opt.limit || 3);
    objects.push({type:'text',x,y,w,h:lines.length*size*1.26+5,size,lines,color:ink,...opt});
  };
  objects.push({type:'logo',x:64,y:30,w:162,h:41});
  text(deck.product,590,42,626,17,{align:'right',color:muted,limit:1});
  rect(64,84,1152,1,rule);
  if(s.kind==='cover') {
    text(deck.state+'   /   '+new Date(deck.created).toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow'}),64,117,1130,19,{color:accent,bold:true});
    text(s.title.replace(/(\d)[ \u00a0\u202f]+%/gu,'$1\u00a0%'),64,167,s.keyValue?820:1128,47,{bold:true,limit:4});
    if(s.keyValue) {
      rect(946,176,4,159,accent);
      const size=Math.min(58,Math.max(25,Math.floor(240/width(s.keyValue,1))));
      text(s.keyValue,973,176,242,size,{bold:true,color:accent,limit:1});
      text(s.keyLabel,974,257,240,20,{color:muted,limit:3});
    }
    if(s.body!==s.title) text(s.body,64,425,1070,23,{limit:2,color:muted});
    rect(64,511,1152,123,pale);
    text(s.decisionTitle || 'Решение',86,526,225,17,{color:accent,bold:true});
    text(s.decision,86,558,1095,23,{limit:2});
  } else {
    text(s.title+(s.continuation?' · продолжение':''),64,105,1152,37,{bold:true,limit:2});
    if(s.kind==='chart') {
      text(s.unit || 'Значение',64,203,1125,18,{color:muted,limit:1});
      objects.push({type:'chart',x:68,y:244,w:1144,h:s.event?310:381,data:chartData(s.series),unit:s.unit,
        style:s.style || (s.series.every(l=>l.points.length<=2)?'bar':'line')});
      if(s.event) {
        rect(64,563,4,62,accent);
        text(s.event.date+'  ·  '+s.event.text,83,566,1124,19,{limit:2});
      }
    } else if(s.kind==='table' || s.kind==='log') {
      objects.push({type:'table',x:64,y:201,w:1152,h:s.headerH+s.heights.reduce((a,b)=>a+b,0),
        widths:s.widths,heights:[s.headerH,...s.heights],rows:[s.columns,...s.rows],size:cellFont});
    } else if(s.kind==='funnel') {
      const amount=s.columns.indexOf('Дошли'), label=s.columns.indexOf('Шаг');
      const values=s.rows.map(r=>Number(String(r[amount]).replace(/\s/g,'')));
      const max=Math.max(1,...values.filter(Number.isFinite));
      s.rows.forEach((row,i)=>{const y=218+i*65;
        text('Шаг '+row[label],64,y,184,22,{limit:1});rect(252,y+2,730,25,'F1ECEE');
        if(values[i]>0) rect(252,y+2,730*values[i]/max,25,accent);
        text(row[amount],1000,y,205,23,{align:'right',bold:true,limit:1});});
    } else if(s.kind==='flow') {
      s.steps.forEach((step,i)=>{const y=214+i*133;
        if(i+1<s.steps.length) rect(82,y+31,2,103,rule);
        rect(73,y+6,21,21,accent);text(step.label,112,y,242,22,{bold:true,color:accent,limit:2});
        text(step.text,366,y,829,24,{limit:3});});
    } else if(s.kind==='sources') {
      const groups=s.groups || (s.links || []).map(r=>({title:r.label,cells:[r]}));
      groups.forEach((g,i)=>{const compact=!s.groups, y=205+i*(compact?60:86),cellGroup=g.cells[0].short;
        rect(64,y+(compact?46:75),1152,1,rule);
        text(g.title,66,y,1144,21,{url:cellGroup?undefined:g.cells[0].url,color:cellGroup?ink:accent,limit:1});
        if(cellGroup) g.cells.forEach((r,j)=>text(r.short,66+j*125,y+34,117,18,{url:r.url,color:accent,limit:1}));});
    } else if(s.kind==='decision') {
      rect(64,214,6,115,accent);text(s.body,92,211,1090,32,{bold:true,limit:3});
      (s.rows || []).slice(0,4).forEach(([label,value],i)=>{const y=363+i*65;
        text(label,64,y,268,18,{color:muted});text(value,340,y,871,20,{limit:2});});
    } else {
      rect(64,218,6,Math.min(345,Math.max(110,wrap(s.body,32,1060).length*41)),accent);
      text(s.body,99,216,1060,32,{lines:String(s.body).split('\n'),color:ink,limit:8});
    }
  }
  rect(64,654,1152,1,rule);
  const refs=[...new Map((s.refs || []).map(r=>[r.url,r])).values()];
  if(refs.length) text(refs[0].label+(refs.length>1?'  ·  Ещё '+(refs.length-1)+' в источниках':''),64,671,984,15,{url:refs[0].url,color:muted,limit:1});
  text((index+1)+' / '+deck.slides.length,1060,670,156,16,{align:'right',color:muted,limit:1});
  return objects;
}
