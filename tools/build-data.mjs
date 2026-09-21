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
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data.js');
const UPSTREAM = 'dvaJi/genshin-data';
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

const GH = 'https://api.github.com';

async function jget(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'genshin-achievement-sync' } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

function readPrev() {
  // 从现有 data.js 里继承「旧键迁移表」和版本名，避免旧进度丢失
  if (!fs.existsSync(OUT)) return { legacy: {}, name: '' };
  const src = fs.readFileSync(OUT, 'utf8');
  let legacy = {};
  const m = src.match(/const LEGACY_KEY_MAP = (\{[\s\S]*?\});/);
  if (m) { try { legacy = JSON.parse(m[1]); } catch (e) { legacy = {}; } }
  const n = src.match(/gameVersionName:\s*"([^"]*)"/);
  return { legacy, name: n ? n[1] : '' };
}

async function main() {
  const prev = readPrev();

  // 1. 上游文件清单
  const list = await jget(`${GH}/repos/${UPSTREAM}/contents/${LANG_DIR}`);
  const files = list.filter(f => f.name.endsWith('.json'));

  // 2. 下载全部合辑
  const albums = [];
  for (const f of files) {
    const r = await fetch(f.download_url);
    const j = await r.json();
    const items = Object.keys(j.achievements).map(k => j.achievements[k]);
    items.sort((a, b) => (a.order - b.order) || (a.id - b.id));
    albums.push({ _id: j._id, name: j.name, items });
  }
  albums.sort((a, b) => a._id - b._id);

  // 3. 上游版本信息（commit 信息里带游戏版本，例如 "update genshin data v7.0"）
  const [pkg, commits] = await Promise.all([
    jget(`https://raw.githubusercontent.com/${UPSTREAM}/master/package.json`).catch(() => ({})),
    jget(`${GH}/repos/${UPSTREAM}/commits?per_page=1`).catch(() => []),
  ]);
  const commitDate = commits?.[0]?.commit?.author?.date?.slice(0, 10) || '';
  const msg = commits?.[0]?.commit?.message || '';
  const gameVersion = (msg.match(/v(\d+\.\d+)/) || [])[1] || '';

  const total = albums.reduce((a, x) => a + x.items.length, 0);
  const totalReward = albums.reduce((a, x) => a + x.items.reduce((y, i) => y + (i.reward || 0), 0), 0);

  // 4. 生成
  const head = `// 原神成就数据库（由 tools/build-data.mjs 自动生成，请勿手工修改）
// 数据来源: ${UPSTREAM} (release ${pkg.version || '?'})
// 游戏版本: ${gameVersion || '（未知，请手动补）'}${prev.name ? '「' + prev.name + '」' : ''}
// 上游更新时间: ${commitDate}
// 生成时间: ${new Date().toISOString().slice(0, 10)}
// 成就总数: ${total} 项 / ${albums.length} 个合辑 / ${totalReward} 原石
`;
  const body = [];
  body.push('ACHIEVEMENTS_META = {');
  body.push(`  gameVersion: ${JSON.stringify(gameVersion)},`);
  body.push(`  gameVersionName: ${JSON.stringify(prev.name)},`);
  body.push(`  dataVersion: ${JSON.stringify(pkg.version || '')},`);
  body.push(`  source: ${JSON.stringify(UPSTREAM)},`);
  body.push(`  sourceUpdatedAt: ${JSON.stringify(commitDate)},`);
  body.push(`  generatedAt: ${JSON.stringify(new Date().toISOString().slice(0, 10))},`);
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
        `order: ${it.order}`,
      ];
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
  body.push('const LEGACY_KEY_MAP = ' + JSON.stringify(prev.legacy) + ';');
  body.push('');
  body.push('window.ACHIEVEMENTS_DATA = ACHIEVEMENTS;');
  body.push('window.ACHIEVEMENTS_META = ACHIEVEMENTS_META;');
  body.push('window.LEGACY_KEY_MAP = LEGACY_KEY_MAP;');

  const next = head + body.join('\n') + '\n';

  if (fs.existsSync(OUT) && fs.readFileSync(OUT, 'utf8') === next) {
    console.log('数据无变化');
    return;
  }
  fs.writeFileSync(OUT, next, 'utf8');
  console.log(`data.js 已更新：${total} 项 / ${albums.length} 个合辑 / 游戏 ${gameVersion || '?'}`);
}

main().catch(e => { console.error('同步失败：' + e.message); process.exit(1); });
