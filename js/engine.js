'use strict';

/*
 * 遊戲引擎（取代法官）。單機與多機共用同一套流程，差別只在 io 物件：
 *   io.revealRoles()                         發身分
 *   io.narrate(text)                         播報（語音＋畫面）
 *   io.idle()                                角色已死/不存在時的假等待，避免洩漏資訊
 *   io.ask(pid, spec)        -> {btn, sel}   只給某位玩家操作的畫面
 *   io.askAll(pids, fn)      -> {pid: ans}   多位玩家各自操作
 *   io.wolfPick(pids, spec)  -> id|null      狼人共同決定刀口
 *   io.announce(spec)        -> {btn}        公開公告
 *   io.raiseHands(pids, spec)-> [pid]        舉手（上警、退水）
 *   io.vote(voters, cands, spec) -> {voter: target|null}
 *   io.decideVote(cands, spec) -> [pid]      （選用）不記名，直接給出得票最高者；平票回傳多人
 *   io.speech({speaker, seconds, title, specials}) -> {kind:'done'|'explode'|'duel', pid, target}
 *   io.update()                              刷新公開狀態列
 *   io.gameOver(result)
 */

class GameOver { constructor(result) { this.result = result; } }

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const R = p => ROLES[p.role];
const lbl = p => p.seat + '號' + (p.name ? ' ' + p.name : '');
const team = p => p.converted ? 'wolf' : R(p).team;
const isWolf = p => team(p) === 'wolf';
const catOf = p => p.converted ? 'wolf' : R(p).cat;
const wakes = p => isWolf(p) && (p.converted || !!R(p).wake);
const roleName = p => p.converted ? '野孩子（已轉狼）' : p.wasThief ? R(p).name + '（盜賊）' : R(p).name;
const alive = S => S.players.filter(p => p.alive);
const has = (S, role) => (S.roleCounts[role] || 0) > 0;
const findRole = (S, role) => S.players.find(q => q.role === role);
const opt = (p, extra) => Object.assign({ id: p.id, label: p.seat + '號', sub: p.name }, extra || {});
const notesOf = p => [p.mateNote].concat(p.notes).filter(Boolean);
const ok = label => [{ id: 'ok', label: label || '知道了' }];

function createGame(names, roleCounts, settings) {
  const n = names.length;
  let deck = [];
  for (const k of ROLE_ORDER) for (let i = 0; i < (roleCounts[k] || 0); i++) deck.push(k);
  shuffle(deck);
  // 盜賊一定發到玩家手上，剩下兩張是底牌
  if (deck.includes('thief')) {
    deck = deck.filter(r => r !== 'thief');
    deck.splice(Math.floor(Math.random() * n), 0, 'thief');
  }
  const players = names.map((name, i) => ({
    id: i, seat: i + 1, name, role: deck[i], alive: true, canVote: true,
    idiotRevealed: false, lover: null, cause: null, notes: [], mateNote: null,
  }));
  const S = {
    players, settings: Object.assign({}, DEFAULT_SETTINGS, settings), roleCounts, extras: deck.slice(n),
    day: 0, phase: 'setup', sheriff: null, badgeLost: false,
    witch: { antidote: true, poison: true }, lastGuard: null, knightUsed: false,
    third: null, log: [], result: null, pending: [], wolvesMet: false,
    charm: null, lastFear: null, lastSilence: null, lastDream: null, silenced: null, curse: null,
    bloodNight: null, dkUsed: false, ftUsed: false, lastExiled: undefined,
  };
  if (S.extras.length) S.log.push('底牌：' + S.extras.map(r => ROLES[r].name).join('、'));
  recount(S);
  refreshWolfNotes(S);
  return S;
}

function recount(S) {
  S.hadGods = S.players.some(p => catOf(p) === 'god');
  S.hadVillagers = S.players.some(p => catOf(p) === 'villager');
}

function refreshWolfNotes(S) {
  const wakers = S.players.filter(p => wakes(p) && (S.wolvesMet || p.role !== 'nightmare'));
  const list = ps => ps.map(x => lbl(x) + '（' + roleName(x) + '）').join('、');
  for (const p of S.players) {
    if (!isWolf(p)) { p.mateNote = null; continue; }
    if (p.role === 'hiddenwolf') {
      const all = S.players.filter(wakes);
      p.mateNote = all.length ? '狼隊友（他們不知道你是隱狼）：' + list(all) : '場上沒有其他會睜眼的狼人';
    } else if (p.role === 'gargoyle') {
      p.mateNote = '你不認識其他狼人，他們也不認識你。';
    } else if (p.role === 'nightmare' && !S.wolvesMet) {
      p.mateNote = '首夜你先獨自行動，之後狼人睜眼時才會認識狼隊友。';
    } else {
      const m = wakers.filter(x => x !== p);
      p.mateNote = m.length ? '狼隊友：' + list(m) : '你是唯一會睜眼的狼人';
    }
  }
}

// 當晚負責刀人的狼：會睜眼的狼 → 隱狼 → 只剩石像鬼
function killers(S) {
  const al = alive(S);
  const wk = al.filter(wakes);
  if (wk.length) return wk;
  const hw = al.filter(p => isWolf(p) && p.role === 'hiddenwolf');
  if (hw.length) return hw;
  const wolves = al.filter(isWolf);
  if (wolves.length === 1 && wolves[0].role === 'gargoyle') return wolves;
  return [];
}

function publicView(S) {
  return {
    day: S.day, phase: S.phase, sheriff: S.sheriff,
    players: S.players.map(p => ({
      id: p.id, seat: p.seat, name: p.name, alive: p.alive,
      sheriff: S.sheriff === p.id, idiot: p.idiotRevealed, silenced: S.phase === 'day' && S.silenced === p.id,
      role: S.phase === 'over' ? p.role : null,
    })),
  };
}

// 套用死亡並連鎖殉情，回傳本次死亡名單
function applyDeath(S, p, cause) {
  const out = [];
  if (!p.alive) return out;
  p.alive = false; p.cause = cause; p.deathDay = S.day; out.push(p);
  S.log.push(`${lbl(p)}（${roleName(p)}）死亡：${CAUSE[cause]}`);
  if (p.lover != null) {
    const q = S.players[p.lover];
    if (q.alive) {
      q.alive = false; q.cause = 'love'; q.deathDay = S.day; out.push(q);
      S.log.push(`${lbl(q)}（${roleName(q)}）殉情`);
    }
  }
  return out;
}

const CAUSE = {
  wolf: '被狼人殺害', poison: '被女巫毒殺', vote: '被放逐', shot: '被開槍帶走', love: '殉情',
  explode: '自爆', whitewolf: '被白狼王帶走', duel: '決鬥', charm: '被魅惑殉情', reflect: '被惡靈騎士反傷',
  hunt: '獵魔', dream: '夢遊而死', bomb: '被炸彈人炸死', bloodmoon: '被血月使徒帶走',
};

function winner(S, night) {
  const al = alive(S);
  const third = S.third;
  const inThird = p => third && third.has(p.id);
  const thirdAlive = al.some(inThird);
  if (third && al.length && al.every(inThird)) return 'lovers';
  const wolves = al.filter(p => isWolf(p) && !inThird(p));
  const good = al.filter(p => !isWolf(p) && !inThird(p) && team(p) !== 'third');
  const gods = good.filter(p => catOf(p) === 'god').length;
  const vills = good.filter(p => catOf(p) === 'villager').length;
  const wolfCond = S.settings.win === 'side'
    ? (S.hadGods && gods === 0) || (S.hadVillagers && vills === 0) || good.length === 0
    : good.length === 0;
  const wolfWin = !thirdAlive && wolfCond;
  const goodWin = !thirdAlive && wolves.length === 0;
  if (wolfWin && goodWin) return night ? 'wolf' : 'good'; // 夜晚狼人優先（刀先於毒）
  if (wolfWin) return 'wolf';
  if (goodWin) return 'good';
  return null;
}

function checkWin(S, night) {
  const w = winner(S, night);
  if (w) throw new GameOver(w);
}

async function runGame(S, io) {
  try {
    io.update();
    await io.revealRoles();
    for (;;) {
      S.day++;
      const res = await nightPhase(S, io);
      await dayPhase(S, io, res);
    }
  } catch (e) {
    if (!(e instanceof GameOver)) throw e;
    S.phase = 'over'; S.result = e.result;
    io.update();
    await io.gameOver(e.result);
  }
}

/* ───────────── 夜晚 ───────────── */

async function step(S, io, role, open, close, act) {
  if (!has(S, role)) return;
  await io.narrate(open);
  const p = findRole(S, role);
  if (p && p.alive) await act(p); else await io.idle();
  await io.narrate(close);
}

async function nightPhase(S, io) {
  S.phase = 'night'; io.update();
  const N = { fear: null, bind: null, guard: null, swap: null, wolf: null, save: null, poison: null, check: null, silence: null, dream: null, hunt: null, curse: null };
  const bloodNight = S.bloodNight === S.day;
  S.log.push(`── 第 ${S.day} 夜 ──`);

  // 白天中毒／中槍的老流氓在入夜時倒下（隔天早上一起公布）
  const res = S.pending.map(id => ({ id, cause: S.players[id].pendingCause }));
  S.pending = [];

  await io.narrate('天黑請閉眼');
  if (bloodNight) await io.narrate('血月之夜，今晚所有神職都無法使用技能');

  // 被恐懼或血月之夜的神職：照常睜眼，但只能看到提示
  const blocked = p => N.fear === p.id || (bloodNight && catOf(p) === 'god');
  const godStep = (role, open, close, act) => step(S, io, role, open, close, async p => {
    if (blocked(p)) {
      await io.ask(p.id, { night: true, title: `${R(p).icon} ${R(p).name}`, big: N.fear === p.id ? '你被夢魘恐懼了' : '血月之夜',
        text: '今晚無法使用技能。', buttons: ok() });
      return;
    }
    await act(p);
  });
  const pickBtns = (label, skip) => [{ id: 'ok', label, needSel: true }].concat(skip ? [{ id: 'skip', label: skip, style: 'ghost' }] : []);

  await step(S, io, 'nightmare', '夢魘請睜眼，請選擇要恐懼的玩家', '夢魘請閉眼', async p => {
    const mates = S.wolvesMet ? S.players.filter(wakes) : [];
    const a = await io.ask(p.id, {
      night: true, title: '😱 夢魘', text: '被恐懼的玩家今晚無法使用技能；恐懼到狼人則狼隊今晚不能刀人。' +
        (S.lastFear != null ? `\n昨晚恐懼：${S.players[S.lastFear].seat}號（不能連續）` : ''),
      options: alive(S).filter(q => q !== p).map(q => opt(q, { disabled: q.id === S.lastFear || mates.includes(q) })), select: 'one',
      buttons: pickBtns('恐懼', '不恐懼'),
    });
    N.fear = a.btn === 'ok' ? a.sel : null;
    if (N.fear != null) { S.players[N.fear].fearedNight = S.day; S.log.push('夢魘恐懼 ' + lbl(S.players[N.fear])); }
  });
  S.lastFear = N.fear;

  if (!S.ftUsed) await godStep('fortuneteller', '占卜師請睜眼，是否要發動占卜？', '占卜師請閉眼', async p => {
    const a = await io.ask(p.id, {
      night: true, title: '🃏 占卜師', text: '整局限用一次。選一名玩家，他與左右兩側存活玩家共三人被綁定，狼人今晚只能刀這三人之一。',
      options: alive(S).map(q => opt(q)), select: 'one', buttons: pickBtns('綁定', '本晚不使用'),
    });
    if (a.btn !== 'ok') return;
    S.ftUsed = true;
    N.bind = neighbors(S, a.sel).concat([a.sel]);
    S.log.push('占卜師綁定 ' + N.bind.map(id => S.players[id].seat + '號').join('、'));
  });

  if (S.day === 1) await nightOne(S, io, N);

  await godStep('guard', '守衛請睜眼，請選擇今晚要守護的玩家', '守衛請閉眼', async p => {
    const last = S.lastGuard != null ? S.players[S.lastGuard] : null;
    const a = await io.ask(p.id, {
      night: true, title: '🛡️ 守衛',
      text: (last ? `昨晚守護：${lbl(last)}（今晚不能連守）\n` : '') + '選擇今晚守護的玩家（可守自己）',
      options: alive(S).map(q => opt(q, { disabled: q.id === S.lastGuard })), select: 'one',
      buttons: [{ id: 'ok', label: '守護', needSel: true }, { id: 'none', label: '空守', style: 'ghost' }],
    });
    N.guard = a.btn === 'ok' ? a.sel : null;
    S.log.push('守衛守護：' + (N.guard != null ? lbl(S.players[N.guard]) : '空守'));
  });
  S.lastGuard = N.guard;

  await godStep('magician', '魔術師請睜眼，是否要交換兩名玩家的號碼？', '魔術師請閉眼', async p => {
    const a = await io.ask(p.id, {
      night: true, title: '🎩 魔術師', text: '今晚指向其中一人的夜間技能會改落在另一人身上。每人整局只能被交換一次（灰色為已交換過）。',
      options: alive(S).map(q => opt(q, { disabled: q.swapped })), select: 'many', min: 2, max: 2,
      buttons: [{ id: 'ok', label: '交換', needSel: true }, { id: 'skip', label: '今晚不交換', style: 'ghost' }],
    });
    if (a.btn !== 'ok') return;
    N.swap = a.sel.slice();
    N.swap.forEach(id => { S.players[id].swapped = true; });
    S.log.push('魔術師交換 ' + N.swap.map(id => S.players[id].seat + '號').join(' ↔ '));
  });

  await io.narrate('狼人請睜眼，請確認同伴，並選擇今晚要擊殺的對象');
  const ks = killers(S);
  if (ks.length) {
    const feared = N.fear != null && isWolf(S.players[N.fear]);
    const crew = '狼隊：' + ks.map(w => lbl(w) + '（' + roleName(w) + '）').join('、');
    if (feared) {
      await io.wolfPick(ks.map(w => w.id), { night: true, title: '🐺 狼隊被恐懼', big: '今晚無法刀人', text: crew, buttons: [{ id: 'none', label: '知道了' }] });
      S.log.push('狼隊被恐懼，無法刀人');
    } else {
      const inBind = q => !N.bind || N.bind.includes(q.id);
      N.wolf = await io.wolfPick(ks.map(w => w.id), {
        night: true, title: '🐺 狼人請選擇刀口',
        text: crew + (N.bind ? '\n占卜師發動：今晚只能刀 ' + N.bind.map(id => S.players[id].seat + '號').join('、') : ''),
        options: alive(S).map(q => opt(q, { disabled: !inBind(q) || q.role === 'wolfbeauty' })), select: 'one', live: true,
        buttons: [{ id: 'ok', label: '確認擊殺', style: 'danger', needSel: true }, { id: 'none', label: '空刀', style: 'ghost' }],
      });
      S.log.push('狼人刀口：' + (N.wolf != null ? lbl(S.players[N.wolf]) : '空刀'));
    }
  } else await io.idle();
  await io.narrate('狼人請閉眼');
  if (!S.wolvesMet) { S.wolvesMet = true; refreshWolfNotes(S); }

  await step(S, io, 'wolfbeauty', '狼美人請睜眼，請選擇要魅惑的玩家', '狼美人請閉眼', async p => {
    if (N.fear === p.id) { await io.ask(p.id, { night: true, title: '💃 狼美人', big: '你被夢魘恐懼了', text: '今晚無法魅惑。', buttons: ok() }); return; }
    const a = await io.ask(p.id, {
      night: true, title: '💃 狼美人', text: '若你白天被放逐或被獵人帶走，最後被魅惑的玩家會隨你殉情。',
      options: alive(S).filter(q => q !== p).map(q => opt(q)), select: 'one', buttons: pickBtns('魅惑'),
    });
    S.charm = a.sel;
    S.log.push('狼美人魅惑 ' + lbl(S.players[a.sel]));
  });

  if (S.day === 1) await step(S, io, 'hiddenwolf', '隱狼請睜眼，確認你的狼隊友', '隱狼請閉眼', async p => {
    await io.ask(p.id, { night: true, title: '🫥 隱狼', text: p.mateNote + '\n其他狼人全部出局後，你才開始刀人。', buttons: ok() });
  });

  await step(S, io, 'gargoyle', '石像鬼請睜眼，請選擇要查驗的玩家', '石像鬼請閉眼', async p => {
    if (N.fear === p.id) { await io.ask(p.id, { night: true, title: '🗿 石像鬼', big: '你被夢魘恐懼了', text: '今晚無法查驗。', buttons: ok() }); return; }
    const a = await io.ask(p.id, {
      night: true, title: '🗿 石像鬼', text: '查驗一名玩家的確切身分',
      options: alive(S).filter(q => q !== p).map(q => opt(q)), select: 'one', buttons: pickBtns('查驗'),
    });
    const q = S.players[swapped(N, a.sel)];
    p.notes.push(`第${S.day}夜 查驗 ${S.players[a.sel].seat}號：${roleName(q)}`);
    S.log.push(`石像鬼查驗 ${lbl(S.players[a.sel])}：${roleName(q)}`);
    await io.ask(p.id, { night: true, title: '🗿 查驗結果', big: `${S.players[a.sel].seat}號 是 ${roleName(q)}`, buttons: ok() });
  });

  await godStep('witch', '女巫請睜眼', '女巫請閉眼', async p => {
    // 不論藥是否用過，每晚都依序詢問解藥與毒藥，避免從流程長短推測女巫狀態
    let saved = false;
    if (S.witch.antidote) {
      const v = N.wolf != null ? S.players[N.wolf] : null;
      const ws = S.settings.witchSelf;
      const selfBlocked = v && v.id === p.id && !(ws === 'always' || (ws === 'first' && S.day === 1));
      const buttons = [];
      if (v) buttons.push({ id: 'save', label: '使用解藥', disabled: selfBlocked });
      buttons.push({ id: 'skip', label: v ? '不救' : '繼續', style: 'ghost' });
      const a = await io.ask(p.id, {
        night: true, title: '🧪 女巫・解藥',
        big: v ? `今晚被殺的是 ${v.seat}號` : '今晚無人被殺',
        text: v ? (selfBlocked ? '（規則不允許你對自己使用解藥）\n' : '') + '是否使用解藥？' : '狼人沒有刀人。',
        tone: v ? 'bad' : 'good', buttons,
      });
      if (a.btn === 'save') {
        N.save = v.id; S.witch.antidote = false; saved = true;
        S.log.push('女巫使用解藥救 ' + lbl(v));
      }
    } else {
      await io.ask(p.id, {
        night: true, title: '🧪 女巫・解藥', big: '解藥已使用',
        text: '你已經用過解藥，不會得知今晚的刀口。',
        buttons: [{ id: 'save', label: '使用解藥', disabled: true }, { id: 'skip', label: '繼續', style: 'ghost' }],
      });
    }
    const canPoison = S.witch.poison && !saved;
    const a = await io.ask(p.id, {
      night: true, title: '🧪 女巫・毒藥',
      big: !S.witch.poison ? '毒藥已使用' : null,
      text: !S.witch.poison ? '你已經用過毒藥。' : saved ? '今晚已使用解藥，同一晚不能再使用毒藥。' : '是否使用毒藥？',
      options: alive(S).map(q => opt(q, { disabled: !canPoison })), select: 'one',
      buttons: [{ id: 'poison', label: '毒殺', style: 'danger', needSel: true, disabled: !canPoison }, { id: 'skip', label: canPoison ? '不使用' : '繼續', style: 'ghost' }],
    });
    if (canPoison && a.btn === 'poison') {
      N.poison = a.sel; S.witch.poison = false;
      S.log.push('女巫毒殺 ' + lbl(S.players[a.sel]));
    }
  });

  await godStep('seer', '預言家請睜眼，請選擇要查驗的玩家', '預言家請閉眼', async p => {
    const hist = p.notes.filter(n => n.startsWith('第'));
    const a = await io.ask(p.id, {
      night: true, title: '🔮 預言家',
      text: (hist.length ? '查驗紀錄：\n' + hist.join('\n') + '\n\n' : '') + '選擇今晚要查驗的玩家',
      options: alive(S).filter(q => q.id !== p.id).map(q => opt(q)), select: 'one', buttons: pickBtns('查驗'),
    });
    const q = S.players[swapped(N, a.sel)];
    N.check = q.id;
    const bad = isWolf(q) && q.role !== 'hiddenwolf';
    const seat = S.players[a.sel].seat;
    p.notes.push(`第${S.day}夜 查驗 ${seat}號：${bad ? '狼人 🐺' : '好人 👍'}`);
    S.log.push(`預言家查驗 ${lbl(S.players[a.sel])}：${bad ? '狼人' : '好人'}`);
    await io.ask(p.id, { night: true, title: '🔮 查驗結果', big: `${seat}號 是 ${bad ? '狼人 🐺' : '好人 👍'}`, tone: bad ? 'bad' : 'good', buttons: ok() });
  });

  if (S.day >= 2) await godStep('gravekeeper', '守墓人請睜眼', '守墓人請閉眼', async p => {
    const e = S.lastExiled;
    const msg = e == null ? '昨天沒有人被放逐' : `${S.players[e.id].seat}號 是 ${e.wolf ? '狼人 🐺' : '好人 👍'}`;
    if (e) p.notes.push(`第${S.day}夜 守墓：${msg}`);
    await io.ask(p.id, { night: true, title: '⚰️ 守墓人', text: '昨天被放逐的玩家：', big: msg, tone: e ? (e.wolf ? 'bad' : 'good') : '', buttons: ok() });
  });

  await godStep('silencer', '禁言長老請睜眼，請選擇要禁言的玩家', '禁言長老請閉眼', async p => {
    const a = await io.ask(p.id, {
      night: true, title: '🤐 禁言長老', text: '被禁言的玩家明天不能發言。' + (S.lastSilence != null ? `\n昨晚禁言：${S.players[S.lastSilence].seat}號（不能連續）` : ''),
      options: alive(S).map(q => opt(q, { disabled: q.id === S.lastSilence })), select: 'one', buttons: pickBtns('禁言', '不禁言'),
    });
    N.silence = a.btn === 'ok' ? a.sel : null;
  });

  await godStep('dreamweaver', '攝夢人請睜眼，請選擇今晚的夢遊者', '攝夢人請閉眼', async p => {
    const a = await io.ask(p.id, {
      night: true, title: '💤 攝夢人', text: '夢遊者今晚免疫夜間死亡；你死亡則夢遊者一起死；連續兩晚選同一人他會死亡。' +
        (S.lastDream != null ? `\n昨晚夢遊者：${S.players[S.lastDream].seat}號` : ''),
      options: alive(S).filter(q => q !== p).map(q => opt(q)), select: 'one', buttons: pickBtns('選為夢遊者'),
    });
    N.dream = a.sel;
  });

  if (S.day >= 2) await godStep('demonhunter', '獵魔人請睜眼，是否要狩獵？', '獵魔人請閉眼', async p => {
    const a = await io.ask(p.id, {
      night: true, title: '🏹 獵魔人', text: '狩獵到狼人則狼人死亡；狩獵到好人則你死亡。',
      options: alive(S).filter(q => q !== p).map(q => opt(q)), select: 'one', buttons: pickBtns('狩獵', '今晚不狩獵'),
    });
    N.hunt = a.btn === 'ok' ? a.sel : null;
    if (N.hunt != null) S.log.push('獵魔人狩獵 ' + lbl(S.players[N.hunt]));
  });

  await godStep('raven', '烏鴉請睜眼，請選擇要詛咒的玩家', '烏鴉請閉眼', async p => {
    const a = await io.ask(p.id, {
      night: true, title: '🐦‍⬛ 烏鴉', text: '被詛咒的玩家明天放逐投票時多 1 票。',
      options: alive(S).map(q => opt(q)), select: 'one', buttons: pickBtns('詛咒', '不詛咒'),
    });
    N.curse = a.btn === 'ok' ? a.sel : null;
  });

  resolveNight(S, N, res, bloodNight);
  return res;
}

// 首夜才有的行動：盜賊 → 丘比特 → 情侶 → 野孩子
async function nightOne(S, io, N) {
  await step(S, io, 'thief', '盜賊請睜眼，請從兩張底牌中選擇一張', '盜賊請閉眼', async p => {
    const cards = S.extras;
    const bothWolf = cards.every(r => ROLES[r].team === 'wolf');
    const a = await io.ask(p.id, {
      night: true, title: '🦹 盜賊', text: bothWolf ? '兩張底牌都是狼人陣營，你必須選擇其中一張。' : '選一張換成你的身分，或保留盜賊（成為平民）。',
      options: cards.map((r, i) => ({ id: i, label: ROLES[r].icon + ' ' + ROLES[r].name, sub: ROLES[r].team === 'wolf' ? '狼人陣營' : '好人陣營' })),
      select: 'one', buttons: [{ id: 'ok', label: '換成這張', needSel: true }].concat(bothWolf ? [] : [{ id: 'keep', label: '不換（平民）', style: 'ghost' }]),
    });
    const newRole = a.btn === 'ok' ? cards[a.sel] : 'villager';
    if (a.btn === 'ok') S.extras[a.sel] = 'thief';
    p.role = newRole; p.wasThief = true;
    p.notes.push('你是盜賊，換成了「' + ROLES[newRole].name + '」');
    S.log.push(`盜賊 ${lbl(p)} 換成 ${ROLES[newRole].name}`);
    recount(S); refreshWolfNotes(S);
    await io.ask(p.id, { night: true, title: '🦹 你的新身分', roleCard: newRole, text: p.mateNote || '', buttons: ok() });
  });

  await step(S, io, 'cupid', '丘比特請睜眼，請選擇兩名玩家成為情侶', '丘比特請閉眼', async p => {
    const a = await io.ask(p.id, {
      night: true, title: '💘 丘比特', text: '選擇兩名玩家連結為情侶（可包含自己）',
      options: alive(S).map(q => opt(q)), select: 'many', min: 2, max: 2,
      buttons: [{ id: 'ok', label: '確認連結', needSel: true }],
    });
    const [x, y] = a.sel.map(id => S.players[id]);
    x.lover = y.id; y.lover = x.id;
    const mixed = isWolf(x) !== isWolf(y);
    if (mixed) S.third = new Set([x.id, y.id, p.id]);
    p.notes.push(`你連結了 ${lbl(x)} 與 ${lbl(y)} 成為情侶` + (mixed ? '（人狼戀，你們是第三方）' : ''));
    x.notes.push(`你與 ${lbl(y)} 是情侶` + (mixed ? '（人狼戀：你們與丘比特是第三方）' : ''));
    y.notes.push(`你與 ${lbl(x)} 是情侶` + (mixed ? '（人狼戀：你們與丘比特是第三方）' : ''));
    S.log.push(`丘比特連結 ${lbl(x)}、${lbl(y)}` + (mixed ? '（人狼戀）' : ''));
  });
  if (has(S, 'cupid')) {
    await io.narrate('被連結的情侶請睜眼，確認彼此');
    const lovers = S.players.filter(p => p.lover != null);
    if (lovers.length) {
      const third = !!S.third;
      await io.askAll(lovers.map(p => p.id), pid => ({
        night: true, title: '💞 情侶', big: lovers.map(p => p.seat + '號').join(' ❤ '),
        text: `你是情侶之一，伴侶為 ${lbl(S.players[S.players[pid].lover])}。一方死亡，另一方殉情。` +
          (third ? '\n你們是「人狼戀」：與丘比特成為第三方，須成為最後存活者才獲勝。' : '\n你們屬於同一陣營。'),
        buttons: ok(),
      }));
    } else await io.idle();
    await io.narrate('情侶請閉眼');
  }

  await step(S, io, 'wildchild', '野孩子請睜眼，請選擇你的榜樣', '野孩子請閉眼', async p => {
    const a = await io.ask(p.id, {
      night: true, title: '🧒 野孩子', text: '若榜樣被投票放逐，你會轉入狼人陣營。',
      options: alive(S).filter(q => q !== p).map(q => opt(q)), select: 'one', buttons: [{ id: 'ok', label: '選為榜樣', needSel: true }],
    });
    p.model = a.sel;
    p.notes.push(`你的榜樣是 ${lbl(S.players[a.sel])}`);
    S.log.push(`野孩子的榜樣：${lbl(S.players[a.sel])}`);
  });
}

function swapped(N, id) {
  if (id == null || !N.swap) return id;
  return id === N.swap[0] ? N.swap[1] : id === N.swap[1] ? N.swap[0] : id;
}

// 左右兩側最近的存活玩家
function neighbors(S, id) {
  const n = S.players.length, out = [];
  for (const dir of [-1, 1]) {
    for (let i = 1; i < n; i++) {
      const q = S.players[((id + dir * i) % n + n) % n];
      if (q.alive && q.id !== id) { if (!out.includes(q.id)) out.push(q.id); break; }
    }
  }
  return out;
}

function resolveNight(S, N, res, bloodNight) {
  const add = (id, cause) => {
    const e = res.find(r => r.id === id);
    if (!e) res.push({ id, cause });
    else if (cause === 'poison' || cause === 'dream') e.cause = cause;
  };
  const P = id => S.players[id];
  const dream = swapped(N, N.dream);
  const immune = p => p.role === 'darkknight' || p.id === dream;

  const t = swapped(N, N.wolf);
  if (t != null && !immune(P(t))) {
    const g = swapped(N, N.guard) === t, s = swapped(N, N.save) === t;
    const safe = S.settings.guardSave === 'die' ? g !== s : g || s;
    if (!safe) add(t, 'wolf');
    else if (g && s) S.log.push('同守同救，' + lbl(P(t)) + ' 存活');
  }
  const pz = swapped(N, N.poison);
  if (pz != null) {
    const q = P(pz);
    if (q.role === 'darkknight') {
      if (!S.dkUsed) { S.dkUsed = true; add(findRole(S, 'witch').id, 'reflect'); }
    } else if (q.role === 'demonhunter' || q.id === dream) {
      S.log.push(lbl(q) + ' 免疫毒藥');
    } else if (q.role === 'thug') {
      q.pendingCause = 'poison'; S.pending.push(q.id);
      S.log.push('老流氓 ' + lbl(q) + ' 中毒，將在下一次入夜時死亡');
    } else add(pz, 'poison');
  }
  if (N.check != null && P(N.check).role === 'darkknight' && !S.dkUsed) {
    S.dkUsed = true; add(findRole(S, 'seer').id, 'reflect');
  }
  const hn = swapped(N, N.hunt);
  if (hn != null) {
    const q = P(hn);
    if (!isWolf(q)) add(findRole(S, 'demonhunter').id, 'hunt');
    else if (!immune(q)) add(hn, 'hunt');
  }
  if (dream != null) {
    const dw = findRole(S, 'dreamweaver');
    if (S.lastDream === dream || res.some(r => r.id === dw.id)) add(dream, 'dream');
  }
  S.lastDream = dream;

  // 隔天生效的效果
  S.silenced = swapped(N, N.silence);
  S.lastSilence = N.silence;
  S.curse = swapped(N, N.curse);
  if (S.silenced != null) S.log.push('禁言長老禁言 ' + lbl(P(S.silenced)));
  if (S.curse != null) S.log.push('烏鴉詛咒 ' + lbl(P(S.curse)));

  // 被恐懼或血月之夜死亡的獵人／狼王不能開槍
  for (const r of res) {
    const q = P(r.id);
    if (q.fearedNight === S.day || (bloodNight && catOf(q) === 'god')) q.noShoot = true;
  }
}

/* ───────────── 白天 ───────────── */

async function dayPhase(S, io, nightRes) {
  S.phase = 'day'; io.update();
  S.log.push(`── 第 ${S.day} 天 ──`);
  await io.narrate('天亮了');

  let endDay = false;
  if (S.day === 1 && S.settings.sheriff) endDay = await sheriffElection(S, io);

  const dead = [];
  for (const r of nightRes) dead.push(...applyDeath(S, S.players[r.id], r.cause));
  dead.sort((a, b) => a.seat - b.seat);
  io.update();
  const extra = [];
  const bear = findRole(S, 'bear');
  if (bear && bear.alive) {
    const roar = neighbors(S, bear.id).some(id => { const q = S.players[id]; return isWolf(q) && q.role !== 'hiddenwolf'; });
    extra.push(roar ? '🐻 熊咆哮了！' : '🐻 熊很安靜。');
    S.log.push('熊' + (roar ? '咆哮' : '沒有咆哮'));
  }
  if (S.silenced != null && S.players[S.silenced].alive) extra.push(`🤐 ${S.players[S.silenced].seat}號 被禁言，今天不能發言。`);
  await io.announce({
    title: `☀️ 第 ${S.day} 天`,
    big: dead.length ? `昨晚死亡：${dead.map(p => p.seat + '號').join('、')}` : '昨晚是平安夜',
    tone: dead.length ? 'bad' : 'good',
    text: [dead.length ? (S.day === 1 ? '首夜死亡的玩家可以發表遺言。' : '非首夜死亡沒有遺言。') : ''].concat(extra).filter(Boolean).join('\n'),
    buttons: [{ id: 'ok', label: '繼續' }],
  });
  checkWin(S, true);
  await afterDeaths(S, io, dead, S.day === 1);
  if (endDay) return;

  for (const id of await speechOrder(S, io, dead)) {
    const p = S.players[id];
    if (!p.alive) continue;
    const r = await speak(S, io, p, `${lbl(p)} 發言`);
    if (r.kind !== 'done' && await handleSpecial(S, io, r, false)) return;
  }
  await votePhase(S, io);
}

// 一般發言（被禁言者跳過）
async function speak(S, io, p, title, inElection) {
  if (S.silenced === p.id) {
    await io.announce({ title, big: `${p.seat}號 被禁言`, text: '跳過發言。', buttons: [{ id: 'ok', label: '下一位' }] });
    return { kind: 'done' };
  }
  return io.speech({ speaker: p.id, seconds: S.settings.speechSec, title, specials: specials(S, inElection) });
}

function specials(S, inElection) {
  const sp = {};
  const wolves = alive(S).filter(p => isWolf(p) && (p.converted || R(p).explode)).map(p => p.id);
  if (wolves.length) sp.explode = wolves;
  if (!inElection && has(S, 'knight') && !S.knightUsed) {
    const k = alive(S).find(p => p.role === 'knight');
    sp.duel = k ? [k.id] : [];
  }
  return sp;
}

async function speechOrder(S, io, dead) {
  const al = alive(S).map(p => p.id);
  const n = S.players.length;
  const seq = (start, dir) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const id = ((start + dir * i) % n + n) % n;
      if (S.players[id].alive) out.push(id);
    }
    return out;
  };
  if (S.sheriff != null && S.players[S.sheriff].alive) {
    const sh = S.players[S.sheriff];
    const next = seq(sh.id + 1, 1)[0], prev = seq(sh.id - 1, -1)[0];
    const a = await io.ask(sh.id, {
      title: '🎖️ 警長決定發言順序', text: '警長最後發言。',
      buttons: [
        { id: 'inc', label: `從 ${S.players[next].seat}號 開始（順時針）` },
        { id: 'dec', label: `從 ${S.players[prev].seat}號 開始（逆時針）` },
      ],
    });
    const dir = a.btn === 'inc' ? 1 : -1;
    return seq(sh.id + dir, dir).filter(id => id !== sh.id).concat([sh.id]);
  }
  let start;
  if (dead.length) start = dead[0].id + 1;
  else start = al[Math.floor(Math.random() * al.length)];
  const order = seq(start, 1);
  await io.announce({ title: '🗣️ 發言順序', big: `從 ${S.players[order[0]].seat}號 開始`, text: order.map(id => S.players[id].seat).join(' → '), buttons: [{ id: 'ok', label: '開始發言' }] });
  return order;
}

async function afterDeaths(S, io, list, lastWords) {
  for (const p of list) {
    await deathSkill(S, io, p);
    if (S.sheriff === p.id) await passBadge(S, io, p);
    if (lastWords) await io.speech({ speaker: p.id, seconds: S.settings.lastWordSec, title: `${lbl(p)} 遺言` });
  }
}

async function deathSkill(S, io, p) {
  if (p.cause === 'explode') return;
  const shooter = p.role === 'hunter' || p.role === 'wolfking';
  const canShoot = shooter && !['poison', 'love', 'reflect'].includes(p.cause) && !p.noShoot;
  if (!canShoot) {
    const msg = !shooter ? '你沒有可發動的死亡技能。'
      : p.cause === 'poison' ? '你被女巫毒殺，無法開槍。'
      : p.cause === 'love' ? '你因殉情死亡，無法開槍。' : '你今晚的技能被封印，無法開槍。';
    await io.ask(p.id, { private: true, title: '☠️ 死亡技能確認', text: msg, buttons: ok() });
    return;
  }
  const a = await io.ask(p.id, {
    private: true, title: `${R(p).icon} ${R(p).name}・可以開槍`,
    text: '你可以開槍帶走一名玩家（會公開你的身分），也可以選擇不開槍。',
    options: alive(S).map(q => opt(q)), select: 'one',
    buttons: [{ id: 'shoot', label: '開槍', style: 'danger', needSel: true }, { id: 'no', label: '不開槍', style: 'ghost' }],
  });
  if (a.btn !== 'shoot') return;
  const q = S.players[a.sel];
  if (q.role === 'thug') {
    q.pendingCause = 'shot'; if (!S.pending.includes(q.id)) S.pending.push(q.id);
    S.log.push(`${lbl(p)} 開槍打中老流氓 ${lbl(q)}，入夜後死亡`);
    await io.announce({ title: '💥 開槍', big: `${p.seat}號（${R(p).name}）射中了 ${q.seat}號`, text: `${q.seat}號 是老流氓，撐著沒有倒下，將在入夜時死亡。`, buttons: [{ id: 'ok', label: '繼續' }] });
    return;
  }
  const d = applyDeath(S, q, 'shot');
  io.update();
  await io.announce({
    title: '💥 開槍', big: `${p.seat}號（${R(p).name}）帶走了 ${q.seat}號`, tone: 'bad',
    text: d.length > 1 ? `${d[1].seat}號 殉情` : '', buttons: [{ id: 'ok', label: '繼續' }],
  });
  if (q.role === 'wolfbeauty' && p.role === 'hunter') d.push(...await charmDeath(S, io));
  checkWin(S, false);
  await afterDeaths(S, io, d, true);
}

// 狼美人被放逐或被獵人帶走時，被魅惑者殉情
async function charmDeath(S, io) {
  const c = S.charm != null ? S.players[S.charm] : null;
  if (!c || !c.alive || c.role === 'thug') return [];
  const d = applyDeath(S, c, 'charm');
  io.update();
  await io.announce({ title: '💃 狼美人的魅惑', big: `${c.seat}號 被魅惑，隨狼美人殉情`, tone: 'bad', text: d.length > 1 ? `${d[1].seat}號 殉情` : '', buttons: [{ id: 'ok', label: '繼續' }] });
  return d;
}

async function passBadge(S, io, p) {
  const a = await io.ask(p.id, {
    title: '🎖️ 移交警徽', text: '請選擇警徽繼承人，或撕毀警徽。',
    options: alive(S).map(q => opt(q)), select: 'one',
    buttons: [{ id: 'give', label: '移交警徽', needSel: true }, { id: 'tear', label: '撕毀警徽', style: 'danger' }],
  });
  if (a.btn === 'give') S.sheriff = a.sel; else { S.sheriff = null; S.badgeLost = true; }
  io.update();
  await io.announce({
    title: '🎖️ 警徽', big: a.btn === 'give' ? `警徽移交給 ${S.players[a.sel].seat}號` : '警徽被撕毀',
    buttons: [{ id: 'ok', label: '繼續' }],
  });
}

async function handleSpecial(S, io, r, inElection) {
  if (r.kind === 'explode') {
    const p = S.players[r.pid];
    const d = applyDeath(S, p, 'explode');
    if (inElection) S.badgeLost = true;
    const blood = p.role === 'bloodmoon';
    if (blood) S.bloodNight = S.day + 1;
    io.update();
    await io.announce({
      title: '💣 狼人自爆', big: `${p.seat}號 自爆！`, tone: 'bad',
      text: (d.length > 1 ? `${d[1].seat}號 殉情\n` : '') + (inElection ? '警徽流失，' : '') + '白天立即結束。' + (blood ? '\n🌕 血月使徒自爆：今晚所有神職無法使用技能。' : ''),
      buttons: [{ id: 'ok', label: '繼續' }],
    });
    checkWin(S, false);
    if (p.role === 'whitewolf') {
      const a = await io.ask(p.id, {
        title: '🤍 白狼王', text: '選擇要一起帶走的玩家',
        options: alive(S).map(q => opt(q)), select: 'one',
        buttons: [{ id: 'take', label: '帶走', style: 'danger', needSel: true }, { id: 'no', label: '不帶人', style: 'ghost' }],
      });
      if (a.btn === 'take') {
        const q = S.players[a.sel];
        const d2 = applyDeath(S, q, 'whitewolf');
        io.update();
        await io.announce({ title: '🤍 白狼王', big: `${p.seat}號 白狼王帶走了 ${q.seat}號`, tone: 'bad', text: d2.length > 1 ? `${d2[1].seat}號 殉情` : '', buttons: [{ id: 'ok', label: '繼續' }] });
        checkWin(S, false);
        await afterDeaths(S, io, d2, false);
      }
    }
    await afterDeaths(S, io, d, false);
    return true;
  }
  if (r.kind === 'duel') {
    S.knightUsed = true;
    const k = S.players[r.pid], t = S.players[r.target];
    const wolf = isWolf(t);
    const d = applyDeath(S, wolf ? t : k, 'duel');
    io.update();
    await io.announce({
      title: '⚔️ 騎士決鬥', big: wolf ? `${t.seat}號 是狼人！` : `${t.seat}號 是好人`, tone: wolf ? 'good' : 'bad',
      text: (wolf ? `${t.seat}號 死亡，白天立即結束。` : `${k.seat}號 騎士以死謝罪，發言繼續。`) + (d.length > 1 ? `\n${d[1].seat}號 殉情` : ''),
      buttons: [{ id: 'ok', label: '繼續' }],
    });
    checkWin(S, false);
    await afterDeaths(S, io, d, false);
    return wolf;
  }
  return false;
}

async function runVote(S, io, voters, cands, title, useSheriff, curse) {
  // 單機模式：玩家自行舉手協調，裝置上直接選出結果
  if (io.decideVote) {
    const notes = [];
    if (useSheriff && S.sheriff != null && voters.includes(S.sheriff)) notes.push(`警長 ${S.players[S.sheriff].seat}號 算 1.5 票`);
    if (curse != null && cands.includes(curse) && S.players[curse].alive) notes.push(`烏鴉詛咒：${S.players[curse].seat}號 額外 +1 票`);
    const off = alive(S).filter(p => !voters.includes(p.id)).map(p => p.seat + '號');
    if (off.length) notes.push(`不能投票：${off.join('、')}`);
    const top = await io.decideVote(cands, { title, notes });
    S.log.push(`${title}：` + (top.length === 1 ? `${S.players[top[0]].seat}號 得票最高` : top.length ? `${top.map(id => S.players[id].seat).join('、')} 平票` : '無人得票'));
    S.lastVotes = null;
    return top;
  }
  const votes = await io.vote(voters, cands, { title });
  const tally = {}, detail = {}, abstain = [];
  for (const v of voters) {
    const t = votes[v];
    if (t == null) { abstain.push(S.players[v].seat); continue; }
    tally[t] = (tally[t] || 0) + (useSheriff && S.sheriff === v ? 1.5 : 1);
    (detail[t] = detail[t] || []).push(S.players[v].seat + (useSheriff && S.sheriff === v ? '🎖️' : ''));
  }
  if (curse != null && cands.includes(curse) && S.players[curse].alive) {
    tally[curse] = (tally[curse] || 0) + 1;
    (detail[curse] = detail[curse] || []).push('🐦‍⬛烏鴉');
  }
  const max = Math.max(0, ...Object.values(tally));
  const top = max > 0 ? Object.keys(tally).filter(k => tally[k] === max).map(Number) : [];
  const lines = Object.keys(tally).sort((a, b) => tally[b] - tally[a])
    .map(t => `${S.players[t].seat}號：${tally[t]} 票（${detail[t].join('、')}）`);
  if (abstain.length) lines.push(`棄票：${abstain.join('、')}`);
  S.log.push(`${title}：` + (lines.join('；') || '全員棄票'));
  await io.announce({
    title: `🗳️ ${title}結果`,
    big: top.length === 1 ? `${S.players[top[0]].seat}號 得票最高` : top.length > 1 ? `${top.map(id => S.players[id].seat + '號').join('、')} 平票` : '全員棄票',
    text: lines.join('\n'), buttons: [{ id: 'ok', label: '繼續' }],
  });
  S.lastVotes = votes;
  return top;
}

async function sheriffElection(S, io) {
  const pool = alive(S).map(p => p.id);
  const lost = async msg => {
    S.badgeLost = true;
    await io.announce({ title: '🎖️ 警長競選', big: msg, buttons: [{ id: 'ok', label: '繼續' }] });
    return false;
  };
  await io.announce({ title: '🎖️ 警長競選', text: '警長投票時算 1.5 票，並決定發言順序、最後發言。\n警長死亡時可移交或撕毀警徽。', buttons: [{ id: 'ok', label: '開始' }] });
  let cands = await io.raiseHands(pool, { title: '🎖️ 是否上警？', text: '想競選警長的玩家請選「上警」', yes: '上警', no: '不上警' });
  if (!cands.length) return lost('無人上警，警徽流失');
  if (cands.length === pool.length) return lost('全員上警無人可投票，警徽流失');
  const voters = pool.filter(id => !cands.includes(id));

  const start = Math.floor(Math.random() * cands.length);
  const order = cands.slice(start).concat(cands.slice(0, start));
  await io.announce({ title: '🎖️ 候選人', big: cands.map(id => S.players[id].seat + '號').join('、'), text: '發言順序：' + order.map(id => S.players[id].seat).join(' → '), buttons: [{ id: 'ok', label: '開始競選發言' }] });
  for (const id of order) {
    const r = await speak(S, io, S.players[id], `${lbl(S.players[id])} 競選發言`, true);
    if (r.kind !== 'done' && await handleSpecial(S, io, r, true)) return true;
  }
  if (cands.length > 1) {
    const w = await io.raiseHands(cands, { title: '🏳️ 退水', text: '要退出競選的候選人請選「退水」（退水者不能投票）', yes: '退水', no: '繼續競選' });
    cands = cands.filter(id => !w.includes(id));
  }
  if (!cands.length) return lost('候選人全部退水，警徽流失');
  if (cands.length > 1) {
    let top = await runVote(S, io, voters, cands, '警長投票', false);
    if (top.length > 1) {
      await io.announce({ title: '🎖️ 平票 PK', text: '平票候選人再次發言，之後重新投票。', buttons: [{ id: 'ok', label: '繼續' }] });
      for (const id of top) {
        const r = await speak(S, io, S.players[id], `${lbl(S.players[id])} PK 發言`, true);
        if (r.kind !== 'done' && await handleSpecial(S, io, r, true)) return true;
      }
      top = await runVote(S, io, voters, top, '警長 PK 投票', false);
    }
    if (top.length !== 1) return lost(top.length ? '再次平票，警徽流失' : '無人投票，警徽流失');
    cands = top;
  }
  S.sheriff = cands[0];
  io.update();
  await io.announce({ title: '🎖️ 警長誕生', big: `${lbl(S.players[S.sheriff])} 當選警長`, tone: 'good', buttons: [{ id: 'ok', label: '公布昨晚結果' }] });
  return false;
}

async function votePhase(S, io) {
  const voters = () => alive(S).filter(p => p.canVote).map(p => p.id);
  S.lastExiled = null;
  let top = await runVote(S, io, voters(), alive(S).map(p => p.id), '放逐投票', true, S.curse);
  if (top.length > 1) {
    await io.announce({ title: '⚖️ 平票 PK', text: '平票玩家依序 PK 發言，其餘玩家再投票（PK 台上的玩家不能投票）。', buttons: [{ id: 'ok', label: '開始 PK' }] });
    for (const id of top) {
      if (!S.players[id].alive) continue;
      const r = await speak(S, io, S.players[id], `${lbl(S.players[id])} PK 發言`);
      if (r.kind !== 'done' && await handleSpecial(S, io, r, false)) return;
    }
    top = top.filter(id => S.players[id].alive);
    const v = voters().filter(id => !top.includes(id));
    if (top.length > 1) {
      if (!v.length) top = [];
      else top = await runVote(S, io, v, top, 'PK 投票', true);
    }
    if (top.length !== 1) {
      await io.announce({ title: '⚖️ 平安日', big: '再次平票，今天無人出局', buttons: [{ id: 'ok', label: '進入黑夜' }] });
      return;
    }
  }
  if (!top.length) {
    await io.announce({ title: '🗳️ 放逐', big: '今天無人出局', buttons: [{ id: 'ok', label: '進入黑夜' }] });
    return;
  }
  const p = S.players[top[0]];
  S.lastExiled = { id: p.id, wolf: isWolf(p) };
  if (p.role === 'idiot' && !p.idiotRevealed) {
    p.idiotRevealed = true; p.canVote = false;
    S.log.push(`${lbl(p)} 白痴翻牌免死`);
    io.update();
    await io.announce({ title: '🤪 白痴翻牌', big: `${p.seat}號 是白痴！`, text: '免於放逐，但之後失去投票權。', buttons: [{ id: 'ok', label: '進入黑夜' }] });
    return;
  }
  const d = applyDeath(S, p, 'vote');
  io.update();
  await io.announce({ title: '🗳️ 放逐', big: `${p.seat}號 被放逐`, tone: 'bad', text: d.length > 1 ? `${d[1].seat}號 殉情` : '', buttons: [{ id: 'ok', label: '繼續' }] });

  // 野孩子的榜樣被放逐 → 轉為狼人（不公開）
  for (const w of S.players) {
    if (w.role === 'wildchild' && w.alive && !w.converted && w.model === p.id) {
      w.converted = true;
      w.notes.push(`你的榜樣 ${lbl(p)} 被放逐，你已轉入狼人陣營，今晚起與狼人一起行動。`);
      S.log.push(`野孩子 ${lbl(w)} 轉為狼人`);
      recount(S); refreshWolfNotes(S);
    }
  }
  if (p.role === 'wolfbeauty') d.push(...await charmDeath(S, io));
  if (p.role === 'bomber') await detonate(S, io, p);
  if (p.role === 'bloodmoon' && !alive(S).some(isWolf)) d.push(...await bloodMoonLast(S, io, p));
  checkWin(S, false);
  await afterDeaths(S, io, d, true);
}

async function detonate(S, io, p) {
  if (!S.lastVotes) {
    // 沒有記名投票紀錄（單機模式）：由炸彈人點選投他的玩家
    const a = await io.ask(p.id, {
      title: '💣 炸彈人', text: '要引爆嗎？請點選所有投你的玩家，引爆後他們會全部被炸死。',
      options: alive(S).filter(q => q.id !== p.id).map(q => opt(q)), select: 'many', min: 1,
      buttons: [{ id: 'boom', label: '引爆！', style: 'danger', needSel: true }, { id: 'no', label: '不引爆', style: 'ghost' }],
    });
    if (a.btn !== 'boom' || !(a.sel || []).length) return;
    return boom(S, io, a.sel);
  }
  const victims = Object.keys(S.lastVotes || {}).map(Number).filter(v => S.lastVotes[v] === p.id && S.players[v].alive);
  const a = await io.ask(p.id, {
    title: '💣 炸彈人', text: victims.length ? `要引爆嗎？投你的玩家：${victims.map(v => S.players[v].seat + '號').join('、')} 會全部被炸死。` : '沒有人投你，引爆不會炸到任何人。',
    buttons: [{ id: 'boom', label: '引爆！', style: 'danger', disabled: !victims.length }, { id: 'no', label: '不引爆', style: 'ghost' }],
  });
  if (a.btn !== 'boom') return;
  return boom(S, io, victims);
}

async function boom(S, io, victims) {
  const d = [];
  for (const v of victims) d.push(...applyDeath(S, S.players[v], 'bomb'));
  io.update();
  await io.announce({ title: '💣 炸彈人引爆', big: `炸死了 ${d.map(q => q.seat + '號').join('、')}`, tone: 'bad', buttons: [{ id: 'ok', label: '繼續' }] });
  if (!alive(S).length) throw new GameOver('bomber');
  checkWin(S, false);
  await afterDeaths(S, io, d, true);
}

// 血月使徒是最後一匹狼且被放逐：再刀一人，若達成屠邊則狼人勝，否則好人勝
async function bloodMoonLast(S, io, p) {
  await io.announce({ title: '🌕 血月使徒', big: '最後的血月之夜', text: `${p.seat}號 血月使徒是最後一匹狼，他可以再帶走一名玩家。若因此達成屠邊，狼人獲勝；否則好人獲勝。`, buttons: [{ id: 'ok', label: '繼續' }] });
  const a = await io.ask(p.id, {
    title: '🌕 血月使徒', text: '選擇最後要刀的玩家',
    options: alive(S).map(q => opt(q)), select: 'one', buttons: [{ id: 'ok', label: '刀他', style: 'danger', needSel: true }],
  });
  const q = S.players[a.sel];
  const d = applyDeath(S, q, 'bloodmoon');
  io.update();
  await io.announce({ title: '🌕 血月使徒', big: `${q.seat}號 被帶走`, tone: 'bad', text: d.length > 1 ? `${d[1].seat}號 殉情` : '', buttons: [{ id: 'ok', label: '繼續' }] });
  // 結算以夜晚規則（狼優先）；若人狼戀第三方仍存活則遊戲繼續
  checkWin(S, true);
  return d;
}

const RESULT_TEXT = {
  wolf: { title: '🐺 狼人陣營獲勝', tone: 'bad' },
  good: { title: '🌞 好人陣營獲勝', tone: 'good' },
  lovers: { title: '💞 第三方（人狼戀）獲勝', tone: 'love' },
  bomber: { title: '💣 炸彈人獨自獲勝', tone: 'bad' },
};
