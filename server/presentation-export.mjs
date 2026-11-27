import { existsSync } from 'node:fs';
import PptxGenJS from 'pptxgenjs';
import { chromium } from 'playwright-core';
import { brandArt } from '../web/brand-art.mjs';
import { composeSlide,W,H,wrap,palette,muted,ink,accent,rule } from './presentation-layout.mjs';
import { compactPresentationVersion } from './presentation-story.mjs';

const esc=v=>String(v ?? '').replace(/[&<>"']/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const logo=brandArt.replaceAll('class="brand-gray"','fill="#A6A8AB"').replaceAll('class="brand-red"','fill="#A20C33"').replaceAll('class="brand-letter"','fill="#FFFFFF"');
const darkLogo=logo.replaceAll('#A6A8AB','#E2E1E5');
const logoImage=art=>'image/svg+xml;base64,'+Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="567" height="142" viewBox="0 0 566.9 141.7">'+art+'</svg>').toString('base64');
const font='Arial';
const link=(url,base)=>typeof url==='string' && url.startsWith('#') ? new URL('/'+url,base).href : undefined;
const point=(v,places=2)=>Number(v.toFixed(places));
const number=n=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(n);
function axisFor(data) {
  let min=0,max=0;
  for(const s of data.series) for(const v of s.values) if(Number.isFinite(v)) {min=Math.min(min,v);max=Math.max(max,v);}
  const raw=(max-min || 1)/4, magnitude=10**Math.floor(Math.log10(raw));
  const step=([1,2,2.5,5,10].find(n=>n*magnitude>=raw) || 10)*magnitude;
  return {min:Math.floor(min/step)*step,max:Math.ceil(max/step)*step || (min===0?step*4:0),step};
}
function textSvg(o) {
  const anchor=o.align==='right'?'end':'start', x=o.align==='right'?o.x+o.w:o.x;
  return '<text font-family="Arial, Liberation Sans, sans-serif" font-size="'+o.size+'" font-weight="'+(o.bold?700:400)+'" fill="#'+o.color+'" text-anchor="'+anchor+'">'+
    o.lines.map((l,i)=>'<tspan x="'+x+'" y="'+point(o.y+o.size+i*o.size*(o.leading || 1.26))+'">'+esc(l)+'</tspan>').join('')+'</text>';
}
function chartSvg(o) {
  const {series,labels}=o.data,axis=axisFor(o.data),lo=axis.min,span=axis.max-lo;
  const x=o.x+78,y=o.y+13,w=o.w-105,h=o.h-105;
  const bar=o.style==='bar';
  const xp=i=>x+(bar?(i+.5)/labels.length:labels.length>1?i/(labels.length-1):.5)*w,yp=v=>y+h*(1-(v-lo)/span);
  const items=[];
  for(let i=0;i<=Math.round(span/axis.step);i++) {
    const val=lo+i*axis.step,at=yp(val);
    items.push('<path stroke="#'+rule+'" d="M'+x+' '+at+'h'+w+'"/>',
      textSvg({x:o.x,y:at-10,w:63,color:muted,size:15,lines:[number(val)],align:'right'}));
  }
  const labelsAt=new Set(Array.from({length:Math.min(5,labels.length)},(_,i)=>Math.round(i*(labels.length-1)/Math.max(1,Math.min(5,labels.length)-1))));
  for(const i of labelsAt) items.push(textSvg({x:Math.max(o.x,Math.min(xp(i)-39,o.x+o.w-93)),y:y+h+9,w:99,size:14,color:muted,lines:[labels[i]]}));
  series.forEach((s,n)=>{
    const color=palette[n];let path='',prev=false;
    s.values.forEach((v,i)=>{
      if(!Number.isFinite(v)){prev=false;return;}
      if(bar) {
        const cluster=w/labels.length*.56, bw=cluster/series.length, left=xp(i)-cluster/2+n*bw;
        items.push('<rect x="'+left+'" y="'+Math.min(yp(v),yp(0))+'" width="'+Math.max(1,bw-3)+'" height="'+Math.max(1,Math.abs(yp(0)-yp(v)))+'" fill="#'+color+'"/>');
        if(labels.length<=4) items.push(textSvg({x:left,y:v>=0?yp(v)-25:yp(v)+1,w:bw,size:16,color:ink,bold:true,lines:[number(v)]}));
        return;
      }
      path+=(prev?' L':' M')+point(xp(i))+' '+point(yp(v));prev=true;
      if(labels.length<=35) items.push('<circle cx="'+xp(i)+'" cy="'+yp(v)+'" r="4" fill="#'+color+'"/>');
    });
    items.push('<path fill="none" stroke="#'+color+'" stroke-width="3" d="'+path+'"/>');
    const legendX=x+n*(w/series.length);
    items.push('<rect x="'+legendX+'" y="'+(y+h+55)+'" width="18" height="4" fill="#'+color+'"/>',
      textSvg({x:legendX+27,y:y+h+44,w:w/series.length-28,size:16,color:ink,lines:[wrap(s.name,16,w/series.length-30)[0]]}));
  });
  return items.join('');
}
function tableSvg(o) {
  let y=o.y;
  return o.rows.map((row,i)=>{
    let x=o.x;
    const cells=row.map((cell,j)=>{
      const w=o.widths[j], inset=o.compact?18:13;
      const lines=o.compact?cell.split('\n'):wrap(cell,o.size,w-26);
      const top=o.compact?(o.heights[i]-lines.length*o.size*1.22)/2:8;
      const result=textSvg({x:x+inset,y:y+top,w:w-2*inset,size:o.size,bold:i===0,color:i===0?'FFFFFF':ink,lines,
        leading:o.compact?1.22:undefined});
      x+=w;return result;
    }).join('');
    const fill=tableFill(i,o.compact);
    const result='<rect x="'+o.x+'" y="'+y+'" width="'+o.w+'" height="'+o.heights[i]+'" fill="#'+fill+'"/>'+cells;
    y+=o.heights[i];return result;
  }).join('');
}
const tableFill=(index,compact)=>index===0?ink:index%2?(compact?'F0EFEC':'F8F7F7'):'FFFFFF';

function slideHtml(deck,i,base) {
  const scene=composeSlide(deck,i);
  const svg=scene.map(o=>{
    if(o.type==='text') return textSvg(o);
    if(o.type==='chart') return chartSvg(o);
    if(o.type==='table') return tableSvg(o);
    if(o.type==='logo') return '<svg x="'+o.x+'" y="'+o.y+'" width="'+o.w+'" height="'+o.h+'" viewBox="0 0 566.9 141.7">'+(o.dark?darkLogo:logo)+'</svg>';
    return '<rect x="'+o.x+'" y="'+o.y+'" width="'+o.w+'" height="'+o.h+'" fill="#'+o.color+'"/>';
  }).join('');
  const links=scene.filter(o=>o.url && link(o.url,base)).map(o=>'<a target="_blank" rel="noopener" aria-label="'+esc(o.lines.join(' '))+
    '" href="'+esc(link(o.url,base))+'" style="left:'+o.x/W*100+'%;top:'+o.y/H*100+'%;width:'+o.w/W*100+'%;height:'+o.h/H*100+'%"></a>').join('');
  return '<section><svg role="img" aria-label="'+esc(deck.slides[i].title)+'" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">'+svg+'</svg>'+links+'</section>';
}
export function presentationHtml(deck,base,index) {
  if(index!==undefined && (!Number.isInteger(index) || !deck.slides[index])) throw Error('Слайд не найден');
  return '<!doctype html><html lang="ru"><meta charset="utf-8"><title>'+esc(deck.title)+'</title><style>'+
    '*{box-sizing:border-box}html,body{margin:0;background:white}section{position:relative;width:100%;aspect-ratio:16/9;overflow:hidden}svg{display:block}section>svg{width:100%;height:100%}a{position:absolute}a:focus-visible{outline:2px solid #a20c33}'+
    '@page{size:1280px 720px;margin:0}@media print{html,body{width:1280px}section{width:1280px;height:720px;break-after:page}section:last-child{break-after:auto}}'+
    '</style><body>'+(index===undefined?deck.slides.map((_,i)=>slideHtml(deck,i,base)).join(''):slideHtml(deck,index,base))+'</body></html>';
}
export async function exportPdf(deck,base,env={}) {
  const path=env.PM_BROWSER_PATH || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium'].find(existsSync);
  const browser=await chromium.launch({headless:true,executablePath:path,args:['--disable-dev-shm-usage']});
  try {
    const page=await browser.newPage({viewport:{width:W,height:H},javaScriptEnabled:false});
    await page.route('**/*',r=>r.abort());
    await page.setContent(presentationHtml(deck,base));
    await page.evaluate(()=>document.fonts.ready);
    return await page.pdf({printBackground:true,preferCSSPageSize:true,tagged:true});
  } finally {await browser.close();}
}
export async function exportPptx(deck,base) {
  const ppt=new PptxGenJS();
  ppt.layout='LAYOUT_WIDE';ppt.author='Signal';ppt.company='Softline';ppt.subject=deck.product;ppt.title=deck.title;
  ppt.theme={headFontFace:font,bodyFontFace:font,lang:'ru-RU'};
  const compact=deck.formatVersion===compactPresentationVersion;
  const logoData=logoImage(logo), darkLogoData=compact?logoImage(darkLogo):undefined;
  if(!compact) ppt.defineSlideMaster({title:'SOFTLINE',background:{color:'FFFFFF'},objects:[{image:{data:logoData,x:64/96,y:30/96,w:162/96,h:41/96}}]});
  for(const [i] of deck.slides.entries()) {
    const slide=ppt.addSlide(compact?{}:{masterName:'SOFTLINE'});
    for(const o of composeSlide(deck,i)) {
      const box={x:o.x/96,y:o.y/96,w:o.w/96,h:o.h/96};
      if(o.type==='text') slide.addText(o.lines.join('\n'),{...box,fontFace:font,fontSize:o.size*.75,bold:!!o.bold,
        color:o.color,margin:0,valign:'top',align:o.align || 'left',breakLine:false,wrap:false,paraSpaceAfter:0,
        ...(o.leading?{lineSpacing:o.leading*o.size*.75}:{lineSpacingMultiple:1}),
        ...(o.url?{hyperlink:{url:link(o.url,base)}}:{})});
      if(o.type==='rect') slide.addShape(ppt.ShapeType.rect,{...box,line:{type:'none'},fill:{color:o.color},radius:0});
      if(o.type==='logo' && compact) slide.addImage({...box,data:o.dark?darkLogoData:logoData});
      if(o.type==='table') slide.addTable(o.rows.map((r,i)=>r.map(v=>({text:String(v),options:{bold:i===0,
        color:i===0?'FFFFFF':ink,fill:{color:tableFill(i,o.compact)}}}))),{...box,colW:o.widths.map(x=>x/96),
        rowH:o.heights.map(h=>h/96),fontFace:font,fontSize:o.size*.75,margin:o.compact?[.065,.18,.065,.18]:[.065,.10,.05,.10],valign:'middle',
        border:{type:'none'},autoPage:false,paraSpaceAfter:0});
      if(o.type==='chart') {
        const axis=axisFor(o.data);
        slide.addChart(o.style==='bar'?ppt.ChartType.bar:ppt.ChartType.line,o.data.series.map(s=>({name:s.name,labels:o.data.labels,values:s.values})),{
        ...box,showTitle:false,showLegend:true,legendPos:'b',legendFontFace:font,legendFontSize:12,showMarker:o.data.labels.length<=35,
        markerSize:4,lineSize:2,chartColors:palette,showCatName:false,catAxisLabelFontSize:10,valAxisLabelFontSize:11,
        catAxisLabelFrequency:Math.max(1,Math.ceil(o.data.labels.length/5)),valGridLine:{color:rule,size:.6},
        catAxisLineColor:rule,valAxisLineShow:false,barDir:'col',barGrouping:'clustered',showValue:o.style==='bar' && o.data.labels.length<=4,
        valAxisMinVal:axis.min,valAxisMaxVal:axis.max,valAxisMajorUnit:axis.step,
        dataLabelPosition:o.style==='bar'?'outEnd':undefined,displayBlanksAs:'gap'});
      }
    }
  }
  return Buffer.from(await ppt.write({outputType:'nodebuffer',compression:true}));
}
