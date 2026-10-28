'use strict';

/* 單機模式：一台裝置放在桌子中央，語音播報＋輪流操作 */

function singleSetup() {
  const saved = loadJSON('ww.single', null);
  const state = saved || { n: 9, names: [], counts: presetFor(9), settings: Object.assign({}, DEFAULT_SETTINGS) };
  state.settings = Object.assign({}, DEFAULT_SETTINGS, state.settings);
  const app = $app();

  const draw = () => {
    app.innerHTML = '';
    while (state.names.length < state.n) state.names.push('');
    state.names.length = state.n;
    const save = () => saveJSON('ww.single', state);
    const editor = setupEditor(state, () => { save(); startBtn.disabled = !editor.dataset.ok; });
    const startBtn = h('button', { class: 'btn primary wide', onclick: () => {
      save();
      Narrator.unlock();
      const names = state.names.map(s => s.trim());
      startSingle(createGame(names, Object.assign({}, state.counts), state.settings));
    } }, '開始遊戲');
    startBtn.disabled = !editor.dataset.ok;

    app.append(h('div', { class: 'page' },
      h('div', { class: 'row between' }, h('h2', null, '📱 單機模式'), h('button', { class: 'btn ghost small', onclick: home }, '返回')),
      h('p', { class: 'hint' }, '一台裝置放在大家中間，由語音主持。請依實際座位順序（順時針）填寫玩家。'),
      h('div', { class: 'row' }, h('h3', null, '玩家人數'),
        h('button', { class: 'step', disabled: state.n <= 6, onclick: () => { state.n--; state.counts = presetFor(state.n); save(); draw(); } }, '−'),
        h('b', { class: 'rc big-n' }, state.n),
        h('button', { class: 'step', disabled: state.n >= 18, onclick: () => { state.n++; state.counts = presetFor(state.n); save(); draw(); } }, '+')),
      h('div', { class: 'names' }, state.names.map((nm, i) => h('label', { class: 'nm' }, h('span', null, (i + 1) + '號'),
        h('input', { value: nm, placeholder: '名字（可留空）', maxlength: 8, oninput: e => { state.names[i] = e.target.value; save(); } })))),
      editor, startBtn));
  };
  draw();
}

function startSingle(S) {
  Narrator.enabled = S.settings.narration;
  document.body.dataset.playing = '1';
  keepAwake();
  const io = new SingleIO(S);
  runGame(S, io);
}

class SingleIO {
  constructor(S) {
    this.S = S;
    const app = $app();
    app.innerHTML = '';
    this.stripEl = h('div');
    this.main = h('div', { class: 'main' });
    app.append(this.stripEl, this.main);
  }

  update() {
    if (this.aborted) return;
    const S = this.S;
    const tools = h('span', { class: 'tools' },
      S.phase === 'day' ? h('button', { class: 'btn ghost tiny', onclick: () => this.peekRole() }, '🔍 查看身分') : null,
      S.phase !== 'over' ? h('button', { class: 'btn ghost tiny', onclick: () => this.abort() }, '⏹ 中斷遊戲') : null);
    this.stripEl.replaceChildren(renderStrip(publicView(S), tools));
    document.body.classList.toggle('is-night', S.phase === 'night');
  }

  async abort() {
    const a = await overlayAsk({ title: '⏹ 中斷遊戲', text: '確定要中斷這局遊戲嗎？進度將不會保留。', buttons: [
      { id: 'end', label: '中斷並公布身分', style: 'danger' },
      { id: 'quit', label: '直接中斷', style: 'ghost' },
      { id: 'cancel', label: '繼續遊戲', style: 'ghost' },
    ] });
    if (a.btn === 'cancel') return;
    // 讓引擎停在目前等待的地方，之後的所有 io 呼叫都不再回應
    this.aborted = true;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    delete document.body.dataset.playing;
    document.body.classList.remove('is-night');
    if (a.btn === 'quit') { singleSetup(); return; }
    const pub = publicView(this.S);
    pub.phase = 'over';
    pub.players.forEach(p => { p.role = this.S.players[p.id].role; });
    this.stripEl.replaceChildren(renderStrip(pub));
    const scr = gameOverScreen(this.S, null, [
      h('button', { class: 'btn primary', onclick: singleSetup }, '再來一局'),
      h('button', { class: 'btn ghost', onclick: home }, '回首頁'),
    ]);
    this.main.replaceChildren(scr);
  }

  show(spec) {
    if (this.aborted) return new Promise(() => {});
    return new Promise(res => {
      this.main.replaceChildren(renderScreen(spec, a => res(a)));
      window.scrollTo(0, 0);
    });
  }

  async narrate(text) {
    if (this.aborted) return new Promise(() => {});
    const night = this.S.phase === 'night';
    this.main.replaceChildren(h('div', { class: 'screen narr' + (night ? ' night' : '') },
      h('div', { class: 'big' }, text), h('p', { class: 'wait' }, night ? '🌙 夜晚進行中，未被點名的玩家請閉眼' : '')));
    await Narrator.speak(text);
  }

  async idle() {
    if (this.aborted) return new Promise(() => {});
    this.main.replaceChildren(h('div', { class: 'screen narr night' }, h('div', { class: 'big' }, '……'), h('p', { class: 'wait' }, '請稍候')));
    await sleep(5000 + Math.random() * 5000);
  }

  // 私人畫面在白天需要先請本人拿起裝置
  async gate(p) {
    await this.show({ title: '🔒 私人畫面', big: `請 ${lbl(p)} 拿起裝置`, text: '其他玩家請勿觀看螢幕', buttons: [{ id: 'ok', label: `我是 ${p.seat}號，開始` }] });
  }

  async ask(pid, spec) {
    const p = this.S.players[pid];
    if (spec.private && !spec.night) await this.gate(p);
    const s = Object.assign({}, spec);
    if (!s.night) s.who = (spec.private ? '🔒 ' : '👤 ') + lbl(p);
    const a = await this.show(s);
    if (spec.private && !spec.night) await this.show({ title: '✅ 完成', text: '請把裝置放回桌子中央', buttons: [{ id: 'ok', label: '繼續' }] });
    return a;
  }

  async askAll(pids, fn) {
    const out = {};
    for (const pid of pids) out[pid] = await this.ask(pid, fn(pid));
    return out;
  }

  async wolfPick(pids, spec) {
    const a = await this.show(spec);
    return a.btn === 'ok' ? a.sel : null;
  }

  announce(spec) { return this.show(spec); }

  async raiseHands(pids, spec) {
    const a = await this.show({
      title: spec.title, text: spec.text + `\n請點選所有選擇「${spec.yes}」的玩家，沒有人就直接確認。`,
      options: pids.map(id => opt(this.S.players[id])), select: 'many', min: 0,
      buttons: [{ id: 'ok', label: '確認' }],
    });
    return a.sel || [];
  }

  async vote(voters, cands, spec) {
    const S = this.S;
    const out = {};
    for (let i = 0; i < voters.length; i++) {
      const v = S.players[voters[i]];
      const a = await this.show({
        title: `🗳️ ${spec.title}`, who: `${lbl(v)} 投票（${i + 1}/${voters.length}）`,
        text: '投票為公開進行，請本人點選要投的對象。',
        options: cands.map(id => opt(S.players[id])), select: 'one',
        buttons: [{ id: 'ok', label: '投票', needSel: true }, { id: 'abs', label: '棄票', style: 'ghost' }]
          .concat(i > 0 ? [{ id: 'back', label: '↩ 上一位', style: 'ghost' }] : []),
      });
      if (a.btn === 'back') { i -= 2; continue; }
      out[v.id] = a.btn === 'ok' ? a.sel : null;
    }
    return out;
  }

  async speech({ speaker, seconds, title, specials }) {
    const S = this.S;
    const endAt = Date.now() + seconds * 1000;
    const sp = specials || {};
    for (;;) {
      const buttons = [{ id: 'done', label: '結束發言' }];
      if (sp.explode) buttons.push({ id: 'explode', label: '🐺 狼人自爆', style: 'danger' });
      if (sp.duel) buttons.push({ id: 'duel', label: '⚔️ 騎士決鬥', style: 'ghost' });
      const a = await this.show({ title, who: `🗣️ ${lbl(S.players[speaker])}`, timer: { endAt }, buttons });
      if (a.btn === 'done') return { kind: 'done' };
      if (a.btn === 'explode') {
        const b = await overlayAsk({ title: '🐺 哪位玩家要自爆？', text: '請自爆的狼人本人點選自己的號碼', options: alive(S).map(q => opt(q)), select: 'one',
          buttons: [{ id: 'ok', label: '確認自爆', style: 'danger', needSel: true }, { id: 'cancel', label: '取消', style: 'ghost' }] });
        if (b.btn !== 'ok') continue;
        if (sp.explode.includes(b.sel)) return { kind: 'explode', pid: b.sel };
        await overlayAsk({ title: '無法自爆', text: '該玩家不能自爆。', buttons: [{ id: 'ok', label: '返回' }] });
      }
      if (a.btn === 'duel') {
        const b = await overlayAsk({ title: '⚔️ 騎士決鬥', text: '請騎士本人先點選自己的號碼', options: alive(S).map(q => opt(q)), select: 'one',
          buttons: [{ id: 'ok', label: '下一步', needSel: true }, { id: 'cancel', label: '取消', style: 'ghost' }] });
        if (b.btn !== 'ok') continue;
        if (!sp.duel.includes(b.sel)) {
          await overlayAsk({ title: '無法決鬥', text: '該玩家不能發動決鬥。', buttons: [{ id: 'ok', label: '返回' }] });
          continue;
        }
        const c = await overlayAsk({ title: '⚔️ 選擇決鬥對象', options: alive(S).filter(q => q.id !== b.sel).map(q => opt(q)), select: 'one',
          buttons: [{ id: 'ok', label: '決鬥！', style: 'danger', needSel: true }, { id: 'cancel', label: '取消', style: 'ghost' }] });
        if (c.btn === 'ok') return { kind: 'duel', pid: b.sel, target: c.sel };
      }
    }
  }

  async revealRoles() {
    const S = this.S;
    await this.show({ title: '🎴 發身分', text: '請依座位順序輪流拿起裝置查看自己的身分，看完後隱藏並傳給下一位。', buttons: [{ id: 'ok', label: '開始' }] });
    for (const p of S.players) {
      await this.show({ title: '🎴 發身分', big: `請 ${lbl(p)} 拿起裝置`, text: '其他玩家請勿觀看', buttons: [{ id: 'ok', label: `我是 ${p.seat}號，查看身分` }] });
      await this.show({ who: lbl(p), roleCard: p.role, text: p.notes.join('\n'), buttons: [{ id: 'ok', label: '記住了，隱藏' }] });
    }
    await this.show({ title: '✅ 身分發放完畢', text: '請把裝置放在桌子中央，準備進入第一夜。\n記得把音量開大！', buttons: [{ id: 'ok', label: '進入黑夜' }] });
  }

  async peekRole() {
    const S = this.S;
    const a = await overlayAsk({ title: '🔍 查看自己的身分', text: '只能查看自己的身分喔！', options: S.players.map(q => opt(q)), select: 'one',
      buttons: [{ id: 'ok', label: '查看', needSel: true }, { id: 'cancel', label: '取消', style: 'ghost' }] });
    if (a.btn !== 'ok') return;
    const p = S.players[a.sel];
    const b = await overlayAsk({ big: `請 ${lbl(p)} 拿起裝置`, text: '其他玩家請勿觀看', buttons: [{ id: 'ok', label: '查看' }, { id: 'cancel', label: '取消', style: 'ghost' }] });
    if (b.btn !== 'ok') return;
    await overlayAsk({ who: lbl(p), roleCard: p.role, text: p.notes.join('\n'), buttons: [{ id: 'ok', label: '隱藏' }] });
  }

  async gameOver(result) {
    delete document.body.dataset.playing;
    Narrator.speak('遊戲結束，' + RESULT_TEXT[result].title.replace(/^\S+\s/, ''));
    this.main.replaceChildren(gameOverScreen(this.S, result, [
      h('button', { class: 'btn primary', onclick: singleSetup }, '再來一局'),
      h('button', { class: 'btn ghost', onclick: home }, '回首頁'),
    ]));
  }
}

function loadJSON(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
