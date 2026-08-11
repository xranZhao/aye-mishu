/* 未尽：单人自用、离线优先的 AI 秘书。数据与 DeepSeek Key 只保存在本机。 */
const KEY = 'weijin-state-v1';
const APP_VERSION = '2026.08.11-3';
const MODEL = 'deepseek-v4-pro';
const API_URL = 'https://api.deepseek.com/chat/completions';
const $ = selector => document.querySelector(selector);
const id = () => crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2);

const PROJECT_SEED = [
  { name: '主业', group: '', status: 'fixed', priority: 1, outcome: '守住稳定现金流和保障', monthlyBudgetMinutes: 0 },
  { name: '阿野在武汉', group: '阿野IP', status: 'focus', priority: 1, protected: true, outcome: '抓住主业变化窗口，发布连贯真实内容并验证关注、互动和私域连接', monthlyBudgetMinutes: 0 },
  { name: '是阿野吖', group: '阿野IP', status: 'secondary', priority: 2, outcome: '出现适合深入表达的选题时独立创作', monthlyBudgetMinutes: 0 },
  { name: '磕学家', group: '', status: 'maintenance', priority: 3, outcome: '维护已验证的收入渠道', monthlyBudgetMinutes: 480 },
  { name: '家庭财务', group: '', status: 'maintenance', priority: 2, outcome: '处理本月真正重要的家庭财务事项', monthlyBudgetMinutes: 0 },
  { name: '基金理财', group: '', status: 'low', priority: 4, outcome: '低频学习与实践，不用学习焦虑占满时间', monthlyBudgetMinutes: 0 },
  { name: '任推帮', group: '', status: 'opportunity', priority: 4, outcome: '有明确收益机会时再投入', monthlyBudgetMinutes: 0 },
  { name: '神图', group: '', status: 'paused', priority: 5, outcome: '暂停保存，等待重新激活', monthlyBudgetMinutes: 0 },
  { name: 'PPT接单', group: '', status: 'paused', priority: 5, outcome: '暂停保存，等待客源或明确机会', monthlyBudgetMinutes: 0 }
];

const PROJECT_DECISION_SEED = [
  {
    concept: '同人文创作',
    aliases: ['同人文创作', '同人文流程', '同人创作', '同人内容生产'],
    decision: 'map_existing',
    project: '磕学家',
    workstream: '同人内容生产'
  }
];

const LEGACY_META_PATTERN = /^(这是个测试|我把本周的任务梳理一下|我把本周任务梳理一下|本周任务梳理一下)$/;

const defaultState = {
  schemaVersion: 3,
  tasks: [],
  life: [],
  projects: PROJECT_SEED,
  sessions: [],
  reports: [],
  monthlyReviews: [],
  incomeRecords: [],
  specialWeeks: [],
  reportDrafts: {},
  projectDecisions: PROJECT_DECISION_SEED,
  legacyReviewAcknowledged: false,
  timer: null,
  secretary: { messages: [], session: null, proposal: null, error: null, busy: false },
  settings: { apiKey: '', personalCapacity: 7, mainCapacity: 20, reminderTime: '22:30' }
};

let state = load();
let view = 'today';
let reportMode = 'weekly';
let draftText = '';
let deferredInstallPrompt = null;
let _swipeState = null;
let _timerRAF = null;
let _scrollSecretaryAfterRender = false;

/* ── 数据迁移与基础工具 ── */
function isoDate(value) {
  const date = value ? new Date(value) : new Date();
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

function weekStartOf(value) {
  const date = value ? new Date(value) : new Date();
  const day = date.getDay() || 7;
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - day + 1);
  return isoDate(date);
}

function addDays(date, days) {
  const value = new Date(date + 'T12:00:00');
  value.setDate(value.getDate() + days);
  return isoDate(value);
}

function currentWeekStart() { return weekStartOf(new Date()); }
function nextWeekStart() { return addDays(currentWeekStart(), 7); }
function monthKey(value) { return isoDate(value).slice(0, 7); }

function planningWeekStart() {
  const now = new Date();
  return now.getDay() === 0 && now.getHours() >= 20 ? nextWeekStart() : currentWeekStart();
}

function ensureProjects(projects) {
  const existing = Array.isArray(projects) ? projects : [];
  return PROJECT_SEED.map(seed => ({ ...seed, ...(existing.find(item => item.name === seed.name) || {}), id: existing.find(item => item.name === seed.name)?.id || id() }))
    .concat(existing.filter(item => !PROJECT_SEED.some(seed => seed.name === item.name)));
}

function normalizeConcept(value = '') {
  return String(value).toLowerCase().replace(/[\s，。、“”‘’：:（）()\-_]/g, '').replace(/项目$/g, '');
}

function ensureProjectDecisions(decisions) {
  const existing = Array.isArray(decisions) ? decisions : [];
  return PROJECT_DECISION_SEED.map(seed => {
    const found = existing.find(item => normalizeConcept(item.concept) === normalizeConcept(seed.concept));
    return { ...seed, ...(found || {}), aliases: Array.from(new Set([...(seed.aliases || []), ...(found?.aliases || [])])) };
  }).concat(existing.filter(item => !PROJECT_DECISION_SEED.some(seed => normalizeConcept(seed.concept) === normalizeConcept(item.concept))));
}

function decisionForConcept(value = '', decisions = state?.projectDecisions || PROJECT_DECISION_SEED) {
  const normalized = normalizeConcept(value);
  if (!normalized) return undefined;
  return (decisions || []).find(item => [item.concept, ...(item.aliases || [])].some(alias => {
    const candidate = normalizeConcept(alias);
    return candidate && (normalized.includes(candidate) || candidate.includes(normalized));
  }));
}

function inferProjectPath(title = '', project = '', workstream = '', decisions = state?.projectDecisions || PROJECT_DECISION_SEED) {
  const decision = decisionForConcept(project || title, decisions);
  if (decision?.decision === 'map_existing') return { project: decision.project, workstream: decision.workstream || workstream || '' };
  if (project) return { project, workstream };
  if (/同人文|同人创作|同人流程/.test(title)) return { project: '磕学家', workstream: '同人内容生产' };
  if (/家庭财务|财务系统/.test(title)) return { project: '家庭财务', workstream: '财务系统' };
  if (/阿野/.test(title) && /视频|引流|武汉/.test(title)) return { project: '阿野在武汉', workstream: '视频内容' };
  if (/是阿野吖/.test(title)) return { project: '是阿野吖', workstream: '公众号内容' };
  return { project: '', workstream };
}

function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY)) || {};
    const oldCapacity = Number(parsed.settings?.capacity);
    const merged = {
      ...structuredClone(defaultState),
      ...parsed,
      schemaVersion: 3,
      settings: {
        ...defaultState.settings,
        ...(parsed.settings || {}),
        personalCapacity: Number(parsed.settings?.personalCapacity) || (parsed.schemaVersion >= 2 ? oldCapacity : 7) || 7,
        mainCapacity: Number(parsed.settings?.mainCapacity) || 20
      },
      secretary: { ...defaultState.secretary, ...(parsed.secretary || {}), busy: false }
    };
    merged.projects = ensureProjects(merged.projects);
    merged.projectDecisions = ensureProjectDecisions(merged.projectDecisions);
    const upgradingFrom = Number(parsed.schemaVersion) || 1;
    merged.tasks = (merged.tasks || []).map(task => {
      let status = task.status === 'candidate' ? 'committed' : task.status;
      let weekStart = task.weekStart || (status === 'later' ? nextWeekStart() : currentWeekStart());
      let plannedDate = task.plannedDate || '';
      if (weekStart <= currentWeekStart() && status === 'later') status = 'pending_review';
      if (plannedDate && plannedDate < isoDate() && ['committed', 'active', 'paused'].includes(status)) status = 'overdue';
      if (!plannedDate && ['committed', 'active', 'paused'].includes(status)) status = 'pending_review';
      if (LEGACY_META_PATTERN.test(String(task.title || '').trim())) status = 'legacy_review';
      const path = inferProjectPath(task.title, task.project, task.workstream, merged.projectDecisions);
      if (!path.project && ['committed', 'active', 'paused'].includes(status)) { status = 'pending_review'; plannedDate = ''; }
      const pool = task.capacityPool || (path.project === '主业' ? 'main' : 'personal');
      return {
        ...task,
        status,
        capacityPool: pool,
        weekStart,
        plannedDate,
        project: path.project,
        workstream: path.workstream,
        supportsProjects: Array.isArray(task.supportsProjects) ? task.supportsProjects : [],
        source: task.source || (upgradingFrom < 3 ? 'legacy' : 'user'),
        createdByVersion: task.createdByVersion || (upgradingFrom < 3 ? 'legacy' : APP_VERSION),
        dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn : [],
        externalConditions: Array.isArray(task.externalConditions) ? task.externalConditions : []
      };
    });
    const activeByDate = {};
    merged.tasks.filter(task => task.plannedDate && ['committed', 'active', 'paused'].includes(task.status)).forEach(task => {
      activeByDate[task.plannedDate] = activeByDate[task.plannedDate] || [];
      activeByDate[task.plannedDate].push(task);
    });
    Object.values(activeByDate).forEach(items => {
      items.sort((a, b) => (a.priority || 9) - (b.priority || 9)).slice(3).forEach(task => {
        task.status = 'pending_review';
        task.plannedDate = '';
      });
    });
    const migratedLifeTasks = [];
    merged.life = (merged.life || []).map(item => {
      if (/家庭财务|财务系统/.test(item.title || '') && !/缴费|交费|采购|买/.test(item.title || '')) {
        migratedLifeTasks.push({ id: item.id || id(), title: item.title, project: '家庭财务', workstream: '财务系统', estimate: +item.estimate || 60, remaining: 0, status: 'pending_review', priority: 2, createdAt: item.createdAt || new Date().toISOString(), weekStart: item.weekStart || currentWeekStart(), plannedDate: '', dependsOn: [], externalConditions: [], supportsProjects: [], capacityPool: 'personal', source: 'legacy_life_reclassified', createdByVersion: APP_VERSION });
        return null;
      }
      return { ...item, weekStart: item.weekStart || currentWeekStart(), plannedDate: item.plannedDate || '', status: item.plannedDate ? (item.status || 'planned') : 'pending_review' };
    }).filter(Boolean);
    merged.tasks.push(...migratedLifeTasks);
    merged.sessions = (merged.sessions || []).map(session => ({
      ...session,
      durationMs: session.durationMs ?? (session.endedAt ? Math.max(0, new Date(session.endedAt) - new Date(session.startedAt)) : 0),
      weekStart: session.weekStart || weekStartOf(session.startedAt)
    }));
    if (merged.secretary.session) {
      const session = merged.secretary.session;
      session.candidates = (session.candidates || []).map(item => {
        const path = inferProjectPath(item.title, item.project, item.workstream, merged.projectDecisions);
        return { ...item, project: path.project, workstream: path.workstream };
      });
      session.suggestedProjects = (session.suggestedProjects || []).filter(suggestion => !decisionForConcept(suggestion.name, merged.projectDecisions));
    }
    if (merged.timer) merged.timer = { ...merged.timer, paused: merged.timer.paused ?? !merged.timer.startedAt };
    return merged;
  } catch (error) {
    console.error('读取本地数据失败', error);
    return structuredClone(defaultState);
  }
}

function persist() { localStorage.setItem(KEY, JSON.stringify(state)); }
function save() { persist(); render(); }
function esc(value = '') { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function minutes(ms) { return Math.round((+ms || 0) / 60000); }
function hours(value) { const number = Math.max(0, +value || 0); return (number / 60).toFixed(number % 60 ? 1 : 0) + 'h'; }

function durationText(ms) {
  const seconds = Math.max(0, Math.floor((+ms || 0) / 1000));
  if (seconds < 60) return seconds + '秒';
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return mins + '分钟';
  const hour = Math.floor(mins / 60);
  const rest = mins % 60;
  return hour + '小时' + (rest ? rest + '分钟' : '');
}

function dateText() {
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
}

function dayText(date) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short' }).format(new Date(date + 'T12:00:00'));
}

function label(status) {
  return ({ committed: '本周承诺', later: '下周', blocked: '受阻', overdue: '逾期待决', pending_review: '待重排', legacy_review: '旧版待清理', done: '已完成', active: '进行中', paused: '已暂停', cancelled: '已取消' }[status] || status);
}

function projectStatusLabel(status) {
  return ({ fixed: '固定基本盘', focus: '本月最高重点', secondary: '本月次重点', maintenance: '最低必要维护', low: '低频推进', opportunity: '机会型投入', paused: '暂停保存' }[status] || status);
}

function toast(text) {
  const element = $('#toast');
  if (!element) return;
  element.textContent = text;
  element.classList.add('show');
  clearTimeout(element._timer);
  element._timer = setTimeout(() => element.classList.remove('show'), 3000);
}

function open(html) {
  document.querySelector('.sheet-backdrop')?.remove();
  document.body.insertAdjacentHTML('beforeend', '<div class="sheet-backdrop" onclick="if(event.target===this)this.remove()"><section class="sheet">' + html + '</section></div>');
}

function close() { document.querySelector('.sheet-backdrop')?.remove(); }

/* ── 容量、依赖与时间 ── */
function taskPool(task) { return task.capacityPool || (task.project === '主业' ? 'main' : 'personal'); }
function inCurrentWeek(item) { return (item.weekStart || currentWeekStart()) === currentWeekStart(); }

function activeTasks(pool) {
  return state.tasks.filter(task => inCurrentWeek(task)
    && ['committed', 'active', 'paused', 'blocked'].includes(task.status)
    && (!pool || taskPool(task) === pool));
}

function reviewTasks() {
  return state.tasks.filter(task => ['pending_review', 'legacy_review', 'overdue'].includes(task.status));
}

function taskActualMs(taskId) {
  let saved = state.sessions.filter(session => session.taskId === taskId).reduce((sum, session) => sum + (+session.durationMs || 0), 0);
  if (state.timer && state.timer.taskId === taskId && !state.timer.paused && state.timer.startedAt) {
    saved += Math.max(0, Date.now() - new Date(state.timer.startedAt));
  }
  return saved;
}

function usedMinutes(pool) {
  const ids = new Set(state.tasks.filter(task => !pool || taskPool(task) === pool).map(task => task.id));
  let total = state.sessions.filter(session => weekStartOf(session.startedAt) === currentWeekStart() && ids.has(session.taskId))
    .reduce((sum, session) => sum + (+session.durationMs || 0), 0);
  if (state.timer && !state.timer.paused && weekStartOf(state.timer.startedAt) === currentWeekStart() && ids.has(state.timer.taskId)) {
    total += Math.max(0, Date.now() - new Date(state.timer.startedAt));
  }
  return total / 60000;
}

function taskPendingMinutes(task) {
  if (task.status === 'done' || task.status === 'cancelled') return 0;
  if (+task.remaining > 0) return +task.remaining;
  return Math.max(0, (+task.estimate || 0) - taskActualMs(task.id) / 60000);
}

function capacityHours(pool) { return pool === 'main' ? state.settings.mainCapacity : state.settings.personalCapacity; }
function committedForecastMinutes(pool) { return usedMinutes(pool) + activeTasks(pool).reduce((sum, task) => sum + taskPendingMinutes(task), 0); }
function remaining(pool = 'personal') { return capacityHours(pool) * 60 - committedForecastMinutes(pool); }
function usedPct(pool) { const capacity = capacityHours(pool) * 60; return capacity ? Math.min(1, usedMinutes(pool) / capacity) : 0; }

function dependencyReady(task) {
  const internalReady = (task.dependsOn || []).every(depId => state.tasks.find(item => item.id === depId)?.status === 'done');
  return internalReady && !(task.externalConditions || []).length && !task.blockedReason;
}

function overdueTasks() {
  const today = isoDate();
  return state.tasks.filter(task => ['overdue', 'committed', 'active', 'paused'].includes(task.status)
    && task.plannedDate
    && task.plannedDate < today
    && !(state.timer && state.timer.taskId === task.id));
}

function todayTasks() {
  const today = isoDate();
  return state.tasks.filter(task => inCurrentWeek(task)
    && ['committed', 'active', 'paused'].includes(task.status)
    && task.plannedDate === today
    && dependencyReady(task))
    .sort((a, b) => (a.priority || 9) - (b.priority || 9))
    .slice(0, 3);
}

function nextSchedulableDate(date, type = 'work') {
  let result = date || isoDate();
  if (type === 'life') return result;
  while (new Date(result + 'T12:00:00').getDay() === 6) result = addDays(result, 1);
  return result;
}

function ringSvg(pct, size, strokeWidth, className) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  return '<svg viewBox="0 0 ' + size + ' ' + size + '"><circle class="ring-bg" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + radius + '" stroke-width="' + strokeWidth + '"/><circle class="' + className + '" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + radius + '" stroke-width="' + strokeWidth + '" stroke-dasharray="' + circumference + '" stroke-dashoffset="' + circumference * (1 - pct) + '"/></svg>';
}

function empty(icon, title, hint) {
  return '<div class="empty-state"><div class="empty-icon">' + icon + '</div><div class="empty-label">' + title + '</div><div class="empty-hint">' + hint + '</div></div>';
}

/* ── 今日页 ── */
function pageToday() {
  const work = todayTasks();
  const life = state.life.filter(item => inCurrentWeek(item) && item.status === 'planned' && item.plannedDate === isoDate()).slice(0, 3);
  const running = state.timer && state.tasks.find(task => task.id === state.timer.taskId);
  const overdue = reviewTasks();
  const subtitle = running ? (state.timer.paused ? '这件事已暂停' : '专注在这一件事上') : '今天，先做这一件';
  return '\n<header class="masthead"><div><div class="brand">未尽</div><div class="brand-subtitle">你的个人 AI 秘书</div></div><button class="leaf-mark" onclick="settings()" aria-label="设置">⚙️</button></header>'
    + '<div class="date-line">' + dateText() + ' · ' + subtitle + '</div>'
    + (overdue.length ? '<button class="overdue-card" onclick="startOverdueReview()"><span><b>' + overdue.length + ' 件事项等待重新判断</b><small>没有自动塞进今天，秘书先给集中处理建议</small></span><span>去处理 ›</span></button>' : '')
    + '<section class="panel"><div class="panel-label"><span class="emoji">📋</span> 工作</div>'
    + (running ? timerInlineHtml(running) : work[0] ? focusCardHtml(work[0], work.slice(1)) : empty('📝', '今天还没有确认的工作', '去「秘书」沟通，确认后才会进入今天。')) + '</section>'
    + '<section class="panel"><div class="panel-label"><span class="emoji">🌿</span> 生活</div>'
    + (life.length ? life.map(lifeRowHtml).join('') : empty('🌸', '今天没有生活安排', '关系和生活会占用时间，但不作为工作 KPI。')) + '</section>'
    + eveningSummaryHtml();
}

function focusCardHtml(task, next) {
  const actual = taskActualMs(task.id);
  const time = actual > 0 ? '已投入 ' + durationText(actual) + ' · 预计剩余约 ' + hours(taskPendingMinutes(task)) : '预计 ' + hours(+task.estimate || 0);
  return '<div class="focus-main"><div class="priority-badge">1</div><div class="focus-copy"><div class="task-name">' + esc(task.title) + '</div><div class="meta">' + time + '</div></div></div>'
    + '<button class="btn-primary" style="margin-top:12px" onclick="startTimer(\'' + task.id + '\')">▶&nbsp;&nbsp;' + (task.status === 'paused' ? '继续计时' : '开始计时') + '</button>'
    + (next.length ? '<div class="next-tasks">' + next.map((item, index) => '<button class="next-task" onclick="startTimer(\'' + item.id + '\')"><span class="seq">' + (index + 2) + '</span><span class="title">' + esc(item.title) + '</span><span class="arrow">›</span></button>').join('') + '</div>' : '');
}

function timerInlineHtml(task) {
  return '<div style="text-align:center;padding:4px 0"><div class="meta" style="margin-bottom:4px">' + (state.timer.paused ? '已暂停' : '正在专注') + '</div><div class="timer-inline-title">' + esc(task.title) + '</div><div id="timer-text" class="timer-inline-clock">' + timerClock(taskActualMs(task.id)) + '</div><button class="btn-primary" onclick="openTimerOverlay(\'' + task.id + '\')">打开专注面板</button></div>';
}

function lifeRowHtml(item) {
  return '<div class="life-item"><div class="life-icon">' + (item.kind === 'relation' ? '💬' : '🏠') + '</div><div class="item-main"><div class="item-title">' + esc(item.title) + '</div><div class="meta">' + (item.when || dayText(item.plannedDate)) + (item.estimate ? ' · 约 ' + hours(item.estimate) : '') + '</div></div><button class="life-arrow" onclick="lifeDone(\'' + item.id + '\')">›</button></div>';
}

function eveningSummaryHtml() {
  const [hour, minute] = String(state.settings.reminderTime || '22:30').split(':').map(Number);
  const now = new Date();
  if (now.getHours() * 60 + now.getMinutes() < hour * 60 + minute) return '';
  const today = isoDate();
  const invested = state.sessions.filter(session => isoDate(session.startedAt) === today).reduce((sum, session) => sum + (+session.durationMs || 0), 0);
  const left = activeTasks().filter(task => task.status !== 'blocked').length;
  const tomorrow = addDays(today, 1);
  const next = state.tasks.filter(task => inCurrentWeek(task) && task.plannedDate === tomorrow && ['committed', 'active', 'paused'].includes(task.status)).sort((a, b) => (a.priority || 9) - (b.priority || 9))[0];
  return '<section class="daily-summary"><div class="eyebrow">今日小结</div><p>今天投入了 <b>' + durationText(invested) + '</b>；本周还有 <b>' + left + '</b> 件未完成；明天最值得先做的是 <b>' + esc(next?.title || '尚未确认') + '</b>。</p></section>';
}

/* ── 本周日历 ── */
function pageWeek() {
  const personalRemaining = remaining('personal');
  const mainRemaining = remaining('main');
  const days = Array.from({ length: 7 }, (_, index) => addDays(currentWeekStart(), index));
  const nextItems = state.tasks.filter(task => task.status === 'later' || task.weekStart === nextWeekStart());
  const pending = reviewTasks();
  return '<header class="topbar"><div><div class="brand">本周</div><div class="subtitle">周一到周日，只显示确认后的安排</div></div><button class="btn-icon" onclick="beginSecretaryMode(\'weekly\')">＋</button></header>'
    + (pending.length ? '<button class="review-banner" onclick="startOverdueReview()"><span><b>' + pending.length + ' 件旧事项等待整理</b><small>它们没有被悄悄塞进今天，交给秘书集中重排</small></span><span>去处理 ›</span></button>' : '')
    + '<div class="capacity-grid">' + capacityCardHtml('个人项目', 'personal', personalRemaining) + capacityCardHtml('主业', 'main', mainRemaining) + '</div>'
    + '<button class="btn-primary week-plan-button" onclick="beginSecretaryMode(\'weekly\')">和秘书做本周规划</button>'
    + '<div class="week-calendar">' + days.map(dayCardHtml).join('') + '</div>'
    + '<div class="section-title">下周事项 <span class="count">' + nextItems.length + ' 项</span></div>'
    + '<div class="task-list">' + (nextItems.length ? nextItems.map(taskRowHtml).join('') : empty('📥', '下周还没有事项', '只有你确认放到下周的事情才会出现在这里。')) + '</div>';
}

function capacityCardHtml(title, pool, value) {
  const pct = usedPct(pool);
  return '<div class="capacity-card compact"><div class="capacity-ring">' + ringSvg(pct, 80, 8, 'ring-fill') + '<div class="ring-center">' + Math.round(pct * 100) + '%</div></div><div class="capacity-info"><div class="pool-name">' + title + '</div><div class="main-text">' + (value >= 0 ? '余 ' + hours(value) : '超 ' + hours(-value)) + '</div><div class="sub-text">可靠容量 ' + capacityHours(pool) + 'h</div></div></div>';
}

function dayCardHtml(date) {
  const tasks = state.tasks.filter(task => inCurrentWeek(task) && task.plannedDate === date && ['committed', 'active', 'paused', 'blocked', 'done'].includes(task.status));
  const life = state.life.filter(item => inCurrentWeek(item) && item.plannedDate === date && ['planned', 'done'].includes(item.status));
  const isToday = date === isoDate();
  const isSaturday = new Date(date + 'T12:00:00').getDay() === 6;
  return '<section class="day-card ' + (isToday ? 'is-today' : '') + '"><div class="day-head"><span>' + dayText(date) + '</span>' + (isToday ? '<b>今天</b>' : '') + '</div>'
    + (tasks.length ? tasks.map(taskRowHtml).join('') : (isSaturday ? '<div class="rest-row">周六不排工作承诺</div>' : '<div class="day-empty">没有工作安排</div>'))
    + (life.length ? '<div class="day-life"><div class="day-section-label">生活安排</div>' + life.map(item => '<button onclick="lifeMenu(\'' + item.id + '\')">🌿 ' + esc(item.title) + '</button>').join('') + '</div>' : '') + '</section>';
}

function projectPath(task) {
  const parts = [task.project || '未归属项目'];
  if (task.workstream) parts.push(task.workstream);
  return parts.join(' / ');
}

function taskRowHtml(task) {
  const actual = taskActualMs(task.id);
  const remainingText = actual > 0 ? '已投入 ' + durationText(actual) + ' · 剩余约 ' + hours(taskPendingMinutes(task)) : '预计 ' + hours(+task.estimate || 0);
  const dependencyNames = (task.dependsOn || []).map(depId => state.tasks.find(item => item.id === depId)?.title).filter(Boolean);
  const blocked = task.status === 'blocked' || !dependencyReady(task);
  const blockedText = task.blockedReason || (dependencyNames.length ? '等待 ' + dependencyNames.join('、') : '当前受阻');
  return '<div class="task-row-wrap" data-task-id="' + task.id + '"><div class="swipe-bg"><div class="swipe-action swipe-done" onclick="event.stopPropagation();finishTask(\'' + task.id + '\')">✓</div><div class="swipe-action swipe-block" onclick="event.stopPropagation();blockTask(\'' + task.id + '\')">⊘</div></div><div class="task-item" id="task-item-' + task.id + '"><button class="btn-done" onclick="event.stopPropagation();finishTask(\'' + task.id + '\')">' + (task.status === 'done' ? '✓' : '○') + '</button><div class="item-main"><div class="item-title">' + esc(task.title) + '</div><div class="meta">' + esc(projectPath(task)) + ' · ' + label(task.status) + ' · ' + remainingText + (blocked ? ' · ' + esc(blockedText) : '') + '</div></div><div class="item-actions">' + (!blocked && task.status !== 'done' ? '<button class="btn-sm" onclick="event.stopPropagation();startTimer(\'' + task.id + '\')">▶</button>' : '') + '<button class="btn-sm" onclick="event.stopPropagation();taskMenu(\'' + task.id + '\')">⋮</button></div></div></div>';
}

/* ── 秘书沟通页 ── */
function pageSecretary() {
  const secretary = state.secretary;
  const session = secretary.session;
  const messages = secretary.messages.slice(-40);
  return '<header class="topbar secretary-head"><div><div class="brand">秘书</div><div class="subtitle">你说原话，我负责理解、追问和排程</div></div><button class="btn-icon" onclick="secretaryMenu()">⋯</button></header>'
    + (!state.settings.apiKey ? '<button class="ai-error-card" onclick="go(\'settings\')"><b>DeepSeek 尚未连接</b><span>先去设置 API Key；没有 AI 时不会用标点拆分代替。</span></button>' : '')
    + '<div class="secretary-actions"><button onclick="beginSecretaryMode(\'weekly\')">本周梳理</button><button onclick="beginSecretaryMode(\'midweek\')">新增事情</button><button onclick="beginSecretaryMode(\'change\')">情况变化</button></div>'
    + (session ? '<div class="session-strip"><span>' + sessionLabel(session.mode) + '</span><small>' + sessionStatusLabel(session.status) + '</small></div>' : '')
    + '<section class="conversation">' + (messages.length ? messages.map(messageHtml).join('') : secretaryWelcomeHtml()) + (secretary.busy ? busyMessageHtml() : '') + '</section>'
    + (session?.suggestedProjects?.length ? suggestedProjectsHtml(session.suggestedProjects) : '')
    + (secretary.error ? errorCardHtml(secretary.error) : '')
    + (secretary.proposal ? proposalHtml(secretary.proposal) : '')
    + (!secretary.proposal && session?.status === 'confirmed' && secretary.lastPlan ? confirmedPlanHtml(secretary.lastPlan) : '')
    + (session && ['collecting', 'clarifying'].includes(session.status) && !secretary.proposal ? '<p class="conversation-hint">继续输入即可；准备好了就直接说“开始排”。</p>' : '');
}

function secretaryWelcomeHtml() {
  return '<div class="secretary-welcome"><div class="welcome-mark">未尽</div><h2>把事情原样告诉我</h2><p>可以很乱，也可以分几次说。我会先确认自己理解得对不对，再给排程；不会按逗号拆任务。</p></div>';
}

function suggestedProjectsHtml(projects) {
  return '<section class="project-suggestions"><div class="proposal-kicker">先确认它属于哪个核心项目</div>' + projects.map((project, index) => {
    const path = inferProjectPath(project.name, project.existingProject || '', project.workstream || '');
    const recommended = path.project;
    return '<div class="project-suggestion"><div><b>' + esc(project.name) + '</b><p>' + esc(project.reason || '') + '</p><small>' + esc(recommended ? '秘书建议归入：' + recommended + (path.workstream ? ' / ' + path.workstream : '') : project.displaces || '只有独立长期结果才建立新项目') + '</small></div><div>'
      + (recommended ? '<button onclick="mapSuggestedProject(' + index + ',\'' + esc(recommended) + '\',\'' + esc(path.workstream) + '\')">归入' + esc(recommended) + '</button>' : '<button onclick="openProjectMapping(' + index + ')">选择归属</button>')
      + '<button class="muted" onclick="openProjectMapping(' + index + ')">其他项目</button><button class="muted" onclick="acceptSuggestedProject(' + index + ')">确实新建</button></div></div>';
  }).join('') + '</section>';
}

function acceptSuggestedProject(index) {
  const suggestion = state.secretary.session?.suggestedProjects?.[index];
  if (!suggestion || state.projects.some(project => project.name === suggestion.name)) return;
  state.projects.push({ id: id(), name: suggestion.name, group: suggestion.group || '', status: 'opportunity', priority: 4, outcome: suggestion.reason || '等待本月复盘确认长期结果', monthlyBudgetMinutes: 0 });
  state.secretary.session.suggestedProjects.splice(index, 1);
  appendMessage('assistant', '已建立项目「' + suggestion.name + '」。它不会自动获得额外容量，具体事项仍要单独确认。');
  save();
}

function rememberProjectDecision(suggestion, project, workstream) {
  const existing = decisionForConcept(suggestion.name);
  const aliases = Array.from(new Set([suggestion.name, ...(suggestion.aliases || []), ...(existing?.aliases || [])]));
  const decision = { concept: suggestion.name, aliases, decision: 'map_existing', project, workstream: workstream || '' };
  if (existing) Object.assign(existing, decision);
  else state.projectDecisions.push(decision);
}

function mapSuggestedProject(index, project, workstream = '') {
  const suggestion = state.secretary.session?.suggestedProjects?.[index];
  if (!suggestion) return;
  rememberProjectDecision(suggestion, project, workstream);
  const matches = item => item.project === suggestion.name || normalizeConcept(item.title).includes(normalizeConcept(suggestion.name));
  state.secretary.session.candidates.forEach(item => { if (matches(item)) { item.project = project; item.workstream = workstream; } });
  if (state.secretary.proposal?.items) state.secretary.proposal.items.forEach(item => { if (matches(item)) { item.project = project; item.workstream = workstream; } });
  state.secretary.session.suggestedProjects.splice(index, 1);
  appendMessage('assistant', '已记住：「' + suggestion.name + '」不是新项目，归入「' + project + (workstream ? ' / ' + workstream : '') + '」。以后不会再重复询问。');
  close();
  save();
}

function openProjectMapping(index) {
  const suggestion = state.secretary.session?.suggestedProjects?.[index];
  if (!suggestion) return;
  open('<h2>把它归入现有核心项目</h2><p>这次确认会成为秘书的长期归属记忆。</p><div class="field"><label>核心项目</label><select id="mapping-project">' + projectOptions('') + '</select></div><div class="field"><label>工作流 / 子项目</label><input id="mapping-workstream" placeholder="例如：同人内容生产"></div><button class="btn-primary" onclick="saveProjectMapping(' + index + ')">确认归属并记住</button>');
}

function saveProjectMapping(index) {
  const project = $('#mapping-project')?.value;
  if (!project) { toast('请选择一个核心项目'); return; }
  mapSuggestedProject(index, project, $('#mapping-workstream')?.value.trim() || '');
}

function messageHtml(message) {
  return '<div class="message ' + (message.role === 'user' ? 'user' : 'assistant') + '"><div class="message-role">' + (message.role === 'user' ? '你' : '秘书') + '</div><div class="message-body">' + esc(message.text).replace(/\n/g, '<br>') + '</div><time>' + new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(message.createdAt)) + '</time></div>';
}

function busyMessageHtml() {
  return '<div class="message assistant thinking"><div class="message-role">秘书</div><div class="message-body"><span></span><span></span><span></span> 正在核对项目、依赖和容量</div></div>';
}

function errorCardHtml(error) {
  return '<section class="ai-failure"><b>这次没有处理成功</b><p>' + esc(error.message) + '</p><div class="row"><button class="btn-secondary" onclick="clearSecretaryError()">先保留原话</button><button class="btn-primary" onclick="retrySecretary()">重试</button></div></section>';
}

function sessionLabel(mode) {
  return ({ weekly: '本周规划会话', midweek: '周中新增会话', change: '现实变化会话', overdue: '逾期处理会话', monthly: '月度项目复盘' }[mode] || '任务沟通');
}

function sessionStatusLabel(status) {
  return ({ collecting: '继续说，暂未写入计划', clarifying: '正在补齐关键信息', scheduling: '正在形成建议', proposed: '等待你确认', confirmed: '已经确认' }[status] || '沟通中');
}

function secretaryMenu() {
  open('<h2>秘书会话</h2><p>清空会话不会删除已经确认的任务、计时或周报。</p><button class="btn-secondary" onclick="newSecretarySession()">开始新的沟通</button><button class="btn-secondary danger" onclick="clearSecretaryHistory()">清空沟通记录</button>');
}

function proposalHtml(proposal) {
  if (proposal.type === 'monthly') return monthlyProposalHtml(proposal);
  const items = proposal.items || [];
  const changes = proposal.changes || [];
  const over = proposalOverCapacity(proposal);
  return '<section class="proposal"><div class="proposal-kicker">秘书的建议 · 你确认后才生效</div><h2>' + esc(proposal.title || '这样安排最可信') + '</h2><p class="proposal-summary">' + esc(proposal.summary || '') + '</p>'
    + (proposal.reasoning?.length ? '<ul class="reason-list">' + proposal.reasoning.map(reason => '<li>' + esc(reason) + '</li>').join('') + '</ul>' : '')
    + (proposal.executionAdvice?.length ? '<div class="execution-advice"><h3>建议这样完成</h3><ul>' + proposal.executionAdvice.map(item => '<li>' + esc(item) + '</li>').join('') + '</ul></div>' : '')
    + (changes.length ? '<div class="proposal-block"><h3>需要调整已有计划</h3>' + changes.map(changeHtml).join('') + '</div>' : '')
    + '<div class="proposal-block"><div class="proposal-block-head"><h3>' + (items.length ? '本周与后续安排' : '没有新增事项') + '</h3><button onclick="addProposalItem()">＋ 自加</button></div>' + proposalDayGroupsHtml(items) + '</div>'
    + (over ? '<div class="notice warn">' + esc(over) + '</div>' : '')
    + '<div class="proposal-actions">' + (!over ? '<button class="btn-primary" onclick="confirmProposal(false)">确认并写入计划</button>' : '<button class="btn-primary" onclick="moveProposalToNextWeek()">新事项放到下周</button><button class="btn-secondary" onclick="confirmProposal(true)">明确开启例外冲刺</button>') + '<button class="btn-text" onclick="discardProposal()">继续和秘书讨论</button></div></section>';
}

function proposalDayGroupsHtml(items, readonly = false) {
  const groups = new Map();
  (items || []).forEach(item => {
    const key = item.plannedDate || '待重排';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([date, rows]) => {
    const title = date === '待重排' ? date : (date >= nextWeekStart() ? '下周 · ' : '') + dayText(date);
    return '<section class="proposal-day"><div class="proposal-day-title">' + esc(title) + '</div>' + rows.sort((a, b) => (a.priority || 9) - (b.priority || 9)).map(item => readonly ? confirmedPlanItemHtml(item) : proposalItemHtml(item)).join('') + '</section>';
  }).join('');
}

function confirmedPlanItemHtml(item) {
  return '<div class="confirmed-plan-item"><div><b>' + esc(item.title) + '</b><small>' + esc([item.project, item.workstream].filter(Boolean).join(' / ') || (item.type === 'life' ? '生活安排' : '未归属')) + ' · ' + hours(item.estimate) + '</small></div>' + (item.approach ? '<p>' + esc(item.approach) + '</p>' : '') + '</div>';
}

function confirmedPlanHtml(plan) {
  return '<section class="proposal confirmed-plan"><div class="proposal-kicker">已确认的本周计划</div><h2>' + esc(plan.title || '本周这样推进') + '</h2><p class="proposal-summary">' + esc(plan.summary || '') + '</p>' + (plan.executionAdvice?.length ? '<div class="execution-advice"><h3>完成方式</h3><ul>' + plan.executionAdvice.map(item => '<li>' + esc(item) + '</li>').join('') + '</ul></div>' : '') + proposalDayGroupsHtml(plan.items || [], true) + '<button class="btn-secondary" onclick="go(\'week\')">查看周一至周日</button></section>';
}

function changeHtml(change) {
  const task = state.tasks.find(item => item.id === change.taskId);
  const action = change.action === 'next_week' ? '顺延到下周' : change.action === 'cancel' ? '取消' : change.action === 'activate' ? '解除受阻并安排到 ' + (change.plannedDate || '本周') : '调整到 ' + (change.plannedDate || '待定');
  return '<div class="change-row editable-change" data-change-id="' + change.taskId + '"><button class="change-remove" onclick="removeProposalChange(\'' + change.taskId + '\')">×</button><div><b>' + esc(task?.title || change.title || '已有事项') + '</b><small>' + esc(action) + '</small></div><p>' + esc(change.reason || '') + '</p><div class="change-controls"><select onchange="setProposalChangeField(\'' + change.taskId + '\',\'action\',this.value)"><option value="move" ' + (change.action === 'move' ? 'selected' : '') + '>改日期</option><option value="next_week" ' + (change.action === 'next_week' ? 'selected' : '') + '>放下周</option><option value="cancel" ' + (change.action === 'cancel' ? 'selected' : '') + '>取消</option><option value="activate" ' + (change.action === 'activate' ? 'selected' : '') + '>解除受阻</option></select><input type="date" value="' + esc(change.plannedDate || '') + '" onchange="setProposalChangeField(\'' + change.taskId + '\',\'plannedDate\',this.value)"></div></div>';
}

function projectOptions(selected) {
  const pending = selected && !state.projects.some(project => project.name === selected) ? '<option value="' + esc(selected) + '" selected>待确认新项目 / ' + esc(selected) + '</option>' : '';
  return '<option value="">未归属项目</option>' + pending + state.projects.map(project => '<option value="' + esc(project.name) + '" ' + (project.name === selected ? 'selected' : '') + '>' + esc(project.group ? project.group + ' / ' + project.name : project.name) + '</option>').join('');
}

function proposalItemHtml(item) {
  const dependencies = Array.isArray(item.dependsOn) ? item.dependsOn.join('、') : '';
  return '<article class="proposal-item" data-proposal-id="' + item.id + '"><button class="proposal-remove" onclick="removeProposalItem(\'' + item.id + '\')" aria-label="删除">×</button><div class="proposal-item-summary"><b>' + esc(item.title) + '</b><small>' + esc([item.project, item.workstream].filter(Boolean).join(' / ') || (item.type === 'life' ? '生活安排' : '未归属')) + ' · ' + hours(item.estimate) + '</small>' + (item.approach ? '<p>' + esc(item.approach) + '</p>' : '') + '</div><details><summary>编辑名称、归属、估时、日期和依赖</summary>'
    + '<div class="field"><label>事项名称</label><input value="' + esc(item.title) + '" onchange="setProposalField(\'' + item.id + '\',\'title\',this.value)"></div>'
    + '<div class="proposal-grid"><div class="field"><label>核心项目</label><select onchange="setProposalField(\'' + item.id + '\',\'project\',this.value)">' + projectOptions(item.project) + '</select></div><div class="field"><label>工作流 / 子项目</label><input value="' + esc(item.workstream || '') + '" onchange="setProposalField(\'' + item.id + '\',\'workstream\',this.value)"></div></div><div class="field"><label>类型</label><select onchange="setProposalField(\'' + item.id + '\',\'type\',this.value)"><option value="work" ' + (item.type !== 'life' ? 'selected' : '') + '>工作</option><option value="life" ' + (item.type === 'life' ? 'selected' : '') + '>生活</option></select></div>'
    + '<div class="proposal-grid three"><div class="field"><label>预计分钟</label><input type="number" min="5" value="' + (+item.estimate || '') + '" onchange="setProposalField(\'' + item.id + '\',\'estimate\',this.value)"></div><div class="field"><label>安排日期</label><input type="date" value="' + esc(item.plannedDate || '') + '" onchange="setProposalField(\'' + item.id + '\',\'plannedDate\',this.value)"></div><div class="field"><label>位置</label><select onchange="setProposalField(\'' + item.id + '\',\'status\',this.value)"><option value="committed" ' + (item.status !== 'later' ? 'selected' : '') + '>本周</option><option value="later" ' + (item.status === 'later' ? 'selected' : '') + '>下周</option></select></div></div>'
    + '<div class="field"><label>前置事项（用顿号分开）</label><input value="' + esc(dependencies) + '" placeholder="没有就留空" onchange="setProposalDependencies(\'' + item.id + '\',this.value)"></div>'
    + '<div class="field"><label>完成方式建议</label><input value="' + esc(item.approach || '') + '" onchange="setProposalField(\'' + item.id + '\',\'approach\',this.value)"></div>'
    + '<div class="field"><label>完成标准</label><input value="' + esc(item.completionDefinition || '') + '" onchange="setProposalField(\'' + item.id + '\',\'completionDefinition\',this.value)"></div>'
    + (item.externalConditions?.length ? '<div class="dependency-note">外部条件：' + esc(item.externalConditions.join('、')) + '</div>' : '')
    + '<p class="draft-reason">' + esc(item.reason || '') + '</p></details></article>';
}

/* ── 周报与月度项目复盘 ── */
function pageReports() {
  return '<header class="topbar"><div><div class="brand">复盘</div><div class="subtitle">事实、判断和下一步</div></div><button class="btn-icon" onclick="exportMenu()">⇩</button></header>'
    + '<div class="segmented"><button class="' + (reportMode === 'weekly' ? 'active' : '') + '" onclick="setReportMode(\'weekly\')">本周周报</button><button class="' + (reportMode === 'monthly' ? 'active' : '') + '" onclick="setReportMode(\'monthly\')">月度项目</button></div>'
    + (reportMode === 'weekly' ? weeklyReportHtml() : monthlyReportHtml());
}

function setReportMode(mode) { reportMode = mode; render(); }

function weeklyReportHtml() {
  const report = buildReport();
  const draft = state.reportDrafts[currentWeekStart()];
  const personalLeft = remaining('personal');
  return (reviewTasks().length ? '<button class="review-banner compact" onclick="startOverdueReview()"><span><b>' + reviewTasks().length + ' 件旧事项未计入正式周报</b><small>先集中清理或重排，避免测试数据污染判断</small></span><span>处理 ›</span></button>' : '')
    + '<div class="kpis"><div class="kpi"><span class="kpi-num">' + report.done + '/' + report.total + '</span><span class="kpi-label">本周工作完成</span></div><div class="kpi"><span class="kpi-num">' + hours(report.actualMinutes) + '</span><span class="kpi-label">实际专注投入</span></div><div class="kpi"><span class="kpi-num">' + report.bias + '</span><span class="kpi-label">已完成项估时偏差</span></div><div class="kpi ' + (personalLeft < 0 ? 'is-over' : '') + '"><span class="kpi-num">' + (personalLeft >= 0 ? hours(personalLeft) : '超 ' + hours(-personalLeft)) + '</span><span class="kpi-label">' + (personalLeft >= 0 ? '个人剩余容量' : '个人计划已超载') + '</span></div></div>'
    + '<section class="report-card"><h3>工作承诺</h3><ul class="report-list">' + (report.workLines || '<li>本周还没有工作承诺。</li>') + '</ul></section>'
    + '<section class="report-card"><h3>生活安排 <small>不计工作 KPI</small></h3><ul class="report-list">' + (report.lifeLines || '<li>本周还没有生活安排。</li>') + '</ul></section>'
    + '<section class="report-card"><h3>秘书的判断</h3><div class="report-advice"><p>' + (draft ? esc(draft.judgment) : '尚未调用 AI 生成判断。这里不会用固定模板冒充秘书。') + '</p></div>' + (draft ? '<small class="meta">' + esc(draft.sourceLabel) + '</small>' : '<button class="btn-secondary" onclick="generateWeeklyReport()">调用 AI 生成判断</button>') + '</section>'
    + '<section class="report-card"><h3>下周建议</h3><ul class="report-suggest">' + (draft?.suggestions?.length ? draft.suggestions.map(item => '<li>' + esc(item) + '</li>').join('') : '<li>生成 AI 判断后给出针对性建议。</li>') + '</ul></section>'
    + '<button class="btn-primary" onclick="saveReport()">保存本周周报快照</button>';
}

function monthlyReportHtml() {
  const key = monthKey();
  const stats = projectStats(key);
  const review = state.monthlyReviews.find(item => item.month === key);
  return '<section class="month-focus"><div class="eyebrow">本月配置</div><h2>不是所有项目都要同时向前</h2><p>月底由你重新决定重点，当前配置不会自动变成永久规则。</p></section>'
    + '<div class="project-list">' + state.projects.map(project => {
      const stat = stats.find(item => item.name === project.name) || { minutes: 0, income: 0 };
      const workstreams = Array.from(new Set(state.tasks.filter(task => task.project === project.name && task.workstream).map(task => task.workstream)));
      return '<article class="project-card ' + (project.status === 'paused' ? 'is-paused' : '') + '"><div><b>' + esc(project.name) + '</b>' + (project.group ? '<small>' + esc(project.group) + '</small>' : '') + '</div><span class="project-status">' + projectStatusLabel(project.status) + '</span><p>' + esc(project.outcome || '') + '</p>' + (workstreams.length ? '<div class="project-workstreams">' + workstreams.map(item => '<span>' + esc(item) + '</span>').join('') + '</div>' : '') + '<footer><span>投入 ' + hours(stat.minutes) + '</span><span>收入 ¥' + stat.income.toFixed(2) + '</span>' + (project.monthlyBudgetMinutes ? '<span>预算上限 ' + hours(project.monthlyBudgetMinutes) + '</span>' : '') + '</footer></article>';
    }).join('') + '</div>'
    + (review ? '<section class="report-card"><h3>本月秘书判断</h3><div class="report-advice"><p>' + esc(review.judgment) + '</p></div></section>' : '')
    + '<div class="row month-actions"><button class="btn-secondary" onclick="recordIncome()">记录收入</button><button class="btn-primary" onclick="beginSecretaryMode(\'monthly\')">做月度项目复盘</button></div>';
}

function buildReport() {
  const weekStart = currentWeekStart();
  const tasks = state.tasks.filter(task => task.weekStart === weekStart && ['committed', 'active', 'paused', 'blocked', 'done'].includes(task.status));
  const life = state.life.filter(item => item.weekStart === weekStart && ['planned', 'done'].includes(item.status));
  const done = tasks.filter(task => task.status === 'done');
  const estimates = done.reduce((sum, task) => sum + (+task.estimate || 0), 0);
  const actualMs = state.sessions.filter(session => weekStartOf(session.startedAt) === weekStart).reduce((sum, session) => sum + (+session.durationMs || 0), 0);
  const doneActual = done.reduce((sum, task) => sum + taskActualMs(task.id) / 60000, 0);
  const bias = estimates ? String(Math.round((doneActual - estimates) / estimates * 100)) + '%' : '暂无';
  const workGroups = new Map();
  tasks.forEach(task => {
    const key = task.project || '未归属项目';
    if (!workGroups.has(key)) workGroups.set(key, []);
    workGroups.get(key).push(task);
  });
  return {
    weekStart,
    total: tasks.length,
    done: done.length,
    actualMs,
    actualMinutes: actualMs / 60000,
    bias,
    tasks,
    life,
    workLines: Array.from(workGroups.entries()).map(([project, rows]) => '<li class="report-group-title">' + esc(project) + '</li>' + rows.map(task => '<li class="report-row ' + (task.status === 'done' ? 'done' : '') + '"><button onclick="taskMenu(\'' + task.id + '\')"><span>' + esc(task.title) + '</span><small>' + esc(task.workstream || '常规事项') + ' · ' + label(task.status) + ' · 预计 ' + hours(task.estimate) + ' · 实际 ' + durationText(taskActualMs(task.id)) + '</small></button></li>').join('')).join(''),
    lifeLines: life.map(item => '<li class="report-row ' + (item.status === 'done' ? 'done' : '') + '"><button onclick="lifeMenu(\'' + item.id + '\')"><span>' + esc(item.title) + '</span><small>' + (item.status === 'done' ? '已完成' : '本周安排') + ' · 不计工作容量</small></button></li>').join('')
  };
}

function projectStats(month) {
  return state.projects.map(project => {
    const taskIds = new Set(state.tasks.filter(task => task.project === project.name).map(task => task.id));
    const time = state.sessions.filter(session => monthKey(session.startedAt) === month && taskIds.has(session.taskId)).reduce((sum, session) => sum + (+session.durationMs || 0), 0) / 60000;
    const income = state.incomeRecords.filter(record => record.month === month && record.project === project.name).reduce((sum, record) => sum + (+record.amount || 0), 0);
    return { name: project.name, minutes: time, income };
  });
}

/* ── 设置页 ── */
function pageSettings() {
  return '<header class="topbar"><div><div class="brand">设置</div><div class="subtitle">数据只保留在这台设备</div></div></header>'
    + '<section class="setting-card"><div class="eyebrow">DeepSeek AI</div><p>当前模型：' + MODEL + '。密钥不会写进 GitHub 或导出的公开周报。</p><div class="field"><label>API Key</label><input id="api-key" type="password" placeholder="sk-..." value="' + esc(state.settings.apiKey) + '"></div><div class="row"><button class="btn-secondary" onclick="testDeepSeek()">测试连接</button><button class="btn-primary" onclick="saveSettings()">保存设置</button></div></section>'
    + '<section class="setting-card"><div class="eyebrow">两个容量池</div><div class="row"><div class="field"><label>个人项目/周</label><input id="personal-capacity" type="number" min="1" max="100" value="' + state.settings.personalCapacity + '"></div><div class="field"><label>主业专注/周</label><input id="main-capacity" type="number" min="1" max="100" value="' + state.settings.mainCapacity + '"></div></div><p>初始按个人 7 小时、主业显式专注任务 20 小时；四周后用实际数据校准。</p><button class="btn-secondary" onclick="saveSettings()">更新容量</button></section>'
    + '<section class="setting-card"><div class="eyebrow">每日小结</div><div class="field"><label>打开 App 后显示小结的时间</label><input id="reminder-time" type="time" value="' + esc(state.settings.reminderTime) + '"></div><p>PWA 没有后台服务时不会伪装成已推送；下次打开时仍可看到总结。</p><button class="btn-secondary" onclick="saveSettings()">保存时间</button></section>'
    + '<section class="setting-card"><div class="eyebrow">数据</div><p>可导出完整备份。换手机前请先保存 JSON 文件。</p><div class="row"><button class="btn-secondary" onclick="exportMenu()">导出与备份</button><button class="btn-secondary" onclick="legacyCleanupMenu()">整理旧数据</button></div></section>'
    + '<section class="setting-card version-card"><div><div class="eyebrow">当前版本</div><p>' + APP_VERSION + '</p></div><span>新版接管后会自动刷新一次</span></section>';
}

function legacyCleanupMenu() {
  const obvious = state.tasks.filter(task => task.status === 'legacy_review');
  const pending = state.tasks.filter(task => ['pending_review', 'overdue'].includes(task.status));
  open('<h2>整理旧版数据</h2><p>旧事项不会再自动塞进今天。明显的测试句可以批量移除，其余事项交给秘书重新归属和排程。</p><div class="notice">明显测试项 ' + obvious.length + ' 件 · 待重排/逾期 ' + pending.length + ' 件</div>' + (obvious.length ? '<button class="btn-secondary danger" onclick="removeObviousLegacy()">移除明显测试项</button>' : '') + (pending.length ? '<button class="btn-primary" onclick="close();startOverdueReview()">交给秘书集中整理</button>' : ''));
}

function removeObviousLegacy() {
  const ids = new Set(state.tasks.filter(task => task.status === 'legacy_review').map(task => task.id));
  state.tasks = state.tasks.filter(task => !ids.has(task.id));
  state.sessions = state.sessions.filter(session => !ids.has(session.taskId));
  close(); save(); toast('明显测试项已移除');
}

/* ── 渲染与导航 ── */
function render() {
  const pages = { today: pageToday, week: pageWeek, secretary: pageSecretary, reports: pageReports, settings: pageSettings };
  const showDock = view === 'today' || view === 'secretary';
  const app = $('#app');
  app.classList.toggle('with-quick-dock', view === 'today');
  app.classList.toggle('with-chat-dock', view === 'secretary');
  app.innerHTML = pages[view]() + (showDock ? dockHtml() : '') + navHtml();
  if (view === 'week') bindSwipes();
  if (state.timer && view === 'today') tickInline();
  if (view === 'secretary' && _scrollSecretaryAfterRender) {
    _scrollSecretaryAfterRender = false;
    requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'auto' }));
  }
}

function dockHtml() {
  const contextClass = view === 'secretary' ? 'chat-compose' : 'quick-capture';
  return '<form class="input-dock ' + contextClass + '" onsubmit="submitSecretary(event)"><input id="secretary-input" autocomplete="off" placeholder="' + (view === 'secretary' ? '继续告诉秘书…' : '随时告诉秘书一件事…') + '" value="' + esc(draftText) + '"><button class="send" aria-label="发送">↑</button></form>';
}

function navHtml() {
  const tabs = [
    { view: 'today', label: '今天', icon: '⌂' },
    { view: 'week', label: '本周', icon: '▦' },
    { view: 'secretary', label: '秘书', icon: '✦' },
    { view: 'reports', label: '复盘', icon: '◔' },
    { view: 'settings', label: '设置', icon: '⚙' }
  ];
  return '<nav class="nav">' + tabs.map(tab => '<button class="' + (view === tab.view ? 'active' : '') + ' ' + (tab.view === 'secretary' ? 'secretary-tab' : '') + '" onclick="go(\'' + tab.view + '\')"><span class="nav-icon">' + tab.icon + '</span>' + tab.label + '</button>').join('') + '</nav>';
}

function go(nextView) { view = nextView; if (nextView === 'secretary') _scrollSecretaryAfterRender = true; render(); }
function settings() { go('settings'); }

/* ── 秘书会话与 DeepSeek ── */
function newSession(mode) {
  return { id: id(), mode, status: 'collecting', rawInputs: [], summary: '', candidates: [], questions: [], suggestedProjects: [], startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

function appendMessage(role, text, meta = {}) {
  state.secretary.messages.push({ id: id(), role, text, createdAt: new Date().toISOString(), ...meta });
  state.secretary.messages = state.secretary.messages.slice(-80);
  _scrollSecretaryAfterRender = true;
}

function beginSecretaryMode(mode) {
  view = 'secretary';
  state.secretary.proposal = null;
  state.secretary.error = null;
  state.secretary.session = newSession(mode);
  const openings = {
    weekly: '把这周想到的事情原样告诉我，可以分几次说。等你说完，我再统一检查项目、依赖、估时和容量。',
    midweek: '直接告诉我新增了什么。我会拿它和本周已确认的安排比较，不会悄悄加塞。',
    change: '告诉我现实里发生了什么变化，例如“客户给素材了”或“今天临时加班”。我会判断哪些计划因此需要调整。',
    overdue: '我会先给逾期事项一个集中处理方案，你不需要逐项从零决定。',
    monthly: '这是月度项目复盘。先告诉我你现在最担心什么、最想保护什么；我会结合本月投入、结果和收入建议下个月重点。'
  };
  appendMessage('assistant', openings[mode]);
  persist();
  render();
}

function newSecretarySession() { close(); beginSecretaryMode('midweek'); }
function clearSecretaryHistory() { state.secretary.messages = []; state.secretary.session = null; state.secretary.proposal = null; close(); save(); }
function clearSecretaryError() { state.secretary.error = null; save(); }

async function submitSecretary(event) {
  event.preventDefault();
  const input = $('#secretary-input');
  const text = input?.value.trim();
  if (!text) { toast('先告诉秘书一件事'); return; }
  draftText = '';
  if (view !== 'secretary') view = 'secretary';
  if (!state.secretary.session || ['confirmed'].includes(state.secretary.session.status)) state.secretary.session = newSession('midweek');
  if (state.secretary.proposal) {
    state.secretary.proposal = null;
    state.secretary.session.status = 'collecting';
  }
  const session = state.secretary.session;
  session.rawInputs.push(text);
  session.updatedAt = new Date().toISOString();
  appendMessage('user', text);
  state.secretary.error = null;
  persist();
  render();
  await understandSecretaryTurn();
}

function planningContext() {
  return {
    now: new Date().toISOString(),
    today: isoDate(),
    currentWeekStart: currentWeekStart(),
    nextWeekStart: nextWeekStart(),
    planningWeekStart: planningWeekStart(),
    planningWeekEnd: addDays(planningWeekStart(), 6),
    rules: {
      saturdayRest: true,
      personalCapacityMinutes: state.settings.personalCapacity * 60,
      mainCapacityMinutes: state.settings.mainCapacity * 60,
      personalRemainingMinutes: Math.round(remaining('personal')),
      mainRemainingMinutes: Math.round(remaining('main')),
      dailyConfirmedLimit: 3,
      observationZone: false,
      userConfirmationRequired: true
    },
    projects: state.projects.map(project => ({ name: project.name, group: project.group, status: project.status, priority: project.priority, protected: !!project.protected, outcome: project.outcome, monthlyBudgetMinutes: project.monthlyBudgetMinutes })),
    projectDecisions: state.projectDecisions,
    currentTasks: activeTasks().map(task => ({ id: task.id, title: task.title, project: task.project, workstream: task.workstream, supportsProjects: task.supportsProjects || [], pool: taskPool(task), status: task.status, estimateMinutes: task.estimate, actualMinutes: Math.round(taskActualMs(task.id) / 60000), remainingMinutes: Math.round(taskPendingMinutes(task)), plannedDate: task.plannedDate, blockedReason: task.blockedReason, dependencies: (task.dependsOn || []).map(depId => state.tasks.find(item => item.id === depId)?.title).filter(Boolean), externalConditions: task.externalConditions || [] })),
    unplacedTasks: reviewTasks().map(task => ({ id: task.id, title: task.title, project: task.project, workstream: task.workstream, status: task.status, estimateMinutes: task.estimate, plannedDate: task.plannedDate })),
    life: state.life.filter(inCurrentWeek).map(item => ({ id: item.id, title: item.title, plannedDate: item.plannedDate, kind: item.kind, estimateMinutes: item.estimate })),
    recentEstimateHistory: state.tasks.filter(task => task.status === 'done').slice(-20).map(task => ({ title: task.title, project: task.project, estimateMinutes: task.estimate, actualMinutes: Math.round(taskActualMs(task.id) / 60000) })),
    currentMonthStats: projectStats(monthKey())
  };
}

const UNDERSTAND_SYSTEM = `你是“未尽”，一位冷静、直接但不咄咄逼人的中文个人秘书。用户会用语音转文字输入混乱原话。
你的工作是理解，不是按标点拆句。必须丢弃“这是测试”“我梳理一下”“然后我……”等话语组织成分，禁止把它们创建为事项。
事项保持用户可直接开工的粗颗粒度，不拆执行步骤；完成事项过程中的联系客户、找素材等动作通常不单独建任务。
只追问会改变排程的问题：完成标准、是否必须本周、截止时间、估时、硬依赖、外部条件。不要追问执行方法。
识别三类关系：hard_dependency（不完成前置就不能开始）、external_condition（等待他人/场所/素材）、preferred_order（只是建议顺序）。
项目只允许从给定项目表选择；确实是独立长期结果且有持续工作量时，才建议新项目。projectDecisions 是用户已确认的长期归属规则，必须遵守，禁止再次把已否决概念建议为新项目。
每个工作事项必须给出一个核心项目；可以再给 workstream 表示核心项目下的工作流。工作流不是新项目。
生活安排占现实时间但不计工作 KPI；关系事项默认不计时器，但仍建议现实占用分钟。
用户容易过度承诺。你应指出不可信计划，但最终决定属于用户。
只输出 JSON，不要 Markdown。结构：
{"mode":"weekly|midweek|change|overdue|monthly","assistantMessage":"先复述理解，再说需要补什么；语气自然","understanding":"对本轮原意的简洁总结","readyToSchedule":true,"finishIntent":false,"questions":[{"question":"只问关键问题","reason":"为何影响排程"}],"suggestedProjects":[{"name":"新项目名","group":"项目组或空","existingProject":"若更适合现有项目则填写","workstream":"现有项目下的工作流","reason":"为何它是独立长期结果","displaces":"它会挤占什么现有重点或容量"}],"candidates":[{"id":"稳定短ID","title":"事项名","type":"work|life","project":"核心项目名","workstream":"工作流或空","estimate":60,"kind":"relation|home|other","statusIntent":"this_week|next_week|later|unclear","deadline":"YYYY-MM-DD或空","dependencies":[{"type":"hard_dependency|external_condition|preferred_order","target":"事项或条件"}],"reason":"判断依据"}]}
如果用户只是在回答上一轮问题，更新已有理解，不要把回答本身创建成新任务。每轮 candidates 都返回本次会话目前确认到的完整候选列表，不要只返回本轮新增。无法确认估时时可以给参考值，但要说明待用户确认。
当用户说“就这些、开始排、先排进去、按这些生成计划”或已经回答完最后一个会改变排程的问题时，finishIntent 必须为 true；不要继续循环追问。`;

async function understandSecretaryTurn() {
  const session = state.secretary.session;
  if (!session) return;
  if (!state.settings.apiKey) {
    secretaryFailure(new Error('NO_KEY'));
    return;
  }
  state.secretary.busy = true;
  persist();
  render();
  try {
    const payload = {
      session: { mode: session.mode, summary: session.summary, candidates: session.candidates, questions: session.questions, suggestedProjects: session.suggestedProjects, rawInputs: session.rawInputs },
      recentConversation: state.secretary.messages.slice(-12).map(message => ({ role: message.role, content: message.text })),
      context: planningContext()
    };
    const result = await deepseekJSON(UNDERSTAND_SYSTEM, JSON.stringify(payload), 'high');
    session.mode = result.mode || session.mode;
    session.summary = result.understanding || session.summary;
    session.questions = Array.isArray(result.questions) ? result.questions : [];
    session.candidates = normalizeCandidates(result.candidates?.length ? result.candidates : session.candidates);
    const suggestions = Array.isArray(result.suggestedProjects) ? result.suggestedProjects : [];
    const appliedDecisions = [];
    session.suggestedProjects = suggestions.filter(project => {
      if (!project?.name || state.projects.some(existing => existing.name === project.name)) return false;
      const decision = decisionForConcept(project.name);
      if (!decision?.project) return true;
      appliedDecisions.push({ name: project.name, project: decision.project, workstream: decision.workstream || '' });
      session.candidates.forEach(item => {
        if (item.project === project.name || normalizeConcept(item.title).includes(normalizeConcept(project.name))) {
          item.project = decision.project;
          item.workstream = decision.workstream || item.workstream || '';
        }
      });
      return false;
    });
    session.status = session.questions.length ? 'clarifying' : 'collecting';
    session.updatedAt = new Date().toISOString();
    const rememberedMessage = appliedDecisions.length ? '我已按你之前确认的归属处理：' + appliedDecisions.map(item => '「' + item.name + '」归入「' + item.project + (item.workstream ? ' / ' + item.workstream : '') + '」').join('；') + '，不会再建议建立新项目。' + (session.questions.length ? '\n' + session.questions.map(item => item.question).join('\n') : '') : '';
    appendMessage('assistant', rememberedMessage || result.assistantMessage || (session.questions.length ? session.questions.map(item => item.question).join('\n') : '我已经理解并记在本次对话草稿里。'));
    state.secretary.busy = false;
    state.secretary.error = null;
    persist();
    render();
    const latestInput = session.rawInputs.at(-1) || '';
    const explicitFinish = !!result.finishIntent || /就这些|开始排|开始整理|帮我排|排一下|没有了|先这样/.test(latestInput);
    if (result.readyToSchedule && !session.questions.length && (session.mode !== 'weekly' || explicitFinish)) await buildScheduleProposal();
  } catch (error) {
    secretaryFailure(error);
  }
}

function normalizeCandidates(items) {
  return (Array.isArray(items) ? items : []).filter(item => item && String(item.title || '').trim()).map(item => {
    const title = String(item.title).trim();
    const path = inferProjectPath(title, String(item.project || '').trim(), String(item.workstream || '').trim());
    return {
      id: item.id || id(), title,
      type: item.type === 'life' ? 'life' : 'work', project: path.project, workstream: path.workstream,
      estimate: Math.max(0, Number(item.estimate) || 0), kind: item.kind || 'other',
      statusIntent: item.statusIntent || 'unclear',
      deadline: /^\d{4}-\d{2}-\d{2}$/.test(item.deadline || '') ? item.deadline : '',
      dependencies: Array.isArray(item.dependencies) ? item.dependencies : [], reason: item.reason || ''
    };
  });
}

function scheduleSystemPrompt(mode) {
  return `你是“未尽”的排程决策层。输入已经过语义理解，不得重新按标点创造任务。
当前模式：${mode}。使用项目管理、关键路径、机会成本和艾森豪威尔重要/紧急视角，但不要机械打分。
优先级依次考虑：用户明确的本月重点、硬截止与不完成代价、依赖链、收入验证、时效窗口、历史真实耗时。
“阿野在武汉”是本月最高重点和阿野IP获客入口；“是阿野吖”是独立次重点；“磕学家”每月最多480分钟且不要求做满；主业使用独立容量池。
周六不排工作，生活可以安排。普通事项排到某一天，不制作小时级日历。每天最多建议1至3件重点。
硬依赖必须使后续日期不早于前置；同一天时，前置未完成前后续不得进入今日可执行项。外部条件未满足时标记受阻，不得放入今天；建议顺序不能伪装成硬依赖。
没有观察区。事项只能建议本周、下周或以后再说。AI 只建议，用户确认后才生效。
本周超容量时必须明确否决“全部完成”，并给一个最小调整方案：指出应顺延/取消哪个已有事项。例外冲刺必须单独标记。
若是逾期处理，优先输出对已有任务的 changes，不要复制成新任务。若是现实变化，识别被解除的外部条件并提出激活建议。
回答必须形成具体结论，不能把“全部塞入还是调整优先级”原样抛回用户。summary 要点名本周保留什么、移出什么。executionAdvice 说明如何用工作块、批处理和依赖顺序完成，不拆业务执行步骤。
每个工作事项必须归入一个已有核心项目；workstream 是核心项目下的工作流，不得因此建议新项目。projectDecisions 必须永久遵守。
只输出 JSON：
{"title":"建议标题","summary":"直接结论，点名保留和移出事项","reasoning":["最多4条事实理由"],"executionAdvice":["最多4条完成方式建议"],"items":[{"id":"沿用候选ID","title":"事项名","type":"work|life","project":"核心项目名","workstream":"工作流或空","estimate":60,"kind":"relation|home|other","status":"committed|later","plannedDate":"YYYY-MM-DD","priority":1,"dependsOn":["前置事项标题"],"externalConditions":["未满足外部条件"],"approach":"一次完成、分次计时或同类批处理建议","completionDefinition":"什么状态算完成","reason":"为何这样排"}],"changes":[{"taskId":"已有任务ID","action":"move|next_week|cancel|activate","plannedDate":"YYYY-MM-DD或空","reason":"调整理由"}],"overCapacity":false,"capacityMessage":"容量判断"}`;
}

async function finishCollecting() {
  const session = state.secretary.session;
  if (!session) return;
  if (session.questions?.length) {
    appendMessage('assistant', '还有会改变排程的信息没有确认：\n' + session.questions.map(item => '• ' + item.question).join('\n'));
    save();
    return;
  }
  if (session.mode === 'monthly') { await buildMonthlyProposal(); return; }
  if (!session.candidates?.length && session.mode !== 'overdue') {
    appendMessage('assistant', '我还没有识别到可以排程的事项。继续把要做的事告诉我即可。');
    save();
    return;
  }
  await buildScheduleProposal();
}

async function buildScheduleProposal() {
  const session = state.secretary.session;
  if (!session || !state.settings.apiKey) { secretaryFailure(new Error('NO_KEY')); return; }
  session.status = 'scheduling';
  state.secretary.busy = true;
  state.secretary.error = null;
  persist();
  render();
  try {
    const overdue = session.mode === 'overdue' ? reviewTasks().map(task => ({ id: task.id, title: task.title, project: task.project, workstream: task.workstream, status: task.status, plannedDate: task.plannedDate, remainingMinutes: taskPendingMinutes(task), priority: task.priority, dependenciesReady: dependencyReady(task) })) : [];
    const payload = { mode: session.mode, summary: session.summary, candidates: session.candidates, overdue, context: planningContext() };
    const result = await deepseekJSON(scheduleSystemPrompt(session.mode), JSON.stringify(payload), 'max');
    const proposal = normalizeProposal(result);
    state.secretary.proposal = proposal;
    session.status = 'proposed';
    state.secretary.busy = false;
    appendMessage('assistant', proposal.summary || '我已经形成一份可确认的安排。');
    persist();
    render();
  } catch (error) {
    secretaryFailure(error);
  }
}

function rebalanceProposalItems(items) {
  const adjusted = [];
  const available = { personal: Math.max(0, remaining('personal')), main: Math.max(0, remaining('main')) };
  const counts = {};
  activeTasks().filter(task => task.plannedDate && task.status !== 'blocked').forEach(task => { counts[task.plannedDate] = (counts[task.plannedDate] || 0) + 1; });
  const weekEnd = addDays(planningWeekStart(), 6);
  items.filter(item => item.type === 'work' && item.status !== 'later').sort((a, b) => (a.priority || 9) - (b.priority || 9)).forEach(item => {
    const pool = item.project === '主业' ? 'main' : 'personal';
    if ((+item.estimate || 0) > available[pool]) {
      item.status = 'later';
      item.plannedDate = nextSchedulableDate(nextWeekStart());
      item.reason = (item.reason ? item.reason + '；' : '') + '当前可靠容量不足，秘书先移到下周。';
      adjusted.push(item.title);
      return;
    }
    let date = nextSchedulableDate(item.plannedDate || planningWeekStart());
    while ((counts[date] || 0) >= 3 && date <= weekEnd) date = nextSchedulableDate(addDays(date, 1));
    if (date > weekEnd) {
      item.status = 'later';
      item.plannedDate = nextSchedulableDate(nextWeekStart());
      item.reason = (item.reason ? item.reason + '；' : '') + '本周每天的可靠任务位已满，秘书先移到下周。';
      adjusted.push(item.title);
      return;
    }
    item.plannedDate = date;
    counts[date] = (counts[date] || 0) + 1;
    available[pool] -= +item.estimate || 0;
  });
  return adjusted;
}

function normalizeProposal(result) {
  const items = (Array.isArray(result.items) ? result.items : []).filter(item => item && item.title).map(item => {
    const type = item.type === 'life' ? 'life' : 'work';
    const status = item.status === 'later' ? 'later' : 'committed';
    let date = /^\d{4}-\d{2}-\d{2}$/.test(item.plannedDate || '') ? item.plannedDate : (status === 'later' ? nextWeekStart() : planningWeekStart());
    if (date < isoDate()) date = isoDate();
    if (status === 'later' && date < nextWeekStart()) date = nextWeekStart();
    date = nextSchedulableDate(date, type);
    const normalizedStatus = date >= nextWeekStart() ? 'later' : status;
    const path = inferProjectPath(String(item.title).trim(), String(item.project || '').trim(), String(item.workstream || '').trim());
    return {
      id: item.id || id(), title: String(item.title).trim(), type,
      project: path.project, workstream: path.workstream,
      estimate: Math.max(0, Number(item.estimate) || 0), kind: item.kind || 'other', status: normalizedStatus,
      plannedDate: date, priority: Math.min(5, Math.max(1, +item.priority || 3)),
      dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn : [],
      externalConditions: Array.isArray(item.externalConditions) ? item.externalConditions : [],
      approach: item.approach || '', completionDefinition: item.completionDefinition || '', reason: item.reason || ''
    };
  });
  const autoMoved = rebalanceProposalItems(items);
  enforceDependencyDates(items);
  const summary = (result.summary || '') + (autoMoved.length ? ' 按可靠容量，秘书已明确把「' + autoMoved.join('」「') + '」移到下周；没有把它们伪装成本周承诺。' : '');
  return { id: id(), type: 'schedule', title: result.title || '这样安排最可信', summary, reasoning: Array.isArray(result.reasoning) ? result.reasoning : [], executionAdvice: Array.isArray(result.executionAdvice) ? result.executionAdvice : [], items, changes: Array.isArray(result.changes) ? result.changes : [], overCapacity: false, capacityMessage: result.capacityMessage || '', createdAt: new Date().toISOString() };
}

function enforceDependencyDates(items) {
  const byTitle = new Map([...state.tasks, ...items].map(item => [item.title, item]));
  items.forEach(item => {
    (item.dependsOn || []).forEach(name => {
      const dependency = byTitle.get(name);
      if (dependency?.plannedDate && item.status === 'committed' && item.plannedDate < dependency.plannedDate) item.plannedDate = nextSchedulableDate(dependency.plannedDate, item.type);
    });
  });
}

async function buildMonthlyProposal() {
  const session = state.secretary.session;
  if (!session || !state.settings.apiKey) { secretaryFailure(new Error('NO_KEY')); return; }
  state.secretary.busy = true;
  session.status = 'scheduling';
  persist(); render();
  const system = `你是“未尽”的月度项目组合顾问。用户不是要把所有项目都做好，而是要基于当前风险、机会、真实投入、收入和愿景选择下月重点。
项目状态只能是 fixed、focus、secondary、maintenance、low、opportunity、paused。月度状态月底失效，需要用户下月重新确认。
阿野在武汉与是阿野吖是阿野IP下两个独立创作项目，容量冲突时保护阿野在武汉。磕学家已有每月100至200元收入，本月预算上限480分钟，不要求做满。
给出直接判断，但不得替用户永久决定。只输出 JSON：{"title":"下月项目建议","summary":"结论","judgment":"基于数据和用户表达的判断","recommendations":[{"name":"项目名","status":"状态","monthlyBudgetMinutes":0,"reason":"原因"}]}`;
  try {
    const result = await deepseekJSON(system, JSON.stringify({ conversation: state.secretary.messages.slice(-16), projects: state.projects, stats: projectStats(monthKey()), userSummary: session.summary }), 'max');
    state.secretary.proposal = { id: id(), type: 'monthly', title: result.title, summary: result.summary, judgment: result.judgment, recommendations: Array.isArray(result.recommendations) ? result.recommendations : [], createdAt: new Date().toISOString() };
    session.status = 'proposed'; state.secretary.busy = false;
    appendMessage('assistant', result.summary || '我已经形成下个月的项目配置建议。');
    persist(); render();
  } catch (error) { secretaryFailure(error); }
}

function monthlyProposalHtml(proposal) {
  return '<section class="proposal"><div class="proposal-kicker">下月项目配置 · 你确认后生效</div><h2>' + esc(proposal.title || '下月项目建议') + '</h2><p class="proposal-summary">' + esc(proposal.summary || '') + '</p><div class="report-advice"><p>' + esc(proposal.judgment || '') + '</p></div><div class="project-recommendations">' + proposal.recommendations.map(item => '<div class="change-row"><div><b>' + esc(item.name) + '</b><small>' + projectStatusLabel(item.status) + (item.monthlyBudgetMinutes ? ' · 上限 ' + hours(item.monthlyBudgetMinutes) : '') + '</small></div><p>' + esc(item.reason || '') + '</p></div>').join('') + '</div><button class="btn-primary" onclick="confirmMonthlyProposal()">确认下月配置</button><button class="btn-text" onclick="discardProposal()">继续讨论</button></section>';
}

function confirmMonthlyProposal() {
  const proposal = state.secretary.proposal;
  if (!proposal || proposal.type !== 'monthly') return;
  proposal.recommendations.forEach(recommendation => {
    const project = state.projects.find(item => item.name === recommendation.name);
    if (!project) return;
    if (['fixed', 'focus', 'secondary', 'maintenance', 'low', 'opportunity', 'paused'].includes(recommendation.status)) project.status = recommendation.status;
    if (Number.isFinite(+recommendation.monthlyBudgetMinutes) && +recommendation.monthlyBudgetMinutes >= 0) project.monthlyBudgetMinutes = +recommendation.monthlyBudgetMinutes;
  });
  state.monthlyReviews = state.monthlyReviews.filter(item => item.month !== monthKey());
  state.monthlyReviews.push({ id: id(), month: monthKey(), createdAt: new Date().toISOString(), judgment: proposal.judgment, summary: proposal.summary, recommendations: proposal.recommendations, stats: projectStats(monthKey()) });
  state.secretary.proposal = null;
  state.secretary.session.status = 'confirmed';
  appendMessage('assistant', '下月项目配置已经确认。它只对下个月有效，月底会重新问你。');
  save();
}

async function deepseekJSON(system, user, reasoningEffort = 'high') {
  if (!state.settings.apiKey) throw new Error('NO_KEY');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.settings.apiKey },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        thinking: { type: 'enabled' },
        reasoning_effort: reasoningEffort,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
      })
    });
  } catch (error) {
    clearTimeout(timer);
    if (error.name === 'AbortError') throw new Error('TIMEOUT');
    throw new Error('NETWORK');
  }
  clearTimeout(timer);
  const raw = await response.text();
  if (!response.ok) {
    const apiError = new Error('HTTP_' + response.status);
    apiError.details = raw.slice(0, 240);
    throw apiError;
  }
  try {
    const data = JSON.parse(raw);
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('EMPTY');
    return JSON.parse(String(content).replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim());
  } catch (error) {
    throw new Error('INVALID_JSON');
  }
}

function apiErrorMessage(error) {
  const code = error?.message || '';
  if (code === 'NO_KEY') return '尚未配置 DeepSeek API Key。你的原话已经保留，请先去设置。';
  if (code === 'NETWORK') return '浏览器没有成功连接 DeepSeek。请检查网络、代理或浏览器跨域限制。';
  if (code === 'TIMEOUT') return 'DeepSeek 超过 90 秒没有返回。你的原话没有丢失，可以重试。';
  if (code === 'HTTP_401' || code === 'HTTP_403') return 'API Key 无效或没有权限，请在设置中重新保存。';
  if (code === 'HTTP_402') return 'DeepSeek 账户余额不足。充值后可以直接重试。';
  if (code === 'HTTP_429') return 'DeepSeek 请求过于频繁，请稍后重试。';
  if (code.startsWith('HTTP_')) return 'DeepSeek 返回错误 ' + code.replace('HTTP_', '') + '。不会使用本地拆句代替。';
  if (code === 'INVALID_JSON' || code === 'EMPTY') return 'AI 返回的结构不完整。原话和对话草稿均已保留，请重试。';
  return 'AI 暂时没有完成处理。原话已保留，不会降级成标点拆分。';
}

function secretaryFailure(error) {
  state.secretary.busy = false;
  state.secretary.error = { code: error?.message || 'UNKNOWN', message: apiErrorMessage(error), at: new Date().toISOString() };
  persist(); render();
}

async function retrySecretary() {
  state.secretary.error = null;
  persist(); render();
  const session = state.secretary.session;
  if (session?.status === 'scheduling') await buildScheduleProposal();
  else await understandSecretaryTurn();
}

/* ── 建议编辑与确认 ── */
function setProposalField(itemId, field, value) {
  const item = state.secretary.proposal?.items?.find(candidate => candidate.id === itemId);
  if (!item) return;
  item[field] = field === 'estimate' ? Math.max(0, +value || 0) : value;
  if (field === 'project') item.capacityPool = value === '主业' ? 'main' : 'personal';
  persist();
}

function setProposalDependencies(itemId, value) {
  const item = state.secretary.proposal?.items?.find(candidate => candidate.id === itemId);
  if (!item) return;
  item.dependsOn = value.split(/[、,，]/).map(part => part.trim()).filter(Boolean);
  persist();
}

function setProposalChangeField(taskId, field, value) {
  const change = state.secretary.proposal?.changes?.find(item => item.taskId === taskId);
  if (!change) return;
  change[field] = value;
  persist();
}

function removeProposalChange(taskId) {
  mutateProposalWithoutJump('[data-change-id="' + taskId + '"]', () => {
    state.secretary.proposal.changes = state.secretary.proposal.changes.filter(item => item.taskId !== taskId);
  });
}

function removeProposalItem(itemId) {
  mutateProposalWithoutJump('[data-proposal-id="' + itemId + '"]', () => {
    state.secretary.proposal.items = state.secretary.proposal.items.filter(item => item.id !== itemId);
  });
}

function mutateProposalWithoutJump(selector, mutate) {
  const current = document.querySelector(selector);
  const candidates = current ? Array.from(document.querySelectorAll('[data-proposal-id],[data-change-id]')) : [];
  const index = current ? candidates.indexOf(current) : -1;
  const nextAnchor = index >= 0 ? candidates[index + 1] : null;
  const anchor = nextAnchor || (index >= 0 ? candidates[index - 1] : null);
  const anchorKey = anchor?.dataset.proposalId ? '[data-proposal-id="' + anchor.dataset.proposalId + '"]' : anchor?.dataset.changeId ? '[data-change-id="' + anchor.dataset.changeId + '"]' : '';
  const top = nextAnchor ? current?.getBoundingClientRect().top : anchor?.getBoundingClientRect().top;
  mutate();
  persist();
  render();
  if (anchorKey && Number.isFinite(top)) requestAnimationFrame(() => {
    const next = document.querySelector(anchorKey);
    if (next) window.scrollBy({ top: next.getBoundingClientRect().top - top, behavior: 'auto' });
  });
}

function addProposalItem() {
  state.secretary.proposal.items.push({ id: id(), title: '', type: 'work', project: '', workstream: '', estimate: 0, kind: 'other', status: 'committed', plannedDate: nextSchedulableDate(isoDate()), priority: 3, dependsOn: [], externalConditions: [], approach: '', completionDefinition: '', reason: '由你手动加入，仍需确认估时、日期和依赖。' });
  _scrollSecretaryAfterRender = true;
  save();
}

function changeReliefMinutes(change, pool) {
  if (!['next_week', 'cancel'].includes(change.action)) return 0;
  const task = state.tasks.find(item => item.id === change.taskId);
  return task && taskPool(task) === pool ? taskPendingMinutes(task) : 0;
}

function changeAddedMinutes(change, pool) {
  if (!['move', 'activate'].includes(change.action)) return 0;
  const task = state.tasks.find(item => item.id === change.taskId);
  if (!task || taskPool(task) !== pool || ['committed', 'active', 'paused', 'blocked'].includes(task.status)) return 0;
  return taskPendingMinutes(task);
}

function proposalPoolImpact(proposal, pool) {
  const added = (proposal.items || []).filter(item => item.type === 'work' && item.status !== 'later' && (item.project === '主业' ? 'main' : 'personal') === pool).reduce((sum, item) => sum + (+item.estimate || 0), 0);
  const relief = (proposal.changes || []).reduce((sum, change) => sum + changeReliefMinutes(change, pool), 0);
  const reactivated = (proposal.changes || []).reduce((sum, change) => sum + changeAddedMinutes(change, pool), 0);
  return added + reactivated - relief;
}

function proposalDailyOverload(proposal) {
  const counts = {};
  const changedIds = new Set((proposal.changes || []).map(change => change.taskId));
  activeTasks().filter(task => !changedIds.has(task.id) && task.status !== 'blocked' && dependencyReady(task)).forEach(task => { counts[task.plannedDate] = (counts[task.plannedDate] || 0) + 1; });
  (proposal.changes || []).filter(change => ['move', 'activate'].includes(change.action) && change.plannedDate).forEach(change => { counts[change.plannedDate] = (counts[change.plannedDate] || 0) + 1; });
  (proposal.items || []).filter(item => item.type === 'work' && item.status !== 'later' && !(item.externalConditions || []).length).forEach(item => { counts[item.plannedDate] = (counts[item.plannedDate] || 0) + 1; });
  const overloaded = Object.entries(counts).find(([, count]) => count > 3);
  return overloaded ? { date: overloaded[0], count: overloaded[1] } : null;
}

function proposalOverCapacity(proposal) {
  if (proposal.type !== 'schedule') return '';
  const dailyOverload = proposalDailyOverload(proposal);
  if (dailyOverload) return dayText(dailyOverload.date) + ' 被安排了 ' + dailyOverload.count + ' 件可执行工作；每天最多确认 3 件，请改日期。';
  const personalOver = proposalPoolImpact(proposal, 'personal') - Math.max(0, remaining('personal'));
  const mainOver = proposalPoolImpact(proposal, 'main') - Math.max(0, remaining('main'));
  if (personalOver > 0) return '个人项目仍超出可靠容量 ' + hours(personalOver) + '。要插入它，必须顺延已有事项，放到下周，或明确开启例外冲刺。';
  if (mainOver > 0) return '主业显式任务仍超出可靠容量 ' + hours(mainOver) + '。需要减少或顺延已有安排。';
  return proposal.overCapacity ? (proposal.capacityMessage || '秘书判断当前计划仍不可信，请先调整。') : '';
}

function applyProposalChanges(changes) {
  changes.forEach(change => {
    const task = state.tasks.find(item => item.id === change.taskId);
    if (!task) return;
    if (change.action === 'next_week') {
      task.status = 'later'; task.weekStart = nextWeekStart(); task.plannedDate = nextSchedulableDate(nextWeekStart());
    } else if (change.action === 'cancel') {
      task.status = 'cancelled';
    } else if (change.action === 'activate') {
      task.status = 'committed'; task.blockedReason = ''; task.externalConditions = []; task.plannedDate = nextSchedulableDate(change.plannedDate || isoDate()); task.weekStart = weekStartOf(task.plannedDate);
    } else if (change.action === 'move') {
      task.plannedDate = nextSchedulableDate(change.plannedDate || isoDate());
      task.weekStart = weekStartOf(task.plannedDate);
      task.status = task.plannedDate >= nextWeekStart() ? 'later' : 'committed';
    }
  });
}

function confirmProposal(sprint) {
  const proposal = state.secretary.proposal;
  if (!proposal || proposal.type !== 'schedule') return;
  proposal.items.forEach(item => {
    if (item.status === 'later' && item.plannedDate < nextWeekStart()) item.plannedDate = nextSchedulableDate(nextWeekStart(), item.type);
    if (item.plannedDate >= nextWeekStart()) item.status = 'later';
    item.plannedDate = nextSchedulableDate(item.plannedDate, item.type);
  });
  enforceDependencyDates(proposal.items);
  const unknownProject = proposal.items.find(item => item.project && !state.projects.some(project => project.name === item.project));
  if (unknownProject) { toast('请先确认是否建立项目「' + unknownProject.project + '」'); return; }
  const invalid = proposal.items.find(item => !String(item.title || '').trim() || !(+item.estimate > 0) || !item.plannedDate || (item.type === 'work' && !item.project));
  if (invalid) { toast('工作事项必须确认名称、核心项目、预计时间和日期'); return; }
  const over = proposalOverCapacity(proposal);
  if (over && !sprint) { toast('这份方案仍然超容量，请先取舍'); return; }
  applyProposalChanges(proposal.changes || []);
  const titleMap = new Map(state.tasks.map(task => [task.title, task.id]));
  const created = [];
  proposal.items.forEach(item => {
    if (item.type === 'life') {
      state.life.push({ id: id(), title: item.title.trim(), kind: item.kind || 'other', estimate: +item.estimate, status: 'planned', when: dayText(item.plannedDate), plannedDate: item.plannedDate, weekStart: weekStartOf(item.plannedDate) });
      return;
    }
    const task = { id: id(), title: item.title.trim(), project: item.project || '', workstream: item.workstream || '', supportsProjects: [], estimate: +item.estimate, remaining: 0, status: item.externalConditions?.length ? 'blocked' : item.status, priority: item.priority || 3, createdAt: new Date().toISOString(), weekStart: weekStartOf(item.plannedDate), plannedDate: item.plannedDate, dependsOn: [], externalConditions: item.externalConditions || [], blockedReason: item.externalConditions?.length ? '等待 ' + item.externalConditions.join('、') : '', capacityPool: item.project === '主业' ? 'main' : 'personal', source: 'secretary', createdByVersion: APP_VERSION, approach: item.approach || '', completionDefinition: item.completionDefinition || '' };
    state.tasks.push(task); titleMap.set(task.title, task.id); created.push({ task, names: item.dependsOn || [] });
  });
  created.forEach(entry => {
    const missing = [];
    entry.task.dependsOn = entry.names.map(name => { const depId = titleMap.get(name); if (depId) return depId; missing.push(name); return null; }).filter(Boolean);
    if (missing.length) { entry.task.status = 'blocked'; entry.task.blockedReason = '等待 ' + missing.join('、'); }
  });
  if (sprint && !state.specialWeeks.includes(currentWeekStart())) state.specialWeeks.push(currentWeekStart());
  const changedPlanItems = (proposal.changes || []).filter(change => change.action !== 'cancel').map(change => {
    const task = state.tasks.find(item => item.id === change.taskId);
    return task ? { ...task, type: 'work', approach: change.reason || task.approach || '' } : null;
  }).filter(Boolean);
  state.secretary.lastPlan = structuredClone({ title: proposal.title, summary: proposal.summary, executionAdvice: proposal.executionAdvice || [], items: [...proposal.items, ...changedPlanItems], confirmedAt: new Date().toISOString() });
  state.secretary.proposal = null;
  state.secretary.session.status = 'confirmed';
  appendMessage('assistant', sprint ? '已经按例外冲刺写入。本周会单独标记，不会拿来提高以后容量。' : '已经按你确认的方案写入计划。');
  save();
}

function moveProposalToNextWeek() {
  const proposal = state.secretary.proposal;
  proposal.items.forEach(item => { if (item.type === 'work') { item.status = 'later'; item.plannedDate = nextSchedulableDate(nextWeekStart()); } });
  proposal.overCapacity = false;
  save();
}

function discardProposal() {
  state.secretary.proposal = null;
  if (state.secretary.session) state.secretary.session.status = 'collecting';
  appendMessage('assistant', '方案暂时不生效。继续告诉我你想改哪里。');
  save();
}

function startOverdueReview() {
  beginSecretaryMode('overdue');
  const tasks = reviewTasks();
  state.secretary.session.summary = '需要集中处理待重排、旧版遗留和逾期事项：' + tasks.map(task => task.title).join('、');
  appendMessage('user', '请直接给我这些待整理事项的归属、删除和重排建议，不要让我逐项从零决定。');
  persist(); render();
  buildScheduleProposal();
}

/* ── AI 周报 ── */
async function generateWeeklyReport() {
  const report = buildReport();
  if (!state.settings.apiKey) { toast('请先在设置中连接 DeepSeek'); return; }
  open('<h2>正在生成周报判断</h2><p>秘书会使用本周真实事项、计时、依赖和项目重点，不会套固定模板。</p>');
  const system = `你是“未尽”的周报判断层。必须引用输入里的具体事实，不说空话，不使用固定鸡汤。
区分工作和生活；生活不计工作完成率。分析估时偏差、依赖、过载、例外冲刺和项目投入。未完成不自动等于投入不足，也可能是计划过载或受阻。
给下周最多4条具体建议；建议必须说明继续、顺延、取消、调整估时或先解除哪个依赖。只输出 JSON：{"judgment":"事实判断","suggestions":["建议"]}`;
  try {
    const result = await deepseekJSON(system, JSON.stringify({ report: reportPayload(report), projects: state.projects, stats: projectStats(monthKey()), exceptionSprint: state.specialWeeks.includes(currentWeekStart()), capacities: { personal: state.settings.personalCapacity, main: state.settings.mainCapacity } }), 'max');
    state.reportDrafts[report.weekStart] = { judgment: result.judgment, suggestions: Array.isArray(result.suggestions) ? result.suggestions : [], sourceLabel: MODEL + ' · 基于本周真实数据', generatedAt: new Date().toISOString() };
    close(); save(); toast('AI 周报判断已生成');
  } catch (error) {
    close(); toast(apiErrorMessage(error));
  }
}

function reportPayload(report) {
  return {
    weekStart: report.weekStart,
    work: report.tasks.map(task => ({ title: task.title, project: task.project, status: label(task.status), estimateMinutes: task.estimate, actualMinutes: Math.round(taskActualMs(task.id) / 60000), remainingMinutes: Math.round(taskPendingMinutes(task)), plannedDate: task.plannedDate, blockedReason: task.blockedReason })),
    life: report.life.map(item => ({ title: item.title, status: item.status, kind: item.kind, plannedDate: item.plannedDate })),
    actualMinutes: Math.round(report.actualMinutes),
    bias: report.bias
  };
}

function saveReport() {
  const report = buildReport();
  const draft = state.reportDrafts[report.weekStart];
  if (!draft) { toast('请先生成 AI 判断，再保存周报快照'); return; }
  const snapshot = { id: id(), weekStart: report.weekStart, createdAt: new Date().toISOString(), done: report.done, total: report.total, actualMinutes: report.actualMinutes, bias: report.bias, work: report.tasks.map(task => ({ ...task, actualMs: taskActualMs(task.id) })), life: report.life.map(item => ({ ...item })), judgment: draft.judgment, suggestions: draft.suggestions, sourceLabel: draft.sourceLabel };
  state.reports = state.reports.filter(item => item.weekStart !== report.weekStart);
  state.reports.unshift(snapshot);
  save(); toast('本周周报快照已保存');
}

function recordIncome() {
  open('<h2>记录项目收入</h2><p>收入与真实投入会一起进入月度判断。</p><div class="field"><label>项目</label><select id="income-project">' + projectOptions('磕学家') + '</select></div><div class="field"><label>金额（元）</label><input id="income-amount" type="number" min="0" step="0.01"></div><button class="btn-primary" onclick="saveIncome()">保存收入</button>');
}

function saveIncome() {
  const project = $('#income-project').value;
  const amount = +$('#income-amount').value;
  if (!project || !(amount >= 0)) { toast('请选择项目并填写金额'); return; }
  state.incomeRecords.push({ id: id(), project, amount, date: isoDate(), month: monthKey(), createdAt: new Date().toISOString() });
  close(); save(); toast('收入已记录');
}

/* ── 计时器 ── */
function timerClock(ms) {
  const total = Math.floor(Math.max(0, +ms || 0) / 1000);
  return String(Math.floor(total / 3600)).padStart(2, '0') + ':' + String(Math.floor(total / 60) % 60).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}

function openTimerOverlay(taskId) {
  const task = state.tasks.find(item => item.id === taskId);
  if (!task) return;
  document.getElementById('timer-overlay')?.remove();
  const paused = state.timer?.paused;
  document.body.insertAdjacentHTML('beforeend', '<div class="timer-overlay" id="timer-overlay"><button class="timer-close" onclick="closeTimerOverlay()">✕</button><div class="timer-label" id="timer-label">' + (paused ? '已暂停' : '正在专注') + '</div><div class="timer-task">' + esc(task.title) + '</div><div class="timer-ring">' + ringSvg(0, 200, 6, 'ring-fill') + '<div class="timer-display" id="timer-display">' + timerClock(taskActualMs(taskId)) + '</div></div><div class="timer-actions"><button class="btn-secondary" id="timer-toggle" onclick="' + (paused ? 'resumeTimer()' : 'pauseTimer()') + '">' + (paused ? '▶ 继续' : '⏸ 暂停') + '</button><button class="btn-primary" onclick="finishTask(\'' + taskId + '\')">✓ 结束</button></div></div>');
  cancelAnimationFrame(_timerRAF);
  _timerRAF = requestAnimationFrame(timerOverlayTick);
}

function closeTimerOverlay() { cancelAnimationFrame(_timerRAF); document.getElementById('timer-overlay')?.remove(); render(); }

function timerOverlayTick() {
  if (!state.timer) return;
  const totalMs = taskActualMs(state.timer.taskId);
  const element = document.getElementById('timer-display');
  if (element) element.textContent = timerClock(totalMs);
  const task = state.tasks.find(item => item.id === state.timer.taskId);
  const totalEstimate = (+task?.estimate || 60) * 60000;
  const pct = Math.min(1, totalMs / totalEstimate);
  const ring = document.querySelector('#timer-overlay .ring-fill');
  if (ring) { const radius = 97; const circumference = 2 * Math.PI * radius; ring.setAttribute('stroke-dashoffset', circumference * (1 - pct)); }
  _timerRAF = requestAnimationFrame(timerOverlayTick);
}

function recordActiveSegment() {
  if (!state.timer || state.timer.paused || !state.timer.startedAt) return;
  const endedAt = new Date().toISOString();
  state.sessions.push({ id: id(), taskId: state.timer.taskId, startedAt: state.timer.startedAt, endedAt, durationMs: Math.max(0, new Date(endedAt) - new Date(state.timer.startedAt)), weekStart: weekStartOf(state.timer.startedAt) });
}

function startTimer(taskId) {
  if (state.timer && state.timer.taskId !== taskId) { toast('当前还有一件暂停或进行中的工作，请先结束它'); return; }
  const task = state.tasks.find(item => item.id === taskId);
  if (!task) return;
  if (!dependencyReady(task)) { toast('前置事项或外部条件还没满足'); return; }
  if (!state.timer) state.timer = { taskId, startedAt: new Date().toISOString(), paused: false };
  else if (state.timer.paused) { state.timer.startedAt = new Date().toISOString(); state.timer.paused = false; }
  task.status = 'active'; persist(); render(); openTimerOverlay(taskId);
}

function pauseTimer() {
  if (!state.timer || state.timer.paused) return;
  recordActiveSegment(); state.timer.startedAt = null; state.timer.paused = true;
  const task = state.tasks.find(item => item.id === state.timer.taskId);
  if (task) task.status = 'paused';
  persist(); render(); openTimerOverlay(state.timer.taskId); toast('已暂停，仍停留在专注页');
}

function resumeTimer() {
  if (!state.timer || !state.timer.paused) return;
  state.timer.startedAt = new Date().toISOString(); state.timer.paused = false;
  const task = state.tasks.find(item => item.id === state.timer.taskId);
  if (task) task.status = 'active';
  persist(); render(); openTimerOverlay(state.timer.taskId);
}

function tickInline() {
  if (!state.timer) return;
  const element = $('#timer-text');
  if (!element || view !== 'today') return;
  element.textContent = timerClock(taskActualMs(state.timer.taskId));
  setTimeout(tickInline, 500);
}

/* ── 任务操作 ── */
function finishTask(taskId) {
  if (state.timer?.taskId === taskId) {
    recordActiveSegment(); state.timer = null; persist(); cancelAnimationFrame(_timerRAF); document.getElementById('timer-overlay')?.remove();
  }
  const task = state.tasks.find(item => item.id === taskId);
  if (!task) return;
  open('<h2>这件事完成了吗？</h2><p>未完成也不是失败。告诉秘书真实剩余时间。</p><div class="notice">' + esc(task.title) + ' · 已投入 ' + durationText(taskActualMs(taskId)) + '</div><div class="row" style="margin-top:16px"><button class="btn-secondary" onclick="markRemaining(\'' + taskId + '\')">还没完成</button><button class="btn-primary" onclick="markDone(\'' + taskId + '\')">已完成</button></div>');
}

function markDone(taskId) {
  const task = state.tasks.find(item => item.id === taskId);
  if (!task) return;
  task.status = 'done'; task.completedAt = new Date().toISOString(); task.remaining = 0;
  close(); save(); toast('完成已记录 ✓');
}

function markRemaining(taskId) {
  const task = state.tasks.find(item => item.id === taskId);
  close(); open('<h2>还需要多久？</h2><p>校准预估，不是自我批评。</p><div class="field"><label>预计剩余分钟</label><input id="remain" type="number" min="5" value="' + (task.remaining || task.estimate || 60) + '"></div><button class="btn-primary" onclick="saveRemaining(\'' + taskId + '\')">保存真实剩余时间</button>');
}

function saveRemaining(taskId) {
  const task = state.tasks.find(item => item.id === taskId);
  task.remaining = +$('#remain').value || 0; task.status = 'committed';
  close(); save(); toast('已保存，不会自动滚到明天');
}

function lifeDone(itemId) { const item = state.life.find(entry => entry.id === itemId); if (!item) return; item.status = 'done'; save(); toast('已记录。生活不是 KPI。'); }

function taskMenu(taskId) {
  const task = state.tasks.find(item => item.id === taskId);
  if (!task) return;
  open('<h2>' + esc(task.title) + '</h2><p>归属：' + esc(projectPath(task)) + '</p><button class="btn-primary" onclick="editTask(\'' + taskId + '\')">编辑事项</button><button class="btn-secondary" onclick="rescheduleTask(\'' + taskId + '\')">只修改日期</button><button class="btn-secondary" onclick="blockTask(\'' + taskId + '\')">标记受阻</button><button class="btn-secondary danger" onclick="removeTask(\'' + taskId + '\')">删除此项</button>');
}

function editTask(taskId) {
  const task = state.tasks.find(item => item.id === taskId);
  if (!task) return;
  close();
  open('<h2>编辑事项</h2><div class="field"><label>事项名称</label><input id="edit-task-title" value="' + esc(task.title) + '"></div><div class="field"><label>核心项目</label><select id="edit-task-project">' + projectOptions(task.project) + '</select></div><div class="field"><label>工作流 / 子项目</label><input id="edit-task-workstream" value="' + esc(task.workstream || '') + '"></div><div class="row"><div class="field"><label>预计分钟</label><input id="edit-task-estimate" type="number" min="5" value="' + (+task.estimate || '') + '"></div><div class="field"><label>安排日期</label><input id="edit-task-date" type="date" value="' + esc(task.plannedDate || '') + '"></div></div><button class="btn-primary" onclick="saveTaskEdit(\'' + taskId + '\')">保存修改</button>');
}

function saveTaskEdit(taskId) {
  const task = state.tasks.find(item => item.id === taskId);
  if (!task) return;
  const title = $('#edit-task-title')?.value.trim();
  const project = $('#edit-task-project')?.value;
  const date = $('#edit-task-date')?.value;
  const estimate = +$('#edit-task-estimate')?.value;
  if (!title || !project || !(estimate > 0)) { toast('请确认名称、核心项目和预计时间'); return; }
  task.title = title;
  task.project = project;
  task.workstream = $('#edit-task-workstream')?.value.trim() || '';
  task.estimate = estimate;
  task.capacityPool = project === '主业' ? 'main' : 'personal';
  task.plannedDate = date || '';
  task.weekStart = date ? weekStartOf(date) : currentWeekStart();
  if (!date) task.status = 'pending_review';
  else if (date < isoDate()) task.status = 'overdue';
  else if (date >= nextWeekStart()) task.status = 'later';
  else if (['pending_review', 'legacy_review', 'overdue', 'later'].includes(task.status)) task.status = 'committed';
  close(); save(); toast('事项已更新');
}

function lifeMenu(itemId) {
  const item = state.life.find(entry => entry.id === itemId);
  if (!item) return;
  open('<h2>' + esc(item.title) + '</h2><p>生活安排不计入工作 KPI，但会保留现实占用时间。</p><button class="btn-primary" onclick="editLife(\'' + itemId + '\')">编辑生活安排</button><button class="btn-secondary" onclick="lifeDone(\'' + itemId + '\');close()">标记完成</button><button class="btn-secondary danger" onclick="removeLife(\'' + itemId + '\')">删除此项</button>');
}

function editLife(itemId) {
  const item = state.life.find(entry => entry.id === itemId);
  if (!item) return;
  close();
  open('<h2>编辑生活安排</h2><div class="field"><label>名称</label><input id="edit-life-title" value="' + esc(item.title) + '"></div><div class="row"><div class="field"><label>预计分钟</label><input id="edit-life-estimate" type="number" min="0" value="' + (+item.estimate || '') + '"></div><div class="field"><label>日期</label><input id="edit-life-date" type="date" value="' + esc(item.plannedDate || '') + '"></div></div><button class="btn-primary" onclick="saveLifeEdit(\'' + itemId + '\')">保存修改</button>');
}

function saveLifeEdit(itemId) {
  const item = state.life.find(entry => entry.id === itemId);
  if (!item) return;
  const title = $('#edit-life-title')?.value.trim();
  const date = $('#edit-life-date')?.value;
  if (!title || !date) { toast('请确认名称和日期'); return; }
  item.title = title; item.estimate = +$('#edit-life-estimate')?.value || 0; item.plannedDate = date; item.weekStart = weekStartOf(date); item.when = dayText(date); item.status = item.status === 'done' ? 'done' : 'planned';
  close(); save(); toast('生活安排已更新');
}

function removeLife(itemId) { state.life = state.life.filter(item => item.id !== itemId); close(); save(); toast('已移除生活安排'); }

function rescheduleTask(taskId) {
  const task = state.tasks.find(item => item.id === taskId);
  close(); open('<h2>修改安排日期</h2><p>修改后仍会遵守已经确认的硬依赖。</p><div class="field"><label>日期</label><input id="reschedule-date" type="date" value="' + task.plannedDate + '"></div><button class="btn-primary" onclick="saveReschedule(\'' + taskId + '\')">确认修改</button>');
}

function saveReschedule(taskId) {
  const task = state.tasks.find(item => item.id === taskId);
  const date = $('#reschedule-date').value;
  if (!date) return;
  const dependencies = (task.dependsOn || []).map(depId => state.tasks.find(item => item.id === depId)).filter(Boolean);
  if (dependencies.some(dep => dep.plannedDate > date && dep.status !== 'done')) { toast('这个日期早于尚未完成的前置事项'); return; }
  task.plannedDate = nextSchedulableDate(date);
  task.weekStart = weekStartOf(task.plannedDate);
  task.status = task.plannedDate >= nextWeekStart() ? 'later' : task.plannedDate < isoDate() ? 'overdue' : 'committed';
  close(); save();
}

function blockTask(taskId) { const task = state.tasks.find(item => item.id === taskId); if (!task) return; task.status = 'blocked'; task.blockedReason = task.blockedReason || '等待外部条件'; close(); save(); toast('已标记受阻，不会进入今日事项'); }
function removeTask(taskId) { state.tasks = state.tasks.filter(item => item.id !== taskId); close(); save(); toast('已移除'); }

/* ── 滑动手势 ── */
function swipeStart(event, taskId) {
  const item = document.getElementById('task-item-' + taskId);
  if (!item) return;
  _swipeState = { taskId, item, startX: event.touches ? event.touches[0].clientX : event.clientX, startY: event.touches ? event.touches[0].clientY : event.clientY, offset: 0 };
}

function swipeMove(event) {
  if (!_swipeState) return;
  const clientX = event.touches ? event.touches[0].clientX : event.clientX;
  const clientY = event.touches ? event.touches[0].clientY : event.clientY;
  const dx = clientX - _swipeState.startX;
  const dy = clientY - _swipeState.startY;
  if (Math.abs(dy) > Math.abs(dx)) return;
  event.preventDefault();
  _swipeState.offset = Math.min(0, Math.max(-120, dx));
  _swipeState.item.style.transform = 'translateX(' + _swipeState.offset + 'px)';
}

function swipeEnd() {
  if (!_swipeState) return;
  _swipeState.item.style.transform = _swipeState.offset < -80 ? 'translateX(-120px)' : 'translateX(0)';
  _swipeState = null;
}

function bindSwipes() {
  document.querySelectorAll('.task-row-wrap').forEach(wrap => {
    const item = wrap.querySelector('.task-item');
    const taskId = wrap.dataset.taskId;
    item?.addEventListener('touchstart', event => swipeStart(event, taskId), { passive: false });
    item?.addEventListener('touchmove', swipeMove, { passive: false });
    item?.addEventListener('touchend', swipeEnd);
  });
}

/* ── 设置、导出与 PWA ── */
function saveSettings() {
  const apiKey = $('#api-key');
  const personal = $('#personal-capacity');
  const main = $('#main-capacity');
  const reminder = $('#reminder-time');
  if (apiKey) state.settings.apiKey = apiKey.value.trim();
  if (personal) state.settings.personalCapacity = +personal.value || 7;
  if (main) state.settings.mainCapacity = +main.value || 20;
  if (reminder) state.settings.reminderTime = reminder.value || '22:30';
  save(); toast('设置已保存在本机');
}

function rollTemporalState() {
  let changed = false;
  state.tasks.forEach(task => {
    if (task.status === 'later' && task.weekStart < currentWeekStart()) { task.status = 'pending_review'; task.plannedDate = ''; changed = true; }
    if (task.plannedDate && task.plannedDate < isoDate() && ['committed', 'active', 'paused'].includes(task.status)) { task.status = 'overdue'; changed = true; }
  });
  if (changed) persist();
}

async function testDeepSeek() {
  const keyInput = $('#api-key');
  if (keyInput) state.settings.apiKey = keyInput.value.trim();
  if (!state.settings.apiKey) { toast('请先填写 API Key'); return; }
  toast('正在测试 DeepSeek…');
  try {
    await deepseekJSON('只输出 JSON：{"ok":true}', '连接测试', 'high');
    persist(); toast('DeepSeek 连接成功');
  } catch (error) { toast(apiErrorMessage(error)); }
}

function download(name, type, data) {
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(new Blob([data], { type })); anchor.download = name; anchor.click(); URL.revokeObjectURL(anchor.href);
}

function exportMenu() {
  open('<h2>导出与备份</h2><p>JSON 包含完整本地数据。公开周报不会包含 API Key。</p><button class="btn-primary" onclick="exportBackup()">导出完整 JSON</button><button class="btn-secondary" style="width:100%" onclick="exportMd()">导出本周周报 Markdown</button><button class="btn-secondary" style="width:100%" onclick="exportCsv()">导出任务 CSV</button>');
}

function exportBackup() {
  const backup = structuredClone(state);
  backup.settings.apiKey = '';
  download('未尽-完整备份.json', 'application/json', JSON.stringify(backup, null, 2)); close();
}

function exportMd() {
  const report = buildReport();
  const draft = state.reportDrafts[report.weekStart];
  const md = '# 未尽 · 本周周报\n\n- 完成：' + report.done + '/' + report.total + '\n- 实际专注：' + durationText(report.actualMs) + '\n- 估时偏差：' + report.bias + '\n\n## 工作承诺\n' + report.tasks.map(task => '- ' + task.title + '（' + task.project + '）：' + label(task.status)).join('\n') + '\n\n## 生活安排（不计工作 KPI）\n' + report.life.map(item => '- ' + item.title + '：' + (item.status === 'done' ? '已完成' : '本周安排')).join('\n') + '\n\n## 秘书判断\n' + (draft?.judgment || '尚未生成 AI 判断') + '\n\n## 下周建议\n' + (draft?.suggestions || []).map(item => '- ' + item).join('\n') + '\n';
  download('未尽-本周周报.md', 'text/markdown;charset=utf-8', md); close();
}

function exportCsv() {
  const rows = ['任务,项目,容量池,状态,安排日期,预计分钟,实际分钟,剩余分钟'];
  state.tasks.forEach(task => rows.push([task.title, task.project, taskPool(task), label(task.status), task.plannedDate, task.estimate, Math.round(taskActualMs(task.id) / 60000), task.remaining || ''].map(value => '"' + String(value).replace(/"/g, '""') + '"').join(',')));
  download('未尽-任务.csv', 'text/csv;charset=utf-8', '﻿' + rows.join('\n')); close();
}

async function installApp() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const result = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    toast(result.outcome === 'accepted' ? '正在安装未尽' : '已取消安装');
    return;
  }
  open('<h2>安装未尽</h2><p>请用 Chrome 打开，点击右上角菜单，选择“安装应用”。</p><button class="btn-primary" onclick="close()">我知道了</button>');
}

window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferredInstallPrompt = event; render(); });
window.addEventListener('appinstalled', () => { deferredInstallPrompt = null; toast('未尽已安装到桌面'); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { rollTemporalState(); render(); } });

if ('serviceWorker' in navigator) {
  let reloadingForNewWorker = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadingForNewWorker) return;
    reloadingForNewWorker = true;
    location.reload();
  });
  navigator.serviceWorker.register('./sw.js?v=8').then(registration => registration.update()).catch(error => console.warn('Service Worker 更新失败', error));
}
render();
