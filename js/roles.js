'use strict';

/*
 * 角色定義
 *   team    陣營：wolf / good / third
 *   cat     屠邊分類：wolf / god / villager / third
 *   group   設定畫面分組：wolf / god / villager / special
 *   wake    狼人陣營中，夜晚與狼隊一起睜眼刀人
 *   explode 可以自爆
 */
const ROLES = {
  // ── 狼人陣營 ──
  werewolf:   { name: '狼人', team: 'wolf', cat: 'wolf', group: 'wolf', icon: '🐺', max: 8, wake: true, explode: true,
    desc: '每晚與狼隊友共同擊殺一名玩家（可空刀、可自刀）。白天發言階段可「自爆」，立即結束白天進入黑夜。' },
  wolfking:   { name: '狼王', team: 'wolf', cat: 'wolf', group: 'wolf', icon: '👑', max: 1, wake: true, explode: true,
    desc: '與狼人一同行動。死亡時可開槍帶走一名玩家；被毒死、殉情或自爆時不能開槍。' },
  whitewolf:  { name: '白狼王', team: 'wolf', cat: 'wolf', group: 'wolf', icon: '🤍', max: 1, wake: true, explode: true,
    desc: '與狼人一同行動。白天自爆時可同時帶走一名玩家。' },
  wolfbeauty: { name: '狼美人', team: 'wolf', cat: 'wolf', group: 'wolf', icon: '💃', max: 1, wake: true, explode: false,
    desc: '與狼人一同行動，之後每晚另外魅惑一名玩家。若狼美人白天被放逐或被獵人開槍帶走，最後一次被魅惑的玩家隨之殉情。不能自爆，狼隊也不能刀她。老流氓不受魅惑影響。' },
  hiddenwolf: { name: '隱狼', team: 'wolf', cat: 'wolf', group: 'wolf', icon: '🫥', max: 1, wake: false, explode: false,
    desc: '首夜會得知狼隊友是誰，但狼隊友不知道他。被預言家查驗、被訓熊師感應都顯示為好人。其他狼人全部死亡後才開始在夜晚刀人。不能自爆。' },
  gargoyle:   { name: '石像鬼', team: 'wolf', cat: 'wolf', group: 'wolf', icon: '🗿', max: 1, wake: false, explode: false,
    desc: '每晚獨自醒來，查驗一名玩家的確切身分。與其他狼人互不相認。只有在成為最後一名狼人時才能刀人。不能自爆。' },
  bloodmoon:  { name: '血月使徒', team: 'wolf', cat: 'wolf', group: 'wolf', icon: '🌕', max: 1, wake: true, explode: true,
    desc: '與狼人一同行動。自爆後的那一晚，所有神職都無法使用技能。若他是最後一名狼人且被放逐，可立刻再刀一人：若因此達成屠邊則狼人獲勝，否則好人獲勝。' },
  darkknight: { name: '惡靈騎士', team: 'wolf', cat: 'wolf', group: 'wolf', icon: '🏇', max: 1, wake: true, explode: false,
    desc: '與狼人一同行動，夜晚任何能力都殺不死他。第一個對他使用查驗或毒藥的神職（預言家或女巫）會在隔天死亡（反傷限一次）。白天可被放逐、開槍或決鬥而死。不能自爆。' },
  nightmare:  { name: '夢魘', team: 'wolf', cat: 'wolf', group: 'wolf', icon: '😱', max: 1, wake: true, explode: true,
    desc: '每晚最先行動，恐懼一名玩家，使其當晚無法使用技能（被恐懼的獵人當晚死亡也不能開槍）；若恐懼到狼人，狼隊當晚無法刀人。不能連續兩晚恐懼同一人。首夜不認識狼隊友，之後與狼人一同行動。' },

  // ── 神職 ──
  seer:       { name: '預言家', team: 'good', cat: 'god', group: 'god', icon: '🔮', max: 1,
    desc: '每晚查驗一名玩家，得知對方是「好人」還是「狼人」。' },
  witch:      { name: '女巫', team: 'good', cat: 'god', group: 'god', icon: '🧪', max: 1,
    desc: '擁有解藥與毒藥各一瓶，各限用一次，同一晚不能同時使用兩瓶。解藥用掉後不再得知刀口。' },
  hunter:     { name: '獵人', team: 'good', cat: 'god', group: 'god', icon: '🔫', max: 1,
    desc: '死亡時可開槍帶走一名玩家；被毒死、殉情，或當晚被夢魘恐懼／血月之夜死亡則不能開槍。' },
  guard:      { name: '守衛', team: 'good', cat: 'god', group: 'god', icon: '🛡️', max: 1,
    desc: '每晚守護一名玩家（可守自己）免於狼刀，不能連續兩晚守同一人。守不住毒藥。' },
  idiot:      { name: '白痴', team: 'good', cat: 'god', group: 'god', icon: '🤪', max: 1,
    desc: '被投票放逐時翻牌免死，之後失去投票權（仍可發言）。被狼殺或毒殺則正常死亡。' },
  knight:     { name: '騎士', team: 'good', cat: 'god', group: 'god', icon: '⚔️', max: 1,
    desc: '白天發言階段可翻牌與一名玩家決鬥（限一次）：對方是狼人則狼人死亡並立即進入黑夜；對方是好人則騎士以死謝罪。' },
  bear:       { name: '訓熊師', team: 'good', cat: 'god', group: 'god', icon: '🐻', max: 1,
    desc: '每天早上公布死訊後，若訓熊師左右兩側最近的存活玩家中有狼人，熊會咆哮（隱狼不會被感應）。訓熊師死亡後熊不再出聲。' },
  silencer:   { name: '禁言長老', team: 'good', cat: 'god', group: 'god', icon: '🤐', max: 1,
    desc: '每晚禁言一名玩家，該玩家隔天白天不能發言（遺言除外，仍可投票）。不能連續兩晚禁言同一人。' },
  dreamweaver:{ name: '攝夢人', team: 'good', cat: 'god', group: 'god', icon: '💤', max: 1,
    desc: '每晚必須選一名玩家當夢遊者，夢遊者當晚免疫一切夜間死亡。若攝夢人當晚死亡，夢遊者一起死亡；同一人連續兩晚當夢遊者也會死亡。' },
  magician:   { name: '魔術師', team: 'good', cat: 'god', group: 'god', icon: '🎩', max: 1,
    desc: '每晚可秘密交換兩名玩家的號碼，當晚所有指向其中一人的夜間技能都會改落在另一人身上。每名玩家整局只能被交換一次。' },
  demonhunter:{ name: '獵魔人', team: 'good', cat: 'god', group: 'god', icon: '🏹', max: 1,
    desc: '從第二晚起可狩獵一名玩家：對方是狼人則狼人死亡；對方是好人則獵魔人死亡。免疫女巫毒藥。' },
  raven:      { name: '烏鴉', team: 'good', cat: 'god', group: 'god', icon: '🐦‍⬛', max: 1,
    desc: '每晚詛咒一名玩家，隔天放逐投票時該玩家額外多 1 票。' },
  gravekeeper:{ name: '守墓人', team: 'good', cat: 'god', group: 'god', icon: '⚰️', max: 1,
    desc: '從第二晚起，每晚得知前一個白天被放逐的玩家是好人還是狼人。' },
  fortuneteller:{ name: '占卜師', team: 'good', cat: 'god', group: 'god', icon: '🃏', max: 1,
    desc: '整局限用一次，夜晚最早行動：選一名玩家，與其左右兩側存活玩家綁定，狼人當晚只能從這三人中選擇刀口。' },
  cupid:      { name: '丘比特', team: 'good', cat: 'god', group: 'special', icon: '💘', max: 1,
    desc: '第一晚連結兩名玩家成為情侶（可含自己），一方死亡另一方殉情。若情侶為人狼戀，情侶與丘比特成為第三方，須成為最後存活者才獲勝。' },

  // ── 平民 ──
  villager:   { name: '平民', team: 'good', cat: 'villager', group: 'villager', icon: '🧑‍🌾', max: 12,
    desc: '沒有特殊能力，靠發言、推理與投票找出狼人。' },
  thug:       { name: '老流氓', team: 'good', cat: 'villager', group: 'villager', icon: '🚬', max: 1,
    desc: '平民。不受狼美人魅惑。被毒殺或被開槍帶走時不會立刻死亡，會撐到下一次入夜才死。' },
  wildchild:  { name: '野孩子', team: 'good', cat: 'villager', group: 'special', icon: '🧒', max: 1,
    desc: '第一晚選一名榜樣。若榜樣被投票放逐，野孩子轉入狼人陣營，從下一晚起與狼人一起刀人；否則一直是好人（算平民）。' },

  // ── 特殊／第三方 ──
  thief:      { name: '盜賊', team: 'good', cat: 'villager', group: 'special', icon: '🦹', max: 1,
    desc: '使用時要多放 2 張底牌（總牌數＝人數＋2）。第一晚查看兩張底牌並換成其中一張；兩張都是狼人陣營時必須選狼。不換則成為平民。' },
  bomber:     { name: '炸彈人', team: 'third', cat: 'third', group: 'special', icon: '💣', max: 1,
    desc: '第三方。被投票放逐時可引爆，炸死所有投票給他的玩家；若因此炸死全部存活玩家則單獨獲勝。被狼殺、毒殺、開槍或殉情則不能引爆。不影響好人與狼人的勝負判定。' },
};

const ROLE_ORDER = [
  'werewolf', 'wolfking', 'whitewolf', 'wolfbeauty', 'hiddenwolf', 'gargoyle', 'bloodmoon', 'darkknight', 'nightmare',
  'seer', 'witch', 'hunter', 'guard', 'idiot', 'knight', 'bear', 'silencer', 'dreamweaver', 'magician', 'demonhunter', 'raven', 'gravekeeper', 'fortuneteller',
  'villager', 'thug',
  'cupid', 'wildchild', 'thief', 'bomber',
];

const ROLE_GROUPS = [['wolf', '狼人陣營'], ['god', '神職'], ['villager', '平民'], ['special', '特殊／第三方']];

const DEFAULT_SETTINGS = {
  witchSelf: 'first',   // 女巫自救：never / first（僅首夜）/ always
  guardSave: 'die',     // 同守同救：die（奶穿，死亡）/ live（存活）
  win: 'side',          // 勝利條件：side（屠邊）/ all（屠城）
  sheriff: true,        // 是否競選警長
  speechSec: 90,
  lastWordSec: 60,
  narration: true,      // 語音播報
};

// 'werewolf*3 seer witch' → { werewolf: 3, seer: 1, witch: 1 }
function parseRoles(spec) {
  const c = {};
  for (const tok of spec.trim().split(/\s+/)) {
    const [k, n] = tok.split('*');
    c[k] = (c[k] || 0) + (n ? +n : 1);
  }
  return c;
}

/*
 * 各人數的建議板子。來源：
 *   andyventure 狼人殺教學（各人數狼／神／民比例）、87G 狼人殺板子大全、口袋狼人殺 12 人板子介紹、萌娘百科。
 *   標示「進階」的板子是以常見 12 人特殊角色局為基礎、依同樣比例調整的組合。
 */
const PRESETS = {
  6: [
    ['預獵入門', 'werewolf*2 seer hunter villager*2', '最基本的 6 人局（萌娘百科）'],
    ['預女', 'werewolf*2 seer witch villager*2', '女巫可救可毒，適合新手'],
    ['預守', 'werewolf*2 seer guard villager*2', '守衛擋刀，節奏較慢'],
  ],
  7: [
    ['預女獵', 'werewolf*2 seer witch hunter villager*2', '神職較多，好人略有利'],
    ['預女', 'werewolf*2 seer witch villager*3', 'andyventure 建議比例 2/2/3'],
    ['預女守', 'werewolf*2 seer witch guard villager*2', '守衛＋女巫，注意同守同救'],
  ],
  8: [
    ['預女獵', 'werewolf*3 seer witch hunter villager*2', 'andyventure 建議比例 3/3/2'],
    ['預女守', 'werewolf*3 seer witch guard villager*2', '守衛取代獵人'],
    ['輕鬆局', 'werewolf*2 seer witch hunter villager*3', '只有 2 狼，適合新手'],
  ],
  9: [
    ['預女獵（標準）', 'werewolf*3 seer witch hunter villager*3', '9 人標準局：無警徽、女巫可自救（87G）', { sheriff: false, witchSelf: 'always' }],
    ['熊局', 'werewolf*3 bear witch hunter villager*3', '以訓熊師取代預言家（87G）', { sheriff: false, witchSelf: 'always' }],
    ['預女白', 'werewolf*3 seer witch idiot villager*3', '以白痴取代獵人（87G）', { sheriff: false, witchSelf: 'always' }],
  ],
  10: [
    ['預女獵（速推）', 'werewolf*3 seer witch hunter villager*4', '10 人標準局：無警徽、女巫可自救（87G）', { sheriff: false, witchSelf: 'always' }],
    ['預女守', 'werewolf*3 seer witch guard villager*4', '守衛取代獵人'],
    ['野孩子', 'werewolf*3 seer witch hunter villager*3 wildchild', '一張民牌換成野孩子（87G 混血兒局的變體）', { sheriff: false }],
    ['炸彈人', 'werewolf*3 seer witch hunter villager*3 bomber', '加入第三方炸彈人，投票要更謹慎', { sheriff: false }],
  ],
  11: [
    ['預女獵白', 'werewolf*4 seer witch hunter idiot villager*3', '有警徽、女巫可自救、屠邊（87G）', { witchSelf: 'always' }],
    ['屠城生推', 'werewolf*3 witch hunter guard villager*5', '沒有預言家，屠城勝利條件（87G）', { win: 'all' }],
    ['預女獵守', 'werewolf*4 seer witch hunter guard villager*3', 'andyventure 建議比例 4/4/3'],
  ],
  12: [
    ['預女獵白（標準）', 'werewolf*4 seer witch hunter idiot villager*4', '最經典的 12 人局，首夜女巫不能自救（87G、口袋狼人殺）', { witchSelf: 'never' }],
    ['白狼王守衛', 'werewolf*3 whitewolf seer witch hunter guard villager*4', '預女獵守，狼方以白狼王平衡（口袋狼人殺）'],
    ['狼王守衛', 'werewolf*3 wolfking seer witch hunter guard villager*4', '狼王＋守衛的常見官方板'],
    ['狼美騎士', 'werewolf*3 wolfbeauty seer witch guard knight villager*4', '官方局：狼美人對上騎士（87G）'],
    ['預女獵丘', 'werewolf*4 seer witch hunter cupid villager*4', '丘比特可能連出人狼戀第三方（口袋狼人殺）'],
    ['盜賊丘比特', 'werewolf*3 seer witch hunter idiot villager*5 thief cupid', '共 14 張牌，盜賊從 2 張底牌中選（87G）'],
    ['石像鬼守墓人', 'werewolf*3 gargoyle seer witch hunter gravekeeper villager*4', '進階：石像鬼獨自查驗，守墓人驗放逐者'],
    ['血月獵魔', 'werewolf*3 bloodmoon seer witch guard demonhunter villager*4', '進階：血月自爆封鎖神職，獵魔人主動獵狼'],
    ['惡靈騎士', 'werewolf*3 darkknight seer witch hunter guard villager*4', '進階：惡靈騎士夜晚不死，還會反傷'],
    ['夢魘攝夢人', 'werewolf*3 nightmare seer witch hunter dreamweaver villager*4', '進階：夢魘恐懼對上攝夢人保護'],
    ['魔術師狼王', 'werewolf*3 wolfking seer witch hunter magician villager*4', '進階：魔術師換號干擾刀口'],
    ['隱狼', 'werewolf*3 hiddenwolf seer witch hunter idiot villager*4', '進階：隱狼查驗為好人'],
    ['占卜老流氓', 'werewolf*4 seer witch hunter fortuneteller villager*3 thug', '進階：占卜師限縮刀口，老流氓吃毒不馬上死'],
  ],
  13: [
    ['預女獵白＋民', 'werewolf*4 seer witch hunter idiot villager*5', '12 人標準局加 1 民（87G）'],
    ['預女獵白守', 'werewolf*4 seer witch hunter idiot guard villager*4', 'andyventure 建議比例 4/4/5 的變體'],
    ['野孩子', 'werewolf*4 seer witch hunter idiot villager*4 wildchild', '12 人標準局加野孩子（87G 混血兒局的變體）'],
  ],
  14: [
    ['禁言長老', 'werewolf*5 seer witch hunter idiot silencer villager*4', '5 狼 5 神 4 民（87G）'],
    ['烏鴉', 'werewolf*5 seer witch hunter idiot raven villager*4', '禁言長老換成烏鴉（87G）'],
    ['白狼王守衛', 'werewolf*4 whitewolf seer witch hunter idiot guard villager*4', '87G 14 人特殊狼變體'],
    ['狼美人守衛', 'werewolf*4 wolfbeauty seer witch hunter idiot guard villager*4', '87G 14 人特殊狼變體'],
    ['盜賊丘比特', 'werewolf*4 seer witch hunter idiot silencer villager*5 thief cupid', '共 16 張牌（87G）'],
  ],
  15: [
    ['標準（禁言長老）', 'werewolf*5 seer witch hunter idiot silencer villager*5', '5 狼 5 神 5 民（87G）'],
    ['白狼王守衛', 'werewolf*4 whitewolf seer witch hunter idiot guard villager*5', '87G 15 人特殊狼變體'],
    ['狼王守衛', 'werewolf*4 wolfking seer witch hunter idiot guard villager*5', '87G 15 人特殊狼變體'],
    ['盜賊丘比特', 'werewolf*4 seer witch hunter idiot silencer villager*6 thief cupid', '共 17 張牌（87G）'],
  ],
  16: [
    ['標準＋野孩子', 'werewolf*5 seer witch hunter idiot silencer villager*5 wildchild', '15 人標準局加 1 張特殊牌（87G）'],
    ['白狼王守衛＋野孩子', 'werewolf*4 whitewolf seer witch hunter idiot guard villager*5 wildchild', '87G 16 人變體'],
    ['夢魘攝夢人', 'werewolf*4 nightmare seer witch hunter guard dreamweaver villager*6', '進階：andyventure 比例 5/5/6'],
  ],
  17: [
    ['標準＋第三方', 'werewolf*5 seer witch hunter idiot silencer villager*5 wildchild bomber', '15 人標準局加特殊牌與第三方（87G）'],
    ['六狼局', 'werewolf*5 wolfking seer witch hunter idiot guard knight villager*5', 'andyventure 建議比例 6/6/5'],
    ['白狼王守衛＋第三方', 'werewolf*4 whitewolf seer witch hunter idiot guard villager*5 wildchild bomber', '87G 17 人變體'],
  ],
  18: [
    ['六六六', 'werewolf*5 whitewolf seer witch hunter idiot guard knight villager*6', 'andyventure 建議比例 6/6/6'],
    ['動物園（改編）', 'werewolf*4 wolfbeauty hiddenwolf seer witch bear raven knight idiot villager*5 wildchild', '參考 87G 18 人動物園局，以現有角色改編'],
    ['全明星', 'werewolf*3 wolfking whitewolf gargoyle seer witch hunter guard magician gravekeeper villager*5 thug', '進階：多種特殊角色同場'],
  ],
};

function presetsFor(n) {
  return (PRESETS[n] || []).map(([name, spec, desc, settings]) => ({ name, counts: parseRoles(spec), desc, settings: settings || {} }));
}

function presetFor(n) {
  const list = presetsFor(n);
  return list.length ? Object.assign({}, list[0].counts) : { werewolf: Math.max(1, Math.round(n / 3)), seer: 1, witch: 1, villager: n - Math.max(1, Math.round(n / 3)) - 2 };
}

function countRoles(c) { return ROLE_ORDER.reduce((s, k) => s + (c[k] || 0), 0); }

// 牌數＝人數，有盜賊時＝人數＋2
function cardsNeeded(n, c) { return n + (c.thief ? 2 : 0); }

function roleSummary(c) {
  return ROLE_ORDER.filter(k => c[k]).map(k => ROLES[k].name + (c[k] > 1 ? '×' + c[k] : '')).join('、');
}
