#!/usr/bin/env node
/**
 * 从上游 dvaJi/genshin-data 拉取最新成就数据，生成 data.js
 *
 * 用法：node tools/build-data.mjs
 * 上游每次游戏版本更新后 1 天内就会同步（例：7.0 数据 2026-08-11 发布，游戏 08-12 上线），
 * 所以配合 .github/workflows/sync-achievements.yml 定时跑，就能自动跟版。
 *
 * 生成规则：
 *   - key 用游戏内稳定成就 id（如 "81032"），版本更新不会错位
 *   - 保留旧的 LEGACY_KEY_MAP，让还没迁移过的浏览器仍能自动转换旧进度
 *   - 新增合辑需要在下面的 ICONS 里补一个图标，否则用默认 🏆
 *   - generatedAt 只在数据真正变化时才刷新，保证「无变化 → 零提交」
 *
 * 版本标记（哪些成就是哪个版本新增的）——自给自足，不依赖额外文件：
 *   - 基线 = LEGACY_KEY_MAP 的全部 value（即 6.8 时代的 1759 个 id）
 *   - 上一版 data.js 里带 v 字段的成就，其版本号直接继承过来
 *   - 上游出现、但既不在基线里、上一版也没记录的 id → 就是本次版本新增，记为当前游戏版本
 *   - 前端据此显示「7.0 新增」徽章；以后再更新会累积成 7.0 / 7.1 / ...
 *
 * 网络：文件内容按 raw.githubusercontent.com → jsDelivr CDN → GitHub API 依次降级，
 *       某些网络环境会拦 raw 域名，多一路备用可以少一次「同步失败」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data.js');
const UPSTREAM = 'dvaJi/genshin-data';
const BRANCH = 'master';
const LANG_DIR = 'src/data/chinese-simplified/achievements';

const ICONS = {
  '天地万象': '🌍',
  '尘世巡游·第一辑': '🚶',
  '冒险手艺': '📜',
  '英雄之旅': '🦸',
  '蒙德·风与牧歌的城邦': '🍃',
  '璃月·岩与契约的海港': '🪨',
  '元素专家·第一辑': '🔮',
  '神射手': '🎯',
  '挑战者·第一辑': '⚔️',
  '秘境与深境螺旋·第一辑': '🌀',
  'Olah！第一辑': '👋',
  '至冬国不相信眼泪·第一辑': '❄️',
  '岩港往事·第一辑': '🪨',
  '异世相逢·第一辑': '🌠',
  '挑战者·第二辑': '⚔️',
  '挑战者·第三辑': '⚔️',
  '雪山上的来客': '🏔️',
  '心跳的记忆': '💭',
  '世外洞天·第一辑': '🌌',
  '世外洞天·第二辑': '🌌',
  '挑战者·第四辑': '⚔️',
  '异世相逢·第二辑': '🌠',
  '尘世巡游·第二辑': '🚶',
  '世外洞天·第三辑': '🌌',
  '稻妻·雷与永恒的群岛·其之一': '⚡',
  '提瓦特钓鱼指南·第一辑': '🎣',
  '稻妻·雷与永恒的群岛·其之二': '⚡',
  '雾海纪行': '🌫️',
  '白昼之光': '☀️',
  '挑战者·第五辑': '⚔️',
  '岩窟流明': '🕯️',
  '须弥·玄识深藏的雨林': '🌿',
  '尘世巡游·第三辑': '🚶',
  '异世相逢·第三辑': '🌠',
  '挑战者·第六辑': '⚔️',
  '须弥·饰金砂原·其之一': '🏜️',
  '元素专家·第二辑': '🔮',
  '七圣召唤': '🃏',
  '须弥·饰金砂原·其之二': '🏜️',
  '挑战者·第七辑': '⚔️',
  '挑战者·第八辑': '⚔️',
  '佑灵砾漠': '🏜️',
  '枫丹·白露澈明的泉舞·其之一': '💃',
  '尘世巡游·第四辑': '🚶',
  '异世相逢·第四辑': '🌠',
  '枫丹·白露澈明的泉舞·其之二': '💃',
  '枫丹·白露澈明的泉舞·其之三': '💃',
  '沉玉成辉': '🏔️',
  '古海狂诗': '🌊',
  '挑战者·第九辑': '⚔️',
  '幻想真境剧诗·第一辑': '🎭',
  '纳塔·火与竞逐的盟地·其之一': '🔥',
  '幻想真境剧诗·第二辑': '🎭',
  '异世相逢·第五辑': '🌠',
  '对决者·第一辑': '🗡️',
  '纳塔·火与竞逐的盟地·其之二': '🔥',
  '对决者·第二辑': '🗡️',
  '尘世巡游·第五辑': '🚶',
  '千音雅集': '🎵',
  '挑战者·第十辑': '⚔️',
  '圣山残辉': '🏔️',
  '对决者·第三辑': '🗡️',
  '岩灰与刺梨的夏日': '🌵',
  '挪德卡莱·月与浪迹的乐园·其之一': '🌙',
  '异世相逢·第六辑': '🌠',
  '尘世巡游·第六辑': '🚶',
  '挪德卡莱·月与浪迹的乐园·其之二': '🌙',
  '魔山风息': '⛰️',
  '无束的残月': '🌙',
  '至冬·冰与苍星的圣都·其之一': '❄️',
  '浮涌的阴影之地': '🌫️',
  '尘世巡游·第七辑': '🧭',
  '异世相逢·第七辑': '🤝',
};

// 已知的「版本号 → 中文版本名」对照（上游 commit 只给版本号，中文名查不到）
// 以后新版本想显示中文名，在这里补一行即可；没补就沿用上一版的名称
const VERSION_NAMES = {
  '7.0': '无神怜爱的雪国',
  '7.1': '往冥府的安魂歌',
};

const GH = 'https://api.github.com';
const UA = 'genshin-achievement-sync';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const CONCURRENCY = 8;   // 并发下载数（73 个合辑串行跑太慢）
let preferred = 0;       // 记住上一次成功的源，避免每个文件都先撞一次被拦的域名

// 内容下载的候选源（按顺序降级）
function contentSources(p) {
  return [
    ['raw.githubusercontent', `https://raw.githubusercontent.com/${UPSTREAM}/${BRANCH}/${p}`, false],
    ['jsDelivr', `https://cdn.jsdelivr.net/gh/${UPSTREAM}@${BRANCH}/${p}`, false],
    ['api.github.com', `${GH}/repos/${UPSTREAM}/contents/${p}?ref=${BRANCH}`, true],
  ];
}

async function fetchText(url, isApi) {
  const headers = { 'User-Agent': UA };
  if (isApi) headers['Accept'] = 'application/vnd.github.raw';
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

/** 按候选源依次尝试，成功即返回；首选源失败时只重试一次，其余源不重试 */
async function getText(p) {
  const srcs = contentSources(p);
  const order = [srcs[preferred], ...srcs.filter((_, i) => i !== preferred)];
  const errs = [];
  for (let i = 0; i < order.length; i++) {
    const [label, url, isApi] = order[i];
    const attempts = i === 0 ? 2 : 1;
    for (let a = 1; a <= attempts; a++) {
      try {
        const t = await fetchText(url, isApi);
        preferred = srcs.indexOf(order[i]);   // 成功了，下次先用它
        return t;
      } catch (e) {
        const detail = e.cause ? `${e.message} (${e.cause.code || e.cause.message})` : e.message;
        errs.push(`${label}#${a}: ${detail}`);
        if (a < attempts) await sleep(300);
      }
    }
  }
  throw new Error(`无法拉取 ${p}\n    ` + errs.join('\n    '));
}

/** 有并发上限地跑一批任务，保持输入顺序返回结果 */
async function pool(items, worker, limit = CONCURRENCY) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function getJSON(p) {
  return JSON.parse(await getText(p));
}

async function apiJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

function readPrev() {
  // 从现有 data.js 继承：旧键迁移表、版本名、上次生成日期、各成就的版本标记
  if (!fs.existsSync(OUT)) return { legacy: {}, name: '', generatedAt: '', versions: {} };
  const src = fs.readFileSync(OUT, 'utf8');

  let legacy = {};
  const m = src.match(/const LEGACY_KEY_MAP = (\{[\s\S]*?\});/);
  if (m) { try { legacy = JSON.parse(m[1]); } catch (e) { legacy = {}; } }

  // 逐行解析成就条目，取出带 v 字段的（一行一条，格式由本脚本生成，稳定）
  const versions = {};
  for (const line of src.split('\n')) {
    const mm = line.match(/^\s*\{\s*key:\s*"([^"]+)".*,\s*v:\s*"([^"]+)",\s*order:/);
    if (mm) versions[mm[1]] = mm[2];
  }

  const n = src.match(/gameVersionName:\s*"([^"]*)"/);
  const g = src.match(/generatedAt:\s*"([^"]*)"/);
  return { legacy, name: n ? n[1] : '', generatedAt: g ? g[1] : '', versions };
}

function buildBody({ albums, gameVersion, gameVersionName, dataVersion, commitDate, generatedAt, legacy, versions }) {
  const total = albums.reduce((a, x) => a + x.items.length, 0);
  const totalReward = albums.reduce((a, x) => a + x.items.reduce((y, i) => y + (i.reward || 0), 0), 0);

  const head = `// 原神成就数据库（由 tools/build-data.mjs 自动生成，请勿手工修改）
// 数据来源: ${UPSTREAM} (release ${dataVersion || '?'})
// 游戏版本: ${gameVersion || '（未知，请手动补）'}${gameVersionName ? '「' + gameVersionName + '」' : ''}
// 上游更新时间: ${commitDate}
// 生成时间: ${generatedAt}
// 成就总数: ${total} 项 / ${albums.length} 个合辑 / ${totalReward} 原石
`;
  const body = [];
  body.push('ACHIEVEMENTS_META = {');
  body.push(`  gameVersion: ${JSON.stringify(gameVersion)},`);
  body.push(`  gameVersionName: ${JSON.stringify(gameVersionName)},`);
  body.push(`  dataVersion: ${JSON.stringify(dataVersion || '')},`);
  body.push(`  source: ${JSON.stringify(UPSTREAM)},`);
  body.push(`  sourceUpdatedAt: ${JSON.stringify(commitDate)},`);
  body.push(`  generatedAt: ${JSON.stringify(generatedAt)},`);
  body.push(`  total: ${total},`);
  body.push(`  totalReward: ${totalReward}`);
  body.push('};');
  body.push('');
  body.push('const ACHIEVEMENTS = {');
  albums.forEach((al, ai) => {
    body.push(`  ${JSON.stringify(al.name)}: {`);
    body.push(`    icon: ${JSON.stringify(ICONS[al.name] || '🏆')},`);
    body.push(`    order: ${al._id},`);
    body.push(`    children: {`);
    body.push(`      ${JSON.stringify(al.name)}: [`);
    al.items.forEach((it, idx) => {
      const f = [
        `key: ${JSON.stringify(String(it.id))}`,
        `name: ${JSON.stringify(it.name)}`,
        `desc: ${JSON.stringify(it.desc)}`,
        `reward: ${it.reward || 0}`,
        `hidden: ${!!it.hidden}`,
      ];
      if (versions[String(it.id)]) f.push(`v: ${JSON.stringify(versions[String(it.id)])}`);
      f.push(`order: ${it.order}`);
      body.push(`        { ${f.join(', ')} }${idx < al.items.length - 1 ? ',' : ''}`);
    });
    body.push('      ]');
    body.push('    }');
    body.push(`  }${ai < albums.length - 1 ? ',' : ''}`);
  });
  body.push('};');
  body.push('');
  body.push('// 旧数据（索引式 key）→ 新数据（稳定 id）的一次性迁移表');
  body.push('// 所有浏览器都完成一次迁移后，这段可以删掉');
  body.push('const LEGACY_KEY_MAP = ' + JSON.stringify(legacy) + ';');
  body.push('');
  body.push('window.ACHIEVEMENTS_DATA = ACHIEVEMENTS;');
  body.push('window.ACHIEVEMENTS_META = ACHIEVEMENTS_META;');
  body.push('window.LEGACY_KEY_MAP = LEGACY_KEY_MAP;');
  return head + body.join('\n') + '\n';
}

async function main() {
  const prev = readPrev();
  const versions = { ...prev.versions };               // 继承上一版已知的版本标记
  const baseIds = new Set(Object.values(prev.legacy)); // 6.8 时代的 1759 个 id

  // 1. 上游文件清单
  const list = await apiJSON(`${GH}/repos/${UPSTREAM}/contents/${LANG_DIR}?ref=${BRANCH}`);
  const files = list.filter(f => f.name.endsWith('.json'));
  if (!files.length) throw new Error('上游文件清单为空');

  // 2. 并发下载全部合辑（8 路并发，失败的上报文件名）
  const results = await pool(files, async (f) => {
    try {
      const j = await getJSON(f.path);
      const items = Object.keys(j.achievements).map(k => j.achievements[k]);
      items.sort((a, b) => (a.order - b.order) || (a.id - b.id));
      return { ok: true, album: { _id: j._id, name: j.name, items } };
    } catch (e) { return { ok: false, name: f.name, err: e.message }; }
  });
  const albums = results.filter(r => r.ok).map(r => r.album);
  const failed = results.filter(r => !r.ok);
  if (failed.length) {
    throw new Error(`有 ${failed.length} 个合辑下载失败：${failed.map(f => f.name).join(', ')}\n    首个错误：${failed[0].err}`);
  }
  albums.sort((a, b) => a._id - b._id);

  // 3. 上游版本信息（commit 信息里带游戏版本，例如 "update genshin data v7.0"）
  const [pkg, commits] = await Promise.all([
    getJSON('package.json').catch(() => ({})),
    apiJSON(`${GH}/repos/${UPSTREAM}/commits?per_page=1`).catch(() => []),
  ]);
  const commitDate = commits?.[0]?.commit?.author?.date?.slice(0, 10) || '';
  const msg = commits?.[0]?.commit?.message || '';
  const gameVersion = (msg.match(/v(\d+\.\d+)/) || [])[1] || '';
  const gameVersionName = VERSION_NAMES[gameVersion] || prev.name || '';

  // 4. 版本标记：不在 6.8 基线、上一版也没记录的 id → 本次版本新增
  let newIds = 0;
  if (gameVersion) {
    for (const al of albums) {
      for (const it of al.items) {
        const id = String(it.id);
        if (!versions[id] && !baseIds.has(id)) { versions[id] = gameVersion; newIds++; }
      }
    }
  }
  const markCount = Object.keys(versions).length;

  // 5. 生成（generatedAt 沿用旧值做比对：数据没变就不刷新日期，保证零提交）
  const today = new Date().toISOString().slice(0, 10);
  const args = {
    albums, gameVersion, gameVersionName, dataVersion: pkg.version,
    commitDate, generatedAt: prev.generatedAt || today, legacy: prev.legacy, versions,
  };
  const withOldDate = buildBody(args);

  if (fs.existsSync(OUT) && fs.readFileSync(OUT, 'utf8') === withOldDate) {
    console.log(`数据无变化（版本标记 ${markCount} 条）`);
    return;
  }

  const next = prev.generatedAt === today ? withOldDate : buildBody({ ...args, generatedAt: today });
  fs.writeFileSync(OUT, next, 'utf8');
  const total = albums.reduce((a, x) => a + x.items.length, 0);
  console.log(`data.js 已更新：${total} 项 / ${albums.length} 个合辑 / 游戏 ${gameVersion || '?'}${gameVersionName ? '「' + gameVersionName + '」' : ''} / 本次新增 ${newIds} 项 / 累计版本标记 ${markCount} 条`);
}

main().catch(e => { console.error('同步失败：' + (e && e.message ? e.message : e)); process.exit(1); });
