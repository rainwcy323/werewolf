'use strict';

// 角色定義：team = 陣營（wolf / good），cat = 屠邊判定分類（wolf / god / villager）
const ROLES = {
  werewolf:  { name: '狼人',   team: 'wolf', cat: 'wolf',     icon: '🐺', max: 8,
    desc: '每晚與狼隊友共同擊殺一名玩家（可空刀、可自刀）。白天發言階段可「自爆」，立即結束白天進入黑夜。' },
  wolfking:  { name: '狼王',   team: 'wolf', cat: 'wolf',     icon: '👑', max: 1,
    desc: '狼人陣營，夜晚與狼人一同行動。死亡時可開槍帶走一名玩家；被女巫毒死、殉情或自爆時不能開槍。' },
  whitewolf: { name: '白狼王', team: 'wolf', cat: 'wolf',     icon: '🤍', max: 1,
    desc: '狼人陣營，夜晚與狼人一同行動。白天自爆時可同時帶走一名玩家。' },
  seer:      { name: '預言家', team: 'good', cat: 'god',      icon: '🔮', max: 1,
    desc: '每晚查驗一名玩家，得知對方是「好人」還是「狼人」。' },
  witch:     { name: '女巫',   team: 'good', cat: 'god',      icon: '🧪', max: 1,
    desc: '擁有解藥與毒藥各一瓶，各限用一次，同一晚不能同時使用兩瓶。解藥用掉後，之後的夜晚將不再得知刀口。' },
  hunter:    { name: '獵人',   team: 'good', cat: 'god',      icon: '🔫', max: 1,
    desc: '被狼人殺害、被放逐或被帶走時，可開槍帶走一名玩家；被女巫毒死或殉情則不能開槍。' },
  guard:     { name: '守衛',   team: 'good', cat: 'god',      icon: '🛡️', max: 1,
    desc: '每晚守護一名玩家（可守自己）免於狼刀，不能連續兩晚守同一人。守衛擋不住毒藥。' },
  idiot:     { name: '白痴',   team: 'good', cat: 'god',      icon: '🤪', max: 1,
    desc: '被投票放逐時翻牌免死，之後失去投票權但仍可發言。被狼殺或毒殺則正常死亡。' },
  knight:    { name: '騎士',   team: 'good', cat: 'god',      icon: '⚔️', max: 1,
    desc: '白天發言階段可翻牌與一名玩家決鬥（限一次）：對方是狼人則狼人死亡並立即進入黑夜；對方是好人則騎士以死謝罪。' },
  cupid:     { name: '丘比特', team: 'good', cat: 'god',      icon: '💘', max: 1,
    desc: '第一晚連結兩名玩家成為情侶（可含自己），一方死亡另一方殉情。若情侶是「人狼戀」，情侶與丘比特成為第三方，必須成為最後存活者才獲勝。' },
  villager:  { name: '平民',   team: 'good', cat: 'villager', icon: '🧑‍🌾', max: 12,
    desc: '沒有特殊能力，靠發言、推理與投票找出狼人。' },
};

const ROLE_ORDER = ['werewolf', 'wolfking', 'whitewolf', 'seer', 'witch', 'hunter', 'guard', 'idiot', 'knight', 'cupid', 'villager'];

const DEFAULT_SETTINGS = {
  witchSelf: 'first',   // 女巫自救：never / first（僅首夜）/ always
  guardSave: 'die',     // 同守同救：die（奶穿，死亡）/ live（存活）
  win: 'side',          // 勝利條件：side（屠邊）/ all（屠城）
  sheriff: true,        // 是否競選警長
  speechSec: 90,
  lastWordSec: 60,
  narration: true,      // 語音播報
};

// 依人數給出建議配置（參考常見板子：預女獵、預女獵守、預女獵白…）
function presetFor(n) {
  const c = {};
  const wolves = n <= 7 ? 2 : n <= 10 ? 3 : n <= 14 ? 4 : n <= 16 ? 5 : 6;
  const godList = ['seer', 'witch', 'hunter', 'guard', 'idiot', 'knight'];
  const gods = n <= 6 ? 2 : n <= 10 ? 3 : n <= 12 ? 4 : n <= 15 ? 5 : 6;
  c.werewolf = wolves;
  if (n >= 12) { c.werewolf = wolves - 1; c.whitewolf = 1; }
  for (let i = 0; i < gods; i++) c[godList[i]] = 1;
  c.villager = n - wolves - gods;
  return c;
}

function countRoles(c) { return ROLE_ORDER.reduce((s, k) => s + (c[k] || 0), 0); }

function roleSummary(c) {
  return ROLE_ORDER.filter(k => c[k]).map(k => ROLES[k].name + (c[k] > 1 ? '×' + c[k] : '')).join('、');
}
