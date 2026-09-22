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
// 账号密码版 2026-09-21（第四轮）
//   · 新增：UID + 自设密码的注册/登录。密码用 PBKDF2-SHA256 + 16 字节随机盐派生 150000 轮，
//     只存哈希不存明文；无 WebCrypto 环境（file:// 打开）自动切换到纯 JS 同名实现，结果一致
//   · 新增：顶栏「切换账号」（不离开页面直接换 UID）+「修改密码」（需旧密码）
//   · 新增：退出登录清除会话；刷新页面不掉线（会话放 sessionStorage）
//   · 新增：删除账号需要密码验证（原先点一下 × 就删）
//   · ⚠️ 安全边界：这是「本机锁定」不是服务器级安全。进度数据本身是明文存的，
//     懂技术的人可直接读浏览器存储绕过密码。用途是防别人顺手翻看 + 防自己输错 UID
// 导入指引版 2026-09-21（第五轮）
//   · 新增：导入弹窗里的「具体操作流程」按钮 —— 点开是 7 段分步说明（下载外部工具 /
//     导出步骤 / 导入步骤 / 多账号 / 常见问题排查表 / 安全边界 / UIAF 是什么）
//   · 2026-09-22 精简：删掉原来的第 1 段「先确认你的 UID」与第 2 段「在本站登录」，
//     后面各段编号整体前移；提示语里也去掉了「50MB 的 .pdb 别下」那句
//   · 新增：导入弹窗里的「下载导出工具 YaeAchievement」直达按钮（官方 releases，新标签打开）
//   · 原先那个挤成一大段的 window.alert 说明，换成可滚动的弹窗版（手机上也能看）
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
function getAuthKey() { return `genshin_achievement_auth_v1`; }
function getSessionKey() { return `genshin_achievement_session_uid`; }

// 密码保护的参数
// 说明：这是「本机锁定」，不是服务器级安全 —— 进度数据本身仍以明文存在浏览器里，
// 懂技术的人可以直接读浏览器存储绕过密码。密码哈希用了正经的 PBKDF2-SHA256 + 随机盐，
// 目的是「即使有人翻到存储里的哈希，也反推不出你的密码」。
const PBKDF2_ITERATIONS = 150000;
const MIN_PASSWORD_LEN = 6;

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

// ========== 账号密码（本机锁定） ==========
// 安全边界（务必如实告知使用者）：
//   · 密码用 PBKDF2-SHA256 + 16 字节随机盐 派生 150000 轮，只存哈希，不存明文；
//   · 但它挡不住懂技术的人 —— 进度数据本身是明文存在浏览器里的，可以直接读。
//     这道锁的用途是「防止别人在你电脑上顺手翻看」+「防止自己输错 UID 进错账号」。

function getCryptoObj() {
  try { return (typeof crypto !== 'undefined' && crypto) ? crypto : null; } catch (e) { return null; }
}

// WebCrypto 只在安全上下文（https / localhost）里存在；以 file:// 打开时没有 subtle
function hasWebCrypto() {
  const c = getCryptoObj();
  return !!(c && c.subtle && typeof c.subtle.importKey === 'function' && typeof c.subtle.deriveBits === 'function');
}

function randomBytes(n) {
  const a = new Uint8Array(n);
  const c = getCryptoObj();
  if (c && typeof c.getRandomValues === 'function') { c.getRandomValues(a); return a; }
  for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256);
  return a;
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64ToBytes(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 自己实现 UTF-8 编码，不依赖 TextEncoder（某些环境没有）
function utf8Bytes(str) {
  if (typeof TextEncoder !== 'undefined') { try { return new TextEncoder().encode(str); } catch (e) { /* 落到下面 */ } }
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

// ---- 纯 JS SHA-256 / HMAC-SHA256 / PBKDF2（file:// 打开时的兜底，与 WebCrypto 结果一致）----
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr32(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }

function sha256Bytes(msg) {
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const l = msg.length;
  const withOne = l + 1;
  const rem = withOne % 64;
  const padLen = rem <= 56 ? 56 - rem : 120 - rem;
  const total = l + 1 + padLen + 8;
  const buf = new Uint8Array(total);
  buf.set(msg, 0);
  buf[l] = 0x80;
  const dv = new DataView(buf.buffer);
  const bitLen = l * 8;
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(total - 4, bitLen >>> 0, false);

  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = (rotr32(x, 7) ^ rotr32(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr32(y, 17) ^ rotr32(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = (rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i], false);
  return out;
}

function hmacSha256Js(keyBytes, msgBytes) {
  const B = 64;
  const HASH_LEN = 32;
  let k = keyBytes;
  if (k.length > B) k = sha256Bytes(k);
  const kPad = new Uint8Array(B);
  kPad.set(k, 0);
  const oKey = new Uint8Array(B + HASH_LEN);
  const iKey = new Uint8Array(B + msgBytes.length);
  for (let i = 0; i < B; i++) {
    oKey[i] = kPad[i] ^ 0x5c;
    iKey[i] = kPad[i] ^ 0x36;
  }
  iKey.set(msgBytes, B);
  const inner = sha256Bytes(iKey);
  oKey.set(inner, B);
  return sha256Bytes(oKey);
}

function pbkdf2Sha256Js(passwordBytes, saltBytes, iterations, dkLen) {
  const hLen = 32;
  const blocks = Math.ceil(dkLen / hLen);
  const out = new Uint8Array(blocks * hLen);
  const msg = new Uint8Array(saltBytes.length + 4);
  msg.set(saltBytes, 0);
  const mdv = new DataView(msg.buffer);
  let offset = 0;
  for (let i = 1; i <= blocks; i++) {
    mdv.setUint32(saltBytes.length, i, false);
    let u = hmacSha256Js(passwordBytes, msg);
    const t = new Uint8Array(u);
    for (let j = 1; j < iterations; j++) {
      u = hmacSha256Js(passwordBytes, u);
      for (let k = 0; k < hLen; k++) t[k] ^= u[k];
    }
    out.set(t, offset);
    offset += hLen;
  }
  return out.slice(0, dkLen);
}

// 统一入口：有 WebCrypto 走原生（快），否则走上面的纯 JS 实现（结果相同）
async function derivePasswordHash(password, saltBytes, iterations) {
  if (hasWebCrypto()) {
    const km = await crypto.subtle.importKey('raw', utf8Bytes(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: saltBytes, iterations: iterations, hash: 'SHA-256' }, km, 256
    );
    return new Uint8Array(bits);
  }
  return pbkdf2Sha256Js(utf8Bytes(password), saltBytes, iterations, 32);
}

// 定长比较，避免通过耗时差异猜哈希
function equalHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return diff === 0;
}

// ---- 凭据存储 ----
function getAuthStore() {
  try {
    const raw = localStorage.getItem(getAuthKey());
    const o = raw ? JSON.parse(raw) : {};
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch (e) { return {}; }
}

function setAuthStore(store) {
  try { localStorage.setItem(getAuthKey(), JSON.stringify(store)); return true; } catch (e) { return false; }
}

function getAuthRecord(uid) { return getAuthStore()[String(uid)] || null; }
function hasPassword(uid) { return !!getAuthRecord(uid); }

function setAuthRecord(uid, rec) {
  const s = getAuthStore();
  s[String(uid)] = rec;
  return setAuthStore(s);
}

function deleteAuthRecord(uid) {
  const s = getAuthStore();
  delete s[String(uid)];
  setAuthStore(s);
}

function createAccountPassword(uid, password) {
  const salt = randomBytes(16);
  return derivePasswordHash(password, salt, PBKDF2_ITERATIONS).then(hash => {
    return setAuthRecord(uid, {
      v: 1,
      algo: hasWebCrypto() ? 'PBKDF2-SHA256' : 'PBKDF2-SHA256-js',
      iter: PBKDF2_ITERATIONS,
      salt: bytesToB64(salt),
      hash: bytesToB64(hash),
      created: Date.now(),
      loginAt: Date.now(),
    });
  });
}

function checkAccountPassword(uid, password) {
  const rec = getAuthRecord(uid);
  if (!rec || !rec.salt || !rec.hash) return Promise.resolve(false);
  return derivePasswordHash(password, b64ToBytes(rec.salt), rec.iter || PBKDF2_ITERATIONS)
    .then(hash => equalHash(bytesToB64(hash), rec.hash));
}

function touchLogin(uid) {
  const rec = getAuthRecord(uid);
  if (!rec) return;
  rec.loginAt = Date.now();
  setAuthRecord(uid, rec);
}

// ---- 会话（放 sessionStorage：刷新页面不掉线，关掉浏览器需要重新输密码）----
function setSession(uid) { try { sessionStorage.setItem(getSessionKey(), String(uid)); } catch (e) { /* 隐私模式下可能不可用 */ } }
function getSession() { try { return sessionStorage.getItem(getSessionKey()); } catch (e) { return null; } }
function clearSession() { try { sessionStorage.removeItem(getSessionKey()); } catch (e) { /* 忽略 */ } }

// ========== 登录页 ==========
// 让出一帧，好让「正在校验…」先画出来（纯 JS 兜底路径下 PBKDF2 会阻塞 1~3 秒）
function nextFrame() { return new Promise(r => setTimeout(r, 0)); }

// 密码输入框是动态注入的 —— index.html 保持不动（与站点其他增强一致）
function ensureAuthFields() {
  const form = document.querySelector('#login-page .login-form');
  if (!form) return;

  if (!document.getElementById('pwd-input')) {
    const wrap = document.createElement('div');
    wrap.className = 'auth-fields';
    wrap.innerHTML =
      '<div class="pwd-row">' +
        '<label for="pwd-input">密码</label>' +
        '<input type="password" id="pwd-input" placeholder="请输入密码" autocomplete="current-password" maxlength="128">' +
      '</div>' +
      '<div class="pwd-row" id="pwd2-row" style="display:none;">' +
        '<label for="pwd2-input">确认密码</label>' +
        '<input type="password" id="pwd2-input" placeholder="再输一次，避免打错" autocomplete="new-password" maxlength="128">' +
      '</div>' +
      '<p class="auth-mode-hint" id="auth-mode-hint"></p>' +
      '<p class="auth-strength" id="auth-strength"></p>';
    const uidEl = form.querySelector('#uid-input');
    // 必须插在 UID 输入框之后、登录按钮之前 —— #login-error 在按钮后面，不能拿它当锚点
    if (uidEl && uidEl.parentNode === form) form.insertBefore(wrap, uidEl.nextSibling);
    else {
      const btn = form.querySelector('#login-btn');
      if (btn) form.insertBefore(wrap, btn); else form.appendChild(wrap);
    }
  }

  if (!document.getElementById('auth-note')) {
    const container = document.querySelector('#login-page .login-container');
    const saved = document.getElementById('saved-accounts');
    const note = document.createElement('div');
    note.id = 'auth-note';
    note.className = 'auth-security-note';
    note.innerHTML =
      '<b>关于这道密码</b>' +
      '<span>密码只保存在这台设备的这个浏览器里，经 PBKDF2-SHA256 + 随机盐派生后存哈希，不存明文。' +
      '它能防止别人顺手打开你的浏览器翻看，但<b>挡不住懂技术的人</b> —— 进度数据本身是明文存放的，' +
      '按 F12 就能读到。所以：<b class="auth-warn">请不要使用你在别处用过的密码。</b></span>';
    if (container && saved) container.insertBefore(note, saved);
    else if (container) container.appendChild(note);
  }
}

function initLoginPage() {
  ensureAuthFields();
  const uidInput = document.getElementById('uid-input');
  const pwdInput = document.getElementById('pwd-input');
  const pwd2Input = document.getElementById('pwd2-input');
  const pwd2Row = document.getElementById('pwd2-row');
  const loginBtn = document.getElementById('login-btn');
  const loginError = document.getElementById('login-error');
  const modeHint = document.getElementById('auth-mode-hint');
  const strengthEl = document.getElementById('auth-strength');
  const accountsList = document.getElementById('accounts-list');
  const savedAccounts = document.getElementById('saved-accounts');
  if (!uidInput || !pwdInput || !loginBtn) return;

  const btnLabel = () => (authMode(uidInput.value) === 'register' ? '注册并进入' : '登录');

  function authMode(uid) {
    return uid && hasPassword(uid) ? 'login' : 'register';
  }

  function refreshMode() {
    const uid = String(uidInput.value || '').trim();
    const isRegister = authMode(uid) === 'register';
    pwd2Row.style.display = isRegister ? 'block' : 'none';
    loginBtn.textContent = btnLabel();
    pwdInput.setAttribute('autocomplete', isRegister ? 'new-password' : 'current-password');
    if (!uid) {
      modeHint.textContent = '第一次用某个 UID，填进去并设置一个密码；已经设过密码的 UID 直接输密码登录。';
      modeHint.className = 'auth-mode-hint';
    } else if (isRegister) {
      modeHint.textContent = 'UID ' + uid + ' 还没有设过密码，请为它设置一个（至少 ' + MIN_PASSWORD_LEN + ' 位）。';
      modeHint.className = 'auth-mode-hint is-register';
    } else {
      modeHint.textContent = 'UID ' + uid + ' 已设置密码，请输入密码登录。';
      modeHint.className = 'auth-mode-hint is-login';
    }
  }

  function refreshStrength() {
    const v = pwdInput.value || '';
    if (!strengthEl) return;
    if (!v) { strengthEl.textContent = ''; strengthEl.className = 'auth-strength'; return; }
    let score = 0;
    if (v.length >= 8) score++;
    if (v.length >= 12) score++;
    if (/[a-z]/.test(v) && /[A-Z]/.test(v)) score++;
    if (/\d/.test(v)) score++;
    if (/[^A-Za-z0-9]/.test(v)) score++;
    const label = score >= 4 ? '较强' : score >= 2 ? '一般' : '偏弱';
    const cls = score >= 4 ? 'is-strong' : score >= 2 ? 'is-mid' : 'is-weak';
    strengthEl.textContent = '密码强度：' + label + (score < 2 ? '（建议 8 位以上、字母数字混用）' : '');
    strengthEl.className = 'auth-strength ' + cls;
  }

  function setError(msg) { if (loginError) loginError.textContent = msg || ''; }

  function busy(on, text) {
    loginBtn.disabled = !!on;
    loginBtn.textContent = on ? (text || '处理中…') : btnLabel();
  }

  function clearPwd() {
    pwdInput.value = '';
    if (pwd2Input) pwd2Input.value = '';
    if (strengthEl) { strengthEl.textContent = ''; strengthEl.className = 'auth-strength'; }
  }

  function enterAccount(uid) {
    currentUid = String(uid);
    userAchievements[currentUid] = loadAchievements(currentUid);
    doneTimes = loadTimes(currentUid);
    lastSnapshot = null;
    persist();
    touchLogin(currentUid);
    setSession(currentUid);
    showMainPage();
  }

  async function requestDeleteAccount(uid) {
    // 删除不可逆：先确认，并提示先导出备份
    const okDel = window.confirm(
      '确定要删除 UID ' + uid + ' 的本地成就记录吗？\n\n' +
      '该账号在这台设备上保存的进度会被永久删除，无法恢复。\n' +
      '建议先用「导出备份（JSON）」保存一份再删除。'
    );
    if (!okDel) return;
    if (hasPassword(uid)) {
      const typed = window.prompt('删除前请验证：输入 UID ' + uid + ' 的密码');
      if (typed === null) return;
      busy(true, '正在校验…');
      await nextFrame();
      const pass = await checkAccountPassword(uid, typed);
      busy(false);
      if (!pass) { window.alert('密码不对，已取消删除。'); return; }
    }
    removeAccount(uid);
    deleteAuthRecord(uid);
    if (getSession() === String(uid)) clearSession();
    if (currentUid === String(uid)) currentUid = null;
    setError('');
    renderSavedAccounts();
  }

  function renderSavedAccounts() {
    const accounts = getAccounts();
    accountsList.innerHTML = '';
    if (accounts.length === 0) { savedAccounts.style.display = 'none'; return; }
    savedAccounts.style.display = 'block';
    accounts.forEach(uid => {
      const locked = hasPassword(uid);
      const tag = document.createElement('span');
      tag.className = 'account-tag';
      tag.innerHTML =
        '<span class="account-uid">UID: ' + esc(uid) +
        ' <span class="pwd-badge' + (locked ? '' : ' is-none') + '">' + (locked ? '已设密码' : '未设密码') + '</span></span>' +
        '<span class="delete-tag" data-uid="' + esc(uid) + '" title="删除这个账号的本地记录">&times;</span>';
      tag.addEventListener('click', (e) => {
        if (e.target.classList.contains('delete-tag')) return;
        // 不再直接进入 —— 必须过密码这一关
        uidInput.value = uid;
        pwdInput.value = '';
        if (pwd2Input) pwd2Input.value = '';
        setError('');
        refreshMode();
        refreshStrength();
        pwdInput.focus();
      });
      tag.querySelector('.delete-tag').addEventListener('click', (e) => {
        e.stopPropagation();
        requestDeleteAccount(uid);
      });
      accountsList.appendChild(tag);
    });
  }

  async function doLogin() {
    const uid = String(uidInput.value || '').trim();
    const pwd = pwdInput.value || '';
    if (!uid) { setError('请输入 UID'); return; }
    if (!/^\d+$/.test(uid)) { setError('UID 必须为数字'); return; }
    if (uid.length < 9) { setError('UID 一般是 9 位数字，请检查'); return; }
    if (!pwd) { setError('请输入密码'); return; }

    const mode = authMode(uid);
    if (mode === 'register') {
      if (pwd.length < MIN_PASSWORD_LEN) { setError('密码至少 ' + MIN_PASSWORD_LEN + ' 位'); return; }
      if (pwd !== (pwd2Input ? pwd2Input.value : '')) { setError('两次输入的密码不一致'); return; }
      setError('');
      busy(true, '正在创建…');
      await nextFrame();
      const saved = await createAccountPassword(uid, pwd);
      busy(false);
      if (!saved) { setError('密码保存失败：浏览器存储可能已满或被禁用'); return; }
      clearPwd();
      enterAccount(uid);
      showToast('已为 UID ' + uid + ' 设好密码 —— 每个 UID 的进度各自独立保存');
    } else {
      setError('');
      busy(true, '正在校验…');
      await nextFrame();
      const pass = await checkAccountPassword(uid, pwd);
      busy(false);
      if (!pass) { setError('密码不对，再试一次'); try { pwdInput.select(); } catch (e) { /* 忽略 */ } return; }
      clearPwd();
      enterAccount(uid);
    }
    refreshMode();
  }

  // 只绑定一次，避免反复退出/登录后监听器叠加
  if (!initLoginPage._bound) {
    initLoginPage._bound = true;
    loginBtn.addEventListener('click', doLogin);
    [uidInput, pwdInput, pwd2Input].forEach(el => {
      if (!el) return;
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    });
    uidInput.addEventListener('input', refreshMode);
    uidInput.addEventListener('blur', refreshMode);
    pwdInput.addEventListener('input', refreshStrength);
  }

  window.__renderSavedAccounts = renderSavedAccounts;
  window.__refreshLoginUi = () => { refreshMode(); refreshStrength(); renderSavedAccounts(); };
  refreshMode();
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
  ensureHeaderSwitchBtn();
  renderAchievements();
  updateStats();
}

function showLoginPage() {
  document.getElementById('main-page').classList.remove('active');
  document.getElementById('login-page').classList.add('active');
  const u = document.getElementById('uid-input'); if (u) u.value = '';
  const p = document.getElementById('pwd-input'); if (p) p.value = '';
  const p2 = document.getElementById('pwd2-input'); if (p2) p2.value = '';
  const e = document.getElementById('login-error'); if (e) e.textContent = '';
  const s = document.getElementById('auth-strength'); if (s) { s.textContent = ''; s.className = 'auth-strength'; }
  document.getElementById('filter-bar')?.remove();
  const sw = document.getElementById('switch-modal'); if (sw) sw.style.display = 'none';
  currentUid = null;
  if (window.__refreshLoginUi) window.__refreshLoginUi();
}

// 顶栏「切换账号」按钮（动态注入，不改 index.html）
function ensureHeaderSwitchBtn() {
  const right = document.querySelector('.header-right');
  if (!right || document.getElementById('switch-account-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'switch-account-btn';
  btn.className = 'btn-secondary';
  btn.textContent = '切换账号';
  btn.title = '不用退出页面，直接切到另一个 UID';
  btn.addEventListener('click', openSwitchModal);
  const logout = document.getElementById('logout-btn');
  if (logout) right.insertBefore(btn, logout); else right.appendChild(btn);
}

// ========== 切换账号弹窗 ==========
let switchTarget = null;

// 换密码时保留原 created 时间
function changeAccountPassword(uid, password) {
  const rec = getAuthRecord(uid);
  const created = rec ? rec.created : Date.now();
  return createAccountPassword(uid, password).then(ok => {
    if (ok) {
      const r = getAuthRecord(uid);
      if (r) { r.created = created; r.changedAt = Date.now(); setAuthRecord(uid, r); }
    }
    return ok;
  });
}

// 不离开主界面，直接换到另一个 UID
function switchToAccount(uid) {
  currentUid = String(uid);
  userAchievements[currentUid] = loadAchievements(currentUid);
  doneTimes = loadTimes(currentUid);
  lastSnapshot = null;
  persist();
  touchLogin(currentUid);
  setSession(currentUid);

  document.getElementById('current-uid').textContent = currentUid;
  const si = document.getElementById('search-input'); if (si) si.value = '';
  const sr = document.getElementById('search-results'); if (sr) sr.style.display = 'none';
  currentSearchKeys = [];
  viewFilter = 'all';
  hideHidden = false;
  document.getElementById('filter-bar')?.remove();
  buildAchievementList();
  ensureFilterBar();
  renderAchievements();
  updateStats();
  showToast('已切换到 UID ' + currentUid);
}

function renderSwitchModal() {
  const modal = document.getElementById('switch-modal');
  if (!modal) return;
  const cur = modal.querySelector('#switch-current-uid');
  if (cur) cur.textContent = currentUid || '';
  modal.querySelector('#switch-pwd-box').style.display = 'none';
  modal.querySelector('#chpwd-box').style.display = 'none';
  modal.querySelector('#switch-error').textContent = '';
  modal.querySelector('#chpwd-error').textContent = '';
  modal.querySelector('#switch-pwd-input').value = '';
  ['#chpwd-old', '#chpwd-new', '#chpwd-new2'].forEach(s => { modal.querySelector(s).value = ''; });
  switchTarget = null;

  const list = modal.querySelector('#switch-list');
  list.innerHTML = '';
  const accounts = getAccounts();
  if (!accounts.length) {
    list.innerHTML = '<p class="switch-empty">这台设备上还没有保存过账号。</p>';
    return;
  }
  accounts.forEach(uid => {
    const isCur = String(uid) === String(currentUid);
    const locked = hasPassword(uid);
    const row = document.createElement('div');
    row.className = 'switch-row' + (isCur ? ' is-current' : '');
    row.innerHTML =
      '<span class="switch-uid">UID: ' + esc(uid) + (isCur ? ' <span class="switch-here">当前</span>' : '') + '</span>' +
      '<span class="pwd-badge' + (locked ? '' : ' is-none') + '">' + (locked ? '已设密码' : '未设密码') + '</span>';
    if (!isCur) {
      row.title = locked ? '点击后输入密码即可切过去' : '这个 UID 还没设密码';
      row.addEventListener('click', () => {
        if (!locked) {
          window.alert(
            'UID ' + uid + ' 还没有设置密码。\n\n' +
            '现在这个站点要求每个账号都有密码才能进入 —— 这样才不会输错一位 UID 就进到别的账号。\n' +
            '请先「退出登录」，在登录页输入这个 UID 并设一个密码，它原来的进度不会被影响。'
          );
          return;
        }
        switchTarget = String(uid);
        modal.querySelector('#switch-target-uid').textContent = uid;
        modal.querySelector('#switch-pwd-box').style.display = 'block';
        modal.querySelector('#chpwd-box').style.display = 'none';
        modal.querySelector('#switch-error').textContent = '';
        const pi = modal.querySelector('#switch-pwd-input');
        pi.value = '';
        pi.focus();
      });
    }
    list.appendChild(row);
  });
  return list;
}

function bindSwitchModal(modal) {
  const close = () => { modal.style.display = 'none'; };
  modal.querySelector('#close-switch').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  const pi = modal.querySelector('#switch-pwd-input');
  const confirmBtn = modal.querySelector('#switch-confirm');
  const err = modal.querySelector('#switch-error');

  async function doSwitch() {
    if (!switchTarget) { err.textContent = '请先点一个账号'; return; }
    const pwd = pi.value || '';
    if (!pwd) { err.textContent = '请输入密码'; return; }
    err.textContent = '';
    confirmBtn.disabled = true;
    confirmBtn.textContent = '正在校验…';
    await nextFrame();
    const pass = await checkAccountPassword(switchTarget, pwd);
    confirmBtn.disabled = false;
    confirmBtn.textContent = '切换到该账号';
    if (!pass) { err.textContent = '密码不对'; try { pi.select(); } catch (e) { /* 忽略 */ } return; }
    const target = switchTarget;
    pi.value = '';
    close();
    switchToAccount(target);
  }
  confirmBtn.addEventListener('click', doSwitch);
  pi.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSwitch(); });

  const chBox = modal.querySelector('#chpwd-box');
  modal.querySelector('#change-pwd-btn').addEventListener('click', () => {
    const show = chBox.style.display === 'none';
    chBox.style.display = show ? 'block' : 'none';
    if (show) {
      modal.querySelector('#switch-pwd-box').style.display = 'none';
      modal.querySelector('#chpwd-uid').textContent = currentUid || '';
      modal.querySelector('#chpwd-error').textContent = '';
      ['#chpwd-old', '#chpwd-new', '#chpwd-new2'].forEach(s => { modal.querySelector(s).value = ''; });
      modal.querySelector('#chpwd-old').focus();
    }
  });

  const chConfirm = modal.querySelector('#chpwd-confirm');
  async function doChangePwd() {
    const cerr = modal.querySelector('#chpwd-error');
    const oldP = modal.querySelector('#chpwd-old').value || '';
    const n1 = modal.querySelector('#chpwd-new').value || '';
    const n2 = modal.querySelector('#chpwd-new2').value || '';
    if (!hasPassword(currentUid)) { cerr.textContent = '当前账号还没有设置密码'; return; }
    if (!oldP) { cerr.textContent = '请输入当前密码'; return; }
    if (n1.length < MIN_PASSWORD_LEN) { cerr.textContent = '新密码至少 ' + MIN_PASSWORD_LEN + ' 位'; return; }
    if (n1 !== n2) { cerr.textContent = '两次输入的新密码不一致'; return; }
    if (n1 === oldP) { cerr.textContent = '新密码不能和当前密码相同'; return; }
    cerr.textContent = '';
    chConfirm.disabled = true;
    chConfirm.textContent = '正在校验…';
    await nextFrame();
    const pass = await checkAccountPassword(currentUid, oldP);
    if (!pass) {
      chConfirm.disabled = false; chConfirm.textContent = '保存新密码';
      cerr.textContent = '当前密码不对';
      return;
    }
    chConfirm.textContent = '正在保存…';
    await nextFrame();
    await changeAccountPassword(currentUid, n1);
    chConfirm.disabled = false; chConfirm.textContent = '保存新密码';
    chBox.style.display = 'none';
    ['#chpwd-old', '#chpwd-new', '#chpwd-new2'].forEach(s => { modal.querySelector(s).value = ''; });
    showToast('密码已修改，下次用新密码登录');
  }
  chConfirm.addEventListener('click', doChangePwd);
}

function openSwitchModal() {
  let modal = document.getElementById('switch-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'switch-modal';
    modal.className = 'modal';
    modal.innerHTML =
      '<div class="modal-content switch-content">' +
        '<div class="modal-header">' +
          '<h3>账号</h3>' +
          '<button class="btn-close" id="close-switch">&times;</button>' +
        '</div>' +
        '<div class="switch-body">' +
          '<div class="switch-current">当前账号：<b id="switch-current-uid"></b></div>' +
          '<div class="switch-list" id="switch-list"></div>' +
          '<div class="switch-pwd" id="switch-pwd-box" style="display:none;">' +
            '<label>输入 UID <b id="switch-target-uid"></b> 的密码</label>' +
            '<input type="password" id="switch-pwd-input" placeholder="密码" autocomplete="current-password" maxlength="128">' +
            '<p class="error-msg" id="switch-error"></p>' +
            '<button class="btn-primary" id="switch-confirm">切换到该账号</button>' +
          '</div>' +
          '<div class="switch-pwd" id="chpwd-box" style="display:none;">' +
            '<label>修改 UID <b id="chpwd-uid"></b> 的密码</label>' +
            '<input type="password" id="chpwd-old" placeholder="当前密码" autocomplete="current-password" maxlength="128">' +
            '<input type="password" id="chpwd-new" placeholder="新密码（至少 ' + MIN_PASSWORD_LEN + ' 位）" autocomplete="new-password" maxlength="128">' +
            '<input type="password" id="chpwd-new2" placeholder="再输一次新密码" autocomplete="new-password" maxlength="128">' +
            '<p class="error-msg" id="chpwd-error"></p>' +
            '<button class="btn-primary" id="chpwd-confirm">保存新密码</button>' +
          '</div>' +
          '<div class="switch-actions">' +
            '<button class="btn-small" id="change-pwd-btn">修改密码</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    bindSwitchModal(modal);
  }
  renderSwitchModal();
  modal.style.display = 'flex';
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

            <div class="import-guide-cta">
              <button class="btn-small guide-btn" id="import-guide-btn">具体操作流程</button>
              <a class="btn-small guide-btn guide-dl" id="import-download-btn" href="https://github.com/HolographicHat/Yae/releases/latest" target="_blank" rel="noopener noreferrer">下载导出工具 YaeAchievement</a>
              <span>还没有 UIAF 文件？工具<b>免费开源</b>、Windows 专用。下载页里只拿 <code>YaeAchievement.exe</code> 那一个（约 11 MB）。<br>第一次用建议先点「具体操作流程」 —— 从下载、导出到导入本站都有分步说明，还带常见问题排查表。</span>
            </div>
          </div>
          <div class="import-pick">
            <button class="btn-small import-pick-btn" id="pick-file">选择文件…</button>
            <span class="import-file" id="import-file"></span>
          </div>
          <div class="import-report" id="import-report"></div>
        </div>
        <div class="modal-footer">
          <button class="btn-small" id="import-help">具体操作流程</button>
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
    // 两个入口指向同一份说明
    modal.querySelector('#import-help').addEventListener('click', openImportGuide);
    const guideEntry = modal.querySelector('#import-guide-btn');
    if (guideEntry) guideEntry.addEventListener('click', openImportGuide);
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

// 导入操作流程说明 —— 弹窗版（原先是 window.alert，一长串文字很难读）
function openImportGuide() {
  let modal = document.getElementById('guide-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'guide-modal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content guide-content">
        <div class="modal-header">
          <h3>导入成就进度 · 完整操作流程</h3>
          <button class="btn-close" id="close-guide">×</button>
        </div>
        <div class="guide-body">
          <div class="guide-lead">
            游戏里 1800 多条成就，想一条条手工回来勾是不现实的。这个功能让你用一款<b>免费的开源工具</b>把游戏里的成就一次性导出，
            再回本站一次性地导入进来。<br>
            整个过程<b>不需要把米哈游账号密码交给任何工具</b>，导出的文件也<b>不会上传到任何服务器</b> ——
            全部在你自己的电脑和浏览器里完成。
          </div>

          <h4 class="guide-h"><span class="guide-num">1</span>下载导出工具</h4>
          <p class="guide-p">工具叫 <b>YaeAchievement</b>（作者后来把项目改名成 <b>Yae</b>，老链接会自动跳转），免费开源，Windows 专用。</p>
          <ul class="guide-list">
            <li>官方下载页：<a class="guide-link" href="https://github.com/HolographicHat/Yae/releases/latest" target="_blank" rel="noopener noreferrer">github.com/HolographicHat/Yae/releases/latest</a></li>
            <li>下载列表里<b>只需要拿 <code>YaeAchievement.exe</code></b> 这一个（约 11 MB）</li>
            <li>同一个列表里的 <code>YaeAchievement.pdb</code> 是 50 MB 的调试符号文件，<b>用不上，别下</b></li>
            <li>给它<b>单独新建一个文件夹</b>放，比如桌面新建一个「成就导出」</li>
          </ul>
          <div class="guide-warn"><b>千万别把 exe 和原神主程序放在同一个文件夹</b>，否则游戏会报「数据异常(31-4302)」，进不去游戏。</div>

          <h4 class="guide-h"><span class="guide-num">2</span>运行工具，把成就导出来</h4>
          <table class="guide-table">
            <thead><tr><th>步骤</th><th>你要做什么</th><th>会发生什么</th></tr></thead>
            <tbody>
              <tr><td>1</td><td>确认原神已经<b>完全退出</b>（启动器也关掉）</td><td>—</td></tr>
              <tr><td>2</td><td>双击 <code>YaeAchievement.exe</code></td><td>它自动帮你把游戏启动起来</td></tr>
              <tr><td>3</td><td>正常登录，进入游戏</td><td>工具会自动读取你的全部成就</td></tr>
              <tr><td>4</td><td>等它读完</td><td><b>游戏会自动退出</b> —— 这是正常现象，不是崩溃</td></tr>
              <tr><td>5</td><td>在弹出的导出目标列表里，选最后一项 <b>「UIAF JSON File」</b></td><td>得到一个 <code>.json</code> 文件</td></tr>
              <tr><td>6</td><td>找到那个文件</td><td>它就在 exe 所在的文件夹里，名字形如 <code>export-20xxxxxxxxxxxx-xxx.json</code></td></tr>
            </tbody>
          </table>
          <div class="guide-tip">列表里其它几项（椰羊、胡桃工具箱、Paimon.moe、CSV 表格等）是给别的工具用的，<b>本站要选「UIAF JSON File」</b>。</div>
          <div class="guide-warn">如果杀毒软件把它拦了：这款工具需要读取游戏进程的内存，容易被误报，需要你手动放行。整个过程<b>不需要你把米哈游账号密码输入给这个工具</b>。</div>

          <h4 class="guide-h"><span class="guide-num">3</span>回到本站导入</h4>
          <ol class="guide-steps">
            <li>点顶栏的「<b>导入进度</b>」</li>
            <li>点「选择文件…」，选中刚才那个 json</li>
            <li>先看<b>预览报告</b>：一共多少条 / 已完成多少 / 将新增多少 / 有没有本站还没收录的</li>
            <li>确认没问题，点「<b>确认导入</b>」</li>
            <li>底部会弹出一条提示，<b>12 秒内可以点「撤销」</b> —— 导错了立刻撤销就行</li>
          </ol>
          <div class="guide-tip">导入是<b>合并</b>语义：只补上你已完成、网站还没勾的，<b>绝不会取消</b>你已有的进度。同一个文件重复导入也是安全的。</div>

          <h4 class="guide-h"><span class="guide-num">4</span>有多个账号怎么办</h4>
          <ul class="guide-list">
            <li>工具抓到的数据会<b>缓存 1 小时</b>。所以可以在缓存有效期内：依次登录每个号 → 分别导出 → 回本站用顶栏的「<b>切换账号</b>」切到对应 UID → 分别导入</li>
            <li>本站每个 UID 的进度互不影响，切号不会互相覆盖</li>
          </ul>

          <h4 class="guide-h"><span class="guide-num">5</span>出问题了？对照这张表</h4>
          <table class="guide-table">
            <thead><tr><th>现象</th><th>原因</th><th>怎么办</th></tr></thead>
            <tbody>
              <tr><td>游戏报「数据异常(31-4302)」</td><td>exe 和原神主程序放在同一个文件夹了</td><td>把 exe 挪到一个单独的文件夹里</td></tr>
              <tr><td>下载列表里分不清该下哪个</td><td>—</td><td>只拿 <code>YaeAchievement.exe</code>；那个 50 MB 的 <code>.pdb</code> 不要</td></tr>
              <tr><td>提示「有 N 条成就本站数据里还没有」</td><td>游戏版本比本站数据新（说明新版本已经上线了）</td><td>这 N 条会被<b>明确列出来、不会被丢掉</b>。等每天上午 10 点本站自动同步完成，再导入一次就补上了</td></tr>
              <tr><td>导入完成，但进度看起来没变化</td><td>这份文件不是当前登录的这个 UID 导出的；或者那几条本来就已完成</td><td>用顶栏「切换账号」切到正确的号，再导一次</td></tr>
              <tr><td>选完文件提示「不是合法的 JSON」</td><td>选错文件了（比如选成了 csv，或选成本站备份）</td><td>回工具里重新选「UIAF JSON File」，导出后再选那个 json</td></tr>
              <tr><td>工具卡住 / 读不到成就</td><td>游戏没完全退出，或者权限不够</td><td>关掉游戏和启动器重来；还不行就右键 exe「以管理员身份运行」</td></tr>
              <tr><td>导入后悔了</td><td>—</td><td>12 秒内点底部提示条上的「撤销」</td></tr>
              <tr><td>不想用任何第三方工具</td><td>—</td><td>完全可以：手动逐条勾选，或者用每个合辑卡片右上角的「<b>整组完成</b>」一次性勾完一个合辑</td></tr>
            </tbody>
          </table>

          <h4 class="guide-h"><span class="guide-num">6</span>安全与边界（建议读一下）</h4>
          <ul class="guide-list">
            <li>这类导出工具需要<b>读取游戏进程内存</b>，属于第三方软件，严格讲走在用户协议的边界上。社区长期共识是「只读、不修改游戏文件、风险很低」，但<b>不是零风险</b> —— 用不用由你自己判断。</li>
            <li>它<b>不需要</b>你提供米哈游账号密码。</li>
            <li>本站的导入 / 导出<b>全程在你的浏览器里完成，文件不会上传到任何服务器</b>。</li>
            <li>你的进度只存在<b>这台设备的这个浏览器</b>里 —— 换电脑、换浏览器、清缓存就没了。所以建议隔一段时间用「导出备份（JSON）」或「导出 UIAF」存一份留底。</li>
          </ul>

          <h4 class="guide-h"><span class="guide-num">7</span>UIAF 是什么</h4>
          <p class="guide-p">
            UIAF（统一可交换成就格式 v1.1）是 UIGF 组织制定的通用成就数据标准，椰羊、Paimon.moe、胡桃工具箱、寻空等工具都认这个格式。
            本站<b>既能导入也能导出</b>，所以进度导进来之后，随时可以再导出去带到别的工具里用。
          </p>
        </div>
        <div class="modal-footer">
          <button class="btn-small" id="close-guide-bottom">知道了</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const closeGuide = () => { modal.style.display = 'none'; };
    modal.querySelector('#close-guide').addEventListener('click', closeGuide);
    modal.querySelector('#close-guide-bottom').addEventListener('click', closeGuide);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeGuide(); });
    // 说明里的外链不要顺带触发遮罩关闭
    modal.querySelectorAll('.guide-link').forEach(a => a.addEventListener('click', (e) => e.stopPropagation()));
  }
  // 每次打开都回到顶部，别停在上次看到的位置
  const body = modal.querySelector('.guide-body');
  if (body) body.scrollTop = 0;
  modal.style.display = 'flex';
}

// 兼容旧调用名
function showImportHelp() { openImportGuide(); }

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
    // 退出前先把当前进度落盘，避免任何意外
    if (currentUid) persist();
    clearSession();
    showLoginPage();
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

  // 本次会话内刷新页面不掉线（会话存在 sessionStorage，关掉浏览器就需要重新输密码）
  const sessUid = getSession();
  if (sessUid && hasPassword(sessUid)) {
    currentUid = String(sessUid);
    userAchievements[currentUid] = loadAchievements(currentUid);
    doneTimes = loadTimes(currentUid);
    lastSnapshot = null;
    showMainPage();
  }
});
