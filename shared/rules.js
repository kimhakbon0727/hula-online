/*
 * 훌라 규칙 (서버/브라우저 공용)
 *
 * 카드 id: 0..51
 *   무늬 = floor(id / 13)  (0 ♠, 1 ♥, 2 ♦, 3 ♣)
 *   숫자 = id % 13 + 1     (1=A, 11=J, 12=Q, 13=K)
 *
 * 멜드 모양
 *   땡(set) : { type:'set', rank, cards:[...] }              같은 숫자 3~4장 (무늬 모두 다름)
 *   런(run) : { type:'run', suit, start, len, cards:[...] }  같은 무늬 연속 숫자 3장 이상
 *             start 숫자부터 오름차순. 7 한 장 단독 등록도 len=1 런으로 표현한다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HulaRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SUIT_CHARS = ['♠', '♥', '♦', '♣'];
  const RANK_LABELS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

  // 정산 배수 (여기 숫자만 바꾸면 점수 규칙이 바뀐다)
  const MULT = {
    hula: 4,        // 첫 등록과 동시에 한 턴에 모두 털고 나감
    blast: 2,       // 블라스트 승리
    fourSevens: 2,  // 7 네 장 승리
    noRegister: 2,  // 한 번도 등록 못 하고 진 사람
    stopFail: 2     // 스톱 실패한 사람
  };

  const suitOf = (id) => Math.floor(id / 13);
  const rankOf = (id) => (id % 13) + 1;
  const makeCard = (suit, rank) => suit * 13 + rank - 1;

  /** 손에 남았을 때 점수: A=1, 2~10, J=11, Q=12, K=13, 7은 14 */
  function handCardPoints(id) {
    const r = rankOf(id);
    return r === 7 ? 14 : r;
  }
  function handPoints(ids) {
    let s = 0;
    for (const id of ids) s += handCardPoints(id);
    return s;
  }
  /** 블라스트 판정용: 7도 7점 */
  function faceSum(ids) {
    let s = 0;
    for (const id of ids) s += rankOf(id);
    return s;
  }

  /** 런이 가지는 숫자 열. wrap=true면 K-A-2 처럼 돌아가기 허용. */
  function runRanks(start, len, wrap) {
    if (len < 1 || len > 13 || start < 1 || start > 13) return null;
    const out = [];
    if (wrap) {
      for (let i = 0; i < len; i++) out.push(((start - 1 + i) % 13) + 1);
      return out;
    }
    if (start + len - 1 > 14) return null; // 14 = A를 K 뒤에 높은 A로 쓰는 경우
    for (let i = 0; i < len; i++) {
      const n = start + i;
      out.push(n === 14 ? 1 : n);
    }
    return out;
  }

  /** 같은 무늬 카드들을 런으로 배열. 실패하면 null */
  function arrangeRun(ids, wrap) {
    const n = ids.length;
    if (n < 3 || n > 13) return null;
    const suit = suitOf(ids[0]);
    const byRank = new Map();
    for (const id of ids) {
      if (suitOf(id) !== suit) return null;
      const r = rankOf(id);
      if (byRank.has(r)) return null;
      byRank.set(r, id);
    }
    const starts = [];
    if (wrap) for (const r of byRank.keys()) starts.push(r);
    else for (let s = 1; s <= 15 - n; s++) starts.push(s);
    for (const s of starts) {
      const ranks = runRanks(s, n, wrap);
      if (ranks && ranks.every((r) => byRank.has(r))) {
        return { type: 'run', suit, start: s, len: n, cards: ranks.map((r) => byRank.get(r)) };
      }
    }
    return null;
  }

  /** 손패에서 새로 등록하는 조합이 유효한지. 유효하면 멜드 객체(id/owner 없음), 아니면 null */
  function tryMeld(ids, wrap) {
    const n = ids.length;
    if (n === 1) {
      return rankOf(ids[0]) === 7
        ? { type: 'run', suit: suitOf(ids[0]), start: 7, len: 1, cards: [ids[0]] }
        : null;
    }
    if (n < 3) return null;
    const r0 = rankOf(ids[0]);
    if (ids.every((i) => rankOf(i) === r0)) {
      if (n > 4) return null;
      const suits = new Set(ids.map(suitOf));
      return suits.size === n ? { type: 'set', rank: r0, cards: ids.slice() } : null;
    }
    return arrangeRun(ids, wrap);
  }

  /** 이미 놓인 멜드에 카드 한 장 붙이기. 되면 새 멜드, 안 되면 null */
  function tryAttach(meld, id, wrap) {
    const r = rankOf(id);
    const s = suitOf(id);
    if (meld.type === 'set') {
      if (r !== meld.rank || meld.cards.length >= 4) return null;
      if (meld.cards.some((c) => suitOf(c) === s)) return null;
      return Object.assign({}, meld, { cards: meld.cards.concat([id]) });
    }
    if (s !== meld.suit || meld.len >= 13) return null;
    const next = runRanks(meld.start, meld.len + 1, wrap);
    if (next && next[next.length - 1] === r) {
      return Object.assign({}, meld, { len: meld.len + 1, cards: meld.cards.concat([id]) });
    }
    let ps;
    if (wrap) ps = meld.start === 1 ? 13 : meld.start - 1;
    else {
      if (meld.start <= 1) return null;
      ps = meld.start - 1;
    }
    if (ps === r) {
      return Object.assign({}, meld, { start: ps, len: meld.len + 1, cards: [id].concat(meld.cards) });
    }
    return null;
  }

  /** 여러 장을 한 멜드에 붙이기(원자적). 전부 붙으면 새 멜드, 하나라도 못 붙으면 null */
  function tryAttachMany(meld, ids, wrap) {
    let cur = meld;
    let rest = ids.slice();
    while (rest.length) {
      let progressed = false;
      for (let i = 0; i < rest.length; i++) {
        const nm = tryAttach(cur, rest[i], wrap);
        if (nm) {
          cur = nm;
          rest.splice(i, 1);
          progressed = true;
          break;
        }
      }
      if (!progressed) return null;
    }
    return cur;
  }

  /** ids 안에서 만들 수 있는 모든 멜드 후보(카드 id 배열들) */
  function meldCandidates(ids, wrap) {
    const out = [];
    const byRank = {};
    for (const id of ids) (byRank[rankOf(id)] = byRank[rankOf(id)] || []).push(id);
    for (const r of Object.keys(byRank)) {
      const g = byRank[r];
      if (g.length >= 3) {
        for (let i = 0; i < g.length; i++)
          for (let j = i + 1; j < g.length; j++)
            for (let k = j + 1; k < g.length; k++) out.push([g[i], g[j], g[k]]);
        if (g.length === 4) out.push(g.slice());
      }
    }
    for (let s = 0; s < 4; s++) {
      const have = new Map();
      for (const id of ids) if (suitOf(id) === s) have.set(rankOf(id), id);
      if (have.size < 3) continue;
      for (let start = 1; start <= 13; start++) {
        for (let len = 3; len <= 13; len++) {
          const ranks = runRanks(start, len, wrap);
          if (!ranks || !ranks.every((r) => have.has(r))) break;
          out.push(ranks.map((r) => have.get(r)));
        }
      }
    }
    for (const id of ids) if (rankOf(id) === 7) out.push([id]);
    return out;
  }

  /** 손패를 가장 많이(점수 기준) 털어내는 멜드 조합. { val, picks:[[...],...] } */
  function bestPartition(ids, wrap) {
    const idx = new Map(ids.map((id, i) => [id, i]));
    const cands = meldCandidates(ids, wrap).map((c) => ({
      cards: c,
      mask: c.reduce((m, id) => m | (1 << idx.get(id)), 0),
      val: c.reduce((s, id) => s + handCardPoints(id), 0)
    }));
    const memo = new Map();
    function go(i, used) {
      if (i === cands.length) return { val: 0, picks: [] };
      const key = i * 16384 + used;
      if (memo.has(key)) return memo.get(key);
      let best = go(i + 1, used);
      const c = cands[i];
      if ((c.mask & used) === 0) {
        const sub = go(i + 1, used | c.mask);
        const v = sub.val + c.val;
        if (v > best.val) best = { val: v, picks: [c.cards].concat(sub.picks) };
      }
      memo.set(key, best);
      return best;
    }
    return go(0, 0);
  }

  function hasFourSevens(hand) {
    let n = 0;
    for (const id of hand) if (rankOf(id) === 7) n++;
    return n === 4;
  }

  /** 블라스트: 등록한 적 없고 손패가 7장일 때 합계(7=7점)가 15 이하이거나 83 이상 */
  function blastEligible(hand, registered) {
    if (registered || hand.length !== 7) return false;
    const f = faceSum(hand);
    return f <= 15 || f >= 83;
  }

  /**
   * 라운드 정산 (제로섬).
   * o = { kind, winnerId, knockerId, ids:[...], totals:{id:n}, registered:{id:bool} }
   * kind: out | hula | stop | stopFail | blast | fourSevens | stockEnd | draw
   */
  function settle(o) {
    const deltas = {};
    const mults = {};
    for (const id of o.ids) deltas[id] = 0;
    if (o.kind === 'draw' || o.winnerId == null) return { deltas, mults };
    const zeroBase = ['out', 'hula', 'blast', 'fourSevens'].includes(o.kind);
    const wTotal = zeroBase ? 0 : o.totals[o.winnerId];
    const kindMult = o.kind === 'hula' ? MULT.hula
      : o.kind === 'blast' ? MULT.blast
      : o.kind === 'fourSevens' ? MULT.fourSevens : 1;
    for (const id of o.ids) {
      if (id === o.winnerId) continue;
      let diff = o.totals[id] - wTotal;
      let m = kindMult;
      if (!o.registered[id]) m *= MULT.noRegister;
      if (o.kind === 'stopFail' && id === o.knockerId) {
        diff = Math.max(1, diff);
        m *= MULT.stopFail;
      }
      const pay = Math.max(0, diff) * m;
      mults[id] = m;
      deltas[id] -= pay;
      deltas[o.winnerId] += pay;
    }
    return { deltas, mults };
  }

  return {
    SUIT_CHARS, RANK_LABELS, MULT,
    suitOf, rankOf, makeCard,
    handCardPoints, handPoints, faceSum,
    runRanks, arrangeRun, tryMeld, tryAttach, tryAttachMany,
    meldCandidates, bestPartition,
    hasFourSevens, blastEligible, settle
  };
});
