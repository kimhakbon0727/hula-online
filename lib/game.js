'use strict';
/*
 * 한 판(라운드)의 상태 머신. 네트워크/타이머와 무관한 순수 로직.
 * 모든 행동 메서드는 { ok:true } 또는 { ok:false, error:'한글 메시지' } 를 돌려준다.
 */
const R = require('../shared/rules');

const DEFAULT_OPTIONS = {
  wrap: true,        // K-A-2 처럼 돌아가는 런 허용
  thankYou: false,   // 땡큐(차례 아닐 때 버린 카드 가져가며 바로 등록) 허용
  stopLimit: 10,     // 이 점수 이하일 때 스톱 가능
  turnSeconds: 0     // 0이면 제한 없음 (서버가 사용)
};

const HAND_SIZE = 7;

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

class HulaGame {
  /**
   * @param {{id:string,name:string}[]} playerList 좌석 순서
   * @param {object} options
   * @param {function} rng
   * @param {number} firstIdx 먼저 시작하는 좌석
   */
  constructor(playerList, options, rng, firstIdx) {
    this.rng = rng || Math.random;
    this.options = Object.assign({}, DEFAULT_OPTIONS, options || {});
    this.players = playerList.map((p) => ({
      id: p.id, name: p.name, hand: [], registered: false, turnStartRegistered: false
    }));
    this.melds = [];
    this.discard = [];
    this.stock = [];
    this.current = (firstIdx || 0) % this.players.length;
    this.phase = 'draw';           // draw | play | ended
    this.turnNo = 1;
    this.log = [];
    this.result = null;
    this.stockEmptied = false;
    this.lastDiscarder = null;
    this.lastDrawn = null;
    this.lastDrawSource = null;    // 'stock' | 'discard'
    this.discardStreak = 0;        // 더미 대신 버린 카드만 연속으로 가져간 횟수 (봇의 무한 순환 방지용)
    this.nextMeldId = 1;
    this._deal();
  }

  // ───────── 조회 ─────────
  player(id) { return this.players.find((p) => p.id === id) || null; }
  get currentPlayer() { return this.players[this.current]; }
  _log(text) { this.log.push(text); if (this.log.length > 60) this.log.shift(); }
  _name(p) { return p.name; }

  _deal() {
    const deck = shuffle(Array.from({ length: 52 }, (_, i) => i), this.rng);
    for (let i = 0; i < HAND_SIZE; i++) for (const p of this.players) p.hand.push(deck.pop());
    this.stock = deck;
    this.currentPlayer.turnStartRegistered = false;
    this._log('카드를 나눠주었습니다. ' + this._name(this.currentPlayer) + '님부터 시작합니다.');
    for (const p of this.players) {
      if (R.hasFourSevens(p.hand)) {
        this._log(this._name(p) + '님이 7 네 장을 받았습니다!');
        this._end('fourSevens', p.id);
        return;
      }
    }
  }

  // ───────── 판정 도우미 ─────────
  canStop(pid) {
    if (this.phase !== 'draw' || this.currentPlayer.id !== pid) return false;
    return R.handPoints(this.currentPlayer.hand) <= this.options.stopLimit;
  }
  canBlast(pid) {
    if (this.phase !== 'draw' || this.currentPlayer.id !== pid) return false;
    return R.blastEligible(this.currentPlayer.hand, this.currentPlayer.registered);
  }
  canThankYou(pid) {
    if (!this.options.thankYou || this.phase !== 'draw') return false;
    const p = this.player(pid);
    if (!p || this.currentPlayer.id === pid || this.lastDiscarder === pid) return false;
    if (!this.discard.length) return false;
    const top = this.discard[this.discard.length - 1];
    const cands = R.meldCandidates(p.hand.concat([top]), this.options.wrap);
    if (cands.some((c) => c.includes(top))) return true;
    return p.registered && this.melds.some((m) => R.tryAttach(m, top, this.options.wrap));
  }

  _turnError(pid, wantPhase) {
    if (this.phase === 'ended') return '이번 판은 이미 끝났습니다.';
    if (this.currentPlayer.id !== pid) return '내 차례가 아닙니다.';
    if (this.phase !== wantPhase) {
      return wantPhase === 'draw' ? '이미 카드를 뽑았습니다.' : '먼저 카드를 한 장 뽑아야 합니다.';
    }
    return null;
  }
  _ownsAll(p, ids) {
    if (!Array.isArray(ids) || !ids.length) return false;
    if (new Set(ids).size !== ids.length) return false;
    return ids.every((i) => Number.isInteger(i) && p.hand.includes(i));
  }
  _removeFromHand(p, ids) {
    p.hand = p.hand.filter((c) => !ids.includes(c));
  }

  // ───────── 행동 ─────────
  draw(pid, from) {
    const err = this._turnError(pid, 'draw');
    if (err) return { ok: false, error: err };
    const p = this.currentPlayer;
    let card;
    if (from === 'discard') {
      if (!this.discard.length) return { ok: false, error: '버린 카드가 없습니다.' };
      card = this.discard.pop();
      this.discardStreak++;
      this._log(this._name(p) + '님이 버린 카드를 가져갔습니다.');
    } else {
      if (!this.stock.length) return { ok: false, error: '더미에 카드가 없습니다.' };
      card = this.stock.pop();
      this.discardStreak = 0;
      if (!this.stock.length) {
        this.stockEmptied = true;
        this._log('마지막 카드가 뽑혔습니다. 이번 차례가 끝나면 판이 종료됩니다.');
      }
    }
    p.hand.push(card);
    this.lastDrawn = card;
    this.lastDrawSource = from === 'discard' ? 'discard' : 'stock';
    this.phase = 'play';
    if (R.hasFourSevens(p.hand)) {
      this._log(this._name(p) + '님이 7 네 장을 모았습니다!');
      this._end('fourSevens', p.id);
    }
    return { ok: true, card };
  }

  meld(pid, ids) {
    const err = this._turnError(pid, 'play');
    if (err) return { ok: false, error: err };
    const p = this.currentPlayer;
    if (!this._ownsAll(p, ids)) return { ok: false, error: '내 손패에 없는 카드입니다.' };
    const m = R.tryMeld(ids, this.options.wrap);
    if (!m) return { ok: false, error: '등록할 수 없는 조합입니다. (같은 숫자 3장 이상, 같은 무늬 연속 3장 이상, 또는 7 한 장)' };
    this._removeFromHand(p, ids);
    this.melds.push(Object.assign({ id: this.nextMeldId++, owner: p.id }, m));
    p.registered = true;
    this._log(this._name(p) + '님이 ' + this._describe(m) + ' 등록했습니다.');
    this._checkOut(p);
    return { ok: true };
  }

  attach(pid, meldId, ids) {
    const err = this._turnError(pid, 'play');
    if (err) return { ok: false, error: err };
    const p = this.currentPlayer;
    if (!p.registered) return { ok: false, error: '먼저 등록(멜드)을 해야 붙일 수 있습니다.' };
    if (!this._ownsAll(p, ids)) return { ok: false, error: '내 손패에 없는 카드입니다.' };
    const idx = this.melds.findIndex((m) => m.id === meldId);
    if (idx < 0) return { ok: false, error: '없는 멜드입니다.' };
    const nm = R.tryAttachMany(this.melds[idx], ids, this.options.wrap);
    if (!nm) return { ok: false, error: '그 멜드에 붙일 수 없는 카드입니다.' };
    this._removeFromHand(p, ids);
    this.melds[idx] = nm;
    const owner = this.player(nm.owner);
    this._log(this._name(p) + '님이 ' + (owner && owner.id !== p.id ? this._name(owner) + '님의 ' : '') + '멜드에 ' + ids.length + '장 붙였습니다.');
    this._checkOut(p);
    return { ok: true };
  }

  discardCard(pid, cardId) {
    const err = this._turnError(pid, 'play');
    if (err) return { ok: false, error: err };
    const p = this.currentPlayer;
    if (!this._ownsAll(p, [cardId])) return { ok: false, error: '내 손패에 없는 카드입니다.' };
    this._removeFromHand(p, [cardId]);
    this.discard.push(cardId);
    this.lastDiscarder = p.id;
    this.lastDrawn = null;
    if (!p.hand.length) {
      this._finishOut(p);
      return { ok: true };
    }
    if (this.stockEmptied) {
      this._endStockEmpty();
      return { ok: true };
    }
    this._advance();
    return { ok: true };
  }

  stop(pid) {
    const err = this._turnError(pid, 'draw');
    if (err) return { ok: false, error: err };
    const p = this.currentPlayer;
    const t = R.handPoints(p.hand);
    if (t > this.options.stopLimit) return { ok: false, error: '스톱은 손패 점수가 ' + this.options.stopLimit + '점 이하일 때만 할 수 있습니다. (지금 ' + t + '점)' };
    const others = [];
    for (let k = 1; k < this.players.length; k++) others.push(this.players[(this.current + k) % this.players.length]);
    const minOther = Math.min.apply(null, others.map((o) => R.handPoints(o.hand)));
    this._log(this._name(p) + '님이 스톱을 외쳤습니다! (' + t + '점)');
    if (t < minOther) {
      this._end('stop', p.id, p.id);
    } else {
      const winner = others.find((o) => R.handPoints(o.hand) === minOther);
      this._log('스톱 실패! 같거나 더 낮은 점수가 있습니다.');
      this._end('stopFail', winner.id, p.id);
    }
    return { ok: true };
  }

  blast(pid) {
    const err = this._turnError(pid, 'draw');
    if (err) return { ok: false, error: err };
    const p = this.currentPlayer;
    if (!R.blastEligible(p.hand, p.registered)) return { ok: false, error: '블라스트 조건이 아닙니다. (등록 전, 손패 7장의 합이 15 이하 또는 83 이상)' };
    this._log(this._name(p) + '님이 블라스트! (7 = 7점으로 계산한 합 ' + R.faceSum(p.hand) + ')');
    this._end('blast', p.id);
    return { ok: true };
  }

  /** 땡큐: 차례가 아닌 사람이 방금 버려진 카드를 가져가 바로 등록/붙이기 */
  thankYou(pid, ids) {
    if (!this.options.thankYou) return { ok: false, error: '이 방은 땡큐를 쓰지 않습니다.' };
    if (this.phase !== 'draw') return { ok: false, error: '지금은 땡큐를 할 수 없습니다.' };
    const p = this.player(pid);
    if (!p) return { ok: false, error: '참가자가 아닙니다.' };
    if (this.currentPlayer.id === pid) return { ok: false, error: '내 차례에는 그냥 뽑으면 됩니다.' };
    if (this.lastDiscarder === pid) return { ok: false, error: '내가 버린 카드는 땡큐할 수 없습니다.' };
    if (!this.discard.length) return { ok: false, error: '버린 카드가 없습니다.' };
    const top = this.discard[this.discard.length - 1];
    const picked = Array.isArray(ids) ? ids : [];
    if (picked.length && !this._ownsAll(p, picked)) return { ok: false, error: '내 손패에 없는 카드입니다.' };

    let newMeld = null;
    let attachIdx = -1;
    if (picked.length) {
      newMeld = R.tryMeld(picked.concat([top]), this.options.wrap);
      if (!newMeld) return { ok: false, error: '그 카드들과 버린 카드로 등록할 수 없습니다.' };
    } else {
      if (!p.registered) return { ok: false, error: '땡큐로 등록할 카드를 함께 선택하세요.' };
      attachIdx = this.melds.findIndex((m) => R.tryAttach(m, top, this.options.wrap));
      if (attachIdx < 0) return { ok: false, error: '그 카드를 붙일 수 있는 멜드가 없습니다.' };
    }

    // 확정: 차례가 땡큐한 사람에게 넘어간다
    this.current = this.players.indexOf(p);
    p.turnStartRegistered = p.registered;
    this.discard.pop();
    this.turnNo++;
    this.phase = 'play';
    this.lastDrawn = null;
    if (newMeld) {
      this._removeFromHand(p, picked);
      this.melds.push(Object.assign({ id: this.nextMeldId++, owner: p.id }, newMeld));
      p.registered = true;
      this._log(this._name(p) + '님이 땡큐! ' + this._describe(newMeld) + ' 등록했습니다.');
    } else {
      this.melds[attachIdx] = R.tryAttach(this.melds[attachIdx], top, this.options.wrap);
      this._log(this._name(p) + '님이 땡큐! 멜드에 붙였습니다.');
    }
    this._checkOut(p);
    return { ok: true };
  }

  // ───────── 진행/종료 ─────────
  _advance() {
    this.current = (this.current + 1) % this.players.length;
    this.phase = 'draw';
    this.turnNo++;
    this.currentPlayer.turnStartRegistered = this.currentPlayer.registered;
  }

  _checkOut(p) {
    if (!p.hand.length) this._finishOut(p);
  }

  _finishOut(p) {
    const hula = !p.turnStartRegistered;
    this._log(this._name(p) + '님이 손패를 모두 털었습니다!' + (hula ? ' 훌라!' : ''));
    this._end(hula ? 'hula' : 'out', p.id);
  }

  _endStockEmpty() {
    const totals = this.players.map((p) => R.handPoints(p.hand));
    const min = Math.min.apply(null, totals);
    const lows = this.players.filter((p, i) => totals[i] === min);
    this._log('더미가 모두 소진되어 판이 끝났습니다.');
    if (lows.length === 1) this._end('stockEnd', lows[0].id);
    else this._end('draw', null);
  }

  _end(kind, winnerId, knockerId) {
    const totals = {}, registered = {}, hands = {};
    const ids = this.players.map((p) => p.id);
    for (const p of this.players) {
      totals[p.id] = R.handPoints(p.hand);
      registered[p.id] = p.registered;
      hands[p.id] = p.hand.slice();
    }
    const s = R.settle({ kind, winnerId, knockerId, ids, totals, registered });
    this.phase = 'ended';
    this.result = {
      kind, winnerId: winnerId || null, knockerId: knockerId || null,
      totals, registered, hands, deltas: s.deltas, mults: s.mults
    };
  }

  _describe(m) {
    const L = R.RANK_LABELS;
    if (m.type === 'set') return L[m.rank] + ' 땡(' + m.cards.length + '장)';
    if (m.len === 1) return '7 단독';
    return R.SUIT_CHARS[m.suit] + ' 런(' + m.len + '장)';
  }

  // ───────── 클라이언트용 뷰 ─────────
  view(pid) {
    const me = this.player(pid);
    const cur = this.currentPlayer;
    return {
      phase: this.phase,
      current: cur.id,
      turnNo: this.turnNo,
      players: this.players.map((p) => ({ id: p.id, name: p.name, handCount: p.hand.length, registered: p.registered })),
      hand: me ? me.hand.slice() : [],
      handPoints: me ? R.handPoints(me.hand) : 0,
      stock: this.stock.length,
      discard: this.discard.slice(),
      melds: this.melds.map((m) => Object.assign({}, m, { cards: m.cards.slice() })),
      canStop: !!me && this.canStop(pid),
      canBlast: !!me && this.canBlast(pid),
      canThankYou: !!me && this.canThankYou(pid),
      lastDrawn: me && cur.id === pid ? this.lastDrawn : null,
      stockEmptied: this.stockEmptied,
      log: this.log.slice(-25),
      result: this.result
    };
  }
}

module.exports = { HulaGame, DEFAULT_OPTIONS, HAND_SIZE, shuffle };
