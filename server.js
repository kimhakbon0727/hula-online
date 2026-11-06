'use strict';
/*
 * 훌라 온라인 서버
 *   node server.js            (기본 포트 3000)
 *   PORT=8080 node server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { Room, cleanName } = require('./lib/room');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_ROOMS = 200;
const ROOM_IDLE_MS = 30 * 60 * 1000;

const PUBLIC_DIR = path.join(__dirname, 'public');
const SHARED_DIR = path.join(__dirname, 'shared');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

// ───────── 정적 파일 ─────────
function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
}

const httpServer = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { pathname = '/'; }
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (pathname === '/rules.js') return serveFile(res, path.join(SHARED_DIR, 'rules.js'));
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  serveFile(res, file);
});

// ───────── 방 관리 ─────────
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  for (let i = 0; i < 100; i++) {
    let c = '';
    for (let k = 0; k < 4; k++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

function normCode(s) {
  return typeof s === 'string' ? s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) : '';
}

function sendTo(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function fail(ws, message, extra) {
  sendTo(ws, Object.assign({ type: 'error', message }, extra || {}));
}

function bind(ws, room, member) {
  if (member.ws && member.ws !== ws) {
    sendTo(member.ws, { type: 'replaced' });
    const old = member.ws;
    member.ws = null;
    old.ctx = null;
    old.close(4000, 'replaced');
  }
  member.ws = ws;
  ws.ctx = { room, memberId: member.id };
  room.emptySince = null;
  sendTo(ws, { type: 'joined', code: room.code, key: member.key, id: member.id });
  room._reassignHost();
  room.afterChange();
}

function handleMessage(ws, msg) {
  if (!msg || typeof msg.type !== 'string') return;
  const ctx = ws.ctx;

  if (!ctx) {
    switch (msg.type) {
      case 'create': {
        if (rooms.size >= MAX_ROOMS) return fail(ws, '지금은 방을 더 만들 수 없습니다.');
        const code = newCode();
        if (!code) return fail(ws, '방 코드를 만들지 못했습니다.');
        const room = new Room(code);
        rooms.set(code, room);
        const m = room.addHuman(cleanName(msg.name), null);
        bind(ws, room, m);
        return;
      }
      case 'join': {
        const room = rooms.get(normCode(msg.code));
        if (!room) return fail(ws, '그런 방이 없습니다. 코드를 다시 확인하세요.');
        if (room.phase === 'playing') return fail(ws, '이미 게임이 진행 중입니다. 끝난 뒤에 들어올 수 있어요.');
        if (room.members.length >= 5) return fail(ws, '방이 가득 찼습니다. (최대 5명)');
        const m = room.addHuman(cleanName(msg.name), null);
        bind(ws, room, m);
        return;
      }
      case 'resume': {
        const room = rooms.get(normCode(msg.code));
        const m = room && typeof msg.key === 'string' ? room.byKey(msg.key) : null;
        if (!room || !m) return fail(ws, '이전 방을 찾을 수 없습니다.', { resumeFailed: true });
        bind(ws, room, m);
        return;
      }
      case 'ping': return sendTo(ws, { type: 'pong' });
      default: return fail(ws, '먼저 방에 들어가세요.');
    }
  }

  const room = ctx.room;
  const m = room.member(ctx.memberId);
  if (!m || room.dead) return;
  let err = null;
  switch (msg.type) {
    case 'ping': return sendTo(ws, { type: 'pong' });
    case 'options': err = room.setOptions(m, msg.options); break;
    case 'addBot': err = room.botAdd(m); break;
    case 'removeBot': err = room.botRemove(m, msg.id); break;
    case 'kick': err = room.kick(m, msg.id); break;
    case 'start': err = room.start(m); break;
    case 'toLobby': err = room.toLobby(m); break;
    case 'resetScores': err = room.resetScores(m); break;
    case 'leave': {
      ws.ctx = null;
      room.leave(m);
      sendTo(ws, { type: 'left' });
      return;
    }
    case 'draw': case 'meld': case 'attach': case 'discard':
    case 'stop': case 'blast': case 'thankyou':
      err = room.act(m, msg); break;
    default: err = '알 수 없는 요청입니다.';
  }
  if (err) fail(ws, err);
}

// ───────── WebSocket ─────────
const wss = new WebSocketServer({ server: httpServer, maxPayload: 16 * 1024 });

wss.on('connection', (ws) => {
  ws.ctx = null;
  ws.isAlive = true;
  ws.msgCount = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    if (++ws.msgCount > 200) return; // 10초당 200개까지만 처리
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    try {
      handleMessage(ws, msg);
    } catch (e) {
      console.error('handler error:', e);
      fail(ws, '서버 오류가 발생했습니다.');
    }
  });
  ws.on('close', () => {
    const ctx = ws.ctx;
    if (!ctx) return;
    const m = ctx.room.member(ctx.memberId);
    if (m && m.ws === ws) ctx.room.disconnect(m);
  });
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    ws.msgCount = 0;
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  }
}, 10000);

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const idle = room.dead || (room.emptySince && now - room.emptySince > ROOM_IDLE_MS) || !room.humans().length;
    if (idle) {
      room.destroy();
      rooms.delete(code);
    }
  }
}, 60000);

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}

if (require.main === module) {
  httpServer.listen(PORT, HOST, () => {
    console.log('훌라 서버 시작: http://localhost:' + PORT);
    for (const a of lanAddresses()) console.log('  같은 네트워크: http://' + a + ':' + PORT);
  });
}

module.exports = { httpServer, wss, rooms };
