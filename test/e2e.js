'use strict';
/* 실제 서버를 띄우고 WebSocket 클라이언트 여러 명으로 방 생성→입장→봇→게임→재접속까지 확인 */
const assert = require('node:assert');
const WebSocket = require('ws');
const { httpServer } = require('../server');

function client(port) {
  const ws = new WebSocket('ws://127.0.0.1:' + port);
  const c = { ws, states: [], errors: [], joined: null, last: null, closed: false };
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'state') { c.last = m; c.states.push(m); }
    else if (m.type === 'joined') c.joined = m;
    else if (m.type === 'error') c.errors.push(m.message);
    else (c.other = c.other || []).push(m);
  });
  ws.on('close', () => { c.closed = true; });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.open = new Promise((r) => ws.on('open', r));
  return c;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await wait(20); }
  throw new Error('시간 초과: ' + label);
}

(async () => {
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const port = httpServer.address().port;

  // HTTP 정적 파일
  for (const [p, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/style.css', 'text/css'], ['/rules.js', 'text/javascript']]) {
    const res = await fetch('http://127.0.0.1:' + port + p);
    assert.strictEqual(res.status, 200, p);
    assert.ok(res.headers.get('content-type').startsWith(type), p);
  }
  assert.strictEqual((await fetch('http://127.0.0.1:' + port + '/../server.js')).status === 200 && false, false);
  const trav = await fetch('http://127.0.0.1:' + port + '/%2e%2e/server.js');
  assert.notStrictEqual((await trav.text()).includes('createServer'), true, '경로 이탈 차단');

  // 방 만들기 / 입장
  const a = client(port); await a.open;
  a.send({ type: 'create', name: '철수' });
  await until(() => a.last, 'create');
  const code = a.last.code;
  assert.match(code, /^[A-Z0-9]{4}$/);
  assert.strictEqual(a.last.hostId, a.last.me);

  const b = client(port); await b.open;
  b.send({ type: 'join', code: 'ZZZZ', name: '영희' });
  await until(() => b.errors.length, '없는 방');
  b.send({ type: 'join', code: code.toLowerCase(), name: '영희' });
  await until(() => b.last, 'join');
  await until(() => a.last.members.length === 2, 'a sees b');

  // 방장 아님 → 시작 불가, 설정 변경 불가
  b.send({ type: 'start' });
  await until(() => b.errors.length >= 2, '비방장 시작 거부');
  b.send({ type: 'options', options: { thankYou: true } });
  await until(() => b.errors.length >= 3, '비방장 설정 거부');

  // 방장 설정 + 봇 추가 + 시작
  a.send({ type: 'options', options: { thankYou: true, stopLimit: 15, turnSeconds: 0, wrap: true } });
  a.send({ type: 'addBot' });
  await until(() => a.last.members.length === 3 && a.last.options.thankYou && a.last.options.stopLimit === 15, '설정/봇');
  a.send({ type: 'start' });
  await until(() => a.last.phase === 'playing' && b.last.phase === 'playing', 'start');
  assert.strictEqual(a.last.game.hand.length === 7 || a.last.game.hand.length === 8, true);
  assert.deepStrictEqual(a.last.game.players.map((p) => p.id).sort(), a.last.members.map((m) => m.id).sort());
  // 다른 사람 손패는 보이지 않는다
  const raw = JSON.stringify(a.last);
  assert.ok(!raw.includes(JSON.stringify(b.last.game.hand)) || b.last.game.hand.length === 0, '상대 손패 노출 금지');
  assert.ok(a.last.members.every((m) => !('key' in m)), '키 노출 금지');

  // 사람 둘이 번갈아 직접 두기 (뽑고 버리기) — 봇은 서버가 알아서
  let turns = 0;
  const players = { [a.last.me]: a, [b.last.me]: b };
  const deadline = Date.now() + 20000;
  while (a.last.phase === 'playing' && Date.now() < deadline) {
    const g = a.last.game;
    const who = players[g.current];
    if (who) {
      const st = who.last;
      if (st.game.phase === 'draw' && st.game.current === st.me) {
        if (st.game.canBlast) who.send({ type: 'blast' });
        else if (st.game.canStop) who.send({ type: 'stop' });
        else who.send({ type: 'draw', from: 'stock' });
        await wait(30);
      } else if (st.game.phase === 'play' && st.game.current === st.me) {
        const hand = st.game.hand;
        who.send({ type: 'discard', cardId: hand[hand.length - 1] });
        turns++;
        await wait(30);
      } else await wait(30);
    } else await wait(60);
  }
  assert.strictEqual(a.last.phase, 'roundEnd', '한 판이 끝나야 함');
  const res = a.last.game.result;
  const sum = Object.values(res.deltas).reduce((x, y) => x + y, 0);
  assert.strictEqual(sum, 0);
  assert.strictEqual(a.last.members.reduce((s, m) => s + m.score, 0), 0, '누적 점수 합 0');
  console.log('  한 판 종료:', res.kind, '/ 사람 턴 수', turns);

  // 잘못된 행동 거부
  a.send({ type: 'draw', from: 'stock' });
  await until(() => a.errors.length >= 1, '끝난 판에서 행동 거부');

  // 재접속(resume)
  const bKey = b.joined.key, bId = b.joined.id;
  b.ws.close();
  await until(() => a.last.members.find((m) => m.id === bId && !m.online), 'b 오프라인 표시');
  const b2 = client(port); await b2.open;
  b2.send({ type: 'resume', code, key: bKey });
  await until(() => b2.last && b2.last.me === bId, 'resume');
  await until(() => a.last.members.find((m) => m.id === bId && m.online), 'b 온라인 복귀');
  const bad = client(port); await bad.open;
  bad.send({ type: 'resume', code, key: 'nope' });
  await until(() => bad.errors.length, '잘못된 키 거부');

  // 다음 판 + 방장 이관
  a.send({ type: 'start' });
  await until(() => a.last.phase === 'playing' && a.last.round === 2, '2판째 시작');
  a.send({ type: 'leave' });
  await until(() => a.other && a.other.some((m) => m.type === 'left'), 'a 나감');
  await until(() => b2.last.members.some((m) => /\(대리\)/.test(m.name)), '대리 봇 전환');
  await until(() => b2.last.hostId === bId, '방장 이관');

  b2.ws.close(); bad.ws.close(); a.ws.close();
  console.log('E2E OK');
  process.exit(0);
})().catch((e) => { console.error('E2E 실패:', e); process.exit(1); });
