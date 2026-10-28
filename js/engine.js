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
const isWolf = p => R(p).team === 'wolf';
const alive = S => S.players.filter(p => p.alive);
const has = (S, role) => (S.roleCounts[role] || 0) > 0;
const opt = (p, extra) => Object.assign({ id: p.id, label: p.seat + '號', sub: p.name }, extra || {});

function createGame(names, roleCounts, settings) {
  const roles = [];
  for (const k of ROLE_ORDER) for (let i = 0; i < (roleCounts[k] || 0); i++) roles.push(k);
  shuffle(roles);
  const players = names.map((name, i) => ({
    id: i, seat: i + 1, name, role: roles[i], alive: true, canVote: true,
    idiotRevealed: false, lover: null, cause: null, notes: [],
  }));
  const S = {
    players, settings: Object.assign({}, DEFAULT_SETTINGS, settings), roleCounts,
    day: 0, phase: 'setup', sheriff: null, badgeLost: false,
    witch: { antidote: true, poison: true }, lastGuard: null, knightUsed: false,
    third: null, log: [], result: null,
    hadGods: players.some(p => R(p).cat === 'god'),
    hadVillagers: players.some(p => R(p).cat === 'villager'),
  };
  const wolves = players.filter(isWolf);
  for (const w of wolves) {
    const mates = wolves.filter(x => x !== w);
    w.notes.push(mates.length ? '狼隊友：' + mates.map(x => lbl(x) + '（' + R(x).name + '）').join('、') : '你是唯一的狼人');
  }
  return S;
}

function publicView(S) {
  return {
    day: S.day, phase: S.phase, sheriff: S.sheriff,
    players: S.players.map(p => ({
      id: p.id, seat: p.seat, name: p.name, alive: p.alive,
      sheriff: S.sheriff === p.id, idiot: p.idiotRevealed,
      role: S.phase === 'over' ? p.role : null,
    })),
  };
}

// 套用死亡並連鎖殉情，回傳本次死亡名單
function applyDeath(S, p, cause) {
  const out = [];
  if (!p.alive) return out;
  p.alive = false; p.cause = cause; p.deathDay = S.day; out.push(p);
  S.log.push(`${lbl(p)}（${R(p).name}）死亡：${CAUSE[cause]}`);
  if (p.lover != null) {
    const q = S.players[p.lover];
    if (q.alive) {
      q.alive = false; q.cause = 'love'; q.deathDay = S.day; out.push(q);
      S.log.push(`${lbl(q)}（${R(q).name}）殉情`);
    }
  }
  return out;
}

const CAUSE = { wolf: '被狼人殺害', poison: '被女巫毒殺', vote: '被放逐', shot: '被開槍帶走', love: '殉情',
  explode: '自爆', whitewolf: '被白狼王帶走', duel: '決鬥' };

function winner(S, night) {
  const al = alive(S);
  const third = S.third;
  const inThird = p => third && third.has(p.id);
  const thirdAlive = al.some(inThird);
  if (third && al.length && al.every(inThird)) return 'lovers';
  const wolves = al.filter(p => isWolf(p) && !inThird(p));
  const good = al.filter(p => !isWolf(p) && !inThird(p));
  const gods = good.filter(p => R(p).cat === 'god').length;
  const vills = good.filter(p => R(p).cat === 'villager').length;
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
  const p = S.players.find(q => q.role === role);
  if (p && p.alive) await act(p); else await io.idle();
  await io.narrate(close);
}

async function nightPhase(S, io) {
  S.phase = 'night'; io.update();
  const N = { guard: null, wolf: null, save: null, poison: null };
  S.log.push(`── 第 ${S.day} 夜 ──`);
  await io.narrate('天黑請閉眼');

  if (S.day === 1) {
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
      const third = !!S.third;
      await io.askAll(lovers.map(p => p.id), pid => ({
        night: true, title: '💞 情侶',
        big: `${lovers.map(p => p.seat + '號').join(' ❤ ')}`,
        text: `你是情侶之一，伴侶為 ${lbl(S.players[S.players[pid].lover])}。一方死亡，另一方殉情。` +
          (third ? '\n你們是「人狼戀」：與丘比特成為第三方，須成為最後存活者才獲勝。' : '\n你們屬於同一陣營。'),
        buttons: [{ id: 'ok', label: '知道了' }],
      }));
      await io.narrate('情侶請閉眼');
    }
  }

  await step(S, io, 'guard', '守衛請睜眼，請選擇今晚要守護的玩家', '守衛請閉眼', async p => {
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

  await io.narrate('狼人請睜眼，請確認同伴，並選擇今晚要擊殺的對象');
  const wolves = alive(S).filter(isWolf);
  if (wolves.length) {
    N.wolf = await io.wolfPick(wolves.map(w => w.id), {
      night: true, title: '🐺 狼人請選擇刀口',
      text: '狼人陣營：' + S.players.filter(isWolf).map(w => lbl(w) + (w.alive ? '' : '（已死）')).join('、'),
      options: alive(S).map(q => opt(q)), select: 'one', live: true,
      buttons: [{ id: 'ok', label: '確認擊殺', style: 'danger', needSel: true }, { id: 'none', label: '空刀', style: 'ghost' }],
    });
    S.log.push('狼人刀口：' + (N.wolf != null ? lbl(S.players[N.wolf]) : '空刀'));
  } else await io.idle();
  await io.narrate('狼人請閉眼');

  await step(S, io, 'witch', '女巫請睜眼', '女巫請閉眼', async p => {
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
        text: v ? (selfBlocked ? '（規則不允許你對自己使用解藥）\n' : '') + '是否使用解藥？' : '狼人選擇了空刀。',
        tone: v ? 'bad' : 'good', buttons,
      });
      if (a.btn === 'save') {
        N.save = v.id; S.witch.antidote = false; saved = true;
        S.log.push('女巫使用解藥救 ' + lbl(v));
      }
    }
    if (saved) return;
    if (S.witch.poison) {
      const a = await io.ask(p.id, {
        night: true, title: '🧪 女巫・毒藥',
        text: (S.witch.antidote ? '' : '解藥已用完，你不會得知今晚的刀口。\n') + '是否使用毒藥？',
        options: alive(S).map(q => opt(q)), select: 'one',
        buttons: [{ id: 'poison', label: '毒殺', style: 'danger', needSel: true }, { id: 'skip', label: '不使用', style: 'ghost' }],
      });
      if (a.btn === 'poison') {
        N.poison = a.sel; S.witch.poison = false;
        S.log.push('女巫毒殺 ' + lbl(S.players[a.sel]));
      }
    } else {
      await io.ask(p.id, { night: true, title: '🧪 女巫', text: '你的解藥與毒藥都已用完。', buttons: [{ id: 'ok', label: '知道了' }] });
    }
  });

  await step(S, io, 'seer', '預言家請睜眼，請選擇要查驗的玩家', '預言家請閉眼', async p => {
    const hist = p.notes.filter(n => n.startsWith('第'));
    const a = await io.ask(p.id, {
      night: true, title: '🔮 預言家',
      text: (hist.length ? '查驗紀錄：\n' + hist.join('\n') + '\n\n' : '') + '選擇今晚要查驗的玩家',
      options: alive(S).filter(q => q.id !== p.id).map(q => opt(q)), select: 'one',
      buttons: [{ id: 'ok', label: '查驗', needSel: true }],
    });
    const q = S.players[a.sel];
    const bad = isWolf(q);
    p.notes.push(`第${S.day}夜 查驗 ${lbl(q)}：${bad ? '狼人 🐺' : '好人 👍'}`);
    S.log.push(`預言家查驗 ${lbl(q)}：${bad ? '狼人' : '好人'}`);
    await io.ask(p.id, {
      night: true, title: '🔮 查驗結果', big: `${q.seat}號 是 ${bad ? '狼人 🐺' : '好人 👍'}`,
      tone: bad ? 'bad' : 'good', buttons: [{ id: 'ok', label: '知道了' }],
    });
  });

  // 結算
  const res = [];
  if (N.wolf != null) {
    const g = N.guard === N.wolf, s = N.save === N.wolf;
    const safe = S.settings.guardSave === 'die' ? g !== s : g || s;
    if (!safe) res.push({ id: N.wolf, cause: 'wolf' });
    else if (g && s) S.log.push('同守同救，' + lbl(S.players[N.wolf]) + ' 存活');
  }
  if (N.poison != null) {
    const e = res.find(r => r.id === N.poison);
    if (e) e.cause = 'poison'; else res.push({ id: N.poison, cause: 'poison' });
  }
  return res;
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
  await io.announce({
    title: `☀️ 第 ${S.day} 天`,
    big: dead.length ? `昨晚死亡：${dead.map(p => p.seat + '號').join('、')}` : '昨晚是平安夜',
    tone: dead.length ? 'bad' : 'good',
    text: dead.length ? (S.day === 1 ? '首夜死亡的玩家可以發表遺言。' : '非首夜死亡沒有遺言。') : '',
    buttons: [{ id: 'ok', label: '繼續' }],
  });
  checkWin(S, true);
  await afterDeaths(S, io, dead, S.day === 1);
  if (endDay) return;

  for (const id of await speechOrder(S, io, dead)) {
    const p = S.players[id];
    if (!p.alive) continue;
    const r = await io.speech({ speaker: id, seconds: S.settings.speechSec, title: `${lbl(p)} 發言`, specials: specials(S, false) });
    if (r.kind !== 'done' && await handleSpecial(S, io, r, false)) return;
  }
  await votePhase(S, io);
}

function specials(S, inElection) {
  const sp = {};
  const wolves = alive(S).filter(isWolf).map(p => p.id);
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
  const canShoot = shooter && !['poison', 'love'].includes(p.cause);
  if (!canShoot) {
    const msg = !shooter ? '你沒有可發動的死亡技能。'
      : p.cause === 'poison' ? '你被女巫毒殺，無法開槍。' : '你因殉情死亡，無法開槍。';
    await io.ask(p.id, { private: true, title: '☠️ 死亡技能確認', text: msg, buttons: [{ id: 'ok', label: '知道了' }] });
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
  const d = applyDeath(S, q, 'shot');
  io.update();
  await io.announce({
    title: '💥 開槍', big: `${p.seat}號（${R(p).name}）帶走了 ${q.seat}號`, tone: 'bad',
    text: d.length > 1 ? `${d[1].seat}號 殉情` : '', buttons: [{ id: 'ok', label: '繼續' }],
  });
  checkWin(S, false);
  await afterDeaths(S, io, d, true);
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
    io.update();
    await io.announce({
      title: '💣 狼人自爆', big: `${p.seat}號 自爆！`, tone: 'bad',
      text: (d.length > 1 ? `${d[1].seat}號 殉情\n` : '') + (inElection ? '警徽流失，' : '') + '白天立即結束。',
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

async function runVote(S, io, voters, cands, title, useSheriff) {
  const votes = await io.vote(voters, cands, { title });
  const tally = {}, detail = {}, abstain = [];
  for (const v of voters) {
    const t = votes[v];
    if (t == null) { abstain.push(S.players[v].seat); continue; }
    tally[t] = (tally[t] || 0) + (useSheriff && S.sheriff === v ? 1.5 : 1);
    (detail[t] = detail[t] || []).push(S.players[v].seat + (useSheriff && S.sheriff === v ? '🎖️' : ''));
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
    const r = await io.speech({ speaker: id, seconds: S.settings.speechSec, title: `${lbl(S.players[id])} 競選發言`, specials: specials(S, true) });
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
        const r = await io.speech({ speaker: id, seconds: S.settings.speechSec, title: `${lbl(S.players[id])} PK 發言`, specials: specials(S, true) });
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
  let top = await runVote(S, io, voters(), alive(S).map(p => p.id), '放逐投票', true);
  if (top.length > 1) {
    await io.announce({ title: '⚖️ 平票 PK', text: '平票玩家依序 PK 發言，其餘玩家再投票（PK 台上的玩家不能投票）。', buttons: [{ id: 'ok', label: '開始 PK' }] });
    for (const id of top) {
      if (!S.players[id].alive) continue;
      const r = await io.speech({ speaker: id, seconds: S.settings.speechSec, title: `${lbl(S.players[id])} PK 發言`, specials: specials(S, false) });
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
  checkWin(S, false);
  await afterDeaths(S, io, d, true);
}

const RESULT_TEXT = {
  wolf: { title: '🐺 狼人陣營獲勝', tone: 'bad' },
  good: { title: '🌞 好人陣營獲勝', tone: 'good' },
  lovers: { title: '💞 第三方（人狼戀）獲勝', tone: 'love' },
};
