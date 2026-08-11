/* 未尽：离线优先 PWA。数据与 DeepSeek Key 仅写入 localStorage。*/
const KEY='weijin-state-v1';
const $=s=>document.querySelector(s); const id=()=>crypto.randomUUID();
const defaultState={tasks:[],life:[],projects:[],sessions:[],reports:[],settings:{apiKey:'',capacity:10,weekStart:'2026-08-10'},timer:null};
let state=load(), view='today', draftText='', deferredInstallPrompt=null;
let _swipeState=null, _timerRAF=null;

/* ── 数据 ── */
function load(){try{return {...defaultState,...JSON.parse(localStorage.getItem(KEY))}}catch{return structuredClone(defaultState)}}
function save(){localStorage.setItem(KEY,JSON.stringify(state));render()}
function esc(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function dateText(){return new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'long'}).format(new Date())}
function minutes(t){return Math.round(t/60000)} function hours(n){return (n/60).toFixed(n%60?1:0)+'h'}

/* ── Toast（底部导航上方） ── */
function toast(t){const el=$('#toast');el.textContent=t;el.classList.add('show');clearTimeout(el._tid);el._tid=setTimeout(()=>el.classList.remove('show'),2400)}

/* ── Sheet 弹窗 ── */
function open(html){document.body.insertAdjacentHTML('beforeend','<div class="sheet-backdrop" onclick="if(event.target===this)this.remove()"><section class="sheet">'+html+'</section></div>')}
function close(){document.querySelector('.sheet-backdrop')?.remove()}

/* ── 状态计算 ── */
function activeTasks(){return state.tasks.filter(t=>['committed','candidate','active'].includes(t.status))}
function usedMinutes(){return state.sessions.reduce((n,s)=>n+(s.endedAt?minutes(new Date(s.endedAt)-new Date(s.startedAt)):0),0)}
function usedPct(){const cap=state.settings.capacity*60;return cap?Math.min(1,usedMinutes()/cap):0}
function remaining(){return Math.max(0,state.settings.capacity*60-usedMinutes()-activeTasks().filter(t=>t.status!=='active').reduce((n,t)=>n+(+t.estimate||0),0))}
function today(){return state.tasks.filter(t=>['committed','active'].includes(t.status)).sort((a,b)=>(a.priority||9)-(b.priority||9)).slice(0,3)}

/* ── 环形进度 SVG ── */
function ringSvg(pct,size,sw,cls){var r=(size-sw)/2,c=2*Math.PI*r,o=c*(1-pct);return '<svg viewBox="0 0 '+size+' '+size+'"><circle class="ring-bg" cx="'+(size/2)+'" cy="'+(size/2)+'" r="'+r+'" stroke-width="'+sw+'"/><circle class="'+cls+'" cx="'+(size/2)+'" cy="'+(size/2)+'" r="'+r+'" stroke-width="'+sw+'" stroke-dasharray="'+c+'" stroke-dashoffset="'+o+'"/></svg>'}

/* ── 空状态 ── */
function empty(icon,title,hint){return '<div class="empty-state"><div class="empty-icon">'+icon+'</div><div class="empty-label">'+title+'</div><div class="empty-hint">'+hint+'</div></div>'}

/* ════════════════════════════════════════════
   今日页
   ════════════════════════════════════════════ */
function pageToday(){var work=today(), life=state.life.filter(function(x){return x.status==='planned'}).slice(0,3), running=state.timer&&state.tasks.find(function(t){return t.id===state.timer.taskId}), subtitle=running?'专注在这一件事上':'今天，先做这一件'; return '\n <header class="masthead"><div><div class="brand">未尽</div><div class="brand-subtitle">你的个人 AI 秘书</div></div><button class="leaf-mark" onclick="settings()" aria-label="设置">⚙️</button></header>\n <div class="date-line">'+dateText()+' · '+subtitle+'</div>\n\n <section class="panel">\n  <div class="panel-label"><span class="emoji">📋</span> 工作</div>\n  '+(running?timerInlineHtml(running):work[0]?focusCardHtml(work[0],work.slice(1)):empty('📝','今天还没有工作承诺','把脑中的事告诉秘书，它会帮你归类和安排。'))+'\n </section>\n\n <section class="panel">\n  <div class="panel-label"><span class="emoji">🌿</span> 生活</div>\n  '+(life.length?life.map(lifeRowHtml).join(''):empty('🌸','生活也值得被留出时间','输入「和朋友吃饭」「大扫除」试试。'))+'\n </section>'}
function focusCardHtml(t,next){var rem=t.remaining?hours(t.remaining):hours(+t.estimate||0); return '\n <div class="focus-main"><div class="priority-badge">1</div><div class="focus-copy"><div class="task-name">'+esc(t.title)+'</div><div class="meta">预计剩余 <b>'+rem+'</b></div></div></div>\n <button class="btn-primary" style="margin-top:12px" onclick="startTimer(\''+t.id+'\')">▶&nbsp;&nbsp;开始计时</button>\n '+(next.length?'<div class="next-tasks">'+next.map(function(x,i){return '\n  <button class="next-task" onclick="startTimer(\''+x.id+'\')"><span class="seq">'+(i+2)+'</span><span class="title">'+esc(x.title)+'</span><span class="arrow">›</span></button>'}).join('')+'</div>':'')}
function timerInlineHtml(t){var sec=state.timer?Math.floor((Date.now()-new Date(state.timer.startedAt))/1000):0,h=String(Math.floor(sec/3600)).padStart(2,'0'),m=String(Math.floor(sec/60)%60).padStart(2,'0'),s=String(sec%60).padStart(2,'0'); return '\n <div style="text-align:center;padding:4px 0">\n  <div class="meta" style="margin-bottom:4px">正在专注</div>\n  <div style="font-family:var(--serif);font-size:18px;font-weight:700;margin-bottom:10px">'+esc(t.title)+'</div>\n  <div id="timer-text" style="font-family:var(--serif);font-size:30px;font-weight:700;letter-spacing:.03em;margin-bottom:12px">'+h+':'+m+':'+s+'</div>\n  <button class="btn-primary" onclick="openTimerOverlay(\''+t.id+'\')">打开专注面板</button>\n </div>'}
function lifeRowHtml(x){return '\n <div class="life-item"><div class="life-icon">'+(x.kind==='relation'?'💬':'🏠')+'</div><div class="item-main"><div class="item-title">'+esc(x.title)+'</div><div class="meta">'+(x.when||'本周找合适时间')+' · 约 '+hours(+x.estimate||0)+'</div></div><button class="life-arrow" onclick="lifeDone(\''+x.id+'\')">›</button></div>'}

/* ════════════════════════════════════════════
   本周页
   ════════════════════════════════════════════ */
function pageWeek(){var tasks=activeTasks(), life=state.life.filter(function(x){return x.status==='planned'}), capPct=usedPct(), rem=remaining(); return '\n <header class="topbar"><div><div class="brand">本周</div><div class="subtitle">先看真实容量，再做承诺</div></div><button class="btn-icon" onclick="planWeek()">＋</button></header>\n\n <div class="capacity-card">\n  <div class="capacity-ring">'+ringSvg(Math.min(1,capPct),80,8,'ring-fill')+'<div class="ring-center">'+Math.round(capPct*100)+'%</div></div>\n  <div class="capacity-info"><div class="main-text">还可以承诺 '+hours(rem)+'</div><div class="sub-text">已记录 '+hours(usedMinutes())+' · 设置容量 '+state.settings.capacity+'h</div></div>\n </div>\n <button class="btn-primary" style="margin-top:14px" onclick="planWeek()">和秘书做周计划</button>\n\n <div class="section-title">工作承诺 <span class="count">'+tasks.length+' 项</span></div>\n <div class="task-list">'+(tasks.length?tasks.map(taskRowHtml).join(''):empty('📋','还没有本周承诺','在输入框告诉秘书你想做的事。'))+'</div>\n\n <div class="section-title">生活安排 <span class="count">'+life.length+' 项</span></div>\n <div class="task-list">'+(life.length?life.map(lifeRowHtml).join(''):empty('🌸','生活也可以被留出空间','输入你的生活安排，秘书会帮你记住。'))+'</div>'}
function taskRowHtml(t){var rem=t.remaining?'还剩 '+hours(t.remaining):'预计 '+hours(+t.estimate||0); return '\n <div class="task-row-wrap" data-task-id="'+t.id+'">\n  <div class="swipe-bg"><div class="swipe-action swipe-done" onclick="event.stopPropagation();finishTask(\''+t.id+'\')" data-action="done">✓</div><div class="swipe-action swipe-block" onclick="event.stopPropagation();blockTask(\''+t.id+'\')" data-action="block">⊘</div></div>\n  <div class="task-item" id="task-item-'+t.id+'">\n   <button class="btn-done '+(t.status==='done'?'is-done':'')+'" onclick="event.stopPropagation();finishTask(\''+t.id+'\')">'+(t.status==='done'?'✓':'○')+'</button>\n   <div class="item-main"><div class="item-title">'+esc(t.title)+'</div><div class="meta">'+esc(t.project||'未归属项目')+' · '+rem+'</div></div>\n   <div class="item-actions"><button class="btn-sm" onclick="event.stopPropagation();startTimer(\''+t.id+'\')">▶</button><button class="btn-sm" onclick="event.stopPropagation();taskMenu(\''+t.id+'\')">⋮</button></div>\n  </div>\n </div>'}

/* ════════════════════════════════════════════
   周报页
   ════════════════════════════════════════════ */
function pageReports(){var r=buildReport(); return '\n <header class="topbar"><div><div class="brand">周报</div><div class="subtitle">事实、原因、下一步</div></div><button class="btn-icon" onclick="exportMenu()">⇩</button></header>\n\n <div class="kpis">\n  <div class="kpi"><span class="kpi-num">'+r.done+'/'+r.total+'</span><span class="kpi-label">本周工作完成</span></div>\n  <div class="kpi"><span class="kpi-num">'+hours(r.actual)+'</span><span class="kpi-label">实际专注投入</span></div>\n  <div class="kpi"><span class="kpi-num">'+r.bias+'</span><span class="kpi-label">平均估时偏差</span></div>\n  <div class="kpi"><span class="kpi-num">'+hours(remaining())+'</span><span class="kpi-label">剩余可靠容量</span></div>\n </div>\n\n <section class="report-card"><h3>本周承诺</h3><ul class="report-list">'+(r.lines||'<li>先录入本周要做的事。</li>')+'</ul></section>\n <section class="report-card"><h3>秘书的判断</h3><div class="report-advice"><p>'+r.advice+'</p></div></section>\n <section class="report-card"><h3>下周建议</h3><ul class="report-suggest"><li>延续仍有价值的未完成项，不自动背债。</li><li>按本周实际数据，再确认下周承诺。</li><li>周六保持完整休息，不排工作承诺。</li></ul></section>\n\n <button class="btn-primary" onclick="saveReport()">保存本周周报</button>'}
function buildReport(){var ts=state.tasks.filter(function(t){return t.status!=='later'}), done=ts.filter(function(t){return t.status==='done'}), estimates=done.reduce(function(n,t){return n+(+t.estimate||0)},0), actual=state.sessions.reduce(function(n,s){return n+(s.endedAt?minutes(new Date(s.endedAt)-new Date(s.startedAt)):0)},0), bias=estimates?String(Math.round((actual-estimates)/estimates*100))+'%':'暂无'; return {total:ts.length,done:done.length,actual:actual,bias:bias,lines:ts.map(function(t){var cls=t.status==='done'?'done':''; return '<li class="'+cls+'">'+esc(t.title)+'<br><small style="color:var(--muted)">'+label(t.status)+' · 预计 '+hours(+t.estimate||0)+(t.remaining?' · 还剩 '+hours(t.remaining):'')+'</small></li>'}).join(''),advice:ts.length===0?'先把下一周真正想完成的事录入。':remaining()<0?'这周的承诺已经超过可靠容量。先顺延代价最小的一项，而不是依赖熬夜偿还。':done.length<ts.length?'未完成并不说明投入不足。先检查估时、受阻和可用容量，再决定下周是否延续。':'你兑现了本周承诺。下周可以小幅增加挑战，但仍保留缓冲。'}}
function saveReport(){var r=buildReport();state.reports.unshift({id:id(),createdAt:new Date().toISOString(),done:r.done,total:r.total,actual:r.actual,bias:r.bias,lines:r.lines,advice:r.advice});save();toast('周报已保存到本机')}

/* ════════════════════════════════════════════
   设置页
   ════════════════════════════════════════════ */
function pageSettings(){return '\n <header class="topbar"><div><div class="brand">设置</div><div class="subtitle">数据只保留在这台设备</div></div></header>\n\n <section class="setting-card"><div class="eyebrow">安装应用</div><p>安装后会以独立应用打开，不显示浏览器地址栏。</p><button class="btn-primary" onclick="installApp()">安装未尽</button></section>\n\n <section class="setting-card"><div class="eyebrow">DeepSeek AI</div><p>密钥不会写进 GitHub，只保存于浏览器。</p><div class="field"><label>API Key</label><input id="api-key" type="password" placeholder="sk-..." value="'+esc(state.settings.apiKey)+'"></div><button class="btn-primary" onclick="saveSettings()">保存设置</button></section>\n\n <section class="setting-card"><div class="eyebrow">本周容量</div><div class="field"><label>本周可承诺专注时长（小时）</label><input id="capacity" type="number" min="1" max="100" value="'+state.settings.capacity+'"></div><button class="btn-secondary" onclick="saveSettings()">更新容量</button></section>\n\n <section class="setting-card"><div class="eyebrow">数据</div><p>可导出完整备份，换手机前请先保存 JSON 文件。</p><button class="btn-secondary" onclick="exportMenu()">导出与备份</button></section>'}

/* ════════════════════════════════════════════
   计时器全屏浮层
   ════════════════════════════════════════════ */
function openTimerOverlay(taskId){var t=state.tasks.find(function(x){return x.id===taskId});if(!t)return; document.body.insertAdjacentHTML('beforeend','\n<div class="timer-overlay" id="timer-overlay">\n <button class="timer-close" onclick="closeTimerOverlay()">✕</button>\n <div class="timer-label">正在专注</div>\n <div class="timer-task">'+esc(t.title)+'</div>\n <div class="timer-ring">'+ringSvg(0,200,6,'ring-fill')+'<div class="timer-display" id="timer-display">00:00:00</div></div>\n <div class="timer-actions"><button class="btn-secondary" onclick="pauseTimer()">⏸ 暂停</button><button class="btn-primary" onclick="finishTask(\''+taskId+'\');closeTimerOverlay()">✓ 结束</button></div>\n</div>'); _timerRAF=requestAnimationFrame(timerOverlayTick)}
function closeTimerOverlay(){cancelAnimationFrame(_timerRAF);document.getElementById('timer-overlay')?.remove();render()}
function timerOverlayTick(){if(!state.timer){closeTimerOverlay();return}var d=Date.now()-new Date(state.timer.startedAt),totalSec=Math.floor(d/1000),h=String(Math.floor(totalSec/3600)).padStart(2,'0'),m=String(Math.floor(totalSec/60)%60).padStart(2,'0'),s=String(totalSec%60).padStart(2,'0'),el=document.getElementById('timer-display');if(el)el.textContent=h+':'+m+':'+s;var task=state.tasks.find(function(x){return x.id===state.timer.taskId}),totalEst=((+task?.estimate||60)*60),pct=Math.min(1,totalSec/totalEst),ring=document.querySelector('#timer-overlay .ring-fill');if(ring){var r=(200-6)/2,c=2*Math.PI*r;ring.setAttribute('stroke-dashoffset',c*(1-pct))}_timerRAF=requestAnimationFrame(timerOverlayTick)}

/* ════════════════════════════════════════════
   滑动操作
   ════════════════════════════════════════════ */
function swipeStart(e,taskId){var item=document.getElementById('task-item-'+taskId);if(!item)return; _swipeState={taskId:taskId,item:item,startX:e.touches?e.touches[0].clientX:e.clientX,startY:e.touches?e.touches[0].clientY:e.clientY,offset:0}}
function swipeMove(e){if(!_swipeState)return;var clientX=e.touches?e.touches[0].clientX:e.clientX,clientY=e.touches?e.touches[0].clientY:e.clientY,dx=clientX-_swipeState.startX,dy=clientY-_swipeState.startY;if(Math.abs(dy)>Math.abs(dx))return; e.preventDefault();var offset=Math.min(0,Math.max(-144,dx));_swipeState.offset=offset;_swipeState.item.style.transform='translateX('+offset+'px)'}
function swipeEnd(){if(!_swipeState)return;var offset=_swipeState.offset; if(offset<-100)_swipeState.item.style.transform='translateX(-144px)';else _swipeState.item.style.transform='translateX(0)'; _swipeState=null}
function bindSwipes(){document.querySelectorAll('.task-row-wrap').forEach(function(wrap){var item=wrap.querySelector('.task-item');if(!item)return;var taskId=wrap.dataset.taskId;item.addEventListener('touchstart',function(e){swipeStart(e,taskId)},{passive:false});item.addEventListener('touchmove',swipeMove,{passive:false});item.addEventListener('touchend',swipeEnd)})}

/* ════════════════════════════════════════════
   渲染
   ════════════════════════════════════════════ */
function render(){var pages={today:pageToday,week:pageWeek,reports:pageReports,settings:pageSettings}; $('#app').innerHTML=pages[view]()+(view==='settings'?'':dockHtml())+navHtml();if(view==='week')bindSwipes();if(state.timer&&view==='today')tickInline()}
function dockHtml(){return '<form class="input-dock" onsubmit="capture(event)"><input id="capture" autocomplete="off" placeholder="告诉秘书…" value="'+esc(draftText)+'"><button class="send" aria-label="发送">↑</button></form>'}
function navHtml(){var tabs=[{view:'today',label:'今天',icon:'🏠'},{view:'week',label:'本周',icon:'📅'},{view:'reports',label:'周报',icon:'📊'},{view:'settings',label:'设置',icon:'⚙️'}]; return '<nav class="nav">'+tabs.map(function(t){return '\n <button class="'+(view===t.view?'active':'')+'" onclick="go(\''+t.view+'\')"><span class="nav-icon">'+t.icon+'</span>'+t.label+'</button>'}).join('')+'</nav>'}
function go(v){view=v;render()} function settings(){go('settings')}

/* 内联计时器刷新 */
function tickInline(){if(!state.timer)return;var el=$('#timer-text');if(!el||view!=='today')return;var d=Date.now()-new Date(state.timer.startedAt),h=String(Math.floor(d/3600000)).padStart(2,'0'),m=String(Math.floor(d/60000)%60).padStart(2,'0'),s=String(Math.floor(d/1000)%60).padStart(2,'0');el.textContent=h+':'+m+':'+s;setTimeout(function(){tickInline()},500)}

/* ════════════════════════════════════════════
   输入解析
   ════════════════════════════════════════════ */
function capture(e){e.preventDefault();var input=$('#capture');draftText=input.value.trim();if(!draftText)return;parseInput(draftText)}
async function parseInput(text){open('<h2>秘书正在整理</h2><p>先理解你说的任务和时间意图。</p><div class="notice">'+esc(text)+'</div>');var items=[];try{items=state.settings.apiKey?await aiParse(text):heuristic(text)}catch(e){items=heuristic(text);toast('AI 暂不可用，已用本地规则整理')}showDraft(items,text)}
function heuristic(text){var life=/姐姐|朋友|老公|家里|被单|被套|大扫除|家庭财务|吃饭|聊天/.test(text);var status=/下周|以后|暂缓|先录入/.test(text)?'later':/候选|最好|想做/.test(text)?'candidate':'committed';var clean=text.replace(/这周|需要|完成|安排|先录入|下周|估计没办法|，/g,' ').trim();return clean.split(/[、；;\n]|和/).filter(function(s){return s.trim().length>1}).map(function(s){return {title:s.trim(),type:life?'life':'work',status:status,project:'',estimate:life?30:60,reason:status==='later'?'已识别为以后再说':'建议本周处理'}})}
async function aiParse(text){var prompt='你是中文个人秘书。根据用户输入抽取工作或生活安排。返回纯 JSON 数组，不要 markdown。字段：title,type(work|life),status(committed|candidate|later|blocked),project,estimate(分钟整数),kind(relation|home|other),reason。用户输入：'+text;var r=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+state.settings.apiKey},body:JSON.stringify({model:'deepseek-chat',temperature:.2,response_format:{type:'json_object'},messages:[{role:'system',content:'只输出 {"items":[...]}。估时无法判断时工作60分钟、生活30分钟。'},{role:'user',content:prompt}]})});if(!r.ok)throw Error('API');var data=await r.json();return JSON.parse(data.choices[0].message.content).items}
function showDraft(items,text){var body=items.map(function(x,i){return '\n <div class="task-draft"><div class="draft-title">'+esc(x.title)+'</div><div class="draft-meta">'+(x.type==='life'?'生活安排':'工作')+' · '+label(x.status)+(x.project?' · '+esc(x.project):'')+' · 预估 <input id="est-'+i+'" type="number" min="5" value="'+(x.estimate||60)+'"> 分钟</div></div>'});close();open('<h2>这样理解对吗？</h2><p>你的原话优先。秘书只在容量或依赖冲突时提出建议。</p>'+body+'<button class="btn-primary" onclick=\'confirmDraft('+JSON.stringify(items).replace(/'/g,"&#39;")+')\'>确认录入</button><button class="btn-text" onclick="close()">返回修改</button>')}
function label(s){return ({committed:'本周承诺',candidate:'本周候选',later:'以后再说',blocked:'受阻',done:'已完成',active:'进行中'}[s]||s)}
function confirmDraft(items){items.forEach(function(x,i){x.estimate=+document.querySelector('#est-'+i).value||60;if(x.type==='life')state.life.push({id:id(),title:x.title,kind:x.kind||'home',estimate:x.estimate,status:'planned',when:'本周找合适时间'});else state.tasks.push({id:id(),title:x.title,project:x.project||'',estimate:x.estimate,remaining:0,status:x.status,priority:x.status==='committed'?1:5,createdAt:new Date().toISOString()})});close();var over=remaining()<0;save();toast(over?'已录入，但本周超容量，请到本周页决定取舍。':'已录入。秘书会按你的承诺安排。')}

/* ════════════════════════════════════════════
   计时器操作
   ════════════════════════════════════════════ */
function startTimer(taskId){if(state.timer&&state.timer.taskId!==taskId){toast('请先暂停正在计时的任务');return}if(!state.timer){state.timer={taskId:taskId,startedAt:new Date().toISOString()};var t=state.tasks.find(function(x){return x.id===taskId});if(t)t.status='active';save();openTimerOverlay(taskId)}else{openTimerOverlay(taskId)}}
function pauseTimer(){if(!state.timer)return;state.sessions.push({id:id(),taskId:state.timer.taskId,startedAt:state.timer.startedAt,endedAt:new Date().toISOString()});var t=state.tasks.find(function(x){return x.id===state.timer.taskId});if(t)t.status='committed';state.timer=null;closeTimerOverlay();save();toast('已暂停，真实投入已记录')}

/* ════════════════════════════════════════════
   任务操作
   ════════════════════════════════════════════ */
function finishTask(taskId){if(state.timer?.taskId===taskId)pauseTimer();var t=state.tasks.find(function(x){return x.id===taskId});if(!t)return;open('<h2>这件事完成了吗？</h2><p>未完成也不是失败。告诉秘书还需多久。</p><div class="notice">'+esc(t.title)+'</div><div class="row" style="margin-top:16px"><button class="btn-secondary" onclick="markRemaining(\''+taskId+'\')">还没完成</button><button class="btn-primary" onclick="markDone(\''+taskId+'\')">已完成</button></div>')}
function markDone(taskId){var t=state.tasks.find(function(x){return x.id===taskId});t.status='done';t.completedAt=new Date().toISOString();close();save();toast('完成已记录 ✓')}
function markRemaining(taskId){var t=state.tasks.find(function(x){return x.id===taskId});close();open('<h2>还需要多久？</h2><p>校准预估，不是自我批评。</p><div class="field"><label>预计剩余分钟</label><input id="remain" type="number" min="5" value="'+(t.remaining||t.estimate||60)+'"></div><button class="btn-primary" onclick="saveRemaining(\''+taskId+'\')">保存并重排</button>')}
function saveRemaining(taskId){var t=state.tasks.find(function(x){return x.id===taskId});t.remaining=+$('#remain').value||0;t.status='committed';close();save();toast(remaining()<0?'剩余工作已更新。本周已超容量，请重排。':'剩余工作已纳入本周。')}
function lifeDone(i){var x=state.life.find(function(x){return x.id===i});x.status='done';save();toast('已记录。生活不是 KPI。')}
function taskMenu(i){var t=state.tasks.find(function(x){return x.id===i});open('<h2>'+esc(t.title)+'</h2><p>'+(t.project?'项目：'+esc(t.project):'尚未归属项目')+'</p><button class="btn-secondary" onclick="blockTask(\''+i+'\')">标记受阻</button><button class="btn-secondary danger" onclick="removeTask(\''+i+'\')">删除此项</button>')}
function blockTask(i){var t=state.tasks.find(function(x){return x.id===i});t.status='blocked';close();save();toast('已标记受阻，不再占用今日目标。')}
function removeTask(i){state.tasks=state.tasks.filter(function(x){return x.id!==i});close();save();toast('已移除')}
function planWeek(){var rem=remaining();open('<h2>本周容量检查</h2><p>秘书不会默默把新事塞进你的一周。</p><div class="notice '+(rem<0?'warn':'')+'">'+(rem>=0?'还可承诺 '+hours(rem)+'。':'本周已超容量 '+hours(-rem)+'。需要顺延、降级，或明确开启例外冲刺。')+'</div><p>周日 20:00-23:30 是默认规划窗口。周六不安排工作承诺。</p><button class="btn-primary" onclick="close()">我知道了</button>')}

/* ════════════════════════════════════════════
   导出
   ════════════════════════════════════════════ */
function download(name,type,data){var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([data],{type:type}));a.download=name;a.click();URL.revokeObjectURL(a.href)}
function exportMenu(){open('<h2>导出与备份</h2><p>导出后可换手机恢复。请妥善保管，JSON 包含本地设置。</p><button class="btn-primary" onclick="download(\'未尽-完整备份.json\',\'application/json\',JSON.stringify(state,null,2));close()">导出完整 JSON</button><button class="btn-secondary" style="margin-top:9px;width:100%" onclick="exportMd()">导出本周周报 Markdown</button><button class="btn-secondary" style="margin-top:9px;width:100%" onclick="exportCsv()">导出任务 CSV</button>')}
function exportMd(){var r=buildReport();var md='# 未尽 · 本周周报\n\n- 完成：'+r.done+'/'+r.total+'\n- 实际专注：'+hours(r.actual)+'\n- 估时偏差：'+r.bias+'\n\n## 秘书的判断\n'+r.advice+'\n';download('未尽-本周周报.md','text/markdown;charset=utf-8',md);close()}
function exportCsv(){var rows=['任务,项目,状态,预计分钟,剩余分钟'];state.tasks.forEach(function(t){rows.push([t.title,t.project,label(t.status),t.estimate,t.remaining||''].map(function(v){return '"'+String(v).replace(/"/g,'""')+'"'}).join(','))});download('未尽-任务.csv','text/csv;charset=utf-8','﻿'+rows.join('\n'));close()}
function saveSettings(){state.settings.apiKey=$('#api-key').value.trim();state.settings.capacity=+$('#capacity').value||10;save();toast('设置已保存在本机')}

/* ════════════════════════════════════════════
   PWA
   ════════════════════════════════════════════ */
async function installApp(){if(deferredInstallPrompt){deferredInstallPrompt.prompt();var result=await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;toast(result.outcome==='accepted'?'正在安装未尽':'已取消安装');return}open('<h2>安装未尽</h2><p>请用 Chrome 打开本页，点击右上角菜单，选择"安装应用"或"安装未尽"。</p><button class="btn-primary" onclick="close()">我知道了</button>')}
window.addEventListener('beforeinstallprompt',function(event){event.preventDefault();deferredInstallPrompt=event;render()});window.addEventListener('appinstalled',function(){deferredInstallPrompt=null;toast('未尽已安装到桌面')});

/* ════════════════════════════════════════════
   启动
   ════════════════════════════════════════════ */
if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js?v=4');
render();
