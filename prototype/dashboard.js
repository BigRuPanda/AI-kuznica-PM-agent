(() => {
  const root = document.getElementById('release-dashboard');
  const data = globalThis.releaseDemo;
  const { DAY, metrics, snapshot } = globalThis.releaseMetrics;
  const ids = Object.keys(data).sort((a,b) => data[b].launch-data[a].launch);
  const segments = {all:'Все клиенты', new:'Новые клиенты', returning:'Постоянные клиенты'};
  const storageKey = 'softline-release-preview-v1';
  const slot = name => root.querySelector('[data-slot="'+name+'"]');
  const find = selector => root.querySelector(selector);
  const themeButton = find('[data-theme-toggle]');
  let preference;
  try { preference = localStorage.getItem('pm-theme'); } catch {}
  function applyTheme() {
    const dark = preference === 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    themeButton.setAttribute('aria-pressed', String(dark));
  }
  themeButton.onclick = () => {
    preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('pm-theme', preference); } catch {}
    applyTheme();
  };
  applyTheme();
  const layout = find('.layout');
  const composer = find('.chat-composer');
  const input = composer.querySelector('input');
  const send = composer.querySelector('[type=submit]');
  const updateSend = () => { send.disabled = !input.value.trim(); };
  input.addEventListener('input', updateSend);
  const mobile = matchMedia('(max-width: 850px)');
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(storageKey)) || {}; } catch {}
  const linkId = () => location.hash.slice(1);
  const entryRelease = () => linkId() || history.state?.releaseDemoId;
  const initialRelease = [entryRelease(), saved.id].find(key => ids.includes(key)) ?? ids[0];
  let id = initialRelease;
  // Keep the root entry tied to its release when another history entry is reloaded.
  if (!linkId() && history.state?.releaseDemoId !== id) {
    try { history.replaceState({ ...history.state, releaseDemoId: id }, ''); } catch {}
  }
  const views = {}, chats = {}, drafts = {};
  for (const key of ids) {
    const v = saved.views?.[key];
    views[key] = {day:Number.isInteger(v?.day) && v.day>=0 && v.day<=14 ? v.day : 14,
      segment:Object.hasOwn(segments,v?.segment) ? v.segment : 'all'};
    chats[key] = []; drafts[key] = '';
  }
  const panels = {left: saved.left !== false, right: saved.right !== false};
  const width = {left:Number(saved.leftWidth)||240, right:Number(saved.rightWidth)||365};
  let pane = 'main', current;
  const dateFmt = new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',timeZone:'Europe/Moscow'});
  const fmt = new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1});
  const rubles = new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0});
  const date = (d,key=id) => dateFmt.format(data[key].launch+d*DAY).replace(/\.$/u,'');
  const view = () => views[id];
  const target = () => id==='R-001'?0:1;
  function save() {
    try {localStorage.setItem(storageKey,JSON.stringify({id,views,...panels,leftWidth:width.left,rightWidth:width.right}));} catch {}
  }
  const number = (n,i) => n===null?'—':metrics[i][1]==='%'?fmt.format(n)+'%':rubles.format(n)+' ₽';
  const metricText = (r,i) => i===2 ? number(r.n,2)+' · оплат '+r.d :
    i===3 ? number(r.n,2)+' / '+r.d+' заказов' : r.n+' из '+r.d;
  function make(tag, text, cls) {
    const el=document.createElement(tag);
    if (text!==undefined) el.textContent=text;
    if (cls) el.className=cls;
    return el;
  }

  function setTab(name) {
    slot('workspace').hidden=name!=='workspace'; slot('releases').hidden=name!=='releases';
    root.querySelectorAll('.top [data-tab]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tab===name)));
    if(name==='releases') sizePanels();
  }
  root.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>setTab(b.dataset.tab));
  function sizePanels() {
    const w=layout.clientWidth;
    layout.dataset.pane=pane;
    for(const [side,other,min,max,panel] of [['left','right',115,300,'.sidebar'],['right','left',165,460,'.thread']]) {
      const prefix=side[0];
      const allowed=Math.max(min,Math.min(max,w-320-(panels[other]?width[other]:0)-12));
      const display=Math.max(min,Math.min(allowed,width[side]));
      layout.style.setProperty('--'+prefix+'w',panels[side]?display+'px':'0px');
      layout.style.setProperty('--'+prefix+'g',panels[side]?'6px':'0px');
      find(panel).hidden=!mobile.matches&&!panels[side];
      const grip=find('.'+side+'-grip');
      grip.hidden=!panels[side]||mobile.matches;grip.setAttribute('aria-valuemin',min);
      grip.setAttribute('aria-valuemax',Math.round(allowed));grip.setAttribute('aria-valuenow',Math.round(display));
      const open=mobile.matches?pane===side:panels[side];
      const button=find('[data-toggle="'+side+'"]');
      button.setAttribute('aria-expanded',String(open));
      const label=side==='left'?'Список релизов':'Обсуждение';
      button.textContent=mobile.matches ? (open?'К разбору':label) : label+(open?' −':' +');
    }
  }
  function changeWidth(side,value) {
    const grip=find('.'+side+'-grip');
    width[side]=Math.max(+grip.getAttribute('aria-valuemin'),Math.min(+grip.getAttribute('aria-valuemax'),value));
    sizePanels();
  }
  for(const side of ['left','right']) {
    find('[data-toggle="'+side+'"]').onclick=()=>{
      if(mobile.matches) pane=pane===side?'main':side;
      else panels[side]=!panels[side];
      sizePanels();save();
    };
    const grip=find('.'+side+'-grip'),sign=side==='left'?1:-1;
    let drag=null;
    grip.onpointerdown=e=>{drag={x:e.clientX,w:+grip.getAttribute('aria-valuenow')};grip.setPointerCapture(e.pointerId);};
    grip.onpointermove=e=>{if(drag)changeWidth(side,drag.w+(e.clientX-drag.x)*sign);};
    grip.onlostpointercapture=()=>{drag=null;save();};
    grip.onkeydown=e=>{
      if(!['ArrowLeft','ArrowRight'].includes(e.key))return;
      e.preventDefault();changeWidth(side,width[side]+sign*(e.key==='ArrowLeft'?-12:12));save();
    };
  }
  new ResizeObserver(sizePanels).observe(layout);
  mobile.addEventListener('change',sizePanels);

  function switchRelease(next) {
    if(!ids.includes(next))return;
    const returnFromList=mobile.matches&&pane==='left';
    drafts[id]=input.value;
    id=next;pane='main';setTab('releases');
    input.value=drafts[id];
    updateSend();
    render();save();
    if(returnFromList)slot('title').focus();
  }
  window.addEventListener('hashchange',()=>switchRelease(entryRelease()||initialRelease));
  const links=ids.map(key=>{
    const link=make('a',undefined,'release-link');
    link.href='#'+key;
    link.append(make('small',key+' · '+date(0,key)),make('strong',data[key].title));
    link.addEventListener('click',event=>{
      if(!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey&&linkId()===key)switchRelease(key);
    });
    return link;
  });
  slot('list').replaceChildren(...links);
  const dateFilter=find('[data-filter=date]'), segmentFilter=find('[data-filter=segment]');
  dateFilter.onchange=()=>{view().day=Number(dateFilter.value);render();save();};
  segmentFilter.onchange=()=>{view().segment=segmentFilter.value;render();save();};

  function caption(i,report,day,segment) {
    const a=report.before[i], b=report.after[i];
    if(day===0)return 'Наблюдение началось. События после запуска будут появляться по мере накопления.';
    if(b.value===null)return b.pending?'Окно оплаты ещё открыто. Ждём семь суток для каждого наблюдения.':
      (i===4?'В этом срезе ещё нет подписок с наступившим сроком продления.':'В выбранном срезе пока нет наблюдений для расчёта.');
    if(day===14&&segment==='all'&&i===0&&id==='R-001')return 'У новых клиентов осталось 5%, у постоянных — 20%. Доля новых клиентов выросла с 40% до 60%.';
    if(day===14&&segment==='all'&&i===1&&id==='R-002')return 'Рост виден в обеих группах клиентов. Чтобы оценить вклад кнопки, нужно сравнение с контрольной группой.';
    if(a.value===null)return 'Данных до запуска пока недостаточно для сравнения.';
    const delta=b.value-a.value;
    const diff=metrics[i][1]==='%'?fmt.format(Math.abs(delta))+' п. п.':number(Math.abs(delta),i);
    let result=Math.abs(delta)<0.00001?'Значение в двух периодах совпадает.':
      'За период после запуска показатель '+(delta>0?'выше':'ниже')+' на '+diff.replace(/\.$/u,'')+'.';
    if(day<7 || (day<14 && (i===0||i===1)))result+=' Сравнение предварительное.';
    return result;
  }
  function headline(report, brief=false) {
    const {day,segment}=view(),i=target(),a=report.before[i],b=report.after[i];
    if(day<14)return caption(i,report,day,segment)+' Первый полный разбор — '+date(14)+'.';
    if(brief&&a.value!==null&&b.value!==null){
      const subject=i===0?'Конверсия':metrics[i][0];
      if(a.value===b.value)return subject+' сохранилась на уровне '+number(b.value,i)+'.';
      const change=b.value>a.value?' выросла с ':' снизилась с ';
      return subject+change+number(a.value,i)+' до '+number(b.value,i)+'.';
    }
    return metrics[i][0]+' — '+number(b.value,i)+' после запуска и '+number(a.value,i)+' до него. '+caption(i,report,day,segment);
  }
  function initialReason(i) {
    if(view().day<14||i!==target())return '';
    return id==='R-001'?'Первый полный разбор, все клиенты. Снижение с 14% до 11% связано с изменением состава аудитории.':
      'Первый полный разбор, все клиенты. За семь суток оплачено 110 из 200 счетов после запуска и 80 из 200 до.';
  }
  function interval(i) {
    if(view().day<14)return null;
    if(id==='R-001'&&i===0&&view().segment==='all')return {seg:'all',text:'Все клиенты. Снижение конверсии на 3 п. п. при 1 000 компаниях в каждом периоде.'};
    if(id==='R-002'&&[0,1].includes(i)&&view().segment!=='returning')return {seg:'new',text:
      'Новые клиенты. '+(i===1?'Оплачено 55 из 100 счетов против 40 из 100 до запуска.':'Оплатили заказ 55 из 100 компаний против 40 из 100 до запуска.')};
    return null;
  }

  const precise = new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
  const dailyFields = [
    ['Оплатили за 7 суток','Компаний в расчёте'],
    ['Оплачено за 7 суток','Счетов в расчёте'],
    ['Поступления, ₽','Количество оплат'],
    ['Сумма оплат, ₽','Оплаченных заказов'],
    ['Продлено вовремя','Подписок с наступившим сроком']
  ];
  const versionLines = [
    {key:'all',label:'Все',color:'var(--fg)',weight:3.6},
    {key:'old',label:'Старая версия',color:'var(--series-control)',weight:2,dash:'6 4'},
    {key:'new',label:'Новая версия',color:'var(--series-main)',weight:2}
  ];
  const rowUnits = ['компаний','счетов','оплат','заказов','подписок'];
  const basisNames = ['Оплатили / компаний','Оплачено / счетов','Оплат','Сумма / заказов','Продлено / подписок'];
  function seriesReport(report,key) { return key==='all'?report:report.byVersion[key]; }
  function basis(row,i) {
    if(i===2)return String(row.d);
    return (i===3?rubles.format(row.n)+' ₽':row.n)+' / '+row.d;
  }
  function versionTable(report,i,period,index) {
    const table=make('table',undefined,'version-table');
    const header=table.createTHead().insertRow();
    for(const name of ['Версия','Значение',basisNames[i]])header.append(make('th',name));
    const body=table.createTBody();
    for(const line of versionLines) {
      const series=seriesReport(report,line.key);
      const row=period==='daily'?series.daily[index][i]:series[period][i];
      const tr=body.insertRow(), label=make('th',line.label);
      label.scope='row';tr.append(label);
      tr.insertCell().textContent=row.value===null?'—':precise.format(row.value)+' '+metrics[i][1];
      tr.insertCell().textContent=basis(row,i)+(row.pending?' · в ожидании '+row.pending:'');
    }
    return table;
  }
  const viewTime=new Intl.DateTimeFormat('ru-RU',{
    day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Moscow'
  });
  function bothViewsDetail(row) {
    const detail=make('details',undefined,'both-views');
    detail.append(make('summary','Счета с пометкой «Видел обе версии» · '+row.bothViews.length+' из '+(row.d+row.pending)));
    detail.append(make('p','Каждый счёт уже учтён в строке первой показанной версии. Время просмотров — МСК.','proof'));
    const list=make('ul');
    for(const order of row.bothViews) {
      const first=order[7]==='old'?'старая':'новая',second=order[7]==='old'?'новая':'старая';
      const time=offset=>viewTime.format(data[id].launch+offset);
      const item=make('li');
      item.append(make('strong',order[10] || 'Счёт без ID'),
        document.createTextNode(' · '+first+' ('+time(order[8])+') → '+second+' ('+time(order[9])+')'));
      list.append(item);
    }
    detail.append(list);
    return detail;
  }
  let activePlot = null;
  function hideActivePlot() { if(activePlot) activePlot.hide(); }
  root.addEventListener('pointerdown',e=>{
    if(activePlot && !activePlot.element.contains(e.target)) hideActivePlot();
  });

  function attachDayInspector(plot,report,i,scaleMax,visible) {
    const guide=make('span',undefined,'day-guide'), dot=make('span',undefined,'day-dot');
    guide.setAttribute('aria-hidden','true');dot.setAttribute('aria-hidden','true');
    const tip=make('div',undefined,'day-tip');
    tip.id='release-day-tip-'+i;tip.setAttribute('role','tooltip');
    plot.append(guide,dot,tip);
    plot.tabIndex=0;plot.setAttribute('role','slider');plot.setAttribute('aria-orientation','horizontal');
    plot.setAttribute('aria-label',metrics[i][0]+'. Выбор дня стрелками');
    plot.setAttribute('aria-valuemin','1');plot.setAttribute('aria-valuemax',String(report.days.length));
    plot.setAttribute('aria-valuenow','1');plot.setAttribute('aria-valuetext',date(report.days[0]));
    let index=0;
    const inspector={element:plot,hide(){
      guide.hidden=dot.hidden=tip.hidden=true;
      plot.removeAttribute('aria-describedby');
      if(activePlot===inspector)activePlot=null;
    }};
    inspector.hide();
    function show(next) {
      if(activePlot && activePlot!==inspector)hideActivePlot();
      activePlot=inspector;
      index=Math.max(0,Math.min(report.days.length-1,next));
      const day=report.days[index],row=report.daily[index][i],prior=report.daily[index-1]?.[i];
      const fraction=(index+.5)/report.days.length, pos=fraction*100+'%';
      const phase=day<0?'До запуска':day<7?'Первая неделя релиза':'После первой недели';
      const val=row.value===null?(row.pending?'Окно оплаты открыто':'Нет наблюдений'):precise.format(row.value)+' '+metrics[i][1];
      const selected=versionLines.find(line=>visible.has(line.key)&&seriesReport(report,line.key).daily[index][i].value!==null);
      guide.hidden=false;guide.style.left=pos;dot.hidden=!selected;dot.style.left=pos;
      if(selected){
        const value=seriesReport(report,selected.key).daily[index][i].value;
        dot.style.top=(92-84*value/scaleMax)+'%';dot.style.background=selected.color;
      }
      const keyValues=make('dl');
      function field(name,value){keyValues.append(make('dt',name),make('dd',String(value)));}
      const [numerator,denominator]=dailyFields[i];
      if(row.bothViews.length)field('Из них видели обе версии',row.bothViews.length);
      if(!report.hasVersion){
        if(row.d || !row.pending)field(numerator,precise.format(row.n));
        field(denominator,precise.format(row.d));
      }
      if(i<=1){
        if(row.pending)field('Ещё в окне оплаты',row.pending);
        else if(row.d)field('Окно оплаты','Завершено');
      }
      if(row.value!==null && prior?.value!=null && !row.pending && !prior.pending){
        const delta=row.value-prior.value;
        field('Все · к предыдущим суткам',(delta>0?'+':'')+precise.format(delta)+(metrics[i][1]==='%'?' п. п.':' ₽'));
      }
      tip.replaceChildren(make('strong',date(day)+' → '+date(day+1)+' · 10:00 МСК'),make('small',phase+' · '+segments[view().segment]));
      if(report.hasVersion)tip.append(versionTable(report,i,'daily',index));
      else tip.append(make('b',val));
      tip.append(keyValues);
      const unknown=report.byVersion.unknown.daily[index][i];
      if(unknown.d+unknown.pending)tip.append(make('small','Без версии · '+(unknown.d+unknown.pending)+' '+rowUnits[i]+'. Включены в «Все».'));
      tip.hidden=false;
      plot.setAttribute('aria-describedby',tip.id);
      const width=plot.clientWidth,tipWidth=tip.offsetWidth, point=width*fraction;
      const preferred=point+12+tipWidth<=width?point+12:point-tipWidth-12;
      tip.style.left=Math.max(0,Math.min(width-tipWidth,preferred))+'px';
      plot.setAttribute('aria-valuenow',String(index+1));
      plot.setAttribute('aria-valuetext',date(day)+', '+val+'. '+numerator+' '+row.n+', '+denominator+' '+row.d+
        (row.pending?', ещё в окне оплаты '+row.pending:''));
    }
    function indexAt(e){
      const box=plot.getBoundingClientRect();
      return Math.floor((e.clientX-box.left)/Math.max(1,box.width)*report.days.length);
    }
    plot.onpointermove=e=>{
      if(e.pointerType==='touch')return;
      const candidate=Math.max(0,Math.min(report.days.length-1,indexAt(e)));
      if(tip.hidden||candidate!==index)show(candidate);
    };
    plot.onpointerleave=e=>{if(e.pointerType!=='touch'&&!plot.matches(':focus-visible'))inspector.hide();};
    plot.onpointerup=e=>{if(e.pointerType==='touch'||e.pointerType==='pen'){plot.focus({preventScroll:true});show(indexAt(e));}};
    plot.onfocus=()=>{if(tip.hidden)show(index);};plot.onblur=inspector.hide;
    plot.onkeydown=e=>{
      const keys={ArrowLeft:index-1,ArrowRight:index+1,Home:0,End:report.days.length-1};
      if(e.key==='Escape'){e.preventDefault();inspector.hide();}
      else if(Object.hasOwn(keys,e.key)){e.preventDefault();show(keys[e.key]);}
    };
  }
  function drawChart(card,i,report,mark) {
    const wrap=make('div',undefined,'chartwrap'), ns='http://www.w3.org/2000/svg';
    const svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 1000 100');
    svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('class','plot');
    svg.setAttribute('role','img');svg.setAttribute('aria-label',metrics[i][0]+' по дням, от '+date(-7)+' до '+date(view().day));
    function add(tag,attrs) {const el=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,v);svg.append(el);return el;}
    const plot=make('div',undefined,'plot-area');plot.append(svg);wrap.append(plot);
    const lines=report.hasVersion?versionLines:versionLines.slice(0,1);
    const seriesValues=lines.map(line=>seriesReport(report,line.key).daily.map(rows=>rows[i].value));
    const rawStep=Math.max(1,...seriesValues.flat().filter(v=>v!==null))/4, magnitude=10**Math.floor(Math.log10(rawStep));
    const step=([1,2,2.5,5,10].find(v=>v*magnitude>=rawStep)??10)*magnitude;
    const top=i===2||i===3?4*step:Math.min(100,4*step);
    const n=report.days.length, edge=d=>(d+7)*1000/n;
    if(i<=1){
      report.days.forEach((day,j)=>{
        if(report.daily[j][i].pending)add('rect',{x:edge(day),y:8,width:1000/n,height:84,fill:'var(--surface-hover)'});
      });
    }
    if(mark)add('rect',{x:edge(0),y:8,width:edge(7)-edge(0),height:84,class:'band'});
    for(let tick=0;tick<=4;tick++){
      const y=92-tick*21,value=top*tick/4;
      add('line',{x1:0,y1:y,x2:1000,y2:y,class:'gridline','vector-effect':'non-scaling-stroke'});
      const label=metrics[i][1]==='%'?fmt.format(value)+'%':
        (value>=1000?fmt.format(value/1000)+' тыс.':fmt.format(value));
      const axis=make('span',label,'y-tick');
      axis.style.top=y+'%';plot.append(axis);
    }
    const launch=edge(0);
    add('line',{x1:launch,x2:launch,y1:4,y2:95,stroke:'var(--series-main)','stroke-dasharray':'3 4','vector-effect':'non-scaling-stroke'});
    const visible=new Set(lines.map(line=>line.key)),legend=make('div',undefined,'series-legend');
    legend.setAttribute('role','group');legend.setAttribute('aria-label','Ряды по версиям интерфейса');
    lines.forEach((line,seriesIndex)=>{
      let path='',continuous=false;
      const marks=[];
      seriesValues[seriesIndex].forEach((v,j)=>{
        if(v===null){continuous=false;return;}
        const x=(j+.5)*1000/n,y=92-v/top*84;
        path+=(continuous?' L':' M')+x+' '+y;continuous=true;
        const marker=make('span',undefined,'sample-dot');
        marker.style.cssText='left:'+x/10+'%;top:'+y+'%;background:'+line.color;
        plot.append(marker);marks.push(marker);
      });
      if(path)marks.push(add('path',{d:path.trim(),fill:'none',stroke:line.color,'stroke-width':line.weight,'stroke-dasharray':line.dash||'none','stroke-linejoin':'round','vector-effect':'non-scaling-stroke','pointer-events':'none'}));
      const button=make('button',line.label);button.type='button';button.dataset.line=line.key;
      button.setAttribute('aria-pressed','true');button.disabled=lines.length===1;
      button.onclick=()=>{
        if(visible.has(line.key))visible.delete(line.key);else visible.add(line.key);
        const shown=visible.has(line.key);
        for(const mark of marks)mark.style.display=shown?'':'none';
        button.setAttribute('aria-pressed',String(shown));hideActivePlot();
        for(const b of legend.querySelectorAll('button'))b.disabled=visible.size===1&&visible.has(b.dataset.line);
      };
      legend.append(button);
    });
    card.append(legend);
    if(!report.hasVersion)card.append(make('p','Нет данных о версии','meta'));
    attachDayInspector(plot,report,i,top,visible);
    const dates=make('div',undefined,'dates');
    const first=make('span',date(-7));first.style.left='0';dates.append(first);
    const last=make('span',date(view().day));last.style.right='0';dates.append(last);
    if(view().day>=3){const tag=make('span','Запуск','launch');tag.style.left=(launch/10)+'%';dates.append(tag);}
    for(let d=-3;d<view().day;d+=4){
      const f=edge(d)/10;
      if(f<16||f>84||Math.abs(f-launch/10)<16)continue;
      const tick=make('span',date(d),'mid-date');tick.style.left=f+'%';dates.append(tick);
    }
    wrap.append(dates);card.append(wrap);
    return svg.querySelector('.band');
  }
  function showMetric(i) {
    pane='main';sizePanels();
    const detail=slot('charts').querySelector('[data-metric="'+i+'"] details');
    detail.open=true;detail.querySelector('summary').focus();
  }
  function chart(i) {
    const reason=initialReason(i), mark=interval(i), card=make('section',undefined,'card'+(reason?' important':''));
    card.dataset.metric=i;
    const head=make('header',undefined,'metric-head'), a=current.before[i], b=current.after[i];
    const periods=make('div',undefined,'period-pair');
    for(const [label,result] of [['До запуска',a],['После запуска',b]]) {
      const cell=make('div',undefined,'period-cell');
      const count=metrics[i][1]==='%'?result.n+' из '+result.d:String(result.d);
      cell.append(make('span',label,'period-label'),make('strong',number(result.value,i),'period-value'),
        make('span',count+' '+rowUnits[i],'period-basis'));
      periods.append(cell);
    }
    head.append(make('h3',metrics[i][0]),periods);
    card.append(head);
    const band=drawChart(card,i,current,mark);
    if((i===0||i===1)&&current.daily.some(rows=>rows[i].pending))
      card.append(make('p','Серый фон — ещё не завершилось семидневное окно оплаты.','meta'));
    card.append(make('p',caption(i,current,view().day,view().segment),'caption'));
    if(mark){
      const button=make('button','Участок · '+date(0)+' – '+date(7)+' · '+segments[mark.seg],'mark-open');
      const info=make('p',mark.text,'proof');info.hidden=true;
      button.setAttribute('aria-expanded','false');
      button.onclick=()=>{info.hidden=!info.hidden;button.setAttribute('aria-expanded',String(!info.hidden));};
      band.onclick=button.onclick;card.append(button,info);
      if(view().segment!==mark.seg){const change=make('button','Открыть этот срез','mark-open');info.append(document.createElement('br'),change);change.onclick=()=>{view().segment=mark.seg;render();save();showMetric(i);};}
    }
    const details=make('details');details.append(make('summary','Показать расчёт'));
    details.append(make('p',metrics[i][2]+'. До запуска — '+metricText(a,i)+'. После — '+metricText(b,i)+'.','proof'));
    if(current.hasVersion){
      for(const [key,label] of [['before','До запуска'],['after','После запуска']]){
        const table=make('div',undefined,'table-scroll');
        table.append(versionTable(current,i,key));
        details.append(make('strong',label),table);
        if(current[key][i].bothViews.length)details.append(bothViewsDetail(current[key][i]));
        const u=current.byVersion.unknown[key][i];
        if(u.d+u.pending)details.append(make('p','Без версии · '+(u.d+u.pending)+' '+rowUnits[i]+'. Включены в «Все».','proof'));
      }
    }
    if(reason)details.append(make('p',reason,'proof'));
    const daily=make('details');daily.append(make('summary','Значения по дням'));
    current.days.forEach((d,j)=>{const row=current.daily[j][i];daily.append(make('p',date(d)+' · '+number(row.value,i)+' · '+metricText(row,i),'proof'));});
    details.append(daily);card.append(details);return card;
  }
  function displayChat() {
    const list=slot('messages');list.replaceChildren();
    const show=(text,context)=>{
      const message=make('article',undefined,'bubble '+(context?'user':'assistant'));
      const author=make('header',undefined,'message-author');
      const avatar=make('span',context?'В':undefined,'chat-avatar');
      avatar.setAttribute('aria-hidden','true');
      if(!context)avatar.append(find('.conversation-heading svg').cloneNode(true));
      author.append(avatar,make('strong',context?'Вы':'Агент'));
      message.append(author,make('p',text));
      if(context)message.append(make('small',context,'meta'));
      list.append(message);
      return message;
    };
    show(headline(current));
    for(const m of chats[id].filter(m=>m.day<=view().day)){
      show(m.q,segments[m.segment]+' · '+date(m.day));
      const answer=show(m.answer);
      if(m.metric!==null){
        const button=make('button','Открыть расчёт','calculation-link');
        button.onclick=()=>{views[id]={day:m.day,segment:m.segment};render();save();showMetric(m.metric);};
        answer.append(button);
      }
    }
    slot('chatId').textContent=id+' · '+segments[view().segment];
  }
  composer.onsubmit=e=>{
    e.preventDefault();const q=input.value.trim();if(!q)return;
    const s=/постоянн/i.test(q)?'returning':/новы[емхй]|новичк/i.test(q)?'new':view().segment;
    const report=s===view().segment?current:snapshot(data[id],s,view().day);
    let i=target();
    if(/продлен|продлён/i.test(q))i=4;else if(/средн|чек/i.test(q))i=3;
    else if(/сумм|деньг|денег/i.test(q))i=2;else if(/сч[её]т/i.test(q))i=1;else if(/конверс/i.test(q))i=0;
    const supported=/релиз|форм|кнопк|измен|клиент|сегмент|новы|постоян|почему|оплат|денег|откат|средн|чек|сумм|сч[её]т|конверс|продл/i.test(q);
    const answer=supported?metrics[i][0]+'. '+number(report.before[i].value,i)+' → '+number(report.after[i].value,i)+'. '+caption(i,report,view().day,s):
      'В этом макете можно спросить про любую из пяти метрик или про новых и постоянных клиентов.';
    chats[id].push({day:view().day,segment:s,q,answer,metric:supported?i:null});
    drafts[id]='';
    input.value='';
    updateSend();
    displayChat();
    const list=slot('messages');
    list.scrollTop=list.scrollHeight;
  };
  function render() {
    hideActivePlot();
    const v=view(), release=data[id];current=snapshot(release,v.segment,v.day);
    for(const link of links){
      const selected=link.hash==='#'+id;
      link.classList.toggle('chosen',selected);
      if(selected)link.setAttribute('aria-current','page');
      else link.removeAttribute('aria-current');
    }
    slot('identity').textContent=id+' · Запуск '+date(0)+' 2026 · '+(v.day===14?'Разбор готов':v.day===0?'Наблюдение началось':'Предварительные данные');
    slot('title').textContent=release.title;slot('lead').textContent=headline(current,true);
    dateFilter.replaceChildren(...Array.from({length:15},(_,d)=>new Option(date(d),d)));
    dateFilter.value=v.day;segmentFilter.value=v.segment;
    slot('period').textContent='До запуска '+date(-7)+' → '+date(0)+' · После '+date(0)+' → '+date(7)+'. Границы в 10:00 МСК. Графики — до '+date(v.day)+'.';
    slot('charts').replaceChildren(...metrics.map((_,i)=>chart(i)));
    displayChat();sizePanels();
  }
  setTab('releases');render();
})();
