'use strict';
/*
 * 봇(그리고 자리 비운 사람 대신 두는 자동 진행) 로직.
 * chooseAction()은 현재 상태에서 "다음 한 동작"만 돌려준다. 서버가 동작 사이에 시간 간격을 둔다.
 */
const R = require('../shared/rules');

/** 같은 숫자/이웃 숫자 때문에 이 카드가 손패에서 얼마나 쓸모 있는지 */
function usefulness(card, others, wrap) {
  const r = R.rankOf(card);
  const s = R.suitOf(card);
  let u = 0;
  for (const c of others) {
    if (c === card) continue;
    const cr = R.rankOf(c);
    if (cr === r) u += 3;
    if (R.suitOf(c) === s) {
      let d = Math.abs(cr - r);
      if (wrap) d = Math.min(d, 13 - d);
      else {
        // A를 높은 A(14)로도 볼 수 있다
        const a = r === 1 ? 14 : r;
        const b = cr === 1 ? 14 : cr;
        d = Math.min(d, Math.abs(a - b));
      }
      if (d === 1) u += 2.5;
      else if (d === 2) u += 1.5;
    }
  }
  return u;
}

function wantsDiscardTop(game, p) {
  if (!game.discard.length) return false;
  // 서로 버린 카드만 주고받으며 끝없이 도는 것을 막는다
  if (game.discardStreak >= game.players.length * 2) return false;
  const top = game.discard[game.discard.length - 1];
  const wrap = game.options.wrap;
  if (p.registered && game.melds.some((m) => R.tryAttach(m, top, wrap))) return true;
  const before = R.bestPartition(p.hand, wrap).val;
  const after = R.bestPartition(p.hand.concat([top]), wrap).val;
  if (after > before) return true;
  return usefulness(top, p.hand, wrap) >= 3 && R.handCardPoints(top) <= 10;
}

function chooseAction(game, pid, opts) {
  const allowStop = !opts || opts.allowStop !== false;
  const p = game.player(pid);
  const wrap = game.options.wrap;

  if (game.phase === 'draw') {
    if (game.canBlast(pid)) return { type: 'blast' };
    if (allowStop && game.canStop(pid)) {
      const t = R.handPoints(p.hand);
      if (t <= Math.min(game.options.stopLimit, 7)) return { type: 'stop' };
    }
    return { type: 'draw', from: wantsDiscardTop(game, p) ? 'discard' : 'stock' };
  }

  // play 단계: 등록 → 붙이기 → 버리기
  const part = R.bestPartition(p.hand, wrap);
  if (part.picks.length) return { type: 'meld', cardIds: part.picks[0] };

  if (p.registered) {
    const sorted = p.hand.slice().sort((a, b) => R.handCardPoints(b) - R.handCardPoints(a));
    for (const c of sorted) {
      for (const m of game.melds) {
        if (R.tryAttach(m, c, wrap)) return { type: 'attach', meldId: m.id, cardIds: [c] };
      }
    }
  }

  let best = p.hand[0];
  let bestScore = -Infinity;
  for (const c of p.hand) {
    // 방금 버린 카드를 가져왔다면 그 카드를 다시 버리지 않는다
    if (p.hand.length > 1 && game.lastDrawSource === 'discard' && c === game.lastDrawn) continue;
    const sc = R.handCardPoints(c) - 3.5 * usefulness(c, p.hand, wrap);
    if (sc > bestScore) { bestScore = sc; best = c; }
  }
  return { type: 'discard', cardId: best };
}

/** 선택된 동작을 게임에 적용. 실패하면 안전한 대체 동작(뽑기/버리기)으로 진행 */
function applyAction(game, pid, a) {
  let r;
  switch (a.type) {
    case 'blast': r = game.blast(pid); break;
    case 'stop': r = game.stop(pid); break;
    case 'draw': r = game.draw(pid, a.from); break;
    case 'meld': r = game.meld(pid, a.cardIds); break;
    case 'attach': r = game.attach(pid, a.meldId, a.cardIds); break;
    case 'discard': r = game.discardCard(pid, a.cardId); break;
    default: r = { ok: false, error: 'unknown' };
  }
  if (r.ok) return r;
  // 대체 동작
  if (game.phase === 'draw' && game.currentPlayer.id === pid) return game.draw(pid, 'stock');
  if (game.phase === 'play' && game.currentPlayer.id === pid) {
    const p = game.player(pid);
    return game.discardCard(pid, p.hand[p.hand.length - 1]);
  }
  return r;
}

function botStep(game, pid, opts) {
  const a = chooseAction(game, pid, opts);
  return { action: a, result: applyAction(game, pid, a) };
}

module.exports = { chooseAction, applyAction, botStep, usefulness };
