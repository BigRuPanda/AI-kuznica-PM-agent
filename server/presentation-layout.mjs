import { compactPresentationVersion } from './presentation-story.mjs';

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
const cellFont=19;

export function chartData(series) {
  const labels=[...new Set(series.flatMap(s=>s.points.map(p=>p.label)))].sort();
  return {labels,series:series.map(s=>{const values=new Map(s.points.map(p=>[p.label,p.value]));
    return {name:s.name,values:labels.map(l=>values.get(l) ?? null)};})};
}
export function composeSlide(deck, index) {
  if(deck.formatVersion===compactPresentationVersion) return composeCompactSlide(deck,index);
  return composeLegacySlide(deck,index);
}

function composeLegacySlide(deck, index) {
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
    text(deck.state==='Завершено'?'Решение':'Следующий шаг',86,526,225,17,{color:accent,bold:true});
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

const graphite='24252C', panel='30313A', paper='F7F6F3', white='FFFFFF';
const lightMuted='D0D0D7', pink='FF9AB0', gutter=72, contentWidth=W-2*gutter;
const dateFormat=new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',year:'numeric',timeZone:'Europe/Moscow'});

function fittedLines(value,size,available,limit) {
  const lines=wrap(String(value ?? '').replace(/(\d)[ \u00a0\u202f]+%/gu,'$1\u00a0%'),size,available);
  if(lines.length<=limit) return lines;
  const clipped=lines.slice(0,limit);
  let last=clipped.at(-1).trimEnd();
  while(last && width(last+'…',size)>available) last=last.replace(/\s*\S+$/u,'');
  clipped[limit-1]=last+'…';
  return clipped;
}

function composeCompactSlide(deck,index) {
  const slide=deck.slides[index], objects=[];
  const dark=slide.kind==='cover' || slide.kind==='decision';
  const fg=dark?white:ink, quiet=dark?lightMuted:muted, highlight=dark?pink:accent;
  const rect=(x,y,w,h,color)=>objects.push({type:'rect',x,y,w,h,color});
  const text=(value,x,y,w,size,{limit=2,color=fg,bold=false,align,url}={})=>{
    if(value===undefined || value===null || value==='') return;
    const lines=fittedLines(value,size,w,limit), leading=1.22;
    objects.push({type:'text',x,y,w,h:lines.length*size*leading+4,size,leading,lines,color,bold,align,url});
  };

  rect(0,0,W,H,dark?graphite:paper);
  objects.push({type:'logo',x:gutter,y:35,w:139,h:35,dark});
  text(deck.product,560,42,648,18,{color:quiet,align:'right',limit:1});
  rect(gutter,89,contentWidth,1,dark?'4D4F5A':rule);

  if(slide.kind==='cover') {
    const hasValue=Boolean(slide.keyValue);
    text(deck.state+'  ·  '+dateFormat.format(deck.created),gutter,125,820,19,{color:highlight,bold:true,limit:1});
    const headingWidth=hasValue?692:contentWidth;
    const scales=[{size:58,lines:3},{size:50,lines:3},{size:44,lines:4},{size:40,lines:4}];
    const heading=scales.find(({size,lines})=>wrap(slide.title,size,headingWidth).length<=lines) || scales.at(-1);
    text(slide.title,gutter,184,headingWidth,heading.size,{bold:true,limit:heading.lines});
    if(slide.body!==slide.title) text(slide.body,gutter,430,hasValue?682:1040,27,{color:quiet,limit:3});
    if(hasValue) {
      rect(805,184,403,348,panel);
      rect(805,184,6,348,pink);
      const size=Math.min(82,Math.max(26,Math.floor(319/width(slide.keyValue,1))));
      text(slide.keyValue,837,232,331,size,{bold:true,limit:1});
      text(slide.keyUnit,839,340,324,23,{color:highlight,bold:true,limit:1});
      text(slide.keyLabel,839,382,324,24,{bold:true,limit:2});
      text(slide.keyPeriod,839,466,324,17,{color:quiet,limit:1});
    } else {
      rect(gutter,582,104,5,pink);
    }
  } else if(slide.kind==='decision') {
    text(slide.title,gutter,126,contentWidth,34,{color:highlight,bold:true,limit:1});
    const decisionText=String(slide.body ?? '');
    text(decisionText,gutter,190,1094,46,{bold:true,limit:4});
    const rows=(slide.rows || []).slice(0,4);
    rows.forEach(([label,value],i)=>{
      const x=gutter+(i%2)*577, y=430+Math.floor(i/2)*96;
      rect(x,y,557,85,panel);
      text(label,x+18,y+9,525,16,{color:highlight,bold:true,limit:1});
      text(value,x+18,y+34,525,20,{color:white,limit:2});
    });
  } else {
    const heading=slide.kind==='finding' && slide.subject && slide.body===slide.title ? slide.subject : slide.title;
    text(heading,gutter,115,contentWidth,46,{bold:true,limit:2});
    composeCompactBody(slide,text,rect,objects);
  }

  rect(gutter,651,contentWidth,1,dark?'4D4F5A':rule);
  const sources=[...new Map((slide.kind==='flow'?[]:slide.refs || []).map(ref=>[ref.url,ref])).values()]
    .filter(ref=>ref.url!==deck.caseRef?.url);
  sources.slice(0,2).forEach((ref,i)=>text(ref.label,gutter+i*381,666,353,16,{color:highlight,url:ref.url,limit:1}));
  if(deck.caseRef) text(deck.caseRef.label,850,666,262,16,{align:'right',color:highlight,url:deck.caseRef.url,limit:1});
  text((index+1)+' / '+deck.slides.length,1120,665,88,17,{align:'right',color:quiet,limit:1});
  return objects;
}

function composeCompactBody(slide,text,rect,objects) {
  if(slide.kind==='chart') {
    text([slide.unit,slide.period].filter(Boolean).join('  ·  '),gutter,230,contentWidth,20,{color:muted,limit:1});
    rect(gutter,268,contentWidth,slide.event?283:341,white);
    objects.push({type:'chart',x:88,y:285,w:1086,h:slide.event?255:313,data:chartData(slide.series),unit:slide.unit,
      style:slide.style || (slide.series.every(line=>line.points.length<=2)?'bar':'line')});
    if(slide.event) {
      rect(gutter,572,4,49,accent);
      text(slide.event.date+'  ·  '+slide.event.text,88,572,1104,17,{color:muted,limit:2});
    } else if(slide.totalSeries>slide.series.length) {
      text('Показано рядов: '+slide.series.length+' из '+slide.totalSeries,gutter,618,contentWidth,16,{color:muted,limit:1});
    }
    return;
  }
  if(slide.kind==='table') {
    const count=slide.columns.length;
    const widths=count===1 ? [contentWidth] : count===2 ? [326,810] :
      [382,...slide.columns.slice(1).map(()=>(contentWidth-382)/(count-1))];
    const size=22, height=67;
    const rows=[slide.columns,...slide.rows].map(row=>widths.map((w,i)=>fittedLines(row[i],size,w-36,2).join('\n')));
    const heights=rows.map(()=>height), tableBottom=239+height*rows.length;
    objects.push({type:'table',x:gutter,y:239,w:contentWidth,h:height*rows.length,widths,heights,rows,size,compact:true});
    const detail=[
      slide.noSharedSeries && 'У показанных периодов нет общего ряда',
      slide.totalRows>slide.rows.length && 'Строки: '+slide.rows.length+' из '+slide.totalRows,
      slide.totalColumns>slide.columns.length && 'Столбцы: '+slide.columns.length+' из '+slide.totalColumns,
    ].filter(Boolean).join('  ·  ');
    text(detail,gutter,tableBottom+13,contentWidth,17,{color:muted,limit:1});
    return;
  }
  if(slide.kind==='funnel') {
    const amount=slide.columns.indexOf('Дошли'), label=slide.columns.indexOf('Шаг');
    const values=slide.rows.map(row=>Number(String(row[amount]).replace(/\s/g,'')));
    const max=Math.max(1,...values.filter(Number.isFinite));
    text(slide.period && 'Период  ·  '+slide.period,gutter,224,contentWidth,20,{color:muted,limit:1});
    slide.rows.forEach((row,i)=>{
      const y=268+i*61;
      text(row[label],gutter,y,242,22,{bold:true,limit:1});
      rect(325,y+4,659,24,'EAE4E6');
      if(values[i]>0) rect(325,y+4,659*values[i]/max,24,accent);
      text(row[amount],1010,y,198,24,{align:'right',bold:true,limit:1});
    });
    if(slide.totalRows>slide.rows.length)
      text('Строки: '+slide.rows.length+' из '+slide.totalRows,gutter,599,contentWidth,17,{color:muted,limit:1});
    return;
  }
  if(slide.kind==='flow') {
    const gap=18, w=(contentWidth-gap*(slide.steps.length-1))/slide.steps.length;
    slide.steps.forEach((step,i)=>{
      const x=gutter+i*(w+gap), source=step.refs?.find(ref=>!ref.url.startsWith('#case/'));
      rect(x,239,w,340,white);
      rect(x,239,w,4,accent);
      text(step.label,x+21,262,w-42,20,{color:accent,bold:true,limit:2});
      text(step.text,x+21,324,w-42,27,{limit:6});
      if(source) text(source.label,x+21,545,w-42,16,{color:accent,url:source.url,limit:1});
    });
    if(slide.totalSteps>slide.steps.length)
      text('Показано шагов: '+slide.steps.length+' из '+slide.totalSteps,gutter,598,contentWidth,17,{color:muted,limit:1});
    return;
  }
  if(slide.kind==='kpi') {
    rect(gutter,239,540,305,white);
    rect(gutter,239,6,305,accent);
    const size=Math.min(90,Math.max(28,Math.floor(440/width(slide.value,1))));
    text(slide.value,108,287,464,size,{bold:true,limit:1});
    text(slide.unit,109,411,464,25,{color:accent,bold:true,limit:1});
    text(slide.body,657,283,539,35,{bold:true,limit:4});
    text(slide.period,658,471,539,21,{color:muted,limit:2});
    return;
  }
  if(slide.kind==='sources') {
    slide.links.forEach((ref,i)=>{
      const x=gutter+(i%2)*577, y=239+Math.floor(i/2)*111;
      rect(x,y,559,93,white);
      rect(x,y,4,93,accent);
      text(ref.label,x+20,y+18,502,23,{color:accent,bold:true,url:ref.url,limit:2});
    });
    return;
  }
  const quote=slide.kind==='quote';
  const body=slide.subject && slide.body.startsWith(slide.title) && slide.body!==slide.title ?
    slide.body.slice(slide.title.length).trimStart() : slide.body;
  const markWidth=101, markY=221, markSize=85, closingX=W-gutter-markWidth;
  const x=quote?177:103, w=(quote?closingX-24:1200)-x, size=quote?36:34, limit=7;
  if(quote) {
    const mark={color:accent,bold:true,limit:1};
    text('«',gutter,markY,markWidth,markSize,mark);
    text('»',closingX,markY,markWidth,markSize,{...mark,align:'right'});
  } else rect(gutter,240,6,302,accent);
  text(body,x,241,w,size,{limit});
  if(wrap(body,size,w).length>limit)
    text('Полный текст по ссылке ниже',x,587,w,17,{color:muted,limit:1});
}
