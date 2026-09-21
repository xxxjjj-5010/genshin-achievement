// ============================================================
// 原神成就统计 - 核心逻辑
// 升级版 2026-09-18
//   · 成就 key 改用游戏内稳定 id（旧版「文件::合辑::序号」会随版本更新整体错位）
//   · 自动把旧的已保存进度迁移到新键位，进度不丢
//   · 新增：只看未完成 / 只看已完成 / 隐藏隐藏成就
//   · 新增：原石统计、数据版本显示、JSON 备份与恢复
//   · 修复：重复登录导致事件重复绑定、删除账号无二次确认、子分类全选计数错误
// ============================================================

let currentUid = null;
let userAchievements = {};
let allAchievementList = []; // Flat list for search

// 视图筛选状态
let viewFilter = 'all';      // all | undone | done
let hideHidden = false;      // 是否隐藏「隐藏成就」

// 当前版本暂时无法达成的成就（不计入「可完成」分母）
// ⚠️ 每次版本更新后请复核这份名单
const BLOCKED = {
  '80507': '需至冬末期才可达成',
  '81622': '2027-07-01 之后可达成',
  '86063': '达成条件尚未开放',
};

// ========== 工具函数 ==========
function getStorageKey(uid) { return `genshin_achievements_${uid}`; }
function getAccountsKey() { return `genshin_accounts`; }

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

function saveAchievements(uid, data) {
  localStorage.setItem(getStorageKey(uid), JSON.stringify(data));
  const accounts = getAccounts();
  if (!accounts.includes(uid)) {
    accounts.push(uid);
    localStorage.setItem(getAccountsKey(), JSON.stringify(accounts));
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
    saveAchievements(currentUid, userAchievements[currentUid]);
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
  renderAchievements();
  updateStats();
}

function showLoginPage() {
  document.getElementById('main-page').classList.remove('active');
  document.getElementById('login-page').classList.add('active');
  document.getElementById('uid-input').value = '';
  currentUid = null;
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
    `<label class="filter-check"><input type="checkbox" id="hide-hidden"> 隐藏「隐藏成就」</label>`;
  area.parentNode.insertBefore(bar, area.nextSibling);

  bar.querySelectorAll('.btn-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      viewFilter = btn.dataset.filter;
      bar.querySelectorAll('.btn-filter').forEach(b => b.classList.toggle('active', b === btn));
      renderAchievements();
    });
  });
  bar.querySelector('#hide-hidden').addEventListener('change', (e) => {
    hideHidden = e.target.checked;
    renderAchievements();
  });
}

// ========== 渲染成就列表 ==========
function renderAchievements(filterText = '') {
  const container = document.getElementById('achievement-list');
  const data = userAchievements[currentUid] || {};
  let html = '';

  for (const [category, catData] of Object.entries(window.ACHIEVEMENTS_DATA)) {
    // 合辑层统计永远按全量算，不随筛选变化
    let catTotal = 0, catCompleted = 0;
    for (const [, items] of Object.entries(catData.children)) {
      for (const item of items) {
        catTotal++;
        if (data[item.key]) catCompleted++;
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
          (item.hidden ? '<span class="badge badge-hidden">隐藏</span>' : '') +
          (blocked ? `<span class="badge badge-blocked" title="${BLOCKED[item.key]}">暂不可完成</span>` : '') +
          (item.reward ? `<span class="badge badge-reward">${item.reward}</span>` : '');
        inner += `<div class="achievement-item${isDone ? ' completed' : ''}${blocked ? ' blocked' : ''}">
          <input type="checkbox" class="achievement-checkbox" data-key="${item.key}" ${isDone ? 'checked' : ''}>
          <div class="achievement-info">
            <div class="achievement-name">${item.name}${badges}</div>
            <div class="achievement-desc">${item.desc}</div>
          </div>
        </div>`;
      }

      inner += `</div></div>`;
    }

    // 筛选后该合辑没有可见条目 → 整块不渲染
    if (catVisible === 0) continue;

    html += `<div class="category-card" data-category="${category}">`;
    html += `<div class="category-header">
      <div class="category-header-left">
        <span class="category-icon">${catData.icon}</span>
        <span class="category-title">${category}</span>
        <span class="category-count">${catCompleted}/${catTotal}</span>
      </div>
      <div class="category-header-right">
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
      keys.forEach(key => {
        if (subCb.checked) userAchievements[currentUid][key] = true;
        else delete userAchievements[currentUid][key];
      });
      saveAchievements(currentUid, userAchievements[currentUid]);
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
      if (cb.checked) {
        userAchievements[currentUid][key] = true;
        cb.closest('.achievement-item').classList.add('completed');
      } else {
        delete userAchievements[currentUid][key];
        cb.closest('.achievement-item').classList.remove('completed');
      }
      saveAchievements(currentUid, userAchievements[currentUid]);
      const subDiv = cb.closest('.sub-category');
      updateSubCategoryUI(subDiv);
      updateCategoryUI(subDiv.closest('.category-card'));
      updateStats();
    });
  });
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
    item.addEventListener('click', () => {
      const target = item.dataset.target;
      const card = document.querySelector(`.category-card[data-category="${target}"]`);
      if (card) {
        card.querySelector('.sub-categories')?.classList.add('expanded');
        card.querySelector('.category-header .chevron')?.classList.add('expanded');
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
}

// ========== 搜索功能 ==========
function initSearch() {
  const searchInput = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');
  const searchList = document.getElementById('search-list');
  const closeSearch = document.getElementById('close-search');

  let searchTimeout;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      const text = searchInput.value.trim();
      if (!text) { searchResults.style.display = 'none'; return; }

      // 命中上限 300 条，避免 98 万字符级结果把页面卡死
      const results = allAchievementList.filter(a =>
        (a.name || '').includes(text) || (a.desc || '').includes(text)
      ).slice(0, 300);

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
              <div class="search-result-name">${r.name}${r.hidden ? '<span class="badge badge-hidden">隐藏</span>' : ''}${blocked ? '<span class="badge badge-blocked">暂不可完成</span>' : ''}</div>
              <div class="search-result-desc">${r.desc}</div>
            </div>
            <span class="search-result-category">${r.category}</span>
          </div>`;
        }
        searchList.innerHTML = html;

        searchList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
          cb.addEventListener('change', () => {
            const key = cb.dataset.key;
            if (cb.checked) {
              userAchievements[currentUid][key] = true;
            } else {
              delete userAchievements[currentUid][key];
            }
            saveAchievements(currentUid, userAchievements[currentUid]);
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

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const payload = JSON.parse(reader.result);
      const incoming = payload.data || payload;
      if (!incoming || typeof incoming !== 'object') throw new Error('文件格式不正确');
      const map = window.LEGACY_KEY_MAP || {};
      let added = 0, fixed = 0;
      const cur = userAchievements[currentUid] || (userAchievements[currentUid] = {});
      for (const k of Object.keys(incoming)) {
        const nk = map[k] || k;
        if (nk !== k) fixed++;
        if (!incoming[k]) continue;
        if (!cur[nk]) { cur[nk] = true; added++; }
      }
      saveAchievements(currentUid, cur);
      renderAchievements();
      updateStats();
      alert(`导入完成：新增 ${added} 条已完成记录${fixed ? `（其中 ${fixed} 条已从旧格式自动转换）` : ''}。\n已有进度不会被覆盖，只做合并。`);
    } catch (e) {
      alert('导入失败：' + e.message);
    }
  };
  reader.readAsText(file);
}

function initExport() {
  const exportBtn = document.getElementById('export-btn');
  const exportModal = document.getElementById('export-modal');
  const exportText = document.getElementById('export-text');
  const closeModal = document.getElementById('close-modal');
  const copyBtn = document.getElementById('copy-btn');
  const footer = exportModal.querySelector('.modal-footer');

  // 备份 / 恢复按钮（动态注入，不改 index.html）
  if (footer && !document.getElementById('backup-btn')) {
    const backupBtn = document.createElement('button');
    backupBtn.id = 'backup-btn';
    backupBtn.className = 'btn-small';
    backupBtn.textContent = '导出备份（JSON）';
    backupBtn.style.marginRight = '8px';
    backupBtn.addEventListener('click', downloadJSON);

    const importBtn = document.createElement('button');
    importBtn.id = 'import-btn';
    importBtn.className = 'btn-small';
    importBtn.textContent = '导入备份';
    importBtn.style.marginRight = '8px';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) importJSON(fileInput.files[0]);
      fileInput.value = '';
    });
    importBtn.addEventListener('click', () => fileInput.click());

    footer.insertBefore(fileInput, footer.firstChild);
    footer.insertBefore(importBtn, footer.firstChild);
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
