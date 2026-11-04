'use strict';

/*
 * 戰績系統：存在 Firebase Realtime Database（REST API，不需要額外函式庫）。
 * 只有多機模式的主機會在遊戲結束時寫入；任何人都能在首頁瀏覽。
 *
 *   players/<帳號> = { acc, name, games, wins, wolf:{g,w}, good:{g,w}, third:{g,w}, recent:[…], updated }
 */

const STATS_DB = 'https://werewolf-stats-default-rtdb.asia-southeast1.firebasedatabase.app';
const RECENT_MAX = 20;

const Stats = {
  get enabled() { return !!STATS_DB; },

  // 帳號只允許英文字母與數字，不分大小寫
  normAcc(s) { return String(s || '').trim().toLowerCase(); },
  validAcc(s) { return /^[a-z0-9]{1,20}$/.test(s); },

  url(path) { return STATS_DB.replace(/\/$/, '') + '/' + path + '.json'; },

  async req(path, opt) {
    const r = await fetch(this.url(path), opt);
    if (!r.ok && r.status !== 412) throw new Error('戰績資料庫錯誤（' + r.status + '）');
    return r;
  },

  async get(acc) {
    const r = await this.req('players/' + acc);
    return r.json();
  },

  async list() {
    const r = await this.req('players');
    const all = await r.json();
    return all ? Object.values(all) : [];
  },

  // 一局結束後每位有帳號的玩家各算一筆
  entriesFor(S, accs) {
    const third = S.third || new Set();
    return S.players.map((p, i) => {
      const acc = accs[i];
      if (!acc) return null;
      const side = third.has(p.id) || team(p) === 'third' ? 'third' : isWolf(p) ? 'wolf' : 'good';
      const win = S.result === 'lovers' ? third.has(p.id)
        : S.result === 'bomber' ? p.role === 'bomber'
        : side === S.result;
      return { acc, name: p.name, role: p.role, roleName: roleName(p), side, win, result: S.result, alive: p.alive, n: S.players.length, ts: Date.now() };
    }).filter(Boolean);
  },

  // 用 ETag 做條件寫入，避免同時寫入時互相覆蓋
  async addGame(e) {
    for (let tries = 0; tries < 4; tries++) {
      const r = await this.req('players/' + e.acc, { headers: { 'X-Firebase-ETag': 'true' } });
      const etag = r.headers.get('ETag');
      const d = (await r.json()) || { acc: e.acc, games: 0, wins: 0, wolf: { g: 0, w: 0 }, good: { g: 0, w: 0 }, third: { g: 0, w: 0 }, recent: [] };
      d.name = e.name;
      d.games++; if (e.win) d.wins++;
      d[e.side] = d[e.side] || { g: 0, w: 0 };
      d[e.side].g++; if (e.win) d[e.side].w++;
      d.recent = [{ ts: e.ts, name: e.name, role: e.role, roleName: e.roleName, side: e.side, win: e.win, result: e.result, alive: e.alive, n: e.n }]
        .concat(d.recent || []).slice(0, RECENT_MAX);
      d.updated = e.ts;
      const w = await this.req('players/' + e.acc, { method: 'PUT', headers: etag ? { 'if-match': etag } : {}, body: JSON.stringify(d) });
      if (w.status !== 412) return;
    }
    throw new Error('戰績寫入衝突，請稍後再試');
  },

  async record(S, accs) {
    if (!this.enabled) return { ok: 0, fail: 0 };
    let ok = 0, fail = 0;
    for (const e of this.entriesFor(S, accs)) {
      try { await this.addGame(e); ok++; } catch (err) { console.warn(err); fail++; }
    }
    return { ok, fail };
  },
};

const pct = (w, g) => g ? Math.round(w / g * 100) + '%' : '—';
const SIDE_NAME = { wolf: '狼人', good: '好人', third: '第三方' };

/* ───────────── 戰績頁 ───────────── */

async function statsPage() {
  const app = $app();
  const back = h('button', { class: 'btn ghost small', onclick: home }, '返回');
  const body = h('div', { class: 'stats' }, h('p', { class: 'hint' }, '讀取中…'));
  app.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'row between' }, h('h2', null, '📊 戰績'), back), body));
  if (!Stats.enabled) { body.replaceChildren(h('p', { class: 'hint bad' }, '戰績資料庫尚未設定。')); return; }
  let list;
  try { list = await Stats.list(); } catch (e) { body.replaceChildren(h('p', { class: 'hint bad' }, '無法讀取戰績：' + e.message)); return; }
  const search = h('input', { placeholder: '搜尋帳號或暱稱', oninput: () => draw() });
  const sort = h('select', { onchange: () => draw() },
    [['games', '依總局數'], ['wins', '依勝局數'], ['rate', '依勝率'], ['updated', '依最近遊玩']].map(([v, t]) => h('option', { value: v }, t)));
  const table = h('div', { class: 'stlist' });
  const key = {
    games: d => d.games, wins: d => d.wins, updated: d => d.updated || 0,
    rate: d => d.games ? d.wins / d.games + d.games * 1e-6 : -1,
  };
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const rows = list.filter(d => !q || d.acc.includes(q) || String(d.name || '').toLowerCase().includes(q))
      .sort((a, b) => key[sort.value](b) - key[sort.value](a));
    table.replaceChildren(...(rows.length ? rows.map(d => h('button', { class: 'strow', onclick: () => statsDetail(d) },
      h('div', { class: 'stname' }, h('b', null, d.name || d.acc), h('small', null, '@' + d.acc)),
      h('div', { class: 'stnums' },
        h('span', null, h('b', null, d.games), h('small', null, '局')),
        h('span', null, h('b', null, pct(d.wins, d.games)), h('small', null, '勝率')),
        h('span', { class: 'wolf' }, h('b', null, pct(d.wolf && d.wolf.w, d.wolf && d.wolf.g)), h('small', null, '狼')),
        h('span', { class: 'good' }, h('b', null, pct(d.good && d.good.w, d.good && d.good.g)), h('small', null, '好人')))))
      : [h('p', { class: 'hint' }, list.length ? '找不到符合的玩家' : '還沒有任何戰績。多機模式加入房間時輸入帳號，遊戲結束後就會記錄。')]));
  };
  body.replaceChildren(h('div', { class: 'row' }, search, sort), table);
  draw();
}

function statsDetail(d) {
  const app = $app();
  const side = k => { const s = d[k] || { g: 0, w: 0 }; return h('div', { class: 'stat ' + k }, h('small', null, SIDE_NAME[k] + '陣營'), h('b', null, pct(s.w, s.g)), h('small', null, `${s.w} 勝 / ${s.g} 局`)); };
  const fmt = ts => { const t = new Date(ts); return `${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; };
  app.replaceChildren(h('div', { class: 'page' },
    h('div', { class: 'row between' }, h('h2', null, (d.name || d.acc)), h('button', { class: 'btn ghost small', onclick: statsPage }, '返回')),
    h('p', { class: 'hint' }, '帳號 @' + d.acc),
    h('div', { class: 'stgrid' },
      h('div', { class: 'stat' }, h('small', null, '總局數'), h('b', null, d.games)),
      h('div', { class: 'stat' }, h('small', null, '勝局數'), h('b', null, d.wins)),
      h('div', { class: 'stat' }, h('small', null, '總勝率'), h('b', null, pct(d.wins, d.games))),
      side('wolf'), side('good'), (d.third && d.third.g) ? side('third') : null),
    h('h3', null, `最近戰績（最多 ${RECENT_MAX} 局）`),
    h('div', { class: 'recent' }, (d.recent || []).map(r => h('div', { class: 'rec ' + (r.win ? 'win' : 'lose') },
      h('b', null, r.win ? '勝' : '敗'),
      h('span', null, (ROLES[r.role] ? ROLES[r.role].icon + ' ' : '') + (r.roleName || r.role), h('small', null, `${SIDE_NAME[r.side] || ''}・${r.n} 人局・${r.alive ? '存活' : '陣亡'}・暱稱 ${r.name}`)),
      h('small', null, fmt(r.ts)))))));
}
