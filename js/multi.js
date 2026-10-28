'use strict';

/*
 * 多機模式：一台裝置當主機（持有完整遊戲狀態並執行引擎），其他裝置透過 PeerJS（WebRTC）連線。
 * 每位玩家只會收到屬於自己的畫面（view），看不到別人的身分。
 */

const PEER_PREFIX = 'wwk-tw-';
const PEERJS_URL = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
const QR_URL = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('無法載入 ' + src));
    document.head.append(s);
  });
}

function randomCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join('');
}

function myToken() {
  let t = loadJSON('ww.token', null);
  if (!t) { t = Math.random().toString(36).slice(2) + Date.now().toString(36); saveJSON('ww.token', t); }
  return t;
}

function joinUrl(code) { return location.origin + location.pathname + '?room=' + code; }

/* ───────────── 共用：渲染玩家畫面 ───────────── */

function renderGameView(view, o) {
  // o: { control, onAnswer(id, ans), onLive(id, sel), onAction(act, data), onCtrl(id, ans), stripExtra, finalButtons }
  const frag = h('div');
  const me = view.me;
  const roleBtn = me ? h('button', { class: 'btn ghost tiny', onclick: () => overlay(h('div', null,
    h('div', { class: 'who' }, lbl(me)), roleCardEl(me.role, me.notes),
    me.canVote ? null : h('p', { class: 'hint bad' }, '你已失去投票權'))) }, '🎴 我的身分') : null;
  frag.append(renderStrip(view.pub, h('span', { class: 'tools' }, roleBtn, o.stripExtra || null)));
  document.body.classList.toggle('is-night', view.pub.phase === 'night');

  const main = h('div', { class: 'main' });
  frag.append(main);
  if (me && !me.alive && view.pub.phase !== 'over') main.append(h('div', { class: 'banner' }, '💀 你已出局，請保持安靜，不要透露資訊'));

  if (view.final) {
    main.append(gameOverScreen(view.final, view.final.result, o.finalButtons));
    return frag;
  }
  if (view.prompt) {
    const p = view.prompt;
    main.append(h('div', { class: 'banner priv' }, '🔒 只有你看得到這個畫面'));
    main.append(renderScreen(p, ans => o.onAnswer(p.id, ans), { onSel: p.live ? sel => o.onLive(p.id, sel) : null }));
  } else if (view.screen) {
    const s = Object.assign({}, view.screen);
    if (s.control && !o.control) { s.hideButtons = true; s.waitText = '等待主機按下繼續…'; }
    main.append(renderScreen(s, ans => o.onCtrl(s.id, ans)));
  }
  if (view.actions && view.actions.length && !view.prompt) {
    main.append(h('div', { class: 'btns actions' }, view.actions.map(a => h('button', {
      class: 'btn ' + (a.style || 'primary'),
      onclick: async () => {
        if (a.confirm) {
          const c = await overlayAsk({ title: a.label, text: a.confirm, buttons: [{ id: 'ok', label: '確定', style: 'danger' }, { id: 'cancel', label: '取消', style: 'ghost' }] });
          if (c.btn !== 'ok') return;
          o.onAction(a, null);
        } else if (a.pick) {
          const c = await overlayAsk(Object.assign({ select: 'one', buttons: [{ id: 'ok', label: '確定', style: 'danger', needSel: true }, { id: 'cancel', label: '取消', style: 'ghost' }] }, a.pick));
          if (c.btn !== 'ok') return;
          o.onAction(a, { target: c.sel });
        } else o.onAction(a, null);
      },
    }, a.label))));
  }
  return frag;
}

// 把 view 中的相對時間轉成本機時間
function localizeView(view) {
  if (view.screen && view.screen.timer) view.screen.timer = { endAt: Date.now() + view.screen.timer.remain };
  return view;
}

function viewKey(view) {
  return JSON.stringify(view, (k, v) => k === 'timer' ? !!v : v);
}

/* ───────────── 主機 ───────────── */

let currentHost = null;

function hostSetup() {
  const saved = loadJSON('ww.host', {});
  const app = $app();
  app.innerHTML = '';
  const name = h('input', { value: saved.name || '', placeholder: '你的名字', maxlength: 8 });
  const plays = h('input', { type: 'checkbox', checked: saved.plays !== false });
  const err = h('p', { class: 'hint bad' });
  const go = h('button', { class: 'btn primary wide', onclick: async () => {
    if (plays.checked && !name.value.trim()) { err.textContent = '請輸入名字'; return; }
    saveJSON('ww.host', { name: name.value.trim(), plays: plays.checked });
    go.disabled = true; go.textContent = '建立中…';
    Narrator.unlock();
    try {
      const host = new Host(plays.checked ? name.value.trim() : null);
      await host.open();
      currentHost = host;
      host.drawLobby();
    } catch (e) {
      err.textContent = '建立房間失敗：' + e.message + '（需要網路連線）';
      go.disabled = false; go.textContent = '建立房間';
    }
  } }, '建立房間');
  app.append(h('div', { class: 'page' },
    h('div', { class: 'row between' }, h('h2', null, '📡 建立房間'), h('button', { class: 'btn ghost small', onclick: home }, '返回')),
    h('p', { class: 'hint' }, '此裝置將成為主機：負責執行遊戲、語音播報，並需要一直保持畫面開啟。'),
    h('label', { class: 'nm' }, h('span', null, '名字'), name),
    h('label', { class: 'chk' }, plays, h('span', null, '我也參與遊戲（取消勾選＝此裝置只當公共螢幕／播報器）')),
    err, go));
}

class Host {
  constructor(hostName) {
    this.hostName = hostName;
    this.members = hostName ? [{ token: 'host', name: hostName, conn: null, online: true, local: true }] : [];
    const saved = loadJSON('ww.hostcfg', null);
    this.cfg = saved || { counts: presetFor(9), settings: Object.assign({}, DEFAULT_SETTINGS) };
    this.cfg.settings = Object.assign({}, DEFAULT_SETTINGS, this.cfg.settings);
    this.io = null; this.S = null;
    this.lastKey = null;
  }

  async open() {
    await loadScript(PEERJS_URL);
    for (let tries = 0; tries < 5; tries++) {
      const code = randomCode();
      try {
        await new Promise((res, rej) => {
          const peer = new Peer(PEER_PREFIX + code);
          const t = setTimeout(() => { peer.destroy(); rej(new Error('連線逾時')); }, 15000);
          peer.on('open', () => { clearTimeout(t); this.peer = peer; this.code = code; res(); });
          peer.on('error', e => { clearTimeout(t); if (!this.peer) { peer.destroy(); rej(e); } else console.warn(e); });
        });
        break;
      } catch (e) {
        if (e.type !== 'unavailable-id' || tries === 4) throw e;
      }
    }
    this.peer.on('connection', conn => {
      conn.on('data', m => this.onMsg(conn, m));
      conn.on('close', () => { if (conn.member && conn.member.conn === conn) { conn.member.online = false; this.refresh(); } });
    });
    this.peer.on('disconnected', () => { try { this.peer.reconnect(); } catch (e) { /* ignore */ } });
    window.addEventListener('beforeunload', e => { if (this.S && this.S.phase !== 'over') { e.preventDefault(); e.returnValue = ''; } });
  }

  onMsg(conn, m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') {
      let mem = this.members.find(x => x.token === m.token);
      if (!mem) {
        if (this.S && this.S.phase !== 'over') { conn.send({ t: 'reject', reason: '遊戲已經開始，無法加入' }); return; }
        if (this.members.length >= 18) { conn.send({ t: 'reject', reason: '房間已滿（最多 18 人）' }); return; }
        mem = { token: m.token, name: String(m.name || '').slice(0, 8) || '玩家', conn: null, online: true };
        this.members.push(mem);
      }
      if (mem.conn && mem.conn !== conn) try { mem.conn.close(); } catch (e) { /* ignore */ }
      mem.conn = conn; mem.online = true; conn.member = mem;
      if (!this.S && !mem.local) mem.name = String(m.name || mem.name).slice(0, 8);
      this.refresh(true);
      return;
    }
    const mem = conn.member;
    if (!mem || !this.io) return;
    this.io.handle(this.members.indexOf(mem), m, false);
  }

  // 大廳或遊戲中，把最新狀態送給所有人
  refresh(force) {
    if (this.io) { this.io.push(force); return; }
    if (!this.S) this.drawLobby();
    const lobby = { t: 'lobby', code: this.code, players: this.members.map((x, i) => ({ seat: i + 1, name: x.name, online: x.online })),
      roles: roleSummary(this.cfg.counts), host: this.hostName };
    for (const mem of this.members) if (mem.conn && mem.conn.open) mem.conn.send(lobby);
  }

  drawLobby() {
    const app = $app();
    const state = this.cfg;
    if (state.n !== this.members.length) {
      state.n = this.members.length;
      if (state.n >= 6 && countRoles(state.counts) !== state.n) state.counts = presetFor(state.n);
    }
    const editor = setupEditor(state, () => { saveJSON('ww.hostcfg', this.cfg); start.disabled = !canStart(); this.refresh(); });
    const canStart = () => editor.dataset.ok && this.members.length >= 6;
    const start = h('button', { class: 'btn primary wide', onclick: () => this.startGame() }, '開始遊戲');
    start.disabled = !canStart();
    const qr = h('div', { class: 'qr' });
    const list = h('div', { class: 'members' }, this.members.map((m, i) => h('div', { class: 'mem' + (m.online ? '' : ' off') },
      h('b', null, (i + 1) + '號'), h('span', null, m.name + (m.local ? '（主機）' : '') + (m.online ? '' : '（離線）')),
      h('button', { class: 'step', disabled: i === 0, onclick: () => { this.move(i, -1); } }, '▲'),
      h('button', { class: 'step', disabled: i === this.members.length - 1, onclick: () => { this.move(i, 1); } }, '▼'),
      m.local ? null : h('button', { class: 'step', onclick: () => this.kick(i) }, '✕'))));
    app.replaceChildren(h('div', { class: 'page' },
      h('div', { class: 'row between' }, h('h2', null, '📡 房間大廳'), h('button', { class: 'btn ghost small', onclick: () => { if (confirm('確定關閉房間？')) { this.peer.destroy(); currentHost = null; home(); } } }, '關閉房間')),
      h('div', { class: 'roomcode' }, h('small', null, '房號'), h('b', null, this.code)),
      qr,
      h('p', { class: 'hint' }, '其他人打開本網頁 →「加入房間」輸入房號，或掃描 QR Code。'),
      h('h3', null, `玩家（${this.members.length} 人，請用 ▲▼ 排成實際座位順序）`),
      list,
      this.members.length < 6 ? h('p', { class: 'hint bad' }, '至少需要 6 名玩家') : null,
      editor, start));
    if (location.protocol.startsWith('http')) {
      loadScript(QR_URL).then(() => { try { new QRCode(qr, { text: joinUrl(this.code), width: 150, height: 150 }); } catch (e) { /* ignore */ } }).catch(() => {});
    }
  }

  move(i, d) {
    const a = this.members;
    [a[i], a[i + d]] = [a[i + d], a[i]];
    this.refresh();
  }

  kick(i) {
    const m = this.members[i];
    if (m.conn && m.conn.open) { m.conn.send({ t: 'reject', reason: '你已被主機移出房間' }); setTimeout(() => m.conn.close(), 300); }
    this.members.splice(i, 1);
    this.refresh();
  }

  startGame() {
    selStore.clear();
    this.S = createGame(this.members.map(m => m.name), Object.assign({}, this.cfg.counts), this.cfg.settings);
    this.members.forEach((m, i) => { m.pid = i; });
    Narrator.enabled = this.S.settings.narration;
    document.body.dataset.playing = '1';
    keepAwake();
    this.io = new HostIO(this, this.S);
    runGame(this.S, this.io);
  }

  backToLobby() {
    this.io = null; this.S = null;
    delete document.body.dataset.playing;
    document.body.classList.remove('is-night');
    this.members = this.members.filter(m => m.local || m.online);
    this.refresh();
  }

  localPid() { const i = this.members.findIndex(m => m.local); return i >= 0 ? i : null; }

  renderLocal(view) {
    const io = this.io;
    const online = this.members.filter(m => m.online).length;
    const app = $app();
    const key = viewKey(view) + online;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const pid = this.localPid();
    app.replaceChildren(renderGameView(localizeView(view), {
      control: true,
      stripExtra: h('span', { class: 'conn' }, `房號 ${this.code}・連線 ${online}/${this.members.length}`),
      onAnswer: (id, ans) => io.handle(pid, { t: 'answer', id, ans }, true),
      onLive: (id, sel) => io.handle(pid, { t: 'live', id, sel }, true),
      onAction: (a, data) => io.handle(pid, { t: 'action', id: a.id, ctx: a.ctx, data }, true),
      onCtrl: (id, ans) => io.ctrlAnswer(id, ans),
      finalButtons: [h('button', { class: 'btn primary', onclick: () => this.backToLobby() }, '回到大廳再玩一局')],
    }));
  }
}

class HostIO {
  constructor(host, S) {
    this.host = host; this.S = S;
    this.screen = { title: '準備中' };
    this.prompts = new Map();
    this.speechCtx = null; this.ctrl = null;
    this.seq = 0;
  }

  view(pid, isHost) {
    const S = this.S;
    const p = pid != null ? S.players[pid] : null;
    const screen = Object.assign({}, this.screen);
    if (screen.timer) screen.timer = { remain: screen.timer.endAt - Date.now() };
    const pr = pid != null ? this.prompts.get(pid) : null;
    const v = {
      pub: publicView(S), screen, prompt: pr ? pr.spec : null,
      me: p ? { seat: p.seat, name: p.name, role: p.role, alive: p.alive, notes: p.notes, canVote: p.canVote } : null,
      actions: this.actionsFor(pid, isHost),
    };
    if (S.phase === 'over') v.final = { result: S.result, sheriff: S.sheriff, log: S.log,
      players: S.players.map(q => ({ seat: q.seat, name: q.name, role: q.role, alive: q.alive, cause: q.cause, lover: q.lover, id: q.id })) };
    return v;
  }

  push() {
    const host = this.host;
    host.members.forEach((m, i) => {
      if (m.local) return;
      if (m.conn && m.conn.open) try { m.conn.send({ t: 'view', view: this.view(i, false) }); } catch (e) { /* ignore */ }
    });
    host.renderLocal(this.view(host.localPid(), true));
  }

  update() { this.push(); }

  handle(pid, m, isHost) {
    if (m.t === 'answer') {
      const pr = this.prompts.get(pid);
      if (pr && pr.spec.id === m.id && pr.res) pr.res(m.ans);
    } else if (m.t === 'live') {
      const pr = this.prompts.get(pid);
      if (pr && pr.spec.id === m.id && pr.live) pr.live(m.sel);
    } else if (m.t === 'action') {
      this.onAction(pid, m.id, m.data, m.ctx, isHost);
    }
  }

  ctrlAnswer(id, ans) {
    if (this.ctrl && this.ctrl.id === id) this.ctrl.res(ans);
  }

  setPublic(spec) {
    this.screen = Object.assign({ id: ++this.seq }, spec);
  }

  async narrate(text) {
    const night = this.S.phase === 'night';
    this.setPublic({ night, big: text, waitText: night ? '🌙 夜晚進行中，未被點名的玩家請閉眼' : '' });
    this.push();
    await Narrator.speak(text);
  }

  async idle() { await sleep(5000 + Math.random() * 5000); }

  ask(pid, spec, keepPublic) {
    return new Promise(res => {
      const id = ++this.seq;
      this.prompts.set(pid, { spec: Object.assign({}, spec, { id }), res: a => { this.prompts.delete(pid); this.push(); res(a); } });
      if (!spec.night && !keepPublic) {
        const p = this.S.players[pid];
        this.setPublic({ title: spec.private ? '🔒 私人操作中' : spec.title, text: `等待 ${lbl(p)} 操作…` });
      }
      this.push();
    });
  }

  async askAll(pids, fn, title) {
    const out = {};
    const night = this.S.phase === 'night';
    let done = 0;
    const prog = () => {
      if (night) return;
      this.setPublic({ title: title || '等待玩家操作', big: `${done} / ${pids.length}`, text: '等待所有人完成…' });
    };
    prog();
    await Promise.all(pids.map(pid => this.ask(pid, fn(pid), true).then(a => { out[pid] = a; done++; prog(); this.push(); })));
    return out;
  }

  wolfPick(pids, spec) {
    const S = this.S;
    return new Promise(res => {
      const id = ++this.seq;
      const picks = {}, locked = {};
      const marks = () => {
        const m = {};
        for (const w of pids) if (picks[w] != null) (m[picks[w]] = m[picks[w]] || []).push(S.players[w].seat + '號' + (w in locked ? '✔' : ''));
        return m;
      };
      const refresh = () => {
        const mk = marks();
        for (const w of pids) { const pr = this.prompts.get(w); if (pr) pr.spec.marks = mk; }
        this.push();
      };
      for (const w of pids) {
        this.prompts.set(w, {
          spec: Object.assign({}, spec, { id, marks: {} }),
          live: sel => { picks[w] = sel; refresh(); },
          res: a => {
            locked[w] = a.btn === 'ok' ? a.sel : null;
            picks[w] = locked[w];
            if (pids.every(x => x in locked)) {
              pids.forEach(x => this.prompts.delete(x));
              const cnt = new Map();
              for (const x of pids) cnt.set(locked[x], (cnt.get(locked[x]) || 0) + 1);
              const max = Math.max(...cnt.values());
              const top = [...cnt.keys()].filter(k => cnt.get(k) === max);
              this.push();
              res(top[Math.floor(Math.random() * top.length)]);
              return;
            }
            this.prompts.set(w, { spec: { id: id + '-w' + w, night: true, title: '🐺 已確認', text: '等待其他狼人確認…（若意見不同，以多數決，平手隨機）', options: spec.options.map(o => Object.assign({}, o, { disabled: true })), marks: {} } });
            refresh();
          },
        });
      }
      this.push();
    });
  }

  announce(spec) {
    return new Promise(res => {
      this.setPublic(Object.assign({}, spec, { control: true }));
      const id = this.screen.id;
      this.ctrl = { id, res: a => { this.ctrl = null; res(a); } };
      this.push();
    });
  }

  async raiseHands(pids, spec) {
    const out = await this.askAll(pids, () => ({
      title: spec.title, text: spec.text,
      buttons: [{ id: 'yes', label: spec.yes }, { id: 'no', label: spec.no, style: 'ghost' }],
    }), spec.title);
    return pids.filter(id => out[id].btn === 'yes');
  }

  async vote(voters, cands, spec) {
    const S = this.S;
    const out = await this.askAll(voters, () => ({
      title: '🗳️ ' + spec.title, text: '選擇要投票的對象（結果會公開每個人投給誰）',
      options: cands.map(id => opt(S.players[id])), select: 'one',
      buttons: [{ id: 'ok', label: '投票', needSel: true }, { id: 'abs', label: '棄票', style: 'ghost' }],
    }), '🗳️ ' + spec.title + '中');
    const res = {};
    for (const v of voters) res[v] = out[v].btn === 'ok' ? out[v].sel : null;
    return res;
  }

  speech({ speaker, seconds, title, specials }) {
    return new Promise(res => {
      this.setPublic({ title, who: `🗣️ ${lbl(this.S.players[speaker])}`, timer: { endAt: Date.now() + seconds * 1000 } });
      this.speechCtx = { id: this.screen.id, speaker, specials: specials || {}, res: r => { this.speechCtx = null; res(r); } };
      this.push();
    });
  }

  actionsFor(pid, isHost) {
    const c = this.speechCtx;
    if (!c) return [];
    const S = this.S;
    const acts = [];
    if (pid === c.speaker) acts.push({ id: 'done', label: '結束發言', style: 'primary' });
    else if (isHost) acts.push({ id: 'skip', label: '⏭ 結束此人發言', style: 'ghost' });
    if (pid != null && c.specials.explode && c.specials.explode.includes(pid)) acts.push({ id: 'explode', label: '🐺 自爆', style: 'danger', confirm: '確定要自爆嗎？你會死亡，白天立即結束。' });
    if (pid != null && c.specials.duel && c.specials.duel.includes(pid)) acts.push({ id: 'duel', label: '⚔️ 騎士決鬥', style: 'ghost',
      pick: { title: '⚔️ 選擇決鬥對象', text: '對方是狼人則狼人死亡；是好人則你死亡。', options: alive(S).filter(q => q.id !== pid).map(q => opt(q)) } });
    return acts.map(a => Object.assign(a, { ctx: c.id }));
  }

  onAction(pid, act, data, ctx, isHost) {
    const c = this.speechCtx;
    if (!c || c.id !== ctx) return;
    if (act === 'done' && pid === c.speaker) c.res({ kind: 'done' });
    else if (act === 'skip' && isHost) c.res({ kind: 'done' });
    else if (act === 'explode' && c.specials.explode && c.specials.explode.includes(pid)) c.res({ kind: 'explode', pid });
    else if (act === 'duel' && c.specials.duel && c.specials.duel.includes(pid) && data && this.S.players[data.target] && this.S.players[data.target].alive) c.res({ kind: 'duel', pid, target: data.target });
  }

  async revealRoles() {
    const S = this.S;
    await this.askAll(S.players.map(p => p.id), pid => ({
      title: '🎴 你的身分', roleCard: S.players[pid].role, text: S.players[pid].notes.join('\n'),
      buttons: [{ id: 'ok', label: '我已確認身分' }],
    }), '🎴 等待所有玩家確認身分');
    await this.announce({ title: '✅ 身分確認完畢', text: '之後可隨時點上方「🎴 我的身分」查看。\n主機按下開始後進入第一夜。', buttons: [{ id: 'ok', label: '進入黑夜' }] });
  }

  async gameOver(result) {
    delete document.body.dataset.playing;
    this.prompts.clear();
    this.push();
    Narrator.speak('遊戲結束，' + RESULT_TEXT[result].title.replace(/^\S+\s/, ''));
  }
}

/* ───────────── 玩家（加入房間） ───────────── */

function joinSetup(prefill) {
  const saved = loadJSON('ww.join', {});
  const app = $app();
  const code = h('input', { value: prefill || saved.code || '', placeholder: '4 碼房號', maxlength: 4, class: 'codein', oninput: e => { e.target.value = e.target.value.toUpperCase(); } });
  const name = h('input', { value: saved.name || '', placeholder: '你的名字', maxlength: 8 });
  const err = h('p', { class: 'hint bad' });
  const go = h('button', { class: 'btn primary wide', onclick: async () => {
    const c = code.value.trim().toUpperCase(), n = name.value.trim();
    if (c.length !== 4 || !n) { err.textContent = '請輸入 4 碼房號與名字'; return; }
    saveJSON('ww.join', { code: c, name: n });
    go.disabled = true; go.textContent = '連線中…';
    try {
      const cl = new Client(c, n);
      await cl.connect();
    } catch (e) {
      err.textContent = '連線失敗：' + e.message;
      go.disabled = false; go.textContent = '加入';
    }
  } }, '加入');
  app.replaceChildren(h('div', { class: 'page' },
    h('div', { class: 'row between' }, h('h2', null, '🙋 加入房間'), h('button', { class: 'btn ghost small', onclick: home }, '返回')),
    h('label', { class: 'nm' }, h('span', null, '房號'), code),
    h('label', { class: 'nm' }, h('span', null, '名字'), name),
    err, go));
}

class Client {
  constructor(code, name) {
    this.code = code; this.name = name; this.token = myToken();
    this.lastKey = null; this.view = null; this.closed = false;
  }

  async connect() {
    await loadScript(PEERJS_URL);
    await new Promise((res, rej) => {
      this.peer = new Peer();
      const t = setTimeout(() => rej(new Error('連線逾時')), 15000);
      this.peer.on('open', () => {
        this.openConn(() => { clearTimeout(t); res(); }, e => { clearTimeout(t); rej(e); });
      });
      this.peer.on('error', e => {
        if (e.type === 'peer-unavailable') { clearTimeout(t); if (!this.everConnected) rej(new Error('找不到此房號，請確認主機已建立房間')); else this.retry(); }
        else if (!this.everConnected) { clearTimeout(t); rej(e); }
      });
      this.peer.on('disconnected', () => { if (!this.closed) setTimeout(() => { try { this.peer.reconnect(); } catch (e) { /* ignore */ } }, 1000); });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !this.closed && (!this.conn || !this.conn.open)) this.retry();
    });
  }

  openConn(ok, fail) {
    const conn = this.peer.connect(PEER_PREFIX + this.code, { reliable: true });
    this.conn = conn;
    conn.on('open', () => {
      this.everConnected = true;
      this.setBanner(null);
      conn.send({ t: 'hello', token: this.token, name: this.name });
      if (ok) ok();
    });
    conn.on('data', m => this.onMsg(m));
    conn.on('close', () => { if (!this.closed && conn === this.conn) this.retry(); });
    conn.on('error', e => { if (fail && !this.everConnected) fail(e); });
  }

  retry() {
    if (this.retrying || this.closed) return;
    this.retrying = true;
    this.setBanner('⚠️ 與主機的連線中斷，重新連線中…');
    setTimeout(() => {
      this.retrying = false;
      if (this.closed) return;
      if (this.peer.disconnected) try { this.peer.reconnect(); } catch (e) { /* ignore */ }
      this.openConn(null, null);
      setTimeout(() => { if (!this.conn.open) this.retry(); }, 4000);
    }, 1500);
  }

  setBanner(text) {
    let b = document.getElementById('netbanner');
    if (!text) { if (b) b.remove(); return; }
    if (!b) { b = h('div', { id: 'netbanner', class: 'netbanner' }); document.body.append(b); }
    b.textContent = text;
  }

  onMsg(m) {
    if (!m || typeof m !== 'object') return;
    const app = $app();
    if (m.t === 'reject') {
      this.closed = true;
      try { this.peer.destroy(); } catch (e) { /* ignore */ }
      app.replaceChildren(h('div', { class: 'page' }, h('h2', null, '無法加入'), h('p', null, m.reason), h('button', { class: 'btn primary', onclick: home }, '回首頁')));
      return;
    }
    if (m.t === 'lobby') {
      this.lastKey = null;
      delete document.body.dataset.playing;
      document.body.classList.remove('is-night');
      const me = m.players.find(p => p.name === this.name);
      app.replaceChildren(h('div', { class: 'page' },
        h('h2', null, '🛋️ 等待開始'),
        h('div', { class: 'roomcode' }, h('small', null, '房號'), h('b', null, m.code)),
        h('p', { class: 'hint' }, '主機會依實際座位排序，請確認你的號碼與座位相符。'),
        h('div', { class: 'members' }, m.players.map(p => h('div', { class: 'mem' + (p.online ? '' : ' off') + (me && p.seat === me.seat ? ' me' : '') },
          h('b', null, p.seat + '號'), h('span', null, p.name)))),
        h('p', { class: 'hint' }, '本局角色：' + m.roles),
        h('button', { class: 'btn ghost', onclick: () => { this.closed = true; try { this.peer.destroy(); } catch (e) { /* ignore */ } home(); } }, '離開房間')));
      return;
    }
    if (m.t === 'view') {
      const key = viewKey(m.view);
      if (key === this.lastKey) return;
      this.lastKey = key;
      if (!document.body.dataset.playing) { document.body.dataset.playing = '1'; keepAwake(); }
      const send = o => { if (this.conn && this.conn.open) this.conn.send(o); };
      app.replaceChildren(renderGameView(localizeView(m.view), {
        control: false,
        onAnswer: (id, ans) => send({ t: 'answer', id, ans }),
        onLive: (id, sel) => send({ t: 'live', id, sel }),
        onAction: (a, data) => send({ t: 'action', id: a.id, ctx: a.ctx, data }),
        onCtrl: () => {},
        finalButtons: [h('button', { class: 'btn ghost', onclick: () => { this.closed = true; try { this.peer.destroy(); } catch (e) { /* ignore */ } home(); } }, '離開')],
      }));
    }
  }
}
