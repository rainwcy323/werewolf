'use strict';

function home() {
  delete document.body.dataset.playing;
  document.body.classList.remove('is-night');
  if (history.replaceState && location.search) history.replaceState(null, '', location.pathname);
  const app = $app();
  app.replaceChildren(h('div', { class: 'page home' },
    h('div', { class: 'logo' }, '🐺'),
    h('h1', null, '狼人殺'),
    h('p', { class: 'tag' }, '不需要法官，裝置就是上帝'),
    h('button', { class: 'card-btn', onclick: singleSetup },
      h('b', null, '📱 單機模式'), h('small', null, '一台裝置放在大家中間，語音主持、輪流操作')),
    h('button', { class: 'card-btn', onclick: hostSetup },
      h('b', null, '📡 建立房間（多機）'), h('small', null, '每人用自己的手機，這台當主機')),
    h('button', { class: 'card-btn', onclick: () => joinSetup() },
      h('b', null, '🙋 加入房間'), h('small', null, '輸入房號或掃描主機的 QR Code')),
    h('button', { class: 'btn ghost', onclick: () => rulesPage(home) }, '📖 規則說明與角色介紹')));
}

Narrator.init();
const room = new URLSearchParams(location.search).get('room');
if (room) joinSetup(room.toUpperCase().slice(0, 4)); else home();
