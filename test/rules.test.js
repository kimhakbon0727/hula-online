'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../shared/rules');
const { HulaGame } = require('../lib/game');

const C = (suit, rank) => R.makeCard(suit, rank); // suit 0♠ 1♥ 2♦ 3♣

test('땡: 같은 숫자 3~4장만 등록 가능', () => {
  assert.ok(R.tryMeld([C(0, 5), C(1, 5), C(2, 5)], true));
  assert.ok(R.tryMeld([C(0, 5), C(1, 5), C(2, 5), C(3, 5)], true));
  assert.strictEqual(R.tryMeld([C(0, 5), C(1, 5)], true), null);
  assert.strictEqual(R.tryMeld([C(0, 5), C(1, 5), C(2, 6)], true), null);
});

test('런: 같은 무늬 연속 3장 이상', () => {
  const m = R.tryMeld([C(0, 4), C(0, 2), C(0, 3)], true);
  assert.deepStrictEqual([m.start, m.len], [2, 3]);
  assert.deepStrictEqual(m.cards, [C(0, 2), C(0, 3), C(0, 4)]);
  assert.strictEqual(R.tryMeld([C(0, 2), C(1, 3), C(0, 4)], true), null);
  assert.strictEqual(R.tryMeld([C(0, 2), C(0, 3), C(0, 5)], true), null);
});

test('A는 낮게도 높게도: A-2-3, Q-K-A', () => {
  assert.ok(R.tryMeld([C(2, 1), C(2, 2), C(2, 3)], false));
  assert.ok(R.tryMeld([C(2, 12), C(2, 13), C(2, 1)], false));
});

test('K-A-2 돌아가기는 wrap 옵션이 켜졌을 때만', () => {
  const ids = [C(1, 13), C(1, 1), C(1, 2)];
  assert.ok(R.tryMeld(ids, true));
  assert.strictEqual(R.tryMeld(ids, false), null);
});

test('7 한 장 단독 등록, 다른 숫자 단독은 불가', () => {
  const m = R.tryMeld([C(3, 7)], true);
  assert.ok(m);
  assert.deepStrictEqual([m.start, m.len, m.suit], [7, 1, 3]);
  assert.strictEqual(R.tryMeld([C(3, 8)], true), null);
});

test('단독 7에 같은 무늬 6/8 붙이기, 다른 무늬는 불가', () => {
  let m = R.tryMeld([C(0, 7)], true);
  m = R.tryAttach(m, C(0, 8), true);
  assert.ok(m);
  m = R.tryAttach(m, C(0, 6), true);
  assert.deepStrictEqual([m.start, m.len], [6, 3]);
  assert.strictEqual(R.tryAttach(m, C(1, 9), true), null);
  assert.strictEqual(R.tryAttach(m, C(0, 10), true), null);
  assert.ok(R.tryAttach(m, C(0, 9), true));
  assert.ok(R.tryAttach(m, C(0, 5), true));
});

test('땡에 4번째 카드 붙이기, 5번째는 불가', () => {
  let m = R.tryMeld([C(0, 9), C(1, 9), C(2, 9)], true);
  m = R.tryAttach(m, C(3, 9), true);
  assert.strictEqual(m.cards.length, 4);
  assert.strictEqual(R.tryAttach(m, C(0, 9), true), null);
});

test('돌아가기 옵션 꺼짐: K 뒤에 2 못 붙임 / 켜짐: 붙임', () => {
  const run = R.tryMeld([C(0, 11), C(0, 12), C(0, 13)], true);
  assert.ok(R.tryAttach(run, C(0, 1), true));
  assert.ok(R.tryAttach(run, C(0, 1), false));
  const withA = R.tryAttach(run, C(0, 1), true);
  assert.ok(R.tryAttach(withA, C(0, 2), true));
  const withA2 = R.tryAttach(run, C(0, 1), false);
  assert.strictEqual(R.tryAttach(withA2, C(0, 2), false), null);
});

test('여러 장 한꺼번에 붙이기는 원자적', () => {
  const run = R.tryMeld([C(0, 4), C(0, 5), C(0, 6)], true);
  assert.ok(R.tryAttachMany(run, [C(0, 8), C(0, 7)], true));
  assert.strictEqual(R.tryAttachMany(run, [C(0, 8), C(0, 10)], true), null);
});

test('점수: A=1, J/Q/K=11/12/13, 손에 남은 7=14', () => {
  assert.strictEqual(R.handPoints([C(0, 1), C(0, 11), C(0, 12), C(0, 13), C(0, 7), C(0, 10)]), 1 + 11 + 12 + 13 + 14 + 10);
  assert.strictEqual(R.faceSum([C(0, 7), C(1, 7)]), 14);
});

test('블라스트 조건', () => {
  const low = [C(0, 1), C(1, 1), C(2, 1), C(3, 1), C(0, 2), C(1, 2), C(2, 2)]; // 10
  assert.ok(R.blastEligible(low, false));
  assert.ok(!R.blastEligible(low, true));
  const high = [C(0, 13), C(1, 13), C(2, 13), C(3, 13), C(0, 12), C(1, 12), C(2, 12)]; // 88
  assert.ok(R.blastEligible(high, false));
  const mid = [C(0, 5), C(1, 6), C(2, 8), C(3, 9), C(0, 10), C(1, 3), C(2, 4)];
  assert.ok(!R.blastEligible(mid, false));
});

test('정산: 나감/훌라/등록못함 배수와 제로섬', () => {
  const base = { ids: ['a', 'b', 'c'], totals: { a: 0, b: 10, c: 20 }, registered: { a: true, b: true, c: false }, winnerId: 'a' };
  const out = R.settle(Object.assign({ kind: 'out' }, base));
  assert.deepStrictEqual(out.deltas, { a: 10 + 40, b: -10, c: -40 });
  const hula = R.settle(Object.assign({ kind: 'hula' }, base));
  assert.deepStrictEqual(hula.deltas, { a: 4 * 10 + 4 * 40, b: -40, c: -160 });
  const sum = (d) => Object.values(d).reduce((x, y) => x + y, 0);
  assert.strictEqual(sum(out.deltas), 0);
  assert.strictEqual(sum(hula.deltas), 0);
});

test('정산: 스톱 성공/실패', () => {
  const ok = R.settle({ kind: 'stop', winnerId: 'a', knockerId: 'a', ids: ['a', 'b'], totals: { a: 5, b: 12 }, registered: { a: false, b: true } });
  assert.deepStrictEqual(ok.deltas, { a: 7, b: -7 });
  const fail = R.settle({ kind: 'stopFail', winnerId: 'b', knockerId: 'a', ids: ['a', 'b'], totals: { a: 5, b: 5 }, registered: { a: true, b: true } });
  assert.deepStrictEqual(fail.deltas, { a: -2, b: 2 }); // 차이 0이어도 최소 1점 × 2
});

// ── 게임 진행 ──
function rig(hands, opts, first) {
  const g = new HulaGame(hands.map((_, i) => ({ id: 'p' + i, name: 'P' + i })), opts || {}, () => 0.5, first || 0);
  // 손패를 지정한 카드로 교체하고 나머지는 더미로
  const used = new Set([].concat(...hands));
  hands.forEach((h, i) => { g.players[i].hand = h.slice(); });
  g.stock = Array.from({ length: 52 }, (_, i) => i).filter((i) => !used.has(i));
  g.phase = 'draw';
  g.log = [];
  g.result = null;
  return g;
}

test('손패 전부를 한 턴에 등록하면 hula', () => {
  const h0 = [C(0, 2), C(1, 2), C(2, 2), C(0, 4), C(0, 5), C(0, 6), C(1, 12)];
  const h1 = [C(0, 10), C(1, 11), C(2, 3), C(3, 9), C(0, 13), C(2, 13), C(1, 8)];
  const g = rig([h0, h1]);
  g.stock.push(C(1, 13));
  g.players[0].hand = [C(0, 2), C(1, 2), C(2, 2), C(0, 4), C(0, 5), C(0, 6), C(1, 12)];
  // 뽑은 카드를 K♥로 하고 Q♥와 함께 런을 만들 수 없으니, 대신 7 단독 + 나머지로 구성
  g.players[0].hand = [C(0, 2), C(1, 2), C(2, 2), C(0, 4), C(0, 5), C(0, 6), C(1, 7)];
  g.stock.push(C(3, 3)); // 맨 위: 3♣ (등록 안 됨, 버릴 카드)
  g.draw('p0', 'stock');
  assert.ok(g.meld('p0', [C(0, 2), C(1, 2), C(2, 2)]).ok);
  assert.ok(g.meld('p0', [C(0, 4), C(0, 5), C(0, 6)]).ok);
  assert.ok(g.meld('p0', [C(1, 7)]).ok);
  assert.ok(g.discardCard('p0', C(3, 3)).ok);
  assert.strictEqual(g.phase, 'ended');
  assert.strictEqual(g.result.kind, 'hula');
  assert.strictEqual(g.result.winnerId, 'p0');
  const loss = g.result.deltas.p1;
  assert.strictEqual(loss, -(R.handPoints(h1) * 4 * 2)); // 훌라 ×4, p1은 등록 못했으므로 ×2 추가
});

test('등록 전에는 붙이기 불가, 등록 후 가능', () => {
  const h0 = [C(0, 7), C(0, 1), C(1, 3), C(2, 4), C(3, 10), C(3, 11), C(2, 13)];
  const h1 = [C(0, 8), C(1, 3), C(2, 9), C(3, 1), C(1, 10), C(1, 11), C(2, 5)];
  const g = rig([h0, h1]);
  g.stock.push(C(0, 6));
  g.draw('p0', 'stock'); // 6♠
  assert.ok(g.meld('p0', [C(0, 7)]).ok);          // 7♠ 단독 등록
  assert.ok(g.attach('p0', 1, [C(0, 6)]).ok);     // 6♠ 붙이기
  assert.ok(g.discardCard('p0', C(2, 13)).ok);
  // p1 차례: 등록 전이라 붙이기 불가
  g.draw('p1', 'stock');
  const r = g.attach('p1', 1, [C(0, 8)]);
  assert.strictEqual(r.ok, false);
});

test('스톱: 성공/실패(동점은 스톱한 사람이 짐)', () => {
  const h0 = [C(0, 1), C(1, 1), C(2, 1), C(3, 1), C(0, 2), C(1, 2), C(2, 2)]; // 10점
  const h1 = [C(0, 13), C(1, 12), C(2, 11), C(3, 10), C(0, 9), C(1, 8), C(2, 6)];
  const g = rig([h0, h1]);
  assert.ok(g.canStop('p0'));
  assert.ok(g.stop('p0').ok);
  assert.strictEqual(g.result.kind, 'stop');
  assert.strictEqual(g.result.winnerId, 'p0');

  const t0 = [C(0, 1), C(1, 1), C(2, 1), C(3, 1), C(0, 2), C(1, 2), C(2, 2)]; // 10점
  const t1 = [C(0, 3), C(1, 3), C(2, 3), C(3, 3), C(0, 4), C(1, 4), C(2, 4)]; // 더 큼
  const g2 = rig([t0, t1]);
  assert.ok(g2.stop('p0').ok);
  assert.strictEqual(g2.result.kind, 'stop');

  // 동점이면 스톱한 사람이 진다
  const k0 = [C(0, 1), C(1, 1), C(0, 2), C(1, 2), C(0, 3), C(1, 3), C(0, 10)]; // 22
  const k1 = [C(2, 1), C(3, 1), C(2, 2), C(3, 2), C(2, 3), C(3, 3), C(1, 10)]; // 22
  assert.strictEqual(R.handPoints(k0), R.handPoints(k1));
  const g3 = rig([k0, k1], { stopLimit: 22 });
  assert.ok(g3.stop('p0').ok);
  assert.strictEqual(g3.result.kind, 'stopFail');
  assert.strictEqual(g3.result.winnerId, 'p1');
  assert.ok(g3.result.deltas.p0 < 0);
});

test('스톱 점수 초과면 거부', () => {
  const g = rig([
    [C(0, 13), C(1, 12), C(2, 11), C(3, 10), C(0, 9), C(1, 8), C(2, 6)],
    [C(0, 1), C(1, 1), C(2, 1), C(3, 1), C(0, 2), C(1, 2), C(2, 2)]
  ]);
  assert.strictEqual(g.stop('p0').ok, false);
});

test('7 네 장을 모으면 즉시 승리', () => {
  const h0 = [C(0, 7), C(1, 7), C(2, 7), C(0, 1), C(0, 2), C(0, 3), C(1, 13)];
  const h1 = [C(0, 8), C(1, 9), C(2, 10), C(3, 11), C(0, 12), C(1, 12), C(2, 13)];
  const g = rig([h0, h1]);
  g.stock.push(C(3, 7));
  g.draw('p0', 'stock');
  assert.strictEqual(g.phase, 'ended');
  assert.strictEqual(g.result.kind, 'fourSevens');
  assert.strictEqual(g.result.winnerId, 'p0');
});

test('더미 소진: 마지막 카드를 뽑은 사람이 차례를 마치면 판 종료, 최저점 승', () => {
  const h0 = [C(0, 1), C(1, 3), C(2, 5), C(3, 9), C(0, 10), C(1, 12), C(2, 13)];
  const h1 = [C(0, 2), C(1, 4), C(2, 6), C(3, 8), C(0, 9), C(1, 10), C(2, 11)];
  const g = rig([h0, h1]);
  g.stock = [C(3, 2)]; // 마지막 한 장
  g.draw('p0', 'stock');
  assert.ok(g.stockEmptied);
  assert.ok(g.discardCard('p0', C(2, 13)).ok);
  assert.strictEqual(g.phase, 'ended');
  assert.strictEqual(g.result.kind, 'stockEnd');
  const t = g.result.totals;
  assert.ok(t.p0 < t.p1 ? g.result.winnerId === 'p0' : g.result.winnerId === 'p1');
});

test('땡큐: 옵션 꺼짐이면 거부, 켜짐이면 차례가 넘어옴', () => {
  const h0 = [C(0, 1), C(1, 3), C(2, 5), C(3, 9), C(0, 10), C(1, 12), C(2, 13)];
  const h1 = [C(0, 2), C(1, 4), C(2, 6), C(3, 8), C(0, 9), C(1, 10), C(2, 11)];
  const h2 = [C(0, 6), C(1, 6), C(2, 3), C(3, 12), C(1, 11), C(2, 2), C(3, 4)];
  const off = rig([h0, h1, h2]);
  off.draw('p0', 'stock');
  off.discardCard('p0', C(3, 6));
  assert.strictEqual(off.thankYou('p2', [C(0, 6), C(1, 6)]).ok, false);

  const on = rig([h0, h1, h2], { thankYou: true });
  on.draw('p0', 'stock');
  // p0이 6♣을 버렸다고 가정
  on.players[0].hand.push(C(3, 6));
  on.discardCard('p0', C(3, 6));
  assert.ok(on.canThankYou('p2'));
  assert.ok(!on.canThankYou('p0')); // 버린 본인은 불가
  const r = on.thankYou('p2', [C(0, 6), C(1, 6)]);
  assert.ok(r.ok, r.error);
  assert.strictEqual(on.currentPlayer.id, 'p2');
  assert.strictEqual(on.phase, 'play');
  assert.strictEqual(on.melds.length, 1);
  assert.ok(on.discardCard('p2', C(3, 12)).ok);
  assert.strictEqual(on.currentPlayer.id, 'p0'); // p2 다음은 p0
});

test('이미 뽑은 뒤 다시 뽑기 / 남의 차례 행동 거부', () => {
  const g = rig([
    [C(0, 1), C(1, 3), C(2, 5), C(3, 9), C(0, 10), C(1, 12), C(2, 13)],
    [C(0, 2), C(1, 4), C(2, 6), C(3, 8), C(0, 9), C(1, 10), C(2, 11)]
  ]);
  assert.strictEqual(g.draw('p1', 'stock').ok, false);
  assert.ok(g.draw('p0', 'stock').ok);
  assert.strictEqual(g.draw('p0', 'stock').ok, false);
  assert.strictEqual(g.discardCard('p1', C(0, 2)).ok, false);
});

test('bestPartition: 가능한 멜드 조합을 최대한 털어냄', () => {
  const hand = [C(0, 3), C(0, 4), C(0, 5), C(1, 9), C(2, 9), C(3, 9), C(1, 7), C(2, 12)];
  const best = R.bestPartition(hand, true);
  const melded = [].concat(...best.picks).length;
  assert.strictEqual(melded, 7); // 런3 + 땡3 + 7단독
});
