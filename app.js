// ============================================================
// 原神成就统计 - 核心逻辑 (支持 1760+ 成就)
// ============================================================

let currentUid = null;
let userAchievements = {};
let allAchievementList = []; // Flat list for search

// ========== 工具函数 ==========
function getStorageKey(uid) { return `genshin_achievements_${uid}`; }
function getAccountsKey() { return `genshin_accounts`; }

function loadAchievements(uid) {
  const data = localStorage.getItem(getStorageKey(uid));
  return data ? JSON.parse(data) : {};
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
  let total = 0, completed = 0;
  const catStats = {};
  for (const [category, catData] of Object.entries(window.ACHIEVEMENTS_DATA)) {
    let catTotal = 0, catCompleted = 0;
    for (const [, items] of Object.entries(catData.children)) {
      items.forEach(item => {
        total++; catTotal++;
        if (data[item.key]) { completed++; catCompleted++; }
      });
    }
    catStats[category] = { total: catTotal, completed: catCompleted };
  }
  return { total, completed, catStats };
}

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
      tag.innerHTML = `<span>UID: ${uid}</span><span class="delete-tag" data-uid="${uid}">&times;</span>`;
      tag.addEventListener('click', (e) => {
        if (e.target.classList.contains('delete-tag')) return;
        doLogin(uid);
      });
      tag.querySelector('.delete-tag').addEventListener('click', (e) => {
        e.stopPropagation();
        removeAccount(uid);
        renderSavedAccounts();
      });
      accountsList.appendChild(tag);
    });
  }

  function doLogin(uid) {
    uid = uid.trim();
    if (!uid) { loginError.textContent = '请输入 UID'; return; }
    if (!/^\d+$/.test(uid)) { loginError.textContent = 'UID 必须为数字'; return; }
    currentUid = uid;
    userAchievements[currentUid] = loadAchievements(uid);
    saveAchievements(currentUid, userAchievements[currentUid]);
    showMainPage();
  }

  loginBtn.addEventListener('click', () => doLogin(uidInput.value));
  uidInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(uidInput.value); });
  renderSavedAccounts();
}

// ========== 主页面 ==========
function showMainPage() {
  document.getElementById('login-page').classList.remove('active');
  document.getElementById('main-page').classList.add('active');
  document.getElementById('current-uid').textContent = currentUid;
  buildAchievementList();
  renderAchievements();
  updateStats();
  initMainEvents();
}

function showLoginPage() {
  document.getElementById('main-page').classList.remove('active');
  document.getElementById('login-page').classList.add('active');
  document.getElementById('uid-input').value = '';
  currentUid = null;
}

// ========== 渲染成就列表 (optimized with innerHTML) ==========
function renderAchievements(filterText = '') {
  const container = document.getElementById('achievement-list');
  const data = userAchievements[currentUid];
  let html = '';

  for (const [category, catData] of Object.entries(window.ACHIEVEMENTS_DATA)) {
    // Calculate category progress
    let catTotal = 0, catCompleted = 0;
    for (const [, items] of Object.entries(catData.children)) {
      for (const item of items) {
        catTotal++;
        if (data[item.key]) catCompleted++;
      }
    }

    html += `<div class="category-card" data-category="${category}">`;
    // Category header
    html += `<div class="category-header">
      <div class="category-header-left">
        <span class="category-icon">${catData.icon}</span>
        <span class="category-title">${category}</span>
        <span class="category-count">${catCompleted}/${catTotal}</span>
      </div>
      <div class="category-header-right">
        <span class="category-progress-text">${catTotal > 0 ? Math.round(catCompleted / catTotal * 100) : 0}%</span>
        <span class="chevron">&#9660;</span>
      </div>
    </div>`;

    // Sub-categories container
    html += `<div class="sub-categories">`;

    for (const [subName, items] of Object.entries(catData.children)) {
      // Filter
      let filteredItems = items;
      if (filterText) {
        filteredItems = items.filter(item => item.name.includes(filterText) || item.desc.includes(filterText));
        if (filteredItems.length === 0) continue;
      }

      let subCompleted = 0;
      for (const item of items) { if (data[item.key]) subCompleted++; }

      html += `<div class="sub-category" data-sub="${subName}">
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

      // Sort: uncompleted first, completed last (keep relative order)
      const itemsToRender = (filterText ? filteredItems : items).slice().sort((a, b) => {
        const aDone = !!data[a.key];
        const bDone = !!data[b.key];
        if (aDone === bDone) return 0;
        return aDone ? 1 : -1;
      });

      for (const item of itemsToRender) {
        const isDone = !!data[item.key];
        html += `<div class="achievement-item${isDone ? ' completed' : ''}">
          <input type="checkbox" class="achievement-checkbox" data-key="${item.key}" ${isDone ? 'checked' : ''}>
          <div class="achievement-info">
            <div class="achievement-name">${item.name}</div>
            <div class="achievement-desc">${item.desc}</div>
          </div>
        </div>`;
      }

      html += `</div></div>`;
    }

    html += `</div></div>`;
  }

  container.innerHTML = html;
  bindAchievementEvents(container);
}

function bindAchievementEvents(container) {
  // Category expand/collapse
  container.querySelectorAll('.category-header').forEach(header => {
    header.addEventListener('click', () => {
      const card = header.closest('.category-card');
      const subContainer = card.querySelector('.sub-categories');
      const expanded = subContainer.classList.toggle('expanded');
      header.querySelector('.chevron').classList.toggle('expanded', expanded);
    });
  });

  // Sub-category expand/collapse
  container.querySelectorAll('.sub-category-header').forEach(subHeader => {
    subHeader.addEventListener('click', (e) => {
      if (e.target.type === 'checkbox') return;
      const itemsDiv = subHeader.nextElementSibling;
      itemsDiv.classList.toggle('expanded');
      subHeader.querySelector('.chevron').classList.toggle('expanded');
    });
  });

  // Sub-category checkbox (select all)
  container.querySelectorAll('.sub-checkbox').forEach(subCb => {
    subCb.addEventListener('change', () => {
      const subDiv = subCb.closest('.sub-category');
      const checkItems = subDiv.querySelectorAll('.achievement-checkbox');
      checkItems.forEach((cb) => {
        cb.checked = subCb.checked;
        const key = cb.dataset.key;
        if (subCb.checked) {
          userAchievements[currentUid][key] = true;
          cb.closest('.achievement-item').classList.add('completed');
        } else {
          delete userAchievements[currentUid][key];
          cb.closest('.achievement-item').classList.remove('completed');
        }
      });
      saveAchievements(currentUid, userAchievements[currentUid]);
      updateSubCategoryUI(subDiv);
      updateCategoryUI(subDiv.closest('.category-card'));
      updateStats();
    });
  });

  // Individual achievement checkbox (each independent)
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
  const items = subDiv.querySelectorAll('.achievement-checkbox');
  let completed = 0;
  items.forEach(cb => { if (cb.checked) completed++; });
  subDiv.querySelector('.sub-checkbox').checked = completed === items.length && items.length > 0;
  subDiv.querySelector('.sub-progress-text').textContent = `${completed}/${items.length}`;
}

function updateCategoryUI(card) {
  const checkboxes = card.querySelectorAll('.achievement-checkbox');
  let completed = 0;
  checkboxes.forEach(cb => { if (cb.checked) completed++; });
  const total = checkboxes.length;
  card.querySelector('.category-count').textContent = `${completed}/${total}`;
  card.querySelector('.category-progress-text').textContent = `${total > 0 ? Math.round(completed / total * 100) : 0}%`;
}

function toggleAchievement(name, completed) {
  if (completed) {
    userAchievements[currentUid][name] = true;
  } else {
    delete userAchievements[currentUid][name];
  }
  saveAchievements(currentUid, userAchievements[currentUid]);
}

// ========== 更新统计 ==========
function updateStats() {
  const stats = calcStats(userAchievements[currentUid]);
  document.getElementById('stats-completed').textContent = stats.completed;
  document.getElementById('stats-total').textContent = stats.total;
  document.getElementById('stats-percent').textContent = `${stats.total > 0 ? Math.round(stats.completed / stats.total * 100) : 0}%`;
  document.getElementById('stats-progress').style.width = `${stats.total > 0 ? (stats.completed / stats.total * 100) : 0}%`;

  const catStatsDiv = document.getElementById('category-stats');
  let catHtml = '<h3 style="font-size:12px;font-weight:600;color:var(--gray-500);margin-bottom:8px;">分类导航（点击跳转）</h3>';
  for (const [cat, stat] of Object.entries(stats.catStats)) {
    const percent = stat.total > 0 ? Math.round(stat.completed / stat.total * 100) : 0;
    catHtml += `<div class="category-stat-item directory-link" data-target="${cat}" style="cursor:pointer;">
      <span class="cat-name" style="cursor:pointer;">${window.ACHIEVEMENTS_DATA[cat].icon} ${cat}</span>
      <span class="cat-progress">${stat.completed}/${stat.total} (${percent}%)</span>
    </div>`;
  }
  catStatsDiv.innerHTML = catHtml;

  // Click to scroll
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

      const results = allAchievementList.filter(a => a.name.includes(text) || a.desc.includes(text));

      if (results.length === 0) {
        searchList.innerHTML = '<div class="no-results">没有找到匹配的成就</div>';
      } else {
        let html = '';
        for (const r of results) {
          const isDone = !!userAchievements[currentUid][r.key];
          html += `<div class="search-result-item">
            <input type="checkbox" ${isDone ? 'checked' : ''} data-key="${r.key}" style="accent-color:var(--blue-500);">
            <div style="flex:1;min-width:0;">
              <div class="search-result-name">${r.name}</div>
              <div class="search-result-desc">${r.desc}</div>
            </div>
            <span class="search-result-category">${r.category}</span>
          </div>`;
        }
        searchList.innerHTML = html;

        // Bind checkbox events
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

// ========== 导出功能 ==========
function initExport() {
  const exportBtn = document.getElementById('export-btn');
  const exportModal = document.getElementById('export-modal');
  const exportText = document.getElementById('export-text');
  const closeModal = document.getElementById('close-modal');
  const copyBtn = document.getElementById('copy-btn');

  exportBtn.addEventListener('click', () => {
    const stats = calcStats(userAchievements[currentUid]);
    let text = `====== 原神成就统计 ======\n`;
    text += `UID: ${currentUid}\n`;
    text += `导出时间: ${new Date().toLocaleString('zh-CN')}\n`;
    text += `总进度: ${stats.completed}/${stats.total} (${stats.total > 0 ? Math.round(stats.completed / stats.total * 100) : 0}%)\n`;
    text += `========================\n\n`;

    for (const [category, catData] of Object.entries(window.ACHIEVEMENTS_DATA)) {
      const catStat = stats.catStats[category];
      if (!catStat) continue;
      text += `【${catData.icon} ${category}】 ${catStat.completed}/${catStat.total}\n`;
      text += `───────────────────\n`;
      for (const [subName, items] of Object.entries(catData.children)) {
        text += `  ▸ ${subName}:\n`;
        for (const item of items) {
          const done = userAchievements[currentUid][item.key] ? '✓' : '✗';
          text += `    [${done}] ${item.name} — ${item.desc}\n`;
        }
        text += `\n`;
      }
      text += `\n`;
    }

    exportText.value = text;
    exportModal.style.display = 'flex';
  });

  closeModal.addEventListener('click', () => { exportModal.style.display = 'none'; });
  exportModal.addEventListener('click', (e) => { if (e.target === exportModal) exportModal.style.display = 'none'; });

  copyBtn.addEventListener('click', () => {
    exportText.select();
    document.execCommand('copy');
    copyBtn.textContent = '已复制!';
    setTimeout(() => { copyBtn.textContent = '复制到剪贴板'; }, 1500);
  });
}

// ========== 主页面事件 ==========
function initMainEvents() {
  document.getElementById('logout-btn').addEventListener('click', () => {
    showLoginPage();
    initLoginPage();
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
  initLoginPage();
});
