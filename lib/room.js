'use strict';
/*
 * 방(Room): 접속한 사람/봇, 설정, 누적 점수, 현재 판, 봇·자동진행 타이머를 관리한다.
 * 서버(server.js)는 메시지를 파싱해서 Room 메서드만 호출한다.
 */
const crypto = require('crypto');
const { HulaGame, DEFAULT_OPTIONS } = require('./game');
const bot = require('./bot');

const MAX_PLAYERS = 5;
const MIN_PLAYERS = 2;
const BOT_DELAY_MS = parseInt(process.env.HULA_BOT_DELAY || '900', 10); // 봇이 한 동작 두는 간격(ms)
const DISCONNECT_AUTOPLAY_MS = 8000; // 접속이 끊긴 사람 차례를 대신 두기까지 기다리는 시간
const BOT_NAMES = ['하늘봇', '바다봇', '구름봇', '별봇', '달봇'];

const OPTION_CHOICES = {
  stopLimit: [5, 7, 10, 15, 20],
  turnSeconds: [0, 30, 60, 90]
};

function randomId(bytes) { return crypto.randomBytes(bytes).toString('hex'); }

function cleanName(raw) {
  let s = typeof raw === 'string' ? raw : '';
  s = s.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  s = Array.from(s).slice(0, 10).join('');
  return s || '손님';
}

class Room {
  constructor(code) {
    this.code = code;
    this.members = [];            // { id, key, name, isBot, ws }
    this.hostId = null;
    this.options = Object.assign({}, DEFAULT_OPTIONS);
    this.scores = {};             // memberId -> 누적 점수
    this.game = null;
    this.round = 0;
    this.roundScored = false;
    this.lastFirstIdx = -1;
    this.timer = null;
    this.timerToken = 0;
    this.autoFor = null;          // 이번 차례를 대신 두는 중인 사람의 id
    this.turnMark = null;
    this.turnUntil = 0;
    this.deadline = null;
    this.emptySince = null;
  }

  // ───────── 멤버 관리 ─────────
  member(id) { return this.members.find((m) => m.id === id) || null; }
  byKey(key) { return this.members.find((m) => !m.isBot && m.key === key) || null; }
  humans() { return this.members.filter((m) => !m.isBot); }
  connectedHumans() { return this.members.filter((m) => !m.isBot && m.ws); }
  get phase() {
    if (!this.game) return 'lobby';
    return this.game.phase === 'ended' ? 'roundEnd' : 'playing';
  }

  _uniqueName(name) {
    let base = name, n = 2;
    while (this.members.some((m) => m.name === name)) name = base + n++;
    return name;
  }

  addHuman(rawName, ws) {
    const m = { id: randomId(4), key: randomId(16), name: this._uniqueName(cleanName(rawName)), isBot: false, ws: ws || null };
    this.members.push(m);
    this.scores[m.id] = 0;
    if (!this.hostId) this.hostId = m.id;
    this.emptySince = null;
    return m;
  }

  addBot() {
    const used = new Set(this.members.map((m) => m.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || ('봇' + (this.members.length + 1));
    const m = { id: 'bot-' + randomId(3), key: null, name, isBot: true, ws: null };
    this.members.push(m);
    this.scores[m.id] = 0;
    return m;
  }

  _reassignHost() {
    if (this.members.some((m) => m.id === this.hostId && !m.isBot)) return;
    const next = this.connectedHumans()[0] || this.humans()[0] || null;
    this.hostId = next ? next.id : null;
  }

  /** 방을 나감. 진행 중인 판에서는 자리를 봇이 이어받는다. */
  leave(m) {
    const inRound = this.game && this.game.phase !== 'ended';
    m.ws = null;
    if (inRound) {
      m.isBot = true;
      m.key = null;
      const gp = this.game.player(m.id);
      m.name = m.name + '(대리)';
      if (gp) gp.name = m.name;
      this._reassignHost();
      this.afterChange();
      return;
    }
    this.members = this.members.filter((x) => x.id !== m.id);
    delete this.scores[m.id];
    this._reassignHost();
    if (!this.humans().length) this.destroy();
    else this.afterChange();
  }

  disconnect(m) {
    if (m.ws) m.ws = null;
    this._reassignHost();
    if (!this.connectedHumans().length) this.emptySince = Date.now();
    this.afterChange();
  }

  destroy() {
    this.dead = true;
    this._clearTimer();
  }

  // ───────── 설정/시작 ─────────
  setOptions(m, o) {
    if (m.id !== this.hostId) return '방장만 바꿀 수 있습니다.';
    if (this.phase === 'playing') return '게임 중에는 설정을 바꿀 수 없습니다.';
    if (!o || typeof o !== 'object') return '잘못된 설정입니다.';
    if (typeof o.wrap === 'boolean') this.options.wrap = o.wrap;
    if (typeof o.thankYou === 'boolean') this.options.thankYou = o.thankYou;
    if (OPTION_CHOICES.stopLimit.includes(o.stopLimit)) this.options.stopLimit = o.stopLimit;
    if (OPTION_CHOICES.turnSeconds.includes(o.turnSeconds)) this.options.turnSeconds = o.turnSeconds;
    this.afterChange();
    return null;
  }

  kick(m, targetId) {
    if (m.id !== this.hostId) return '방장만 내보낼 수 있습니다.';
    if (this.phase === 'playing') return '게임 중에는 내보낼 수 없습니다.';
    const t = this.member(targetId);
    if (!t || t.id === m.id) return '대상을 찾을 수 없습니다.';
    const ws = t.ws;
    this.members = this.members.filter((x) => x.id !== t.id);
    delete this.scores[t.id];
    if (ws) { this._send(ws, { type: 'kicked' }); ws.close(4001, 'kicked'); }
    this.afterChange();
    return null;
  }

  botAdd(m) {
    if (m.id !== this.hostId) return '방장만 봇을 추가할 수 있습니다.';
    if (this.phase === 'playing') return '게임 중에는 추가할 수 없습니다.';
    if (this.members.length >= MAX_PLAYERS) return '자리가 가득 찼습니다. (최대 ' + MAX_PLAYERS + '명)';
    this.addBot();
    this.afterChange();
    return null;
  }

  botRemove(m, targetId) {
    if (m.id !== this.hostId) return '방장만 할 수 있습니다.';
    if (this.phase === 'playing') return '게임 중에는 뺄 수 없습니다.';
    const t = this.member(targetId);
    if (!t || !t.isBot) return '봇을 찾을 수 없습니다.';
    this.members = this.members.filter((x) => x.id !== t.id);
    delete this.scores[t.id];
    this.afterChange();
    return null;
  }

  resetScores(m) {
    if (m.id !== this.hostId) return '방장만 할 수 있습니다.';
    if (this.phase === 'playing') return '게임 중에는 할 수 없습니다.';
    for (const k of Object.keys(this.scores)) this.scores[k] = 0;
    this.round = 0;
    this.afterChange();
    return null;
  }

  toLobby(m) {
    if (m.id !== this.hostId) return '방장만 할 수 있습니다.';
    if (this.phase === 'playing') return '게임 중에는 할 수 없습니다.';
    this.game = null;
    this._clearTimer();
    this.afterChange();
    return null;
  }

  start(m, rng) {
    if (m.id !== this.hostId) return '방장만 시작할 수 있습니다.';
    if (this.phase === 'playing') return '이미 게임 중입니다.';
    if (this.members.length < MIN_PLAYERS) return '최소 ' + MIN_PLAYERS + '명이 필요합니다. 봇을 추가해 보세요.';
    // 접속이 끊긴 사람만 남은 경우도 시작은 허용(자동 진행됨)
    const n = this.members.length;
    let first;
    if (this.game && this.game.result && this.game.result.winnerId) {
      const wi = this.members.findIndex((x) => x.id === this.game.result.winnerId);
      first = wi >= 0 ? wi : 0;
    } else if (this.lastFirstIdx >= 0) {
      first = (this.lastFirstIdx + 1) % n;
    } else {
      first = Math.floor((rng || Math.random)() * n);
    }
    this.lastFirstIdx = first;
    this.round++;
    this.game = new HulaGame(this.members.map((x) => ({ id: x.id, name: x.name })), this.options, rng || Math.random, first);
    this.roundScored = false;
    this.autoFor = null;
    this.turnMark = null;
    this.afterChange();
    return null;
  }

  // ───────── 게임 행동 ─────────
  act(m, msg) {
    const g = this.game;
    if (!g || g.phase === 'ended') return '진행 중인 판이 없습니다.';
    const ints = (a) => Array.isArray(a) && a.length <= 14 && a.every((x) => Number.isInteger(x));
    let r;
    switch (msg.type) {
      case 'draw': r = g.draw(m.id, msg.from === 'discard' ? 'discard' : 'stock'); break;
      case 'meld': if (!ints(msg.cardIds)) return '잘못된 요청입니다.'; r = g.meld(m.id, msg.cardIds); break;
      case 'attach':
        if (!ints(msg.cardIds) || !Number.isInteger(msg.meldId)) return '잘못된 요청입니다.';
        r = g.attach(m.id, msg.meldId, msg.cardIds); break;
      case 'discard': if (!Number.isInteger(msg.cardId)) return '잘못된 요청입니다.'; r = g.discardCard(m.id, msg.cardId); break;
      case 'stop': r = g.stop(m.id); break;
      case 'blast': r = g.blast(m.id); break;
      case 'thankyou':
        if (msg.cardIds !== undefined && !ints(msg.cardIds)) return '잘못된 요청입니다.';
        r = g.thankYou(m.id, msg.cardIds || []); break;
      default: return '알 수 없는 행동입니다.';
    }
    if (!r.ok) return r.error;
    if (this.autoFor === m.id) this.autoFor = null; // 사람이 직접 두면 자동 진행 해제
    this.afterChange();
    return null;
  }

  // ───────── 타이머(봇/자동 진행) ─────────
  _clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerToken++;
    this.deadline = null;
  }

  armTimer() {
    this._clearTimer();
    const g = this.game;
    if (!g || g.phase === 'ended' || this.dead) return;
    const cur = this.member(g.currentPlayer.id);
    if (!cur) return;
    if (this.autoFor && this.autoFor !== cur.id) this.autoFor = null;

    let delay;
    if (cur.isBot || this.autoFor === cur.id) {
      delay = BOT_DELAY_MS;
    } else if (!cur.ws) {
      delay = DISCONNECT_AUTOPLAY_MS;
    } else if (this.options.turnSeconds > 0) {
      const mark = g.turnNo + ':' + cur.id;
      if (this.turnMark !== mark) {
        this.turnMark = mark;
        this.turnUntil = Date.now() + this.options.turnSeconds * 1000;
      }
      delay = Math.max(0, this.turnUntil - Date.now());
      this.deadline = this.turnUntil;
    } else {
      return;
    }
    const token = ++this.timerToken;
    this.timer = setTimeout(() => this._autoStep(token), delay);
  }

  _autoStep(token) {
    if (token !== this.timerToken || this.dead) return;
    const g = this.game;
    if (!g || g.phase === 'ended') return;
    const cur = this.member(g.currentPlayer.id);
    if (!cur) return;
    if (!cur.isBot) this.autoFor = cur.id;
    bot.botStep(g, cur.id, { allowStop: cur.isBot });
    this.afterChange();
  }

  // ───────── 전송 ─────────
  _send(ws, obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  stateFor(m) {
    return {
      type: 'state',
      code: this.code,
      me: m.id,
      hostId: this.hostId,
      phase: this.phase,
      round: this.round,
      options: this.options,
      members: this.members.map((x) => ({
        id: x.id, name: x.name, isBot: x.isBot, online: x.isBot || !!x.ws, score: this.scores[x.id] || 0
      })),
      game: this.game ? this.game.view(m.id) : null,
      autoFor: this.autoFor,
      deadline: this.deadline,
      now: Date.now(),
      maxPlayers: MAX_PLAYERS
    };
  }

  broadcast() {
    for (const m of this.members) if (m.ws) this._send(m.ws, this.stateFor(m));
  }

  /** 상태가 바뀔 때마다: 점수 반영 → 전송 → 다음 타이머 */
  afterChange() {
    if (this.dead) return;
    const g = this.game;
    if (g && g.phase === 'ended' && !this.roundScored) {
      this.roundScored = true;
      for (const [id, d] of Object.entries(g.result.deltas)) {
        if (id in this.scores) this.scores[id] += d;
      }
    }
    this.broadcast();
    this.armTimer();
  }
}

module.exports = { Room, MAX_PLAYERS, MIN_PLAYERS, cleanName };
