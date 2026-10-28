'use strict';

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const $app = () => document.getElementById('app');

/* ───────────── 語音播報 ───────────── */

const Narrator = {
  enabled: true,
  voice: null,
  init() {
    if (!('speechSynthesis' in window)) return;
    const pick = () => {
      const vs = speechSynthesis.getVoices();
      this.voice = vs.find(v => /zh[-_]TW/i.test(v.lang)) || vs.find(v => /zh[-_]HK/i.test(v.lang))
        || vs.find(v => /^zh/i.test(v.lang)) || null;
    };
    pick();
    speechSynthesis.addEventListener('voiceschanged', pick);
  },
  // iOS 需在使用者點擊時先播一次才能解鎖語音
  unlock() {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  },
  speak(text) {
    const minWait = 900 + text.length * 120;
    if (!this.enabled || !('speechSynthesis' in window)) return sleep(Math.max(1600, minWait));
    return new Promise(res => {
      let done = false;
      const fin = () => { if (!done) { done = true; res(); } };
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = this.voice ? this.voice.lang : 'zh-TW';
      if (this.voice) u.voice = this.voice;
      u.rate = 0.95;
      u.onend = () => setTimeout(fin, 500);
      u.onerror = fin;
      speechSynthesis.speak(u);
      setTimeout(fin, minWait + 4000); // 保險：部分瀏覽器不觸發 onend
    });
  },
};

let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) { /* 不支援就算了 */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && document.body.dataset.playing) keepAwake(); });

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; g.gain.value = 0.15;
    o.start(); o.stop(ctx.currentTime + 0.25);
  } catch (e) { /* ignore */ }
  if (navigator.vibrate) navigator.vibrate(200);
}

/* ───────────── 畫面 ───────────── */

// 依 prompt id 保留選擇，讓多機模式重繪時不會遺失
const selStore = new Map();

/*
 * spec: { id, night, who, title, big, tone, text, roleCard, options, select:'one'|'many', min, max,
 *         marks:{optId:[labels]}, buttons:[{id,label,style,needSel,disabled}], timer:{endAt}, hideButtons }
 */
function renderScreen(spec, onAnswer, opts) {
  opts = opts || {};
  const key = spec.id != null ? spec.id : spec;
  const many = spec.select === 'many';
  let sel = selStore.has(key) ? selStore.get(key) : (many ? [] : null);
  const min = many ? (spec.min != null ? spec.min : 1) : 1;
  const max = many ? (spec.max != null ? spec.max : 99) : 1;
  const valid = () => many ? sel.length >= min && sel.length <= max : sel != null;

  const root = h('div', { class: 'screen' + (spec.night ? ' night' : '') });
  if (spec.who) root.append(h('div', { class: 'who' }, spec.who));
  if (spec.title) root.append(h('h2', null, spec.title));
  if (spec.roleCard) root.append(roleCardEl(spec.roleCard));
  if (spec.big) root.append(h('div', { class: 'big ' + (spec.tone || '') }, spec.big));
  if (spec.text) root.append(h('p', { class: 'text' }, spec.text));

  if (spec.timer) root.append(timerEl(spec.timer));

  const btnEls = [];
  const refreshBtns = () => btnEls.forEach(([b, el]) => { el.disabled = !!b.disabled || (b.needSel && !valid()); });

  if (spec.options) {
    const grid = h('div', { class: 'grid' });
    const optEls = [];
    const paint = () => optEls.forEach(([o, el]) => el.classList.toggle('on', many ? sel.includes(o.id) : sel === o.id));
    for (const o of spec.options) {
      const marks = spec.marks && spec.marks[o.id];
      const el = h('button', { class: 'opt' + (o.danger ? ' danger' : ''), disabled: o.disabled },
        h('b', null, o.label), o.sub ? h('small', null, o.sub) : null,
        marks && marks.length ? h('i', { class: 'mark' }, marks.join(' ')) : null);
      el.addEventListener('click', () => {
        if (many) {
          if (sel.includes(o.id)) sel = sel.filter(x => x !== o.id);
          else if (sel.length < max) sel = sel.concat([o.id]);
          else if (max === 1) sel = [o.id];
        } else sel = sel === o.id ? null : o.id;
        selStore.set(key, sel);
        paint(); refreshBtns();
        if (opts.onSel) opts.onSel(sel);
      });
      optEls.push([o, el]);
      grid.append(el);
    }
    paint();
    root.append(grid);
  }

  if (spec.buttons && spec.buttons.length && !spec.hideButtons) {
    const row = h('div', { class: 'btns' });
    for (const b of spec.buttons) {
      const el = h('button', { class: 'btn ' + (b.style || 'primary') }, b.label);
      el.addEventListener('click', () => {
        if (el.disabled) return;
        row.querySelectorAll('button').forEach(x => { x.disabled = true; });
        selStore.delete(key);
        onAnswer({ btn: b.id, sel });
      });
      btnEls.push([b, el]);
      row.append(el);
    }
    refreshBtns();
    root.append(row);
  } else if (spec.waitText) {
    root.append(h('p', { class: 'wait' }, spec.waitText));
  }
  return root;
}

function timerEl(t) {
  const el = h('div', { class: 'timer' });
  let beeped = false;
  const tick = () => {
    if (!el.isConnected && el.dataset.started) return;
    el.dataset.started = 1;
    const left = Math.max(0, Math.ceil((t.endAt - Date.now()) / 1000));
    el.textContent = left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : '時間到';
    el.classList.toggle('low', left <= 10);
    if (left === 0 && !beeped && !t.silent) { beeped = true; beep(); }
    setTimeout(tick, 250);
  };
  tick();
  return el;
}

function roleCardEl(roleKey, extraNotes) {
  const r = ROLES[roleKey];
  return h('div', { class: 'rolecard ' + r.team },
    h('div', { class: 'ricon' }, r.icon),
    h('div', { class: 'rname' }, r.name),
    h('div', { class: 'rteam' }, r.team === 'wolf' ? '狼人陣營' : r.team === 'third' ? '第三方' : r.cat === 'god' ? '好人陣營・神職' : '好人陣營・平民'),
    h('p', { class: 'rdesc' }, r.desc),
    extraNotes && extraNotes.length ? h('ul', { class: 'notes' }, extraNotes.map(n => h('li', null, n))) : null);
}

function renderStrip(pub, extra) {
  const night = pub.phase === 'night';
  const phase = pub.phase === 'setup' ? '準備中' : pub.phase === 'over' ? '遊戲結束'
    : `第 ${pub.day} ${night ? '夜 🌙' : '天 ☀️'}`;
  return h('div', { class: 'strip' + (night ? ' night' : '') },
    h('div', { class: 'phase' }, phase, extra || null),
    h('div', { class: 'seats' }, pub.players.map(p =>
      h('span', { class: 'seat' + (p.alive ? '' : ' dead'), title: p.name },
        p.seat, p.sheriff ? h('em', null, '🎖️') : null, p.idiot ? h('em', null, '🤪') : null, p.silenced ? h('em', null, '🤐') : null,
        p.role ? h('em', null, ROLES[p.role].icon) : null))));
}

function overlay(content, onClose) {
  const ov = h('div', { class: 'overlay' });
  const box = h('div', { class: 'ovbox' }, content);
  ov.append(box);
  ov.addEventListener('click', e => { if (e.target === ov && onClose !== false) close(); });
  const close = () => { ov.remove(); if (onClose) onClose(); };
  document.body.append(ov);
  return close;
}

// 在覆蓋層中跑一個 renderScreen，回傳答案
function overlayAsk(spec) {
  return new Promise(res => {
    let close;
    const el = renderScreen(spec, a => { res(a); close(); });
    close = overlay(el, () => res({ btn: 'cancel' }));
  });
}

function gameOverScreen(S, result, buttons) {
  const rt = RESULT_TEXT[result] || { title: '⏹ 遊戲已中斷', tone: '' };
  const root = h('div', { class: 'screen' },
    h('h2', null, result ? '遊戲結束' : '遊戲中斷'),
    h('div', { class: 'big ' + rt.tone }, rt.title),
    h('div', { class: 'reveal' }, S.players.map(p => h('div', { class: 'rv ' + team(p) + (p.alive ? '' : ' dead') },
      h('b', null, p.seat + '號'), h('span', null, p.name), h('span', { class: 'rr' }, ROLES[p.role].icon + ' ' + roleName(p)),
      h('small', null, (p.alive ? '存活' : CAUSE[p.cause]) + (p.lover != null ? ' 💞' : '') + (S.sheriff === p.id ? ' 🎖️' : ''))))),
    h('details', { class: 'log' }, h('summary', null, '上帝視角紀錄'), h('pre', null, S.log.join('\n'))));
  if (buttons) root.append(h('div', { class: 'btns' }, buttons));
  return root;
}

/* ───────────── 設定（板子＋規則） ───────────── */

function setupEditor(state, onChange) {
  // state: { n, counts, settings }
  const wrap = h('div', { class: 'setup' });
  const draw = () => {
    wrap.innerHTML = '';
    const total = countRoles(state.counts);
    const need = cardsNeeded(state.n, state.counts);
    const ok = total === need && ROLE_ORDER.some(k => state.counts[k] && ROLES[k].team === 'wolf');
    const same = (a, b) => ROLE_ORDER.every(k => (a[k] || 0) === (b[k] || 0));

    // 建議板子
    const presets = presetsFor(state.n);
    wrap.append(h('h3', null, `建議板子（${state.n} 人）`));
    if (presets.length) {
      wrap.append(h('div', { class: 'presets' }, presets.map(p => h('button', {
        class: 'preset' + (same(p.counts, state.counts) ? ' on' : ''),
        onclick: () => { state.counts = Object.assign({}, p.counts); Object.assign(state.settings, p.settings); draw(); onChange(); },
      }, h('b', null, p.name), h('small', null, roleSummary(p.counts)), h('i', null, p.desc)))));
    } else wrap.append(h('p', { class: 'hint' }, '此人數沒有內建板子，請自行配置。'));

    wrap.append(h('h3', null, '角色配置（可自行調整）'));
    wrap.append(h('p', { class: 'hint ' + (ok ? 'okc' : 'bad') }, `已選 ${total} / ${need} 張` + (state.counts.thief ? '（含盜賊的 2 張底牌）' : '') +
      (ok ? ' ✔' : total !== need ? `（牌數需等於${state.counts.thief ? '人數＋2' : '人數'}）` : '（至少需要一名狼人）')));
    for (const [g, gname] of ROLE_GROUPS) {
      const list = h('div', { class: 'roles' });
      for (const k of ROLE_ORDER.filter(k => ROLES[k].group === g)) {
        const r = ROLES[k], c = state.counts[k] || 0;
        list.append(h('div', { class: 'rrow ' + r.team, title: r.desc },
          h('span', { class: 'ri' }, r.icon), h('span', { class: 'rn' }, r.name),
          h('button', { class: 'step', disabled: c <= 0, onclick: () => { state.counts[k] = c - 1; draw(); onChange(); } }, '−'),
          h('b', { class: 'rc' }, c),
          h('button', { class: 'step', disabled: c >= r.max, onclick: () => { state.counts[k] = c + 1; draw(); onChange(); } }, '+')));
      }
      wrap.append(h('h4', { class: 'grp' }, gname), list);
    }

    const st = state.settings;
    const sel = (label, key, options) => h('label', { class: 'set' }, h('span', null, label),
      h('select', { onchange: e => { const v = e.target.value; st[key] = /^\d+$/.test(v) ? +v : v === 'true' ? true : v === 'false' ? false : v; onChange(); } },
        options.map(([v, t]) => h('option', { value: String(v), selected: String(st[key]) === String(v) }, t))));
    wrap.append(h('h3', null, '規則設定'),
      sel('勝利條件', 'win', [['side', '屠邊（殺光神職或平民）'], ['all', '屠城（殺光所有好人）']]),
      sel('警長競選', 'sheriff', [[true, '開啟'], [false, '關閉']]),
      sel('女巫自救', 'witchSelf', [['first', '僅首夜可自救'], ['never', '不可自救'], ['always', '每晚皆可自救']]),
      sel('同守同救', 'guardSave', [['die', '死亡（奶穿）'], ['live', '存活']]),
      sel('發言時間', 'speechSec', [[60, '60 秒'], [90, '90 秒'], [120, '120 秒'], [180, '180 秒']]),
      sel('遺言時間', 'lastWordSec', [[30, '30 秒'], [60, '60 秒'], [90, '90 秒']]),
      sel('語音播報', 'narration', [[true, '開啟'], [false, '關閉（只顯示文字）']]));
    wrap.dataset.ok = ok ? '1' : '';
  };
  draw();
  wrap.redraw = draw;
  return wrap;
}

function rulesPage(onBack) {
  const app = $app();
  app.innerHTML = '';
  app.append(h('div', { class: 'page' },
    h('div', { class: 'row between' }, h('h2', null, '📖 規則說明'), h('button', { class: 'btn ghost small', onclick: onBack }, '返回')),
    h('div', { class: 'rules', html: RULES_HTML }),
    h('h3', null, '角色一覽'),
    h('div', { class: 'cards' }, ROLE_ORDER.map(k => roleCardEl(k)))));
}

const RULES_HTML = `
<p>本程式取代法官（上帝），自動主持夜晚行動、結算死亡、計票與判定勝負。規則主要參考
<a href="https://andyventure.com/boardgame-langrensha/" target="_blank" rel="noopener">安迪冒險的狼人殺教學</a>，並補上常見例外規則。</p>
<h4>流程</h4>
<ol>
<li><b>發身分</b>：每位玩家私下查看自己的角色。</li>
<li><b>夜晚</b>（依序，只會叫本局有的角色）：夢魘 → 占卜師 → 盜賊（首夜）→ 丘比特（首夜）→ 情侶確認（首夜）→ 野孩子（首夜）→ 守衛 → 魔術師 → 狼人 → 狼美人 → 隱狼（首夜）→ 石像鬼 → 女巫 → 預言家 → 守墓人（第二夜起）→ 禁言長老 → 攝夢人 → 獵魔人（第二夜起）→ 烏鴉。已死亡的角色仍會被「點名」並假等待數秒，避免洩漏資訊。</li>
<li><b>白天</b>：首日競選警長 → 公布昨晚死亡（含熊是否咆哮、誰被禁言）→ 死亡技能／遺言 → 依序發言 → 放逐投票 → 進入黑夜。</li>
</ol>
<h4>特殊角色的結算細節</h4>
<ul>
<li><b>魔術師</b>：交換後，當晚所有指向其中一人的技能（刀、守、救、毒、查驗、夢遊、狩獵、禁言、詛咒）都改落到另一人身上。女巫看到的刀口號碼仍是狼人選的號碼。</li>
<li><b>夢魘</b>：最先行動，被恐懼的神職當晚只會看到「被恐懼」提示；恐懼到任何狼人時，狼隊當晚不能刀人。</li>
<li><b>血月使徒</b>：自爆後的下一晚，所有神職只會看到「血月之夜」提示，當晚死亡的獵人也不能開槍。</li>
<li><b>惡靈騎士</b>：夜晚的刀、毒、狩獵都殺不死他。第一個毒他的女巫或查驗他的預言家，會在隔天早上死亡（女巫比預言家先行動，兩人同晚觸發時只有女巫死亡）。查驗結果仍顯示狼人。</li>
<li><b>攝夢人</b>：夢遊者當晚免疫刀、毒與狩獵；攝夢人當晚死亡或連續兩晚選同一人，夢遊者會死亡。</li>
<li><b>隱狼／石像鬼</b>：刀人順序為「會睜眼的狼」→ 全死後由隱狼刀 → 最後只剩石像鬼時由石像鬼刀。</li>
<li><b>老流氓</b>：被毒或被開槍時，撐到下一次入夜才死亡，並在隔天早上一起公布。</li>
<li><b>盜賊</b>：配置盜賊時，牌數＝人數＋2，多出的兩張就是底牌。</li>
<li><b>炸彈人</b>：只在被投票放逐時能引爆，炸死這一輪所有投他的人。他不影響好人或狼人的勝負判定。</li>
</ul>
<h4>例外規則（可在設定中調整）</h4>
<ul>
<li><b>同守同救</b>：守衛與女巫同時保護被刀的人，預設「奶穿」死亡。</li>
<li><b>女巫</b>：同一晚只能用一瓶藥；解藥用完後不再得知刀口；自救預設僅限首夜。不論藥是否已用完，每晚都會依序詢問解藥與毒藥，避免從流程長短洩漏資訊。</li>
<li><b>獵人／狼王</b>：被毒死或殉情不能開槍；狼王自爆不能開槍。</li>
<li><b>白痴</b>：被放逐時自動翻牌免死，之後失去投票權。</li>
<li><b>遺言</b>：首夜死亡、白天被放逐或被開槍帶走的玩家有遺言；第二夜起的夜晚死亡、自爆、決鬥死亡沒有遺言。</li>
<li><b>平票</b>：平票玩家 PK 發言，其餘玩家重投；再平票則當天無人出局（警長選舉則警徽流失）。</li>
<li><b>警長</b>：1.5 票、決定發言方向並最後發言；死亡時可移交或撕毀警徽。退水者不能投警長票。</li>
<li><b>勝負</b>：屠邊＝狼人殺光所有神職或所有平民即勝；好人需放逐所有狼人。若最後一晚狼刀與毒藥同時讓雙方達成條件，判狼人勝（刀先於毒）。人狼戀時情侶與丘比特為第三方，須成為最後存活者。</li>
</ul>
<h4>單機模式小提醒</h4>
<ul>
<li>裝置放在桌子中央，夜晚聽語音指示：被點名的角色睜眼操作，其他人閉眼。建議將音量開大。</li>
<li>「狼人自爆」「騎士決鬥」按鈕是公開操作，請由本人在大家面前按下，不要拿來試探別人的身分。</li>
<li>標示 🔒 的私人畫面（例如死亡技能確認）會先請指定玩家拿起裝置，其他人請勿偷看。</li>
</ul>
<h4>多機模式小提醒</h4>
<ul>
<li>一台裝置建立房間（主機），其他人輸入房號或掃描 QR Code 加入；主機需保持畫面開啟、不要關閉分頁。</li>
<li>主機可以同時當玩家，或只當公共螢幕／播報器。所有裝置需能連上網路（用來建立點對點連線）。</li>
<li>斷線時重新整理頁面，會自動以同一身分回到遊戲。</li>
</ul>`;
