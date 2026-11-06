'use strict';
/* 봇끼리 수천 판을 돌려 규칙이 깨지지 않는지 확인한다. 사용: node test/sim.js [판수] */
const R = require('../shared/rules');
const { HulaGame } = require('../lib/game');
const { botStep } = require('../lib/bot');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function checkInvariants(g, label) {
  const all = [];
  for (const p of g.players) all.push(...p.hand);
  all.push(...g.stock, ...g.discard);
  for (const m of g.melds) all.push(...m.cards);
  if (all.length !== 52 || new Set(all).size !== 52) throw new Error(label + ': 카드 보존 위반 ' + all.length);
  for (const m of g.melds) {
    if (m.type === 'set') {
      if (m.cards.length < 3 || m.cards.length > 4) throw new Error(label + ': 땡 장수 이상');
      if (new Set(m.cards.map(R.suitOf)).size !== m.cards.length) throw new Error(label + ': 땡 무늬 중복');
      if (!m.cards.every((c) => R.rankOf(c) === m.rank)) throw new Error(label + ': 땡 숫자 불일치');
    } else {
      const ranks = R.runRanks(m.start, m.len, g.options.wrap);
      if (!ranks) throw new Error(label + ': 런 범위 이상');
      m.cards.forEach((c, i) => {
        if (R.rankOf(c) !== ranks[i] || R.suitOf(c) !== m.suit) throw new Error(label + ': 런 카드 불일치');
      });
      if (m.len !== 1 && m.len < 3 && !(m.len === 2 && m.cards.some((c) => R.rankOf(c) === 7))) {
        throw new Error(label + ': 런 길이 이상 ' + m.len);
      }
    }
  }
}

const N = parseInt(process.argv[2] || '2000', 10);
const stats = {};
let maxTurns = 0;
const t0 = Date.now();
for (let n = 0; n < N; n++) {
  const rng = mulberry32(n + 1);
  const count = 2 + Math.floor(rng() * 4);
  const opts = { wrap: rng() < 0.7, thankYou: false, stopLimit: [7, 10, 15][Math.floor(rng() * 3)] };
  const players = Array.from({ length: count }, (_, i) => ({ id: 'b' + i, name: 'B' + i }));
  const g = new HulaGame(players, opts, rng, Math.floor(rng() * count));
  let guard = 0;
  while (g.phase !== 'ended') {
    if (++guard > 3000) throw new Error('무한 루프 의심 (seed ' + n + ')');
    const pid = g.currentPlayer.id;
    const { result } = botStep(g, pid);
    if (!result.ok) throw new Error('봇 동작 실패: ' + result.error + ' (seed ' + n + ')');
    checkInvariants(g, 'seed ' + n);
  }
  const r = g.result;
  stats[r.kind] = (stats[r.kind] || 0) + 1;
  maxTurns = Math.max(maxTurns, g.turnNo);
  const sum = Object.values(r.deltas).reduce((a, b) => a + b, 0);
  if (sum !== 0) throw new Error('정산이 제로섬이 아님 (seed ' + n + ')');
  if (r.winnerId) {
    for (const [id, d] of Object.entries(r.deltas)) {
      if (id !== r.winnerId && d > 0) throw new Error('패자가 이득을 봄 (seed ' + n + ')');
    }
  }
}
console.log('OK ' + N + '판, ' + (Date.now() - t0) + 'ms, 최대 턴 ' + maxTurns);
console.log('종료 유형:', JSON.stringify(stats));
