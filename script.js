'use strict';

/* =========================================================
   1. CONFIG — كل ما يمكن تعديله موجود هنا
   ========================================================= */
const STORAGE = {
  player:         'sq.player',
  tasks:          'sq.tasks',
  history:        'sq.history',
  settings:       'sq.settings',      // يحتوي إعدادات الصوت
  lastActiveDate: 'sq.lastActiveDate',
  currentDay:     'sq.currentDay',    // XP اليوم + المكافآت المفتوحة
  challenges:     'sq.challenges'     // التحدي النشط
};
const LEGACY_KEY = 'soloSystem.v1';   // مفتاح النسخة الأولى (للترحيل التلقائي)

const CONFIG = {
  carryOverTasks: true,   // نقل نفس المهام لليوم الجديد (غير مكتملة)
  challengeBelow: 50,     // أقل من هذه النسبة = تحدي
  maxTaskLength: 60,
  baseXpToLevel: 100,     // XP المطلوب للمستوى 1 -> 2
  xpGrowthPerLevel: 25,
  streak: {
    minProgress: 50,      // النسبة المطلوبة لزيادة الـ Streak
    onFail: 'reset'       // 'reset' = يرجع 0 | 'decrease' = ينقص يومًا | 'keep' = يبقى كما هو
  }
};

const DIFFICULTIES = {
  easy:   { label: 'Easy',   xp: 10 },
  normal: { label: 'Normal', xp: 20 },
  hard:   { label: 'Hard',   xp: 30 }
};

// رتّبها تصاعديًا. المكافأة تُختار عشوائيًا من pool كل مستوى.
const REWARD_TIERS = [
  {
    threshold: 50, tier: 'SMALL', label: 'Small Reward', bonusXp: 5,
    pool: [
      '20 minutes of social media',
      'Listen to your favorite music for 15 minutes',
      'Take a 10-minute rest',
      'Enjoy a cup of your favorite drink'
    ]
  },
  {
    threshold: 75, tier: 'MEDIUM', label: 'Medium Reward', bonusXp: 10,
    pool: [
      '30 minutes of gaming',
      'Watch one anime episode',
      'Relax for 30 minutes',
      'Guilt-free phone time for 30 minutes'
    ]
  },
  {
    threshold: 90, tier: 'RARE', label: 'Rare Reward', bonusXp: 20,
    pool: [
      'Watch a movie tonight',
      'Eat your favorite meal',
      '1 hour of gaming',
      'Pick any entertainment activity you love'
    ]
  },
  {
    threshold: 100, tier: 'PERFECT DAY', label: 'Perfect Day Reward', bonusXp: 50,
    pool: [
      'Watch a full movie of your choice',
      'Order or cook your favorite meal',
      '2 hours of completely free time',
      'Choose any entertainment you want, no guilt'
    ]
  }
];

// تحديات آمنة ومعقولة
const CHALLENGES = [
  'Tidy your desk for 10 minutes',
  'Organize your computer files',
  'Read 10 pages of a book',
  'Review an old lesson for 15 minutes',
  'Write tomorrow’s plan',
  'Clean one small part of your room',
  'Finish one postponed task',
  'Close all distractions for 20 minutes and focus on a single task',
  'Review your weekly goals',
  'Write 3 things you want to improve tomorrow'
];

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const RING_CIRCUMFERENCE = 2 * Math.PI * 60;

/* =========================================================
   2. STATE & HELPERS
   ========================================================= */
let state;
let els = {};
let justAddedId = null;
let justCompletedId = null;
let pendingConfirm = null;
let introActive = true;          // الـ Opening يظهر في كل تحميل للصفحة
let introTimers = [];
const introQueue = [];           // إشعارات تنتظر انتهاء الـ Opening
const messageQueue = [];
let messageOpen = false;
let audioCtx = null;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const pad = n => String(n).padStart(2, '0');

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/* ---------- Dates ---------- */
function toDateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function todayKey() { return toDateKey(new Date()); }
function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}
function addDays(key, n) {
  const d = parseKey(key);
  d.setDate(d.getDate() + n);
  return toDateKey(d);
}
function dayDiff(a, b) {
  return Math.round((parseKey(b) - parseKey(a)) / 86400000);
}
function formatDateLabel(key) {
  const d = parseKey(key);
  return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${formatDateLabel(toDateKey(d))} · ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/* =========================================================
   3. DATA — LocalStorage (JSON)
   ========================================================= */
function createDefaultState() {
  return {
    player: { level: 1, xp: 0, streak: 0 },
    tasks: [],                                   // { id, name, difficulty, xp, completed }
    history: [],                                 // لقطة كاملة لكل يوم (لا تُحذف)
    settings: { sound: true },
    lastActiveDate: todayKey(),
    currentDay: { xpEarned: 0, rewards: [] },    // rewards: { threshold, tier, name, bonusXp }
    challenges: { active: null }                 // active: { text, assignedOn }
  };
}

function readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch (err) {
    return null;
  }
}
function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('Could not save', key, err);
  }
}

/* ---------- Normalization (يحمي من بيانات ناقصة/قديمة) ---------- */
function getTierByThreshold(threshold) {
  return REWARD_TIERS.find(t => t.threshold === threshold) || null;
}

function normalizeTask(t) {
  const difficulty = DIFFICULTIES[t && t.difficulty] ? t.difficulty : 'normal';
  return {
    id: (t && t.id) || generateId(),
    name: String((t && t.name) || 'Quest'),
    difficulty,
    xp: Number.isFinite(t && t.xp) ? t.xp : DIFFICULTIES[difficulty].xp,
    completed: !!(t && t.completed)
  };
}

function normalizeReward(r) {
  const tier = getTierByThreshold(r && r.threshold);
  return {
    threshold: Number(r && r.threshold) || 0,
    tier: (r && r.tier) || (tier ? tier.tier : 'REWARD'),
    name: String((r && r.name) || (tier ? tier.label : 'Reward')),
    bonusXp: Number.isFinite(r && r.bonusXp) ? r.bonusXp : (tier ? tier.bonusXp : 0)
  };
}

function normalizeHistoryEntry(h) {
  const rewards = Array.isArray(h.rewards) ? h.rewards : (h.reward ? [h.reward] : []);
  return {
    date: String(h.date),
    status: h.status === 'missed' ? 'missed' : 'completed',
    progress: Number(h.progress) || 0,
    completed: Number(h.completed) || 0,
    total: Number(h.total) || 0,
    xpEarned: Number(h.xpEarned) || 0,
    level: Number(h.level) || 1,
    streak: Number(h.streak) || 0,
    rewards: rewards.map(normalizeReward),
    challenge: h.challenge || h.penalty || null,
    endedAt: h.endedAt || null,
    tasks: (Array.isArray(h.tasks) ? h.tasks : []).map(normalizeTask)
  };
}

function normalizeState(loaded) {
  const base = createDefaultState();
  const cd = loaded.currentDay || {};
  return {
    player: { ...base.player, ...(loaded.player || {}) },
    tasks: Array.isArray(loaded.tasks) ? loaded.tasks.map(normalizeTask) : [],
    history: Array.isArray(loaded.history)
      ? loaded.history.filter(h => h && h.date).map(normalizeHistoryEntry)
      : [],
    settings: { sound: !(loaded.settings && loaded.settings.sound === false) },
    lastActiveDate: typeof loaded.lastActiveDate === 'string' ? loaded.lastActiveDate : base.lastActiveDate,
    currentDay: {
      xpEarned: Number(cd.xpEarned) || 0,
      rewards: Array.isArray(cd.rewards) ? cd.rewards.map(normalizeReward) : []
    },
    challenges: { active: (loaded.challenges && loaded.challenges.active) || null }
  };
}

/* ---------- ترحيل بيانات النسخة الأولى تلقائيًا ---------- */
function readLegacyData() {
  const old = readJSON(LEGACY_KEY);
  if (!old) return null;
  return {
    player: old.player,
    tasks: old.tasks,
    history: old.history,
    settings: { sound: !(old.settings && old.settings.sound === false) },
    lastActiveDate: old.lastActiveDate,
    currentDay: {
      xpEarned: old.day && old.day.xpEarned,
      rewards: ((old.day && old.day.rewards) || []).map(threshold => ({ threshold }))
    },
    challenges: {
      active: old.pendingPenalty
        ? { text: old.pendingPenalty, assignedOn: old.lastActiveDate }
        : null
    }
  };
}

function loadData() {
  const hasNewData = Object.values(STORAGE).some(key => readJSON(key) !== null);
  const legacy = hasNewData ? null : readLegacyData();
  const loaded = {};
  Object.keys(STORAGE).forEach(name => {
    loaded[name] = legacy ? legacy[name] : readJSON(STORAGE[name]);
  });
  return normalizeState(loaded);
}

function saveData() {
  Object.keys(STORAGE).forEach(name => writeJSON(STORAGE[name], state[name]));
}

/* =========================================================
   4. TASKS
   ========================================================= */
function addTask(name, difficulty) {
  const clean = name.trim().slice(0, CONFIG.maxTaskLength);
  if (!clean) return false;
  const key = DIFFICULTIES[difficulty] ? difficulty : 'normal';
  const task = {
    id: generateId(),
    name: clean,
    difficulty: key,
    xp: DIFFICULTIES[key].xp,
    completed: false
  };
  state.tasks.push(task);
  justAddedId = task.id;
  showNotification('NEW QUEST', clean, 'info');
  playSound('notify');
  afterTaskChange();
  return true;
}

function deleteTask(id) {
  const el = $(`[data-id="${id}"]`, els.taskList);
  if (el && el.classList.contains('leaving')) return;

  const finish = () => {
    const task = state.tasks.find(t => t.id === id);
    if (!task) return;
    if (task.completed) updateXP(-task.xp);
    state.tasks = state.tasks.filter(t => t.id !== id);
    showNotification('QUEST DELETED', task.name, 'warn');
    afterTaskChange();
  };

  if (el) {
    el.classList.add('leaving');
    setTimeout(finish, 220);
  } else {
    finish();
  }
}

function toggleTask(id) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;

  task.completed = !task.completed;
  if (task.completed) {
    justCompletedId = id;
    updateXP(task.xp);
    showNotification('✓ QUEST COMPLETED', `+${task.xp} XP`, 'success');
    playSound('complete');
  } else {
    updateXP(-task.xp);
    showNotification('QUEST REOPENED', `-${task.xp} XP`, 'warn');
    playSound('notify');
  }
  afterTaskChange();
}

function afterTaskChange() {
  checkRewards();
  refresh();
}

/* =========================================================
   5. PROGRESS & XP
   ========================================================= */
function calculateProgress() {
  const total = state.tasks.length;
  const completed = state.tasks.filter(t => t.completed).length;
  const percent = total ? Math.round((completed / total) * 100) : 0;
  return { total, completed, percent };
}

function xpForLevel(level) {
  return CONFIG.baseXpToLevel + (level - 1) * CONFIG.xpGrowthPerLevel;
}

// amount موجب = إضافة XP، سالب = خصم XP
function updateXP(amount) {
  state.player.xp += amount;
  state.currentDay.xpEarned = Math.max(0, state.currentDay.xpEarned + amount);
  if (amount > 0) {
    checkLevelUp();
  } else {
    fixNegativeXP();
  }
}

function fixNegativeXP() {
  while (state.player.xp < 0 && state.player.level > 1) {
    state.player.level--;
    state.player.xp += xpForLevel(state.player.level);
  }
  if (state.player.xp < 0) state.player.xp = 0;
}

function checkLevelUp() {
  let leveled = false;
  while (state.player.xp >= xpForLevel(state.player.level)) {
    state.player.xp -= xpForLevel(state.player.level);
    state.player.level++;
    leveled = true;
  }
  if (!leveled) return;

  playSound('levelup');
  queueSystemMessage({
    type: 'levelup',
    title: 'LEVEL UP',
    name: `PLAYER REACHED LEVEL ${state.player.level}`,
    body: 'You have grown stronger.'
  });
  showNotification('LEVEL UP', `Level ${state.player.level}`, 'success');
}

/* =========================================================
   6. REWARDS & CHALLENGES
   ========================================================= */
function isTierUnlocked(threshold) {
  return state.currentDay.rewards.some(r => r.threshold === threshold);
}

function checkRewards() {
  const { total, percent } = calculateProgress();
  if (!total) return;

  const reached = REWARD_TIERS.filter(t => percent >= t.threshold && !isTierUnlocked(t.threshold));
  if (!reached.length) return;

  const unlocked = reached.map(t => ({
    threshold: t.threshold,
    tier: t.tier,
    name: pickRandom(t.pool),
    bonusXp: t.bonusXp
  }));
  state.currentDay.rewards.push(...unlocked);
  showReward(unlocked[unlocked.length - 1], unlocked);
}

function showReward(reward, allUnlocked = [reward]) {
  const bonus = allUnlocked.reduce((sum, r) => sum + r.bonusXp, 0);
  playSound('reward');
  queueSystemMessage({
    type: 'reward',
    title: 'REWARD UNLOCKED',
    sub: reward.threshold === 100 ? 'PERFECT DAY' : `${reward.tier} REWARD`,
    name: reward.name,
    body: `+${bonus} bonus XP`
  });
  showNotification('REWARD UNLOCKED', reward.name, 'success');
  if (reward.threshold === 100) showNotification('PERFECT DAY', 'All quests cleared!', 'success');
  updateXP(bonus);   // بعد إضافة الرسالة حتى يظهر LEVEL UP بعدها
}

function pickChallenge() {
  return pickRandom(CHALLENGES);
}

function showChallenge(text) {
  playSound('challenge');
  queueSystemMessage({
    type: 'penalty',
    title: 'PENALTY ACTIVATED',
    sub: 'SYSTEM CHALLENGE',
    name: text,
    body: 'Complete it to restore your focus.'
  });
  showNotification('CHALLENGE ACTIVATED', text, 'danger');
}

function completeChallenge() {
  state.challenges.active = null;
  showNotification('CHALLENGE CLEARED', 'Well done, Player.', 'success');
  playSound('complete');
  refresh();
}

/* =========================================================
   7. DAY CYCLE & HISTORY
   ========================================================= */
function computeStreak(current, success) {
  if (success) return current + 1;
  switch (CONFIG.streak.onFail) {
    case 'keep':     return current;
    case 'decrease': return Math.max(0, current - 1);
    default:         return 0;
  }
}

// يحفظ لقطة كاملة لليوم ثم يعيدها
function saveDailyHistory(dateKey, closedAt = new Date()) {
  const { total, completed, percent } = calculateProgress();
  const success = total > 0 && percent >= CONFIG.streak.minProgress;
  const challenge = total > 0 && percent < CONFIG.challengeBelow ? pickChallenge() : null;

  state.player.streak = computeStreak(state.player.streak, success);

  const entry = {
    date: dateKey,
    status: 'completed',
    progress: percent,
    completed,
    total,
    xpEarned: state.currentDay.xpEarned,
    level: state.player.level,
    streak: state.player.streak,
    rewards: state.currentDay.rewards.map(r => ({ ...r })),
    challenge,
    endedAt: closedAt.toISOString(),
    tasks: state.tasks.map(t => ({ ...t }))
  };

  state.history = state.history.filter(h => h.date !== dateKey);
  state.history.push(entry);
  return entry;
}

function saveMissedDay(dateKey) {
  state.player.streak = computeStreak(state.player.streak, false);
  state.history = state.history.filter(h => h.date !== dateKey);
  state.history.push({
    date: dateKey,
    status: 'missed',
    progress: 0,
    completed: 0,
    total: state.tasks.length,
    xpEarned: 0,
    level: state.player.level,
    streak: state.player.streak,
    rewards: [],
    challenge: null,
    endedAt: null,
    tasks: state.tasks.map(t => ({ ...t, completed: false }))
  });
}

function endDay(dateKey) {
  const entry = saveDailyHistory(dateKey);

  const lines = entry.total
    ? [
        `Completed ${entry.completed} / ${entry.total}`,
        `+${entry.xpEarned} XP earned`,
        `Day streak: ${entry.streak}`
      ]
    : ['No quests were recorded.'];
  if (entry.rewards.length) lines.push(`Rewards unlocked: ${entry.rewards.length}`);

  playSound('notify');
  queueSystemMessage({
    type: 'summary',
    title: 'DAILY QUEST COMPLETED',
    name: `FINAL SCORE: ${entry.progress}%`,
    body: lines.join('\n')
  });

  if (entry.challenge) {
    state.challenges.active = { text: entry.challenge, assignedOn: dateKey };
    showChallenge(entry.challenge);
  }
}

function startNewDay(newKey) {
  state.tasks = CONFIG.carryOverTasks
    ? state.tasks.map(t => ({ ...t, completed: false }))
    : [];
  state.currentDay = { xpEarned: 0, rewards: [] };
  state.lastActiveDate = newKey;
}

// يعمل عند فتح الصفحة وكل ثانية، ويعالج الأيام التي مرّت أثناء الغياب
function checkNewDay() {
  const today = todayKey();
  const last = state.lastActiveDate;
  if (last === today) return false;

  const gap = dayDiff(last, today);
  if (!(gap > 0)) return false;   // ساعة الجهاز رجعت للخلف: تجاهل

  endDay(last);
  startNewDay(today);
  for (let i = 1; i < gap; i++) saveMissedDay(addDays(last, i));

  showNotification('NEW DAY STARTED', formatDateLabel(today), 'info');
  saveData();
  return true;
}

function resetCurrentDay() {
  updateXP(-state.currentDay.xpEarned);
  state.tasks.forEach(t => { t.completed = false; });
  state.currentDay = { xpEarned: 0, rewards: [] };
  showNotification('DAY RESET', 'Today’s progress was cleared.', 'warn');
  refresh();
}

function clearAllData() {
  Object.values(STORAGE).forEach(key => {
    try { localStorage.removeItem(key); } catch (err) { console.warn(err); }
  });
  try { localStorage.removeItem(LEGACY_KEY); } catch (err) { console.warn(err); }

  messageQueue.length = 0;
  messageOpen = false;
  closeModal('modal-system');
  state = createDefaultState();
  saveData();
  renderAll();
  showNotification('SYSTEM RESET', 'All player data deleted.', 'danger');
}

/* =========================================================
   8. CLOCK & COUNTDOWN
   ========================================================= */
function updateClock() {
  const now = new Date();
  els.clockDate.textContent = formatDateLabel(toDateKey(now));
  els.clockTime.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function updateCountdown() {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const diff = Math.max(0, midnight - now);
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  els.countdown.textContent = `${pad(h)}:${pad(m)}:${pad(s)}`;
  els.dayBarFill.style.width = `${(diff / 86400000) * 100}%`;
}

function tick() {
  updateClock();
  updateCountdown();
  if (state.lastActiveDate !== todayKey() && checkNewDay()) {
    renderAll();
  }
}

/* =========================================================
   9. RENDERING
   ========================================================= */
function renderAll() {
  renderPlayer();
  renderTasks();
  renderProgress();
  renderRewards();
  renderChallenge();
  renderHistory();
  renderSettings();
}

function refresh() {
  saveData();
  renderAll();
}

function renderPlayer() {
  const { level, xp, streak } = state.player;
  const need = xpForLevel(level);
  els.level.textContent = `Lv. ${level}`;
  els.xpText.textContent = `${xp} / ${need}`;
  els.xpFill.style.width = `${Math.min(100, (xp / need) * 100)}%`;
  els.streak.textContent = `${streak} ${streak === 1 ? 'DAY' : 'DAYS'}`;
}

function renderTasks() {
  els.taskEmpty.style.display = state.tasks.length ? 'none' : 'block';
  els.taskList.innerHTML = state.tasks.map(t => {
    const diff = DIFFICULTIES[t.difficulty] || DIFFICULTIES.normal;
    const classes = [
      'task',
      t.completed ? 'done' : '',
      t.id === justAddedId ? 'entering' : '',
      t.id === justCompletedId ? 'just-completed' : ''
    ].join(' ').trim();
    return `
      <li class="${classes}" data-id="${t.id}">
        <button class="task-check" type="button" data-action="toggle"
                aria-pressed="${t.completed}" aria-label="Toggle quest">✓</button>
        <div class="task-body">
          <span class="task-name">${escapeHTML(t.name)}</span>
          <div class="task-info">
            <span class="diff-${t.difficulty}">Difficulty: ${diff.label}</span>
            <span class="diff-${t.difficulty}">XP: +${t.xp}</span>
            <span class="task-status">${t.completed ? 'COMPLETED' : 'INCOMPLETE'}</span>
          </div>
        </div>
        <button class="task-delete" type="button" data-action="delete" aria-label="Delete quest">✕</button>
      </li>`;
  }).join('');
  justAddedId = null;
  justCompletedId = null;
}

function renderProgress() {
  const { total, completed, percent } = calculateProgress();
  els.ringFill.style.strokeDasharray = RING_CIRCUMFERENCE;
  els.ringFill.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - percent / 100);
  els.progressPercent.textContent = `${percent}%`;
  els.questsCount.textContent = `${completed} / ${total}`;
}

function renderRewards() {
  els.rewardList.innerHTML = REWARD_TIERS.map(t => {
    const got = state.currentDay.rewards.find(r => r.threshold === t.threshold);
    return `
      <li class="reward-item ${got ? 'unlocked' : ''}">
        <span class="reward-text">
          <small>${t.threshold}% · ${t.tier}</small>
          ${escapeHTML(got ? got.name : t.label)}
        </span>
        <span class="tag">${got ? 'UNLOCKED' : 'LOCKED'}</span>
      </li>`;
  }).join('');
}

function renderChallenge() {
  const active = state.challenges.active;
  if (active) {
    els.challengeBox.innerHTML = `
      <div class="challenge-active">
        <strong>CHALLENGE ACTIVE</strong>
        <p>${escapeHTML(active.text)}</p>
        <button class="btn btn-danger" type="button" data-action="complete-challenge">MARK AS DONE</button>
      </div>`;
  } else {
    els.challengeBox.innerHTML = '<p class="challenge-none">NO ACTIVE CHALLENGE</p>';
  }
}

function renderHistory() {
  const items = [...state.history].sort((a, b) => b.date.localeCompare(a.date));
  els.historyEmpty.style.display = items.length ? 'none' : 'block';
  els.historyList.innerHTML = items.map(h => `
    <li>
      <button class="history-card" type="button" data-date="${h.date}">
        <span class="history-date">
          ${formatDateLabel(h.date)}
          ${h.status === 'missed' ? '<span class="history-flag">MISSED DAY</span>' : ''}
        </span>
        <span class="history-row">Progress <b>${h.progress}%</b></span>
        <span class="history-row">Completed <b>${h.completed} / ${h.total}</b></span>
        <span class="history-row">XP Earned <b>${h.xpEarned}</b></span>
        <span class="history-row">Reward <b class="${h.rewards.length ? 'good' : ''}">${h.rewards.length ? 'Unlocked' : 'None'}</b></span>
        <span class="history-row">Penalty <b class="${h.challenge ? 'bad' : ''}">${h.challenge ? 'Activated' : 'None'}</b></span>
      </button>
    </li>`).join('');
}

function renderSettings() {
  els.soundToggle.checked = !!state.settings.sound;
  els.soundState.textContent = state.settings.sound ? 'ON' : 'OFF';
}

function renderDifficultyOptions() {
  els.difficultyOptions.innerHTML = Object.entries(DIFFICULTIES).map(([key, d]) => `
    <label>
      <input type="radio" name="difficulty" value="${key}" ${key === 'normal' ? 'checked' : ''}>
      <span>${d.label.toUpperCase()}<small>+${d.xp} XP</small></span>
    </label>`).join('');
}

function openHistoryDetail(dateKey) {
  const h = state.history.find(x => x.date === dateKey);
  if (!h) return;

  const done = h.tasks.filter(t => t.completed);
  const undone = h.tasks.filter(t => !t.completed);
  const taskList = arr => arr.length
    ? arr.map(t => `<li>${escapeHTML(t.name)}<small>${(DIFFICULTIES[t.difficulty] || DIFFICULTIES.normal).label} · +${t.xp} XP</small></li>`).join('')
    : '<li class="none">— None —</li>';
  const rewardList = h.rewards.length
    ? h.rewards.map(r => `<li>${escapeHTML(r.name)}<small>${escapeHTML(r.tier)}</small></li>`).join('')
    : '<li class="none">— None —</li>';

  els.historyDetail.innerHTML = `
    <h3 class="detail-title">${formatDateLabel(h.date)}${h.status === 'missed' ? ' — MISSED DAY' : ''}</h3>
    <p class="detail-sub">DAY CLOSED AT: ${formatDateTime(h.endedAt)}</p>
    <div class="detail-stats">
      <div class="detail-stat"><small>PROGRESS</small><b>${h.progress}%</b></div>
      <div class="detail-stat"><small>COMPLETED</small><b>${h.completed} / ${h.total}</b></div>
      <div class="detail-stat"><small>XP EARNED</small><b>${h.xpEarned}</b></div>
      <div class="detail-stat"><small>LEVEL (END OF DAY)</small><b>Lv. ${h.level}</b></div>
      <div class="detail-stat"><small>STREAK</small><b>${h.streak}</b></div>
      <div class="detail-stat"><small>PENALTY</small><b class="${h.challenge ? 'bad' : ''}">${h.challenge ? escapeHTML(h.challenge) : 'None'}</b></div>
    </div>
    <div class="detail-section"><h4 class="good">REWARDS</h4><ul>${rewardList}</ul></div>
    <div class="detail-section"><h4 class="good">COMPLETED QUESTS</h4><ul>${taskList(done)}</ul></div>
    <div class="detail-section"><h4 class="bad">INCOMPLETE QUESTS</h4><ul>${taskList(undone)}</ul></div>`;
  openModal('modal-history');
}

function switchView(name) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
}

/* =========================================================
   10. MODALS, NOTIFICATIONS & SYSTEM MESSAGES
   ========================================================= */
function openModal(id) {
  const modal = document.getElementById(id);
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
}

function closeModal(id) {
  const modal = document.getElementById(id);
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  if (!$('.modal.open')) document.body.classList.remove('modal-open');
}

function openAddModal() {
  els.addForm.reset();
  openModal('modal-add');
  setTimeout(() => els.taskName.focus(), 120);
}

function queueSystemMessage(msg) {
  messageQueue.push(msg);
  if (!messageOpen) showNextMessage();
}

function showNextMessage() {
  const msg = messageQueue.shift();
  if (!msg) {
    messageOpen = false;
    closeModal('modal-system');
    return;
  }
  messageOpen = true;
  els.sysModal.dataset.type = msg.type || 'info';
  els.sysTitle.textContent = msg.title;
  els.sysSub.textContent = msg.sub || '';
  els.sysSub.style.display = msg.sub ? 'block' : 'none';
  els.sysName.textContent = msg.name || '';
  els.sysName.style.display = msg.name ? 'block' : 'none';
  els.sysBody.textContent = msg.body || '';
  openModal('modal-system');
}

function openConfirm({ title, text, onConfirm }) {
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  pendingConfirm = onConfirm;
  openModal('modal-confirm');
}

// Toast بتصميم System UI. تنتظر انتهاء الـ Opening لتظهر بوضوح.
function showNotification(title, message = '', type = 'info') {
  if (introActive) {
    introQueue.push([title, message, type]);
    return;
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<strong>${escapeHTML(title)}</strong>${message ? `<span>${escapeHTML(message)}</span>` : ''}`;
  els.toasts.appendChild(el);
  while (els.toasts.children.length > 4) els.toasts.firstElementChild.remove();
  setTimeout(() => el.classList.add('leaving'), 3000);
  setTimeout(() => el.remove(), 3400);
}

/* =========================================================
   11. SOUND (WebAudio — آمن ولا يسبب أخطاء)
   ========================================================= */
function unlockAudio() {
  if (audioCtx) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  } catch (err) {
    audioCtx = null;
  }
}

function playSound(type) {
  if (!state.settings.sound || !audioCtx) return;
  const sequences = {
    complete:  [[660, 0.08], [880, 0.14]],
    levelup:   [[523, 0.1], [659, 0.1], [784, 0.1], [1047, 0.28]],
    reward:    [[784, 0.1], [988, 0.1], [1319, 0.26]],
    notify:    [[600, 0.06], [800, 0.1]],
    challenge: [[320, 0.16], [220, 0.28]]
  };
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    let t = audioCtx.currentTime;
    (sequences[type] || []).forEach(([freq, dur]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
      t += dur;
    });
  } catch (err) {
    console.warn('Sound error', err);
  }
}

/* =========================================================
   12. OPENING SCREEN — يعمل في كل تحميل للصفحة
   (لا يستخدم LocalStorage إطلاقًا)
   ========================================================= */
function runIntro() {
  introActive = true;
  els.intro.classList.remove('hidden', 'fade-out');
  const lines = $$('.intro-line', els.intro);

  introTimers.forEach(clearTimeout);
  introTimers = [
    setTimeout(() => lines[0].classList.add('show'), 150),
    setTimeout(() => lines[1].classList.add('show'), 1100),
    setTimeout(() => lines[2].classList.add('show'), 2000),
    setTimeout(endIntro, 3700)
  ];
}

function endIntro() {
  if (!introActive) return;
  introActive = false;
  introTimers.forEach(clearTimeout);
  introTimers = [];

  els.intro.classList.add('fade-out');
  setTimeout(() => els.intro.classList.add('hidden'), 520);

  // أظهر الإشعارات التي تأخرت بسبب الـ Opening
  while (introQueue.length) showNotification(...introQueue.shift());
}

/* =========================================================
   13. EVENTS
   ========================================================= */
function cacheElements() {
  els = {
    intro: $('#intro'),
    clockDate: $('#clock-date'),
    clockTime: $('#clock-time'),
    level: $('#player-level'),
    xpText: $('#xp-text'),
    xpFill: $('#xp-fill'),
    streak: $('#streak-value'),
    taskList: $('#task-list'),
    taskEmpty: $('#task-empty'),
    ringFill: $('#ring-fill'),
    progressPercent: $('#progress-percent'),
    questsCount: $('#quests-count'),
    countdown: $('#countdown'),
    dayBarFill: $('#day-bar-fill'),
    rewardList: $('#reward-list'),
    challengeBox: $('#challenge-box'),
    historyList: $('#history-list'),
    historyEmpty: $('#history-empty'),
    historyDetail: $('#history-detail'),
    soundToggle: $('#sound-toggle'),
    soundState: $('#sound-state'),
    addForm: $('#add-form'),
    taskName: $('#task-name'),
    difficultyOptions: $('#difficulty-options'),
    sysModal: $('#modal-system'),
    sysTitle: $('#sys-title'),
    sysSub: $('#sys-sub'),
    sysName: $('#sys-name'),
    sysBody: $('#sys-body'),
    toasts: $('#toast-container')
  };
}

function bindEvents() {
  // أول تفاعل من المستخدم = تفعيل الصوت (لتجنب منع المتصفح)
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });

  $('#btn-add-quest').addEventListener('click', openAddModal);

  els.addForm.addEventListener('submit', e => {
    e.preventDefault();
    const difficulty = new FormData(els.addForm).get('difficulty');
    if (addTask(els.taskName.value, difficulty)) {
      closeModal('modal-add');
    } else {
      els.taskName.focus();
    }
  });

  // Event delegation للمهام
  els.taskList.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.closest('.task').dataset.id;
    if (btn.dataset.action === 'toggle') toggleTask(id);
    if (btn.dataset.action === 'delete') deleteTask(id);
  });

  els.challengeBox.addEventListener('click', e => {
    if (e.target.closest('[data-action="complete-challenge"]')) completeChallenge();
  });

  els.historyList.addEventListener('click', e => {
    const card = e.target.closest('[data-date]');
    if (card) openHistoryDetail(card.dataset.date);
  });

  $$('.tab').forEach(tab => tab.addEventListener('click', () => switchView(tab.dataset.view)));

  // إغلاق المودالز
  document.addEventListener('click', e => {
    const closer = e.target.closest('[data-close]');
    if (closer) closeModal(closer.closest('.modal').id);
    if (e.target.classList.contains('modal') && ['modal-add', 'modal-history'].includes(e.target.id)) {
      closeModal(e.target.id);
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeModal('modal-add');
      closeModal('modal-history');
      closeModal('modal-confirm');
    }
  });

  $('#sys-ok').addEventListener('click', showNextMessage);

  $('#confirm-ok').addEventListener('click', () => {
    closeModal('modal-confirm');
    if (typeof pendingConfirm === 'function') pendingConfirm();
    pendingConfirm = null;
  });

  // Settings
  els.soundToggle.addEventListener('change', () => {
    state.settings.sound = els.soundToggle.checked;
    saveData();
    renderSettings();
    playSound('notify');
  });
  $('#btn-reset-day').addEventListener('click', () => openConfirm({
    title: 'RESET CURRENT DAY?',
    text: 'All of today’s quests will be unchecked and today’s XP reverted.',
    onConfirm: resetCurrentDay
  }));
  $('#btn-clear-all').addEventListener('click', () => openConfirm({
    title: 'ALL PLAYER DATA WILL BE DELETED.',
    text: 'Quests, level, streak and the entire history will be permanently removed.',
    onConfirm: clearAllData
  }));

  $('#intro-skip').addEventListener('click', endIntro);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}

/* =========================================================
   14. INIT
   ========================================================= */
function init() {
  cacheElements();
  state = loadData();
  renderDifficultyOptions();
  bindEvents();

  runIntro();            // دائمًا في كل Load / Reload
  checkNewDay();         // يعالج الأيام التي مرّت أثناء إغلاق الموقع
  saveData();
  renderAll();
  tick();
  setInterval(tick, 1000);
}

document.addEventListener('DOMContentLoaded', init);