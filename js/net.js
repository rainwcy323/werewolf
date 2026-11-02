'use strict';

/*
 * 多機連線層：透過公用 MQTT 伺服器（WebSocket）轉送訊息，不需要裝置之間直接連線，
 * 所以手機網路、不同 Wi‑Fi、有隔離的 Wi‑Fi 都能用。
 * 每位玩家與主機之間用 ECDH 交換金鑰、AES‑GCM 加密，伺服器與其他人只看得到密文。
 *
 * 公用伺服器會限制每條連線的發送頻率，所以主機不逐一發給每位玩家，而是：
 *   - 主機對每位玩家只保留「最新的一則」訊息（大廳或遊戲畫面本來就是完整狀態），
 *   - 把所有玩家各自加密後的內容合併成一則廣播發出，
 *   - 玩家每次 ping 回報收到的版本，漏收時主機自動補發。
 *
 *   base/p      保留訊息：主機公鑰（用來判斷房間是否存在）
 *   base/h      主機收件匣（玩家的 ping 與操作）
 *   base/b      主機廣播（各玩家的加密內容＋心跳）
 *   base/c/<cid> 個別通知（只用於要求重新握手）
 */

const MQTT_URL = 'https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js';
const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
const TOPIC_BASE = 'wwk-tw/v3/';
const PRESENCE_EVERY = 30000;   // 主機重發房間資訊的間隔
const PRESENCE_STALE = 120000;  // 超過這個時間沒更新就當作房間不存在
const PING_EVERY = 3000;        // 玩家 ping 間隔
const BEAT_EVERY = 3000;        // 主機心跳間隔
const RESEND_AFTER = 2500;      // 玩家回報版本落後多久後補發
const DEAD_AFTER = 12000;

const b64 = buf => {
  const a = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode(...a.subarray(i, i + 8192));
  return btoa(s);
};
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const randId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const Crypto = {
  async pair() {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
    return { priv: kp.privateKey, pub: b64(await crypto.subtle.exportKey('raw', kp.publicKey)) };
  },
  async shared(priv, pubB64) {
    const pub = await crypto.subtle.importKey('raw', unb64(pubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    return crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, priv, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  },
  async seal(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const d = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
    return { iv: b64(iv), d: b64(d) };
  },
  async open(key, m) {
    const d = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(m.iv) }, key, unb64(m.d));
    return JSON.parse(new TextDecoder().decode(d));
  },
};

class Emitter {
  constructor() { this.handlers = {}; }
  on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  emit(ev, ...a) { (this.handlers[ev] || []).forEach(fn => { try { fn(...a); } catch (e) { console.error(e); } }); }
}

function brokerConnect(url, timeout) {
  return new Promise((res, rej) => {
    const c = mqtt.connect(url, { clientId: 'wwk_' + randId(), clean: true, connectTimeout: timeout, reconnectPeriod: 2000, keepalive: 30 });
    const t = setTimeout(() => { c.end(true); rej(new Error('timeout')); }, timeout);
    c.once('connect', () => { clearTimeout(t); res(c); });
  });
}

const parse = buf => { try { const s = buf.toString(); return s ? JSON.parse(s) : null; } catch (e) { return null; } };

/* ───────────── 主機 ───────────── */

// 主機端看到的一位玩家連線，介面仿照 PeerJS 的 DataConnection
class RelayConn extends Emitter {
  constructor(relay, cid, mq, key) {
    super();
    this.relay = relay; this.cid = cid; this.mq = mq; this.key = key;
    this.open = true; this.seen = Date.now();
    this.epoch = randId(); // 每條連線各自編號，避免與舊連線的版本混淆
    this.latest = null; this.ver = 0; this.ack = 0; this.sentAt = 0; this.sealed = null;
  }
  // 只保留最新一則，稍後合併廣播
  send(obj) {
    if (!this.open) return;
    this.latest = obj; this.ver++; this.sealed = null;
    this.relay.schedule();
  }
  close() {
    if (!this.open) return;
    this.relay.flushNow();
    this.open = false;
    this.relay.conns.delete(this.cid);
    this.emit('close');
  }
}

class RelayHost extends Emitter {
  constructor(code) {
    super();
    this.code = code; this.base = TOPIC_BASE + code + '/';
    this.conns = new Map(); this.mqs = [];
    this.q = Promise.resolve(); this.out = Promise.resolve();
  }

  // 房號是否已被使用（伺服器上有新鮮的房間資訊）
  static async taken(mq, base) {
    return new Promise(res => {
      const t = setTimeout(() => { mq.unsubscribe(base + 'p'); res(false); }, 1500);
      mq.on('message', function f(topic, buf) {
        if (topic !== base + 'p') return;
        const p = parse(buf);
        clearTimeout(t); mq.removeListener('message', f); mq.unsubscribe(base + 'p');
        res(!!(p && Date.now() - p.ts < PRESENCE_STALE));
      });
      mq.subscribe(base + 'p');
    });
  }

  async open() {
    await loadScript(MQTT_URL);
    this.keys = await Crypto.pair();
    // 先用最快連上的伺服器開房，其餘的連上後再加入（玩家連到任一台都找得到房間）
    const tries = BROKERS.map(u => brokerConnect(u, 10000));
    let first;
    try { first = await Promise.any(tries); } catch (e) { throw new Error('連線逾時，無法連上轉送伺服器'); }
    if (await RelayHost.taken(first, this.base)) {
      tries.forEach(t => t.then(mq => mq.end(true), () => {}));
      const e = new Error('房號已被使用'); e.type = 'unavailable-id'; throw e;
    }
    this.attach(first);
    tries.forEach(t => t.then(mq => { if (mq === first) return; if (this.closed) mq.end(true); else this.attach(mq); }, () => {}));
    this.presTimer = setInterval(() => this.mqs.forEach(mq => this.announce(mq)), PRESENCE_EVERY);
    this.beat = setInterval(() => {
      const now = Date.now();
      for (const c of [...this.conns.values()]) if (now - c.seen > DEAD_AFTER) c.close();
      this.flushNow(true);
    }, BEAT_EVERY);
  }

  attach(mq) {
    this.mqs.push(mq);
    mq.subscribe(this.base + 'h');
    mq.on('message', (topic, buf) => { if (topic === this.base + 'h') this.onRaw(mq, parse(buf)); });
    mq.on('connect', () => this.announce(mq)); // 斷線重連後重新宣告
    this.announce(mq);
  }

  announce(mq) {
    if (!this.closed) mq.publish(this.base + 'p', JSON.stringify({ k: this.keys.pub, ts: Date.now() }), { retain: true });
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flushNow(), 40);
  }

  // 把有新內容（或玩家回報漏收）的訊息合併成每台伺服器一則廣播
  flushNow(beat) {
    clearTimeout(this.timer); this.timer = null;
    const now = Date.now();
    const due = [...this.conns.values()].filter(c => c.latest && (c.sentAt < c.ver || (c.ack < c.ver && now - c.sentTime > RESEND_AFTER)));
    if (!due.length && !beat) return;
    due.forEach(c => { c.sentAt = c.ver; c.sentTime = now; });
    const snap = due.map(c => ({ c, ver: c.ver, obj: c.latest }));
    this.out = this.out.then(async () => {
      const per = new Map(this.mqs.map(mq => [mq, {}]));
      for (const { c, ver, obj } of snap) {
        if (!c.sealed || c.sealed.ver !== ver) c.sealed = Object.assign({ e: c.epoch, ver }, await Crypto.seal(c.key, obj));
        const box = per.get(c.mq);
        if (box) box[c.cid] = c.sealed;
      }
      for (const [mq, box] of per) {
        if (!Object.keys(box).length && !beat) continue;
        mq.publish(this.base + 'b', JSON.stringify({ m: box, ts: Date.now() }));
      }
    }).catch(e => console.warn(e));
  }

  // 依序處理，避免解密順序錯亂
  onRaw(mq, m) {
    if (!m || typeof m.c !== 'string') return;
    this.q = this.q.then(() => this.handle(mq, m)).catch(e => console.warn(e));
  }

  async handle(mq, m) {
    let c = this.conns.get(m.c);
    if (!c) {
      if (!m.k) { // 主機不認得這位玩家（例如逾時被清掉），請對方重新握手
        mq.publish(this.base + 'c/' + m.c, JSON.stringify({ rekey: 1 }));
        return;
      }
      c = new RelayConn(this, m.c, mq, await Crypto.shared(this.keys.priv, m.k));
      this.conns.set(m.c, c);
      this.emit('connection', c);
    }
    c.seen = Date.now(); c.mq = mq;
    if (typeof m.ack === 'number' && m.e === c.epoch) {
      c.ack = Math.max(c.ack, m.ack);
      if (c.ack < c.ver) this.schedule();
    }
    if (!m.d) return;
    c.emit('data', await Crypto.open(c.key, m));
  }

  destroy() {
    this.closed = true;
    clearInterval(this.presTimer); clearInterval(this.beat);
    for (const c of [...this.conns.values()]) c.close();
    this.out.then(() => {
      for (const mq of this.mqs) {
        try { mq.publish(this.base + 'p', '', { retain: true }, () => mq.end()); } catch (e) { /* ignore */ }
      }
    });
  }
}

/* ───────────── 玩家 ───────────── */

class RelayClient extends Emitter {
  constructor(code) {
    super();
    this.code = code; this.base = TOPIC_BASE + code + '/';
    this.cid = randId(); this.connected = false; this.closed = false;
    this.q = Promise.resolve(); this.heard = 0; this.ver = 0; this.epoch = null;
  }

  async connect() {
    await loadScript(MQTT_URL);
    this.keys = await Crypto.pair();
    // 同時連上所有伺服器，用第一台找得到這個房間的；完全連不上時重試幾次
    let reached = 0, found = null;
    for (let round = 0; round < 3 && !found && !reached; round++) found = await this.find(() => reached++);
    if (!found) throw new Error(reached ? '找不到此房號，請確認主機已建立房間' : '連線逾時，無法連上轉送伺服器');
    await this.setHost(found.k);
    this.listen();
  }

  find(onReach) {
    return new Promise(res => {
      let left = BROKERS.length;
      const done = () => { if (--left === 0) res(null); };
      BROKERS.forEach(u => brokerConnect(u, 10000).then(async mq => {
        onReach();
        const pres = await this.presence(mq);
        if (pres && !this.mq) { this.mq = mq; res(pres); } else mq.end(true);
        done();
      }, done));
    });
  }

  presence(mq) {
    return new Promise(res => {
      const topic = this.base + 'p';
      const t = setTimeout(() => res(null), 4000);
      mq.on('message', function f(tp, buf) {
        if (tp !== topic) return;
        const p = parse(buf);
        clearTimeout(t); mq.removeListener('message', f);
        res(p && Date.now() - p.ts < PRESENCE_STALE ? p : null);
      });
      mq.subscribe(topic);
    });
  }

  listen() {
    const mq = this.mq;
    const topics = [this.base + 'p', this.base + 'b', this.base + 'c/' + this.cid];
    mq.subscribe(topics);
    mq.on('message', (topic, buf) => {
      const m = parse(buf);
      if (topic === this.base + 'p') {
        if (!m) { this.setStatus(false, 'closed'); return; }
        if (m.k !== this.hostPub) this.q = this.q.then(() => this.setHost(m.k)).then(() => this.hello());
      } else if (topic === this.base + 'b') {
        if (m) this.onBroadcast(m);
      } else if (m && m.rekey) this.hello();
    });
    mq.on('connect', () => { mq.subscribe(topics); this.hello(); });
    this.ping = setInterval(() => {
      if (this.connected && Date.now() - this.heard > DEAD_AFTER) this.setStatus(false);
      if (this.connected) this.raw(this.acked()); else this.hello();
    }, PING_EVERY);
    this.hello();
  }

  async setHost(pub) {
    this.hostPub = pub;
    this.key = await Crypto.shared(this.keys.priv, pub);
  }

  raw(o) {
    if (this.closed || !this.mq) return;
    this.mq.publish(this.base + 'h', JSON.stringify(Object.assign({ c: this.cid }, o)));
  }

  // 告訴主機自己的公鑰；之後上層會送 hello
  hello() {
    if (this.closed || !this.key) return;
    this.raw(Object.assign({ k: this.keys.pub }, this.acked()));
    this.emit('rehello');
  }

  onBroadcast(b) {
    this.heard = Date.now();
    const mine = b.m && b.m[this.cid];
    if (!mine) return;
    this.q = this.q.then(async () => {
      if (mine.e === this.epoch && mine.ver <= this.ver) return;
      const msg = await Crypto.open(this.key, mine);
      this.epoch = mine.e; this.ver = mine.ver;
      if (!this.connected) this.setStatus(true);
      this.emit('data', msg);
    }).catch(e => console.warn(e));
  }

  acked() { return { ack: this.ver, e: this.epoch }; }

  setStatus(ok, why) {
    if (this.connected === ok && !why) return;
    this.connected = ok;
    this.emit('status', ok, why);
  }

  send(obj) {
    if (this.closed || !this.key) return;
    this.q = this.q.then(async () => {
      const m = await Crypto.seal(this.key, obj);
      this.raw(Object.assign(m, this.acked()));
    }).catch(e => console.warn(e));
  }

  destroy() {
    this.closed = true;
    clearInterval(this.ping);
    try { this.mq.end(); } catch (e) { /* ignore */ }
  }
}
