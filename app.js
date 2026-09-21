// ============================================================
// 原神成就统计 - 核心逻辑
// 升级版 2026-09-21
//   · 成就 key 改用游戏内稳定 id（旧版「文件::合辑::序号」会随版本更新整体错位）
//   · 自动把旧的已保存进度迁移到新键位，进度不丢
//   · 新增：只看未完成 / 只看已完成 / 隐藏隐藏成就
//   · 新增：原石统计、数据版本显示、JSON 备份与恢复
//   · 新增：合辑进度总览（按差最少/剩原石/完成率排序，点击跳转）
//   · 新增：今日推荐 5 个未完成成就（按日期+UID 确定性随机，原石优先）
//   · 新增：成就行内「攻略」一键搜索、「7.0 新增」徽章与「只看新增」筛选
//   · 修复：重复登录导致事件重复绑定、删除账号无二次确认、子分类全选计数错误
// 自动导入版 2026-09-21（第三轮）
//   · 新增：UIAF 成就文件导入（一次导入全部进度，含完成时间，符合 UIAF v1.1）
//   · 新增：UIAF 导出（可把进度带去椰羊 / Paimon.moe / 胡桃等工具）
//   · 新增：合辑卡片「整组完成 / 整组清空」批量勾选
//   · 新增：搜索结果「全部标记完成」
//   · 新增：批量操作「撤销」（导入和批量勾选都可一键还原）
//   · 新增：记录每一条成就的完成时间，为后续「最近完成」等功能预留
// ============================================================

let currentUid = null;
let userAchievements = {};
let allAchievementList = []; // Flat list for search

// 视图筛选状态
let viewFilter = 'all';      // all | undone | done
let hideHidden = false;      // 是否隐藏「隐藏成就」

// 完成时间记录：key -> 毫秒时间戳（与 userAchievements 分开存，兼容旧数据）
let doneTimes = {};

// 批量操作快照，用于「撤销」
let lastSnapshot = null;
let toastTimer = null;

// 当前搜索结果对应的成就 key（供「全部标记完成」使用）
let currentSearchKeys = [];

// UIAF 规范：无法识别完成时间时使用的占位值（253402271999 秒 = 9999-12-31 23:59:59）
const UIAF_SENTINEL = 253402271999;

// 当前版本暂时无法达成的成就（不计入「可完成」分母）
// ⚠️ 每次版本更新后请复核这份名单
const BLOCKED = {
  '80507': '需至冬末期才可达成',
  '81622': '2027-07-01 之后可达成',
  '86063': '达成条件尚未开放',
};

// ========== 工具函数 ==========
function getStorageKey(uid) { return `genshin_achievements_${uid}`; }
function getTimesKey(uid) { return `genshin_achievement_times_${uid}`; }
function getAccountsKey() { return `genshin_accounts`; }

// 插入到 HTML 之前先转义，避免文件里的怪字符把页面搞坏
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 旧版键位（wonders_of_the_world::天地万象::0）→ 新键位（成就 id）
function migrateKeys(data) {
  const map = window.LEGACY_KEY_MAP || {};
  const out = {};
  let migrated = 0;
  for (const k of Object.keys(data)) {
    const nk = map[k] || k;
    if (nk !== k) migrated++;
    out[nk] = data[k];
  }
  return { data: out, migrated };
}

function loadAchievements(uid) {
  const raw = localStorage.getItem(getStorageKey(uid));
  if (!raw) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return {}; }
  const { data, migrated } = migrateKeys(parsed);
  if (migrated > 0) {
    localStorage.setItem(getStorageKey(uid), JSON.stringify(data));
    console.log(`[成就统计] 已迁移 ${migrated} 条旧进度到新的稳定键位`);
  }
  return data;
}

function loadTimes(uid) {
  try {
    const parsed = JSON.parse(localStorage.getItem(getTimesKey(uid)) || '{}');
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) { return {}; }
}

function saveAchievements(uid, data) {
  localStorage.setItem(getStorageKey(uid), JSON.stringify(data));
  const accounts = getAccounts();
  if (!accounts.includes(uid)) {
    accounts.push(uid);
    localStorage.setItem(getAccountsKey(), JSON.stringify(accounts));
  }
}

// 进度 + 完成时间一起落盘（所有改动进度的路径都走这里）
function persist() {
  saveAchievements(currentUid, userAchievements[currentUid] || {});
  try { localStorage.setItem(getTimesKey(currentUid), JSON.stringify(doneTimes)); } catch (e) { /* 超额就放弃记录时间，不影响进度 */ }
}

// 统一的勾选入口：on=true 标记完成并记时间；on=false 取消并抹掉时间
function setDone(key, on, ts) {
  if (!key) return;
  const cur = userAchievements[currentUid] || (userAchievements[currentUid] = {});
  if (on) {
    cur[key] = true;
    doneTimes[key] = ts || doneTimes[key] || Date.now();
  } else {
    delete cur[key];
    delete doneTimes[key];
  }
}

function getAccounts() {
  const data = localStorage.getItem(getAccountsKey());
  return data ? JSON.parse(data) : [];
}

function removeAccount(uid) {
  const accounts = getAccounts().filter(id => id !== uid);
  localStorage.setItem(getAccountsKey(), JSON.stringify(accounts));
  localStorage.removeItem(getStorageKey(uid));
  localStorage.removeItem(getTimesKey(uid));
}

// ========== 批量操作：快照与撤销 ==========
function snapshot(label) {
  lastSnapshot = {
    label: label || '批量操作',
    data: Object.assign({}, userAchievements[currentUid] || {}),
    times: Object.assign({}, doneTimes),
  };
}

function undoLast() {
  if (!lastSnapshot) return;
  const label = lastSnapshot.label;
  userAchievements[currentUid] = Object.assign({}, lastSnapshot.data);
  doneTimes = Object.assign({}, lastSnapshot.times);
  lastSnapshot = null;
  persist();
  renderAchievements();
  updateStats();
  const el = document.getElementById('toast');
  if (el) {
    el.querySelector('#toast-msg').textContent = `已撤销：${label}`;
    el.querySelector('#toast-undo').style.display = 'none';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
  }
}

function showToast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.innerHTML = `<span id="toast-msg"></span><button class="toast-undo" id="toast-undo">撤销</button>`;
    document.body.appendChild(el);
    el.querySelector('#toast-undo').addEventListener('click', undoLast);
  }
  el.querySelector('#toast-msg').textContent = msg;
  el.querySelector('#toast-undo').style.display = lastSnapshot ? '' : 'none';
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 12000);
}

// Build flat achievement list for search
function buildAchievementList() {
  allAchievementList = [];
  for (const [category, catData] of Object.entries(window.ACHIEVEMENTS_DATA)) {
    for (const [subName, items] of Object.entries(catData.children)) {
      items.forEach(item => {
        allAchievementList.push({ ...item, category, subName });
      });
    }
  }
}

function knownKeySet() {
  if (!allAchievementList.length) buildAchievementList();
  const set = new Set();
  allAchievementList.forEach(a => set.add(a.key));
  return set;
}

// ========== 统计计算 ==========
function calcStats(data) {
  let total = 0, completed = 0, obtainable = 0, completedObtainable = 0;
  let rewardTotal = 0, rewardDone = 0;
  const catStats = {};
  for (const [category, catData] of Object.entries(window.ACHIEVEMENTS_DATA)) {
    let catTotal = 0, catCompleted = 0, catReward = 0, catRewardDone = 0;
    for (const [, items] of Object.entries(catData.children)) {
      items.forEach(item => {
        const blocked = !!BLOCKED[item.key];
        total++; catTotal++;
        rewardTotal += item.reward || 0; catReward += item.reward || 0;
        if (!blocked) obtainable++;
        if (data[item.key]) {
          completed++; catCompleted++;
          rewardDone += item.reward || 0; catRewardDone += item.reward || 0;
          if (!blocked) completedObtainable++;
        }
      });
    }
    catStats[category] = { total: catTotal, completed: catCompleted, reward: catReward, rewardDone: catRewardDone };
  }
  return { total, completed, obtainable, completedObtainable, rewardTotal, rewardDone, catStats, blockedCount: total - obtainable };
}

function pct(a, b) { return b > 0 ? Math.round(a / b * 100) : 0; }

// ========== 登录页 ==========
function initLoginPage() {
  const uidInput = document.getElementById('uid-input');
  const loginBtn = document.getElementById('login-btn');
  const loginError = document.getElementById('login-error');
  const accountsList = document.getElementById('accounts-list');
  const savedAccounts = document.getElementById('saved-accounts');

  function renderSavedAccounts() {
    const accounts = getAccounts();
    accountsList.innerHTML = '';
    if (accounts.length === 0) { savedAccounts.style.display = 'none'; return; }
    savedAccounts.style.display = 'block';
    accounts.forEach(uid => {
      const tag = document.createElement('span');
      tag.className = 'account-tag';
      tag.innerHTML = `<span>UID: ${uid}</span><span class="delete-tag" data-uid="${uid}" title="删除这个账号的本地记录">&times;</span>`;
      tag.addEventListener('click', (e) => {
        if (e.target.classList.contains('delete-tag')) return;
        doLogin(uid);
      });
      tag.querySelector('.delete-tag').addEventListener('click', (e) => {
        e.stopPropagation();
        // 删除不可逆：先确认，并提示先导出备份
        const ok = window.confirm(
          `确定要删除 UID ${uid} 的本地成就记录吗？\n\n` +
          `该账号在本浏览器里保存的进度会被永久删除，无法恢复。\n` +
          `建议先用「导出文本 / 导出备份」保存一份再删除。`
        );
        if (!ok) return;
        removeAccount(uid);
        renderSavedAccounts();
      });
      accountsList.appendChild(tag);
    });
  }

  function doLogin(uid) {
    uid = String(uid).trim();
    if (!uid) { loginError.textContent = '请输入 UID'; return; }
    if (!/^\d+$/.test(uid)) { loginError.textContent = 'UID 必须为数字'; return; }
    if (uid.length < 9) { loginError.textContent = 'UID 一般是 9 位数字，请检查'; return; }
    loginError.textContent = '';
    currentUid = uid;
    userAchievements[currentUid] = loadAchievements(uid);
    doneTimes = loadTimes(uid);
    lastSnapshot = null;
    persist();
    showMainPage();
  }

  // 只绑定一次，避免反复退出/登录后监听器叠加
  if (!initLoginPage._bound) {
    initLoginPage._bound = true;
    loginBtn.addEventListener('click', () => doLogin(uidInput.value));
    uidInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(uidInput.value); });
  }
  window.__renderSavedAccounts = renderSavedAccounts;
  renderSavedAccounts();
}

// ========== 主页面 ==========
function showMainPage() {
  document.getElementById('login-page').classList.remove('active');
  document.getElementById('main-page').classList.add('active');
  document.getElementById('current-uid').textContent = currentUid;
  buildAchievementList();
  ensureFilterBar();
  ensureHeaderImportBtn();
  renderAchievements();
  updateStats();
}

function showLoginPage() {
  document.getElementById('main-page').classList.remove('active');
  document.getElementById('login-page').classList.add('active');
  document.getElementById('uid-input').value = '';
  document.getElementById('filter-bar')?.remove();
  currentUid = null;
}

// 顶栏「导入进度」按钮（动态注入，不改 index.html）
function ensureHeaderImportBtn() {
  const right = document.querySelector('.header-right');
  if (!right || document.getElementById('import-open-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'import-open-btn';
  btn.className = 'btn-secondary';
  btn.textContent = '导入进度';
  btn.title = '从 UIAF 成就文件或本站备份一键导入进度';
  btn.addEventListener('click', openImportModal);
  right.insertBefore(btn, document.getElementById('export-btn'));
}

// ========== 筛选条（动态注入，无需改动 index.html） ==========
function ensureFilterBar() {
  if (document.getElementById('filter-bar')) return;
  const area = document.querySelector('.achievement-header');
  if (!area) return;
  const bar = document.createElement('div');
  bar.id = 'filter-bar';
  bar.className = 'filter-bar';
  bar.innerHTML =
    `<button class="btn-filter active" data-filter="all">全部</button>` +
    `<button class="btn-filter" data-filter="undone">只看未完成</button>` +
    `<button class="btn-filter" data-filter="done">只看已完成</button>` +
    `<button class="btn-filter" data-filter="new" title="只看最近版本新加入的成就">只看新增</button>` +
    `<label class="filter-check"><input type="checkbox" id="hide-hidden"> 隐藏「隐藏成就」</label>` +
    `<button class="btn-filter overview-toggle" id="overview-btn" title="按合辑查看完成度，快速查漏补缺">📊 合辑总览</button>`;
  area.parentNode.insertBefore(bar, area.nextSibling);

  bar.querySelectorAll('.btn-filter[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      viewFilter = btn.dataset.filter;
      bar.querySelectorAll('.btn-filter[data-filter]').forEach(b => b.classList.toggle('active', b === btn));
      renderAchievements();
    });
  });
  bar.querySelector('#hide-hidden').addEventListener('change', (e) => {
    hideHidden = e.target.checked;
    renderAchievements();
  });
  bar.querySelector('#overview-btn').addEventListener('click', openOverview);
}

// ========== 渲染成就列表 ==========
function renderAchievements(filterText = '') {
  const container = document.getElementById('achievement-list');
  const data = userAchievements[currentUid] || {};
  let html = '';

  for (const [category, catData] of Object.entries(window.ACHIEVEMENTS_DATA)) {
    // 合辑层统计永远按全量算，不随筛选变化
    let catTotal = 0, catCompleted = 0, catNew = 0, catMaxV = 0, catMaxVStr = '';
    for (const [, items] of Object.entries(catData.children)) {
      for (const item of items) {
        catTotal++;
        if (data[item.key]) catCompleted++;
        if (item.v) {
          catNew++;
          const v = parseFloat(item.v);
          if (v > catMaxV) { catMaxV = v; catMaxVStr = item.v; }
        }
      }
    }

    let inner = '';
    let catVisible = 0;

    for (const [subName, items] of Object.entries(catData.children)) {
      // 文本搜索 + 视图筛选 + 隐藏成就过滤
      let shown = items;
      if (filterText) shown = shown.filter(item => (item.name || '').includes(filterText) || (item.desc || '').includes(filterText));
      if (viewFilter === 'undone') shown = shown.filter(item => !data[item.key]);
      else if (viewFilter === 'done') shown = shown.filter(item => !!data[item.key]);
      else if (viewFilter === 'new') shown = shown.filter(item => !!item.v);
      if (hideHidden) shown = shown.filter(item => !item.hidden);
      if (shown.length === 0) continue;
      catVisible += shown.length;

      let subCompleted = 0;
      for (const item of items) { if (data[item.key]) subCompleted++; }

      const allKeys = items.map(i => i.key).join(',');
      inner += `<div class="sub-category" data-sub="${subName}" data-keys="${allKeys}">
        <div class="sub-category-header">
          <div class="sub-category-header-left">
            <input type="checkbox" class="sub-checkbox" ${subCompleted === items.length && items.length > 0 ? 'checked' : ''}>
            <span class="sub-category-title">${subName}</span>
          </div>
          <div class="sub-category-header-right">
            <span class="sub-progress-text">${subCompleted}/${items.length}</span>
            <span class="chevron">&#9660;</span>
          </div>
        </div>
        <div class="achievement-items">`;

      // 未完成排前面
      const itemsToRender = shown.slice().sort((a, b) => {
        const aDone = !!data[a.key];
        const bDone = !!data[b.key];
        if (aDone === bDone) return 0;
        return aDone ? 1 : -1;
      });

      for (const item of itemsToRender) {
        const isDone = !!data[item.key];
        const blocked = !!BLOCKED[item.key];
        const badges =
          (item.v ? `<span class="badge badge-new">${item.v}新增</span>` : '') +
          (item.hidden ? '<span class="badge badge-hidden">隐藏</span>' : '') +
          (blocked ? `<span class="badge badge-blocked" title="${BLOCKED[item.key]}">暂不可完成</span>` : '') +
          (item.reward ? `<span class="badge badge-reward">${item.reward}</span>` : '');
        const guideUrl = 'https://www.bing.com/search?q=' + encodeURIComponent(`原神 成就 攻略 ${item.name}`);
        inner += `<div class="achievement-item${isDone ? ' completed' : ''}${blocked ? ' blocked' : ''}">
          <input type="checkbox" class="achievement-checkbox" data-key="${item.key}" ${isDone ? 'checked' : ''}>
          <div class="achievement-info">
            <div class="achievement-name">${item.name}${badges}</div>
            <div class="achievement-desc">${item.desc}</div>
          </div>
          <a class="guide-link" target="_blank" rel="noopener" title="搜索这个成就的攻略" href="${guideUrl}">攻略</a>
        </div>`;
      }

      inner += `</div></div>`;
    }

    // 筛选后该合辑没有可见条目 → 整块不渲染
    if (catVisible === 0) continue;

    const catAllDone = catTotal > 0 && catCompleted === catTotal;
    const bulkMode = catAllDone ? 'clear' : 'done';
    const bulkLabel = catAllDone ? '整组清空' : '整组完成';
    const bulkTitle = catAllDone
      ? `取消「${category}」全部的勾选（可撤销）`
      : `把「${category}」里尚未完成的 ${catTotal - catCompleted} 个成就一次性标记为已完成（可撤销）`;

    html += `<div class="category-card" data-category="${category}">`;
    html += `<div class="category-header">
      <div class="category-header-left">
        <span class="category-icon">${catData.icon}</span>
        <span class="category-title">${category}</span>` +
      (catNew > 0 ? `<span class="badge badge-new-cat">${catMaxVStr}新增${catNew < catTotal ? '·' + catNew + '项' : ''}</span>` : '') +
      `<span class="category-count">${catCompleted}/${catTotal}</span>
      </div>
      <div class="category-header-right">
        <button class="btn-bulk${catAllDone ? ' is-clear' : ''}" data-cat="${category}" data-mode="${bulkMode}" title="${bulkTitle}">${bulkLabel}</button>
        <span class="category-progress-text">${pct(catCompleted, catTotal)}%</span>
        <span class="chevron">&#9660;</span>
      </div>
    </div>`;
    html += `<div class="sub-categories">${inner}</div></div>`;
  }

  if (!html) html = '<div class="no-results">当前筛选条件下没有成就。</div>';
  container.innerHTML = html;
  bindAchievementEvents(container);
}

function bindAchievementEvents(container) {
  // 合辑展开 / 折叠
  container.querySelectorAll('.category-header').forEach(header => {
    header.addEventListener('click', () => {
      const card = header.closest('.category-card');
      const subContainer = card.querySelector('.sub-categories');
      const expanded = subContainer.classList.toggle('expanded');
      header.querySelector('.chevron').classList.toggle('expanded', expanded);
    });
  });

  // 整组完成 / 整组清空（别让它触发合辑折叠）
  container.querySelectorAll('.btn-bulk').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      bulkCategory(btn.dataset.cat, btn.dataset.mode);
    });
  });

  // 子分类展开 / 折叠
  container.querySelectorAll('.sub-category-header').forEach(subHeader => {
    subHeader.addEventListener('click', (e) => {
      if (e.target.type === 'checkbox') return;
      const itemsDiv = subHeader.nextElementSibling;
      itemsDiv.classList.toggle('expanded');
      subHeader.querySelector('.chevron').classList.toggle('expanded');
    });
  });

  // 子分类全选 —— 按 data-keys 全量处理，不受视图筛选影响
  container.querySelectorAll('.sub-checkbox').forEach(subCb => {
    subCb.addEventListener('change', () => {
      const subDiv = subCb.closest('.sub-category');
      const keys = (subDiv.dataset.keys || '').split(',').filter(Boolean);
      keys.forEach(key => setDone(key, subCb.checked));
      persist();
      subDiv.querySelectorAll('.achievement-checkbox').forEach(cb => {
        cb.checked = subCb.checked;
        cb.closest('.achievement-item').classList.toggle('completed', subCb.checked);
      });
      updateSubCategoryUI(subDiv);
      updateCategoryUI(subDiv.closest('.category-card'));
      updateStats();
    });
  });

  // 单条成就勾选
  container.querySelectorAll('.achievement-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.key;
      setDone(key, cb.checked);
      cb.closest('.achievement-item').classList.toggle('completed', cb.checked);
      persist();
      const subDiv = cb.closest('.sub-category');
      updateSubCategoryUI(subDiv);
      updateCategoryUI(subDiv.closest('.category-card'));
      updateStats();
    });
  });
}

// ========== 合辑级批量勾选 ==========
function bulkCategory(category, mode) {
  const catData = window.ACHIEVEMENTS_DATA[category];
  if (!catData) return;
  const keys = [];
  for (const items of Object.values(catData.children)) items.forEach(i => keys.push(i.key));
  if (!keys.length) return;

  const data = userAchievements[currentUid] || {};
  const toDone = mode !== 'clear';
  const affected = toDone
    ? keys.filter(k => !data[k]).length
    : keys.filter(k => data[k]).length;

  if (affected === 0) {
    showToast(toDone ? `「${category}」已经全部完成` : `「${category}」还没有任何勾选`);
    return;
  }

  if (affected >= 20) {
    const ok = window.confirm(
      `确定把「${category}」里${toDone ? '尚未完成的' : '已完成的'} ${affected} 个成就全部${toDone ? '标记为已完成' : '取消勾选'}吗？\n\n` +
      `这是一次批量操作，完成后可以在页面底部点「撤销」还原。`
    );
    if (!ok) return;
  }

  snapshot(`「${category}」${toDone ? '整组完成' : '整组清空'} ${affected} 条`);
  keys.forEach(k => setDone(k, toDone));
  persist();
  renderAchievements();
  updateStats();
  showToast(`已把「${category}」${affected} 个成就${toDone ? '标记为完成' : '取消勾选'}`);
}

// ========== 搜索结果批量勾选 ==========
function bulkSearchResults() {
  const keys = currentSearchKeys.filter(Boolean);
  if (!keys.length) { showToast('当前没有搜索结果'); return; }
  const data = userAchievements[currentUid] || {};
  const todo = keys.filter(k => !data[k]);
  if (!todo.length) { showToast('这些成就都已经完成了'); return; }

  if (todo.length >= 20) {
    const ok = window.confirm(
      `把搜索结果里尚未完成的 ${todo.length} 个成就全部标记为已完成？\n\n` +
      `这是一次批量操作，完成后可以在页面底部点「撤销」还原。`
    );
    if (!ok) return;
  }

  snapshot(`搜索结果整批完成 ${todo.length} 条`);
  const todoSet = new Set(todo);
  todo.forEach(k => setDone(k, true));
  persist();
  // 同步搜索结果面板本身的勾选状态
  document.querySelectorAll('#search-list input[type="checkbox"]').forEach(cb => {
    if (todoSet.has(cb.dataset.key)) {
      cb.checked = true;
      cb.closest('.search-result-item')?.classList.add('completed');
    }
  });
  renderAchievements();
  updateStats();
  showToast(`已把搜索结果里 ${todo.length} 个成就标记为完成`);
}

function updateSubCategoryUI(subDiv) {
  const keys = (subDiv.dataset.keys || '').split(',').filter(Boolean);
  const data = userAchievements[currentUid] || {};
  let completed = 0;
  keys.forEach(k => { if (data[k]) completed++; });
  const box = subDiv.querySelector('.sub-checkbox');
  const txt = subDiv.querySelector('.sub-progress-text');
  if (box) box.checked = keys.length > 0 && completed === keys.length;
  if (txt) txt.textContent = `${completed}/${keys.length}`;
}

function updateCategoryUI(card) {
  const data = userAchievements[currentUid] || {};
  const category = card.dataset.category;
  const catData = window.ACHIEVEMENTS_DATA[category];
  let total = 0, completed = 0;
  if (catData) {
    for (const [, items] of Object.entries(catData.children)) {
      items.forEach(item => { total++; if (data[item.key]) completed++; });
    }
  }
  const c = card.querySelector('.category-count');
  const p = card.querySelector('.category-progress-text');
  if (c) c.textContent = `${completed}/${total}`;
  if (p) p.textContent = `${pct(completed, total)}%`;

  // 顺手把「整组完成 / 整组清空」的按钮状态同步过来
  const btn = card.querySelector('.btn-bulk');
  if (btn) {
    const allDone = total > 0 && completed === total;
    btn.dataset.mode = allDone ? 'clear' : 'done';
    btn.textContent = allDone ? '整组清空' : '整组完成';
    btn.classList.toggle('is-clear', allDone);
  }
}

// ========== 更新统计 ==========
function updateStats() {
  const stats = calcStats(userAchievements[currentUid] || {});

  document.getElementById('stats-completed').textContent = stats.completedObtainable;
  document.getElementById('stats-total').textContent = stats.obtainable;
  document.getElementById('stats-percent').textContent = `${pct(stats.completedObtainable, stats.obtainable)}%`;
  document.getElementById('stats-progress').style.width = `${pct(stats.completedObtainable, stats.obtainable)}%`;

  // 原石统计 / 版本信息（动态注入节点，不改 index.html）
  const card = document.querySelector('.stats-card');
  if (card && !document.getElementById('stats-reward')) {
    const div = document.createElement('div');
    div.id = 'stats-reward';
    div.className = 'stats-reward';
    card.appendChild(div);
    const tip = document.createElement('div');
    tip.id = 'stats-tip';
    tip.className = 'stats-tip';
    card.appendChild(tip);
  }
  const rewardEl = document.getElementById('stats-reward');
  if (rewardEl) {
    rewardEl.innerHTML = `原石 <b>${stats.rewardDone}</b> / ${stats.rewardTotal}` +
      `<span class="stats-sub">剩 ${stats.rewardTotal - stats.rewardDone}</span>`;
  }
  const tipEl = document.getElementById('stats-tip');
  if (tipEl) {
    tipEl.textContent = stats.blockedCount > 0
      ? `共 ${stats.total} 个成就，其中 ${stats.blockedCount} 个当前版本暂不可完成，未计入上方分母`
      : `已收录全部 ${stats.total} 个成就`;
  }

  const catStatsDiv = document.getElementById('category-stats');
  let catHtml = '<h3 style="font-size:12px;font-weight:600;color:var(--gray-500);margin-bottom:8px;">分类导航（点击跳转）</h3>';
  for (const [cat, stat] of Object.entries(stats.catStats)) {
    catHtml += `<div class="category-stat-item directory-link" data-target="${cat}" style="cursor:pointer;">
      <span class="cat-name" style="cursor:pointer;">${window.ACHIEVEMENTS_DATA[cat].icon} ${cat}</span>
      <span class="cat-progress">${stat.completed}/${stat.total} (${pct(stat.completed, stat.total)}%)</span>
    </div>`;
  }
  const meta = window.ACHIEVEMENTS_META;
  if (meta) {
    catHtml += `<div class="data-meta">数据版本：${meta.gameVersion}「${meta.gameVersionName}」<br>` +
      `上游更新：${meta.sourceUpdatedAt}<br>` +
      `共 ${meta.total} 项 · ${meta.totalReward} 原石</div>`;
  }
  catStatsDiv.innerHTML = catHtml;

  catStatsDiv.querySelectorAll('.directory-link').forEach(item => {
    item.addEventListener('click', () => jumpToCategory(item.dataset.target));
  });

  renderDailyPicks();
}

// ========== 跳转 ==========
function jumpToCategory(category) {
  const card = document.querySelector(`.category-card[data-category="${category}"]`);
  if (!card) return;
  card.querySelector('.sub-categories')?.classList.add('expanded');
  card.querySelector('.category-header .chevron')?.classList.add('expanded');
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function jumpToItem(key) {
  // 目标成就可能被当前筛选隐藏 → 先回到「全部」视图再定位
  const bar = document.getElementById('filter-bar');
  if (viewFilter !== 'all') {
    viewFilter = 'all';
    bar?.querySelectorAll('.btn-filter[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
    renderAchievements();
  }
  const cb = document.querySelector(`.achievement-checkbox[data-key="${key}"]`);
  if (!cb) return;
  const itemEl = cb.closest('.achievement-item');
  const sub = cb.closest('.sub-category');
  const card = cb.closest('.category-card');
  card?.querySelector('.sub-categories')?.classList.add('expanded');
  card?.querySelector('.category-header .chevron')?.classList.add('expanded');
  sub?.querySelector('.achievement-items')?.classList.add('expanded');
  sub?.querySelector('.sub-category-header .chevron')?.classList.add('expanded');
  itemEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  itemEl.classList.remove('flash');
  void itemEl.offsetWidth; // 强制重排以重启动画
  itemEl.classList.add('flash');
}

// ========== 合辑进度总览 ==========
let overviewSort = 'closest';

function openOverview() {
  let modal = document.getElementById('overview-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'overview-modal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content overview-content">
        <div class="modal-header">
          <h3>合辑进度总览</h3>
          <button class="btn-close" id="close-overview">×</button>
        </div>
        <div class="overview-tabs">
          <button class="ov-tab active" data-sort="closest">差最少完成</button>
          <button class="ov-tab" data-sort="reward">剩原石最多</button>
          <button class="ov-tab" data-sort="rate">完成率最低</button>
        </div>
        <div class="overview-list" id="overview-list"></div>
        <div class="overview-foot">点击任意合辑可跳转过去 · 已完成的自动沉底</div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#close-overview').addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
    modal.querySelectorAll('.ov-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        overviewSort = tab.dataset.sort;
        modal.querySelectorAll('.ov-tab').forEach(t => t.classList.toggle('active', t === tab));
        renderOverview();
      });
    });
  }
  renderOverview();
  modal.style.display = 'flex';
}

function renderOverview() {
  const listEl = document.getElementById('overview-list');
  if (!listEl) return;
  const data = userAchievements[currentUid] || {};
  const rows = [];
  for (const [category, catData] of Object.entries(window.ACHIEVEMENTS_DATA)) {
    let total = 0, completed = 0, rewardLeft = 0;
    for (const [, items] of Object.entries(catData.children)) {
      items.forEach(item => {
        total++;
        if (data[item.key]) completed++;
        else rewardLeft += item.reward || 0;
      });
    }
    rows.push({ category, icon: catData.icon, total, completed, left: total - completed, rewardLeft, pctv: pct(completed, total) });
  }
  const isDone = r => r.completed >= r.total;
  if (overviewSort === 'closest') rows.sort((a, b) => (isDone(a) - isDone(b)) || (a.left - b.left) || (b.rewardLeft - a.rewardLeft));
  else if (overviewSort === 'reward') rows.sort((a, b) => (isDone(a) - isDone(b)) || (b.rewardLeft - a.rewardLeft) || (a.left - b.left));
  else rows.sort((a, b) => (isDone(a) - isDone(b)) || (a.pctv - b.pctv) || (a.left - b.left));

  listEl.innerHTML = rows.map(r => `
    <div class="ov-row" data-category="${r.category}">
      <div class="ov-name" title="${r.category}">${r.icon} ${r.category}</div>
      <div class="ov-bar"><div class="ov-bar-fill" style="width:${r.pctv}%"></div></div>
      <div class="ov-num">${r.completed}/${r.total}</div>
      <div class="ov-reward" title="完成剩余成就可得原石">${r.left > 0 ? '剩 ' + r.rewardLeft + ' 原石' : '✓'}</div>
    </div>`).join('');
  listEl.querySelectorAll('.ov-row').forEach(row => {
    row.addEventListener('click', () => {
      document.getElementById('overview-modal').style.display = 'none';
      jumpToCategory(row.dataset.category);
    });
  });
}

// ========== 今日推荐 ==========
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function renderDailyPicks() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;
  let card = document.getElementById('daily-card');
  if (!card) {
    card = document.createElement('div');
    card.id = 'daily-card';
    card.className = 'daily-card';
    const catStats = document.getElementById('category-stats');
    sidebar.insertBefore(card, catStats);
  }
  const d = new Date();
  const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const data = userAchievements[currentUid] || {};
  const undone = allAchievementList.filter(a => !data[a.key] && !a.hidden && !BLOCKED[a.key]);

  let html = `<h3>今日推荐</h3><div class="daily-sub">${dateStr} · 未完成里原石最多的挑 5 个</div>`;
  if (undone.length === 0) {
    html += '<div class="daily-empty">没有待完成的成就了，全成就达成！</div>';
  } else {
    // 候选池：原石最多的前 30 个，按「日期+UID」洗牌 —— 每天稳定换一批，同一天内不变
    const pool = undone.slice().sort((a, b) => (b.reward || 0) - (a.reward || 0)).slice(0, 30);
    let seed = 0;
    const s = dateStr + '#' + currentUid;
    for (let i = 0; i < s.length; i++) seed = (seed * 131 + s.charCodeAt(i)) >>> 0;
    const rnd = mulberry32(seed);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    html += pool.slice(0, 5).map(p => `
      <div class="daily-item" data-key="${p.key}" title="${p.desc}">
        <span class="daily-name">${p.name}</span>
        <span class="daily-reward">${p.reward || 0}</span>
      </div>`).join('');
  }
  card.innerHTML = html;
  card.querySelectorAll('.daily-item').forEach(el => {
    el.addEventListener('click', () => jumpToItem(el.dataset.key));
  });
}

// ========== 搜索功能 ==========
function initSearch() {
  const searchInput = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');
  const searchList = document.getElementById('search-list');
  const closeSearch = document.getElementById('close-search');

  // 「全部标记完成」按钮（只注入一次）
  if (!document.getElementById('search-bulk-done')) {
    const bulkBtn = document.createElement('button');
    bulkBtn.id = 'search-bulk-done';
    bulkBtn.className = 'btn-small';
    bulkBtn.textContent = '全部标记完成';
    bulkBtn.title = '把当前搜索结果里尚未完成的成就一次性勾上';
    bulkBtn.addEventListener('click', bulkSearchResults);
    const hdr = searchResults.querySelector('.search-results-header');
    if (hdr) hdr.insertBefore(bulkBtn, closeSearch);
  }

  let searchTimeout;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      const text = searchInput.value.trim();
      if (!text) { searchResults.style.display = 'none'; currentSearchKeys = []; return; }

      // 命中上限 300 条，避免 98 万字符级结果把页面卡死
      const results = allAchievementList.filter(a =>
        (a.name || '').includes(text) || (a.desc || '').includes(text)
      ).slice(0, 300);
      currentSearchKeys = results.map(r => r.key);

      if (results.length === 0) {
        searchList.innerHTML = '<div class="no-results">没有找到匹配的成就</div>';
      } else {
        let html = '';
        for (const r of results) {
          const isDone = !!(userAchievements[currentUid] || {})[r.key];
          const blocked = !!BLOCKED[r.key];
          html += `<div class="search-result-item${isDone ? ' completed' : ''}">
            <input type="checkbox" ${isDone ? 'checked' : ''} data-key="${r.key}">
            <div style="flex:1;min-width:0;">
              <div class="search-result-name">${r.name}${r.v ? `<span class="badge badge-new">${r.v}新增</span>` : ''}${r.hidden ? '<span class="badge badge-hidden">隐藏</span>' : ''}${blocked ? '<span class="badge badge-blocked">暂不可完成</span>' : ''}</div>
              <div class="search-result-desc">${r.desc}</div>
            </div>
            <span class="search-result-category">${r.category}</span>
          </div>`;
        }
        searchList.innerHTML = html;

        searchList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
          cb.addEventListener('change', () => {
            const key = cb.dataset.key;
            setDone(key, cb.checked);
            persist();
            cb.closest('.search-result-item')?.classList.toggle('completed', cb.checked);
            renderAchievements();
            updateStats();
          });
        });
      }

      searchResults.style.display = 'flex';
    }, 250);
  });

  closeSearch.addEventListener('click', () => {
    searchResults.style.display = 'none';
    searchInput.value = '';
    currentSearchKeys = [];
    renderAchievements();
  });
}

// ========== 导出 / 导入 ==========
function buildExportText() {
  const stats = calcStats(userAchievements[currentUid] || {});
  const meta = window.ACHIEVEMENTS_META;
  let text = `====== 原神成就统计 ======\n`;
  text += `UID: ${currentUid}\n`;
  text += `导出时间: ${new Date().toLocaleString('zh-CN')}\n`;
  if (meta) text += `数据版本: ${meta.gameVersion}「${meta.gameVersionName}」(上游 ${meta.sourceUpdatedAt})\n`;
  text += `总进度: ${stats.completedObtainable}/${stats.obtainable} (${pct(stats.completedObtainable, stats.obtainable)}%)\n`;
  text += `原石: ${stats.rewardDone}/${stats.rewardTotal}\n`;
  text += `========================\n\n`;

  for (const [category, catData] of Object.entries(window.ACHIEVEMENTS_DATA)) {
    const catStat = stats.catStats[category];
    if (!catStat) continue;
    text += `【${catData.icon} ${category}】 ${catStat.completed}/${catStat.total}\n`;
    text += `───────────────────\n`;
    for (const [subName, items] of Object.entries(catData.children)) {
      text += `  ▸ ${subName}:\n`;
      for (const item of items) {
        const done = (userAchievements[currentUid] || {})[item.key] ? '✓' : '✗';
        text += `    [${done}] ${item.name} — ${item.desc}\n`;
      }
      text += `\n`;
    }
    text += `\n`;
  }
  return text;
}

function downloadJSON() {
  const meta = window.ACHIEVEMENTS_META || {};
  const payload = {
    type: 'genshin-achievement-backup',
    version: 2,
    uid: currentUid,
    savedAt: new Date().toISOString(),
    dataVersion: meta.gameVersion || '',
    data: userAchievements[currentUid] || {},
  };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `genshin-achievements-${currentUid}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

// ========== UIAF（统一可交换成就格式 v1.1，uigf.org） ==========
// 导出：把本站进度变成任何成就工具都能读的 UIAF 文件
function buildUIAF() {
  if (!allAchievementList.length) buildAchievementList();
  const data = userAchievements[currentUid] || {};
  const list = [];
  for (const a of allAchievementList) {
    const id = Number(a.key);
    if (!Number.isFinite(id)) continue; // 只导出游戏原生 id，非数字键跳过
    const done = !!data[a.key];
    list.push({
      id: id,
      current: done ? 1 : 0,
      status: done ? 2 : 1,                                  // 1 = 未完成，2 = 已完成
      timestamp: done ? (doneTimes[a.key] ? Math.floor(doneTimes[a.key] / 1000) : UIAF_SENTINEL) : 0,
    });
  }
  return {
    info: {
      export_app: 'genshin-achievement-web',
      export_app_version: '1.1',
      uiaf_version: 'v1.1',
      export_timestamp: Math.floor(Date.now() / 1000),
    },
    list: list,
  };
}

function downloadUIAF() {
  const uiaf = buildUIAF();
  const blob = new Blob([JSON.stringify(uiaf, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `genshin-achievements-${currentUid}-uiaf-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

function isUIAF(payload) {
  return !!(payload && typeof payload === 'object' && Array.isArray(payload.list));
}

// UIAF 的 timestamp 是「秒」。0 表示未完成；253402271999 是「已完成但时间未知」的占位
function uiafTime(t) {
  const n = Number(t) || 0;
  if (n > 0 && n < UIAF_SENTINEL) return n * 1000;
  return Date.now();
}

// 先算一遍「会新增多少、哪些本站没有」，给用户看清楚再决定
function planUIAF(payload) {
  const known = knownKeySet();
  const data = userAchievements[currentUid] || {};
  const plan = { total: 0, finished: 0, unfinished: 0, add: 0, kept: 0, unknown: [], ids: [] };
  for (const rec of payload.list) {
    if (!rec || rec.id === undefined || rec.id === null) continue;
    plan.total++;
    const id = String(rec.id);
    if (!known.has(id)) { plan.unknown.push(id); continue; }
    const st = Number(rec.status);
    if (st === 2 || st === 3) {           // 2 = 已完成，3 = 奖励已领取，都算完成
      plan.finished++;
      if (data[id]) plan.kept++;
      else { plan.add++; plan.ids.push([id, uiafTime(rec.timestamp)]); }
    } else {
      plan.unfinished++;
    }
  }
  return plan;
}

function planBackup(payload) {
  const incoming = payload.data || payload;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    throw new Error('备份文件格式不正确');
  }
  const known = knownKeySet();
  const map = window.LEGACY_KEY_MAP || {};
  const data = userAchievements[currentUid] || {};
  const plan = { total: 0, finished: 0, unfinished: 0, add: 0, kept: 0, unknown: [], ids: [], fixed: 0 };
  for (const k of Object.keys(incoming)) {
    plan.total++;
    const nk = map[k] || k;
    if (nk !== k) plan.fixed++;
    if (!incoming[k]) { plan.unfinished++; continue; }
    plan.finished++;
    if (!known.has(nk)) { plan.unknown.push(nk); continue; }
    if (data[nk]) plan.kept++;
    else { plan.add++; plan.ids.push([nk, Date.now()]); }
  }
  return plan;
}

// ========== 导入弹窗 ==========
let pendingImport = null;

function openImportModal() {
  let modal = document.getElementById('import-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'import-modal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content import-content">
        <div class="modal-header">
          <h3>导入成就进度</h3>
          <button class="btn-close" id="close-import">×</button>
        </div>
        <div class="import-body">
          <div class="import-intro">
            支持两种文件：
            <div class="import-opt"><b>UIAF 成就文件</b>（推荐）—— 用游戏成就导出工具生成，一次导入全部进度，还带完成时间</div>
            <div class="import-opt"><b>本站备份 JSON</b> —— 就是「导出备份」生成的那个文件</div>
            <div class="import-tip">导入只做<b>合并</b>：补上你已完成、网站还没勾的，不会取消你已有的进度。</div>
          </div>
          <div class="import-pick">
            <button class="btn-small import-pick-btn" id="pick-file">选择文件…</button>
            <span class="import-file" id="import-file"></span>
          </div>
          <div class="import-report" id="import-report"></div>
        </div>
        <div class="modal-footer">
          <button class="btn-small" id="import-help">UIAF 文件怎么拿？</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#close-import').addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.style.display = 'none';
    fileInput.id = 'import-file-input';
    modal.appendChild(fileInput);

    modal.querySelector('#pick-file').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) handleImportFile(fileInput.files[0]);
      fileInput.value = '';
    });
    modal.querySelector('#import-help').addEventListener('click', showImportHelp);
  }

  // 每次打开都重置
  pendingImport = null;
  const rep = modal.querySelector('#import-report');
  rep.style.display = 'none';
  rep.innerHTML = '';
  modal.querySelector('#import-file').textContent = '';
  modal.style.display = 'flex';
}

function handleImportFile(file) {
  const modal = document.getElementById('import-modal');
  const rep = modal.querySelector('#import-report');
  modal.querySelector('#import-file').textContent = file.name;
  rep.style.display = 'none';
  rep.innerHTML = '';
  pendingImport = null;

  const reader = new FileReader();
  reader.onload = () => {
    let payload;
    try {
      payload = JSON.parse(reader.result);
    } catch (e) {
      renderImportError('这个文件不是合法的 JSON：' + e.message);
      return;
    }
    try {
      if (isUIAF(payload)) {
        pendingImport = { kind: 'uiaf', plan: planUIAF(payload), raw: payload };
      } else if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        pendingImport = { kind: 'backup', plan: planBackup(payload), raw: payload };
      } else {
        throw new Error('无法识别这个文件：它既不是 UIAF 成就文件，也不是本站导出的备份。');
      }
    } catch (e) {
      renderImportError(e.message);
      return;
    }
    renderImportReport();
  };
  reader.onerror = () => renderImportError('读取文件失败，请重试或换一个文件。');
  reader.readAsText(file);
}

function renderImportError(msg) {
  pendingImport = null;
  const rep = document.getElementById('import-report');
  if (!rep) return;
  rep.innerHTML = `<div class="report-warn">${esc(msg)}</div>`;
  rep.style.display = 'block';
}

function renderImportReport() {
  const rep = document.getElementById('import-report');
  if (!rep || !pendingImport) return;
  const { kind, plan, raw } = pendingImport;
  const isUiaf = kind === 'uiaf';
  const appName = isUiaf && raw.info && raw.info.export_app ? raw.info.export_app : '';

  let html = `<div class="report-title">已识别：${isUiaf
    ? 'UIAF 成就文件' + (appName ? `（来自 ${esc(appName)}）` : '')
    : '本站备份文件'}</div>`;
  html += `<div class="report-grid">
      <div><span>记录条数</span><b>${plan.total}</b></div>
      <div><span>其中已完成</span><b>${plan.finished}</b></div>
      <div><span>其中未完成</span><b>${plan.unfinished}</b></div>
      <div class="hl"><span>将新增</span><b>${plan.add}</b></div>
    </div>`;
  if (plan.kept) html += `<div class="report-line">另有 <b>${plan.kept}</b> 条你本来就已完成，保持不动。</div>`;
  if (!isUiaf && plan.fixed) html += `<div class="report-line">其中 <b>${plan.fixed}</b> 条来自旧版格式，已自动转换到新的稳定键位。</div>`;
  if (plan.unknown.length) {
    html += `<div class="report-warn">有 <b>${plan.unknown.length}</b> 条成就本站数据里还没有，已跳过。
      这说明游戏版本比本站数据更新 —— 等自动同步完成后（每天上午 10 点）再导一次就能补上。<br>
      样例：${esc(plan.unknown.slice(0, 8).join('、'))}${plan.unknown.length > 8 ? ' …' : ''}</div>`;
  }
  if (isUiaf) {
    html += `<div class="report-note">UIAF 文件本身不含 UID。请确认这份文件确实是 UID <b>${esc(currentUid)}</b> 导出的，否则进度会串号。</div>`;
  }
  html += `<button class="btn-primary report-btn" id="confirm-import">${plan.add ? `确认导入（新增 ${plan.add} 条）` : '确认导入'}</button>`;

  rep.innerHTML = html;
  rep.style.display = 'block';
  rep.querySelector('#confirm-import').addEventListener('click', applyPendingImport);
}

function applyPendingImport() {
  if (!pendingImport) return;
  const { kind, plan } = pendingImport;
  const isUiaf = kind === 'uiaf';
  const applied = plan.add;

  snapshot(isUiaf ? '导入 UIAF' : '导入备份');
  for (const pair of plan.ids) setDone(pair[0], true, pair[1]);
  persist();
  pendingImport = null;

  renderAchievements();
  updateStats();

  const rep = document.getElementById('import-report');
  if (rep) {
    rep.innerHTML = `<div class="report-title">导入完成</div>
      <div class="report-line">新增 <b>${applied}</b> 条已完成记录${plan.kept ? `，${plan.kept} 条保持原样` : ''}${plan.unknown.length ? `，跳过 ${plan.unknown.length} 条本站未收录` : ''}。</div>
      <div class="report-line">左侧进度条已经更新。</div>
      <button class="btn-small report-btn" id="close-import-after">关闭</button>`;
    const b = rep.querySelector('#close-import-after');
    if (b) b.addEventListener('click', () => { document.getElementById('import-modal').style.display = 'none'; });
  }

  showToast(`已从${isUiaf ? ' UIAF ' : '备份'}导入 ${applied} 条已完成记录`);
}

function showImportHelp() {
  window.alert(
    'UIAF 文件怎么拿？\n\n' +
    '1. 下载「YaeAchievement」—— 开源免费的成就导出工具（Windows）\n' +
    '2. 先确保原神没有在运行，然后双击打开它，它会自动帮你把游戏启动起来\n' +
    '3. 正常登录进游戏，工具会自动读取你的全部成就；读完后游戏会自动退出\n' +
    '4. 在它列出的导出目标里选「UIAF JSON File」，得到一个 .json 文件\n' +
    '5. 回到本页，点「选择文件…」把这个 json 导进来\n\n' +
    '两个要注意的地方：\n' +
    '· 工具不要和游戏主程序放在同一个文件夹，否则游戏会报「数据异常(31-4302)」\n' +
    '· 它抓到的数据会缓存 1 小时。如果你有多个账号，可以在缓存有效期内依次登录、\n' +
    '  分别导出，然后回到本站切换到对应 UID 分别导入\n\n' +
    'UIAF 是 UIGF 组织制定的通用成就数据标准（uigf.org），本站支持导入也支持导出，\n' +
    '所以你的进度也可以随时带去椰羊、Paimon.moe、胡桃工具箱等工具。\n\n' +
    '不想用第三方工具的话，也可以继续手动勾选，或者用每个合辑卡片上的「整组完成」。'
  );
}

function initExport() {
  const exportBtn = document.getElementById('export-btn');
  const exportModal = document.getElementById('export-modal');
  const exportText = document.getElementById('export-text');
  const closeModal = document.getElementById('close-modal');
  const copyBtn = document.getElementById('copy-btn');
  const footer = exportModal.querySelector('.modal-footer');

  // 备份 / UIAF 导出按钮（动态注入，不改 index.html）
  if (footer && !document.getElementById('backup-btn')) {
    const backupBtn = document.createElement('button');
    backupBtn.id = 'backup-btn';
    backupBtn.className = 'btn-small';
    backupBtn.textContent = '导出备份（JSON）';
    backupBtn.addEventListener('click', downloadJSON);

    const uiafBtn = document.createElement('button');
    uiafBtn.id = 'uiaf-btn';
    uiafBtn.className = 'btn-small';
    uiafBtn.textContent = '导出 UIAF';
    uiafBtn.title = '导出成通用成就格式，可导入椰羊 / Paimon.moe / 胡桃工具箱等';
    uiafBtn.addEventListener('click', downloadUIAF);

    footer.insertBefore(uiafBtn, footer.firstChild);
    footer.insertBefore(backupBtn, footer.firstChild);
  }

  exportBtn.addEventListener('click', () => {
    exportText.value = buildExportText();
    exportModal.style.display = 'flex';
  });

  closeModal.addEventListener('click', () => { exportModal.style.display = 'none'; });
  exportModal.addEventListener('click', (e) => { if (e.target === exportModal) exportModal.style.display = 'none'; });

  copyBtn.addEventListener('click', () => {
    exportText.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    copyBtn.textContent = ok ? '已复制!' : '请按 Ctrl+C 复制';
    setTimeout(() => { copyBtn.textContent = '复制到剪贴板'; }, 1500);
  });
}

// ========== 主页面事件（只在启动时绑定一次） ==========
function initMainEvents() {
  if (initMainEvents._bound) return;
  initMainEvents._bound = true;

  document.getElementById('logout-btn').addEventListener('click', () => {
    showLoginPage();
    if (window.__renderSavedAccounts) window.__renderSavedAccounts();
  });

  document.getElementById('expand-all').addEventListener('click', () => {
    document.querySelectorAll('.sub-categories').forEach(el => el.classList.add('expanded'));
    document.querySelectorAll('.achievement-items').forEach(el => el.classList.add('expanded'));
    document.querySelectorAll('.chevron').forEach(el => el.classList.add('expanded'));
  });

  document.getElementById('collapse-all').addEventListener('click', () => {
    document.querySelectorAll('.sub-categories').forEach(el => el.classList.remove('expanded'));
    document.querySelectorAll('.achievement-items').forEach(el => el.classList.remove('expanded'));
    document.querySelectorAll('.chevron').forEach(el => el.classList.remove('expanded'));
  });

  initSearch();
  initExport();
}

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', () => {
  if (!window.ACHIEVEMENTS_DATA) {
    document.body.insertAdjacentHTML('afterbegin',
      '<div style="padding:16px;background:#fee2e2;color:#991b1b;font-size:13px;">成就数据加载失败：请确认 data.js 与 index.html 在同一目录，且没有被浏览器拦截。</div>');
    return;
  }
  initLoginPage();
  initMainEvents();
});
