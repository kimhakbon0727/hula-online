'use strict';
/* 훌라 클라이언트: 서버가 보내주는 상태를 그리고, 사용자의 행동을 서버로 보낸다. */
(function () {
  const R = window.HulaRules;

  // ───────── 상태 ─────────
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  const S = {
    ws: null,
    status: 'connecting',   // connecting | open | closed
    st: null,               // 서버가 보낸 마지막 state
    sel: new Set(),
    sort: store.get('hula.sort', 'suit'),
    name: store.get('hula.name', ''),
    codeInput: '',
    homeError: '',
    hideResult: false,
    lastPhase: null,
    replaced: false,
    session: null,
    clockOffset: 0
  };
  try { S.session = JSON.parse(store.get('hula.session', 'null')); } catch (e) { S.session = null; }
  const urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  if (urlRoom) S.codeInput = urlRoom;

  // ───────── DOM 도우미 ─────────
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style') el.setAttribute('style', v);
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k in el) el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach((k) => append(el, k)); return; }
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  const chip = (text, cls) => h('span', { class: 'chip' + (cls ? ' ' + cls : '') }, text);

  let toastTimer = null;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  const fmtScore = (n) => (n > 0 ? '+' + n : String(n));
  const scoreCls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

  // ───────── 카드 그리기 ─────────
  function cardEl(id, o) {
    o = o || {};
    const s = R.suitOf(id), r = R.rankOf(id);
    const red = s === 1 || s === 2;
    return h('div', {
      class: 'card ' + (red ? 'red' : 'black') + (o.cls ? ' ' + o.cls : ''),
      dataset: { id: String(id) },
      onclick: o.onclick,
      ondblclick: o.ondblclick,
      title: R.RANK_LABELS[r] + R.SUIT_CHARS[s]
    },
    h('span', { class: 'c-tl' }, R.RANK_LABELS[r], h('br'), R.SUIT_CHARS[s]),
    h('span', { class: 'c-mid' }, R.SUIT_CHARS[s]));
  }
  const backEl = (cls) => h('div', { class: 'card back' + (cls ? ' ' + cls : '') }, h('span'));

  function sortedHand(hand) {
    const a = hand.slice();
    if (S.sort === 'rank') a.sort((x, y) => R.rankOf(x) - R.rankOf(y) || R.suitOf(x) - R.suitOf(y));
    else a.sort((x, y) => R.suitOf(x) - R.suitOf(y) || R.rankOf(x) - R.rankOf(y));
    return a;
  }

  // ───────── 통신 ─────────
  let retry = 0;
  function connect() {
    if (S.replaced) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(proto + '://' + location.host);
    S.ws = ws;
    S.status = 'connecting';
    render();
    ws.onopen = () => {
      retry = 0;
      S.status = 'open';
      if (S.session) send({ type: 'resume', code: S.session.code, key: S.session.key });
      render();
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      onMessage(m);
    };
    ws.onclose = () => {
      if (S.ws !== ws) return;
      S.ws = null;
      S.status = 'closed';
      render();
      if (S.replaced) return;
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 600 * retry);
    };
  }
  function send(obj) {
    if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
    else toast('서버와 연결되어 있지 않습니다.');
  }
  setInterval(() => { if (S.ws && S.ws.readyState === 1) S.ws.send('{"type":"ping"}'); }, 25000);

  function clearSession() {
    S.session = null;
    store.del('hula.session');
    S.st = null;
    S.sel.clear();
    history.replaceState(null, '', location.pathname);
  }

  function onMessage(m) {
    switch (m.type) {
      case 'joined':
        S.session = { code: m.code, key: m.key };
        store.set('hula.session', JSON.stringify(S.session));
        history.replaceState(null, '', '?room=' + m.code);
        break;
      case 'state': {
        S.clockOffset = m.now - Date.now();
        const prev = S.st;
        S.st = m;
        if (S.lastPhase !== m.phase) { S.hideResult = false; S.lastPhase = m.phase; S.sel.clear(); }
        // 손패에 없는 카드는 선택 해제
        const hand = new Set(m.game ? m.game.hand : []);
        for (const id of Array.from(S.sel)) if (!hand.has(id)) S.sel.delete(id);
        // 내 차례가 바뀌면 선택 초기화
        if (prev && prev.game && m.game && (prev.game.current !== m.game.current || prev.game.turnNo !== m.game.turnNo)) S.sel.clear();
        render();
        return;
      }
      case 'error':
        if (m.resumeFailed) { clearSession(); render(); return; }
        toast(m.message);
        if (!S.st) { S.homeError = m.message; render(); }
        return;
      case 'replaced':
        S.replaced = true;
        S.st = null;
        toast('다른 창에서 접속해 이 창의 연결이 종료되었습니다.');
        render();
        return;
      case 'kicked':
        clearSession();
        toast('방장이 방에서 내보냈습니다.');
        render();
        return;
      case 'left':
        clearSession();
        render();
        return;
      default: return;
    }
  }

  // ───────── 화면: 홈 ─────────
  function renderHome() {
    const nameIn = h('input', { type: 'text', maxLength: 10, placeholder: '닉네임', value: S.name, oninput: (e) => { S.name = e.target.value; store.set('hula.name', S.name); } });
    const codeIn = h('input', { type: 'text', class: 'code', maxLength: 4, placeholder: 'ABCD', value: S.codeInput, oninput: (e) => { S.codeInput = e.target.value.toUpperCase(); e.target.value = S.codeInput; } });
    const needName = () => {
      if (!S.name.trim()) { S.homeError = '닉네임을 입력하세요.'; render(); return false; }
      S.homeError = '';
      return true;
    };
    return h('div', { class: 'center-wrap' },
      h('div', { class: 'card-panel' },
        h('h1', { class: 'logo' }, '훌', h('span', null, '라')),
        h('p', { class: 'sub' }, '친구들과 함께하는 온라인 훌라'),
        h('div', { class: 'field' }, h('label', null, '닉네임'), nameIn),
        h('button', { class: 'btn primary', style: 'width:100%', onclick: () => { if (needName()) send({ type: 'create', name: S.name }); } }, '새 방 만들기'),
        h('div', { class: 'divider' }, '또는 방 코드로 입장'),
        h('div', { class: 'field' }, codeIn),
        h('button', { class: 'btn', style: 'width:100%', onclick: () => { if (needName()) send({ type: 'join', code: S.codeInput, name: S.name }); } }, '입장하기'),
        h('div', { class: 'err' }, S.homeError),
        h('div', { style: 'text-align:center' }, h('button', { class: 'link', onclick: showRules }, '게임 규칙 보기'))));
  }

  // ───────── 화면: 로비 ─────────
  function copyLink(code) {
    const url = location.origin + '/?room=' + code;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => toast('초대 링크를 복사했습니다.'), () => window.prompt('링크를 복사하세요', url));
    } else window.prompt('링크를 복사하세요', url);
  }

  function renderLobby() {
    const st = S.st;
    const isHost = st.hostId === st.me;
    const o = st.options;
    const setOpt = (patch) => send({ type: 'options', options: Object.assign({}, o, patch) });

    const list = h('ul', { class: 'members' }, st.members.map((m) => h('li', null,
      h('span', { class: 'nm' }, m.name, m.id === st.hostId ? chip('방장', 'gold') : null, m.isBot ? chip('봇') : null, !m.online ? chip('오프라인', 'off') : null, m.id === st.me ? chip('나', 'ok') : null),
      st.round > 0 ? h('span', { class: 'sc ' + scoreCls(m.score) }, fmtScore(m.score) + '점') : null,
      isHost && m.isBot ? h('button', { class: 'btn small', onclick: () => send({ type: 'removeBot', id: m.id }) }, '빼기') : null,
      isHost && !m.isBot && m.id !== st.me ? h('button', { class: 'btn small', onclick: () => send({ type: 'kick', id: m.id }) }, '내보내기') : null)));

    const check = (label, desc, key) => h('label', { class: 'opt' },
      h('span', null, label, h('small', null, desc)),
      h('input', { type: 'checkbox', checked: !!o[key], disabled: !isHost, onchange: (e) => setOpt({ [key]: e.target.checked }) }));
    const select = (label, desc, key, choices, fmt) => h('label', { class: 'opt' },
      h('span', null, label, h('small', null, desc)),
      h('select', { disabled: !isHost, onchange: (e) => setOpt({ [key]: parseInt(e.target.value, 10) }) },
        choices.map((c) => h('option', { value: String(c), selected: o[key] === c }, fmt(c)))));

    const canStart = st.members.length >= 2;
    return h('div', { class: 'center-wrap' },
      h('div', { class: 'card-panel' },
        h('div', { class: 'room-code' }, h('div', { class: 'sub', style: 'margin:0' }, '방 코드'), h('div', { class: 'big' }, st.code),
          h('button', { class: 'btn small', onclick: () => copyLink(st.code) }, '초대 링크 복사')),
        h('h3', { style: 'margin:0 0 6px' }, '참가자 ' + st.members.length + '/' + st.maxPlayers),
        list,
        isHost ? h('div', { class: 'row', style: 'margin-bottom:12px' },
          h('button', { class: 'btn', disabled: st.members.length >= st.maxPlayers, onclick: () => send({ type: 'addBot' }) }, '봇 추가'),
          st.round > 0 ? h('button', { class: 'btn', onclick: () => send({ type: 'resetScores' }) }, '점수 초기화') : null) : null,
        h('div', { class: 'opts' },
          check('K-A-2 돌아가기', 'K-A-2 처럼 K에서 A로 이어지는 런', 'wrap'),
          check('땡큐 허용', '차례가 아니어도 버린 카드로 바로 등록 (전쟁 훌라)', 'thankYou'),
          select('스톱 가능 점수', '손패 점수가 이 이하일 때 스톱', 'stopLimit', [5, 7, 10, 15, 20], (c) => c + '점 이하'),
          select('제한 시간', '넘기면 자동으로 대신 둡니다', 'turnSeconds', [0, 30, 60, 90], (c) => (c ? c + '초' : '없음'))),
        isHost
          ? h('button', { class: 'btn primary', style: 'width:100%', disabled: !canStart, onclick: () => send({ type: 'start' }) }, canStart ? '게임 시작' : '2명 이상 필요 (봇을 추가해 보세요)')
          : h('p', { class: 'hint' }, '방장이 시작하기를 기다리는 중…'),
        h('div', { class: 'row', style: 'margin-top:10px' },
          h('button', { class: 'btn small', onclick: showRules }, '규칙'),
          h('button', { class: 'btn small', onclick: () => send({ type: 'leave' }) }, '방 나가기'))));
  }

  // ───────── 화면: 테이블 ─────────
  function meldTitle(m) {
    if (m.type === 'set') return R.RANK_LABELS[m.rank] + ' 땡';
    if (m.len === 1) return '7 단독';
    return R.SUIT_CHARS[m.suit] + ' 런';
  }

  function renderTable() {
    const st = S.st, g = st.game, me = st.me;
    const members = new Map(st.members.map((m) => [m.id, m]));
    const memOf = (p) => members.get(p.id) || { name: p.name, isBot: false, online: true, score: 0 };
    const wrap = st.options.wrap;
    const myIdx = g.players.findIndex((p) => p.id === me);
    const myP = myIdx >= 0 ? g.players[myIdx] : null;
    const opps = myIdx >= 0 ? g.players.slice(myIdx + 1).concat(g.players.slice(0, myIdx)) : g.players;
    const live = g.phase !== 'ended';
    const myTurn = live && g.current === me;
    const canDraw = myTurn && g.phase === 'draw';
    const inPlay = myTurn && g.phase === 'play';
    const sel = Array.from(S.sel);
    const topDiscard = g.discard.length ? g.discard[g.discard.length - 1] : null;
    const curName = (members.get(g.current) || {}).name || '';

    // 상대 목록
    const oppEls = opps.map((p) => {
      const m = memOf(p);
      const turn = live && g.current === p.id;
      const backs = [];
      for (let i = 0; i < Math.min(p.handCount, 10); i++) backs.push(backEl());
      return h('div', { class: 'opp' + (turn ? ' turn' : '') },
        h('div', { class: 'opp-name' }, m.name, m.isBot ? chip('봇') : null, !m.online ? chip('오프라인', 'off') : null, st.autoFor === p.id ? chip('자동') : null),
        h('div', { class: 'opp-cards' }, backs),
        h('div', { class: 'opp-meta' }, p.handCount + '장', p.registered ? chip('등록', 'ok') : null),
        h('div', { class: 'opp-score ' + scoreCls(m.score) }, fmtScore(m.score) + '점'),
        turn && st.deadline ? h('div', { class: 'opp-meta' }, '⏱ ', h('span', { class: 'cd' }, '')) : null);
    });

    // 더미 / 버린 카드
    const pileClick = (from) => () => { if (canDraw) send({ type: 'draw', from }); };
    const stockEl = h('div', { class: 'pile' + (canDraw && g.stock > 0 ? ' pick' : ''), onclick: pileClick('stock') },
      g.stock > 0 ? backEl() : h('div', { class: 'empty-slot' }), '더미 ' + g.stock + '장');
    const discEl = h('div', { class: 'pile' + (canDraw && topDiscard != null ? ' pick' : ''), onclick: pileClick('discard') },
      topDiscard != null ? cardEl(topDiscard) : h('div', { class: 'empty-slot' }), '버린 카드 ' + g.discard.length + '장',
      g.discard.length > 1 ? h('div', { class: 'recent' }, g.discard.slice(0, -1).slice(-8).map((c) => cardEl(c))) : null);

    // 놓인 멜드
    const myRegistered = !!(myP && myP.registered);
    const groups = g.players.map((p) => {
      const ms = g.melds.filter((m) => m.owner === p.id);
      if (!ms.length) return null;
      return h('div', { class: 'meld-group' },
        h('h4', null, memOf(p).name + (p.id === me ? ' (나)' : '')),
        h('div', { class: 'meld-list' }, ms.map((m) => {
          const can = inPlay && myRegistered && sel.length > 0 && !!R.tryAttachMany(m, sel, wrap);
          return h('div', {
            class: 'meld' + (can ? ' can' : ''), title: meldTitle(m),
            onclick: () => {
              if (!inPlay) return;
              if (!myRegistered) { toast('먼저 등록(멜드)을 해야 붙일 수 있어요.'); return; }
              if (!sel.length) { toast('붙일 카드를 먼저 선택하세요.'); return; }
              if (!can) { toast('그 멜드에는 붙일 수 없는 카드예요.'); return; }
              send({ type: 'attach', meldId: m.id, cardIds: sel });
              S.sel.clear();
            }
          }, m.cards.map((c) => cardEl(c, { cls: 'sm' })));
        })));
    }).filter(Boolean);

    // 내 손패
    const handEls = sortedHand(g.hand).map((id) => cardEl(id, {
      cls: 'hand' + (S.sel.has(id) ? ' sel' : '') + (g.lastDrawn === id ? ' fresh' : ''),
      onclick: () => { if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id); render(); },
      ondblclick: () => { if (inPlay) { send({ type: 'discard', cardId: id }); S.sel.clear(); } }
    }));

    const meldValid = inPlay && sel.length > 0 && !!R.tryMeld(sel, wrap);
    const actions = [];
    if (canDraw) {
      if (g.canBlast) actions.push(h('button', { class: 'btn primary', onclick: () => send({ type: 'blast' }) }, '블라스트!'));
      if (g.canStop) actions.push(h('button', { class: 'btn danger', onclick: () => { if (confirm('스톱할까요? (내 손패 ' + g.handPoints + '점) 같거나 더 낮은 사람이 있으면 실패합니다.')) send({ type: 'stop' }); } }, '스톱 (' + g.handPoints + '점)'));
    }
    if (inPlay) {
      actions.push(h('button', { class: 'btn primary', disabled: !meldValid, onclick: () => { send({ type: 'meld', cardIds: sel }); S.sel.clear(); } }, '등록'));
      actions.push(h('button', { class: 'btn', onclick: () => {
        const best = R.bestPartition(g.hand, wrap);
        if (!best.picks.length) { toast('지금 등록할 수 있는 조합이 없어요.'); return; }
        S.sel = new Set(best.picks[0]);
        render();
      } }, '추천 선택'));
      actions.push(h('button', { class: 'btn', disabled: sel.length !== 1, onclick: () => { send({ type: 'discard', cardId: sel[0] }); S.sel.clear(); } }, '버리기'));
    }
    if (live && g.canThankYou) {
      actions.push(h('button', { class: 'btn primary', onclick: () => send({ type: 'thankyou', cardIds: sel }) }, '땡큐!'));
    }

    let turnMsg;
    if (!live) turnMsg = '판이 끝났습니다';
    else if (!myP) turnMsg = '관전 중';
    else if (canDraw) turnMsg = '내 차례 — 더미 또는 버린 카드를 눌러 한 장 뽑으세요';
    else if (inPlay) turnMsg = sel.length ? '등록·붙이기를 하거나, 한 장 골라 버리세요' : '카드를 골라 등록하거나 붙이고, 마지막에 한 장 버리세요';
    else turnMsg = curName + '님 차례';
    if (live && g.canThankYou && !myTurn) turnMsg += ' · 땡큐: 함께 낼 카드를 고르고 버튼을 누르세요';

    const topbar = h('div', { class: 'topbar' },
      h('span', { class: 'title' }, '훌라'),
      h('span', { class: 'code' }, st.code),
      chip(st.round + '판째'),
      h('span', { class: 'sp' }),
      h('button', { class: 'btn small', onclick: () => copyLink(st.code) }, '초대'),
      h('button', { class: 'btn small', onclick: showRules }, '규칙'),
      h('button', { class: 'btn small', onclick: () => { if (!live || confirm('나가면 내 자리는 봇이 이어받습니다. 나갈까요?')) send({ type: 'leave' }); } }, '나가기'));

    const logLines = g.log.slice(-3).map((t) => h('div', null, t));

    const root = h('div', { style: 'display:flex;flex-direction:column;flex:1;min-height:0' },
      topbar,
      h('div', { class: 'table' },
        h('div', { class: 'opps' }, oppEls),
        h('div', { class: 'middle' },
          h('div', { class: 'piles' }, stockEl, discEl),
          h('div', { class: 'melds' }, groups.length ? groups : h('div', { class: 'meld-empty' }, '아직 등록된 멜드가 없습니다')))),
      h('div', { class: 'me' },
        h('div', { class: 'me-info' },
          h('strong', null, (members.get(me) || {}).name || ''),
          h('span', { class: scoreCls((members.get(me) || {}).score || 0) }, fmtScore((members.get(me) || {}).score || 0) + '점'),
          myP ? h('span', null, '손패 ' + g.handPoints + '점') : null,
          myRegistered ? chip('등록함', 'ok') : null,
          h('span', { class: 'grow' }),
          myTurn && st.deadline ? h('span', null, '⏱ ', h('span', { class: 'cd' }, '')) : null,
          h('button', { class: 'btn small', onclick: () => { S.sort = S.sort === 'suit' ? 'rank' : 'suit'; store.set('hula.sort', S.sort); render(); } }, S.sort === 'suit' ? '무늬순' : '숫자순')),
        h('div', { class: 'turn-msg' }, turnMsg),
        h('div', { class: 'hand' }, handEls),
        h('div', { class: 'actions' }, actions),
        h('div', { class: 'log' }, logLines)));
    return root;
  }

  // ───────── 결과 ─────────
  function resultTitle(st, r, name) {
    switch (r.kind) {
      case 'hula': return ['훌라!', name(r.winnerId) + '님이 첫 등록과 동시에 손패를 모두 털었습니다 (×' + R.MULT.hula + ')'];
      case 'out': return [name(r.winnerId) + '님 승리', '손패를 모두 털었습니다'];
      case 'stop': return ['스톱 성공', name(r.winnerId) + '님이 가장 낮은 점수로 스톱했습니다'];
      case 'stopFail': return ['스톱 실패', name(r.knockerId) + '님이 스톱했지만 같거나 더 낮은 점수가 있어 ' + name(r.winnerId) + '님이 이겼습니다'];
      case 'blast': return ['블라스트!', name(r.winnerId) + '님 승리 (×' + R.MULT.blast + ')'];
      case 'fourSevens': return ['7 네 장!', name(r.winnerId) + '님 승리 (×' + R.MULT.fourSevens + ')'];
      case 'stockEnd': return ['더미 소진', '가장 낮은 점수의 ' + name(r.winnerId) + '님 승리'];
      default: return ['무승부', '최저 점수가 같아 점수 변동이 없습니다'];
    }
  }

  function renderResult() {
    const st = S.st, g = st.game, r = g.result;
    const members = new Map(st.members.map((m) => [m.id, m]));
    const nameOf = (id) => (members.get(id) || (g.players.find((p) => p.id === id)) || { name: '?' }).name;
    const isHost = st.hostId === st.me;
    const [title, desc] = resultTitle(st, r, nameOf);
    const rows = g.players.map((p) => {
      const d = r.deltas[p.id] || 0;
      const mult = r.mults[p.id];
      return h('div', { class: 'res-row' + (p.id === r.winnerId ? ' win' : '') },
        h('div', { class: 'res-top' },
          h('span', { class: 'nm' }, nameOf(p.id), p.id === r.winnerId ? chip('승', 'gold') : null, p.id === r.knockerId ? chip('스톱') : null, !r.registered[p.id] ? chip('미등록') : null),
          h('span', { class: 'tot' }, '손패 ' + r.totals[p.id] + '점' + (mult && mult > 1 ? ' ×' + mult : '')),
          h('span', { class: 'delta ' + scoreCls(d) }, fmtScore(d))),
        h('div', { class: 'res-cards' }, sortedHand(r.hands[p.id] || []).map((c) => cardEl(c))),
        h('div', { class: 'tot' }, '누적 ' + fmtScore((members.get(p.id) || { score: 0 }).score) + '점'));
    });
    return h('div', { class: 'overlay' },
      h('div', { class: 'modal' },
        h('div', { class: 'result-head' }, h('div', { class: 'kind' }, title), h('div', { class: 'sub', style: 'margin:4px 0 0' }, desc)),
        rows,
        h('div', { class: 'modal-actions' },
          isHost ? h('button', { class: 'btn primary', onclick: () => send({ type: 'start' }) }, '다음 판 시작') : h('span', { class: 'hint' }, '방장이 다음 판을 시작할 때까지 기다려 주세요'),
          isHost ? h('button', { class: 'btn', onclick: () => send({ type: 'toLobby' }) }, '로비로') : null,
          h('button', { class: 'btn', onclick: () => { S.hideResult = true; render(); } }, '테이블 보기'))));
  }

  // ───────── 규칙 ─────────
  function showRules() {
    const root = document.getElementById('modal-root');
    const close = () => root.replaceChildren();
    const M = R.MULT;
    root.replaceChildren(h('div', { class: 'overlay', onclick: (e) => { if (e.target.classList.contains('overlay')) close(); } },
      h('div', { class: 'modal' },
        h('h2', null, '훌라 규칙'),
        h('h3', null, '기본'),
        h('ul', null,
          h('li', null, '조커 없는 52장, 2~5명. 한 사람당 7장씩 받습니다.'),
          h('li', null, '내 차례: ① 더미 또는 버린 카드 맨 위 한 장 뽑기 → ② 등록·붙이기(선택) → ③ 한 장 버리기.')),
        h('h3', null, '등록(멜드)'),
        h('ul', null,
          h('li', null, h('b', null, '땡'), ': 같은 숫자 3~4장 (무늬는 모두 달라야 함)'),
          h('li', null, h('b', null, '런'), ': 같은 무늬 연속 숫자 3장 이상. A-2-3, Q-K-A 가능, 방 설정에 따라 K-A-2 도 가능'),
          h('li', null, h('b', null, '7 단독'), ': 7은 한 장만으로도 등록할 수 있습니다. 같은 무늬 6·8을 이어 붙일 수 있어요.')),
        h('h3', null, '붙이기'),
        h('ul', null,
          h('li', null, '한 번이라도 등록한 뒤에만 가능. 내 멜드뿐 아니라 남의 멜드에도 붙일 수 있습니다.'),
          h('li', null, '카드를 고른 뒤 붙을 수 있는 멜드(노란 테두리)를 누르세요.')),
        h('h3', null, '판이 끝나는 경우'),
        h('ul', null,
          h('li', null, h('b', null, '손패 모두 털기'), ': 모두 등록/붙이거나, 한 장 남겨 버리면 승리.'),
          h('li', null, h('b', null, '훌라'), ': 그 전에 등록한 적 없이 한 턴에 손패를 전부 털면 훌라 (×' + M.hula + ').'),
          h('li', null, h('b', null, '스톱'), ': 내 차례 시작에 손패 점수가 기준 이하면 선언. 모두 공개해 가장 낮으면 승리, 같거나 더 낮은 사람이 있으면 실패(실패 ×' + M.stopFail + ').'),
          h('li', null, h('b', null, '블라스트'), ': 한 번도 등록하지 않은 7장의 합(7=7점)이 15 이하이거나 83 이상이면 내 차례 시작에 선언해 승리 (×' + M.blast + ').'),
          h('li', null, h('b', null, '7 네 장'), ': 7을 네 장 모두 손에 모으면 즉시 승리 (×' + M.fourSevens + ').'),
          h('li', null, h('b', null, '더미 소진'), ': 마지막 카드를 뽑은 사람이 차례를 마치면 끝나고 가장 낮은 점수가 승리. 최저가 같으면 무승부.')),
        h('h3', null, '점수'),
        h('ul', null,
          h('li', null, 'A=1, 2~10은 숫자, J=11, Q=12, K=13. 손에 남은 7은 14점.'),
          h('li', null, '진 사람은 (내 손패 점수 − 승자 손패 점수)를 승자에게 줍니다. 한 번도 등록 못 했다면 ×' + M.noRegister + '.'),
          h('li', null, '판이 끝날 때마다 누적 점수가 쌓입니다 (합계는 항상 0).')),
        h('h3', null, '땡큐(선택 옵션)'),
        h('ul', null, h('li', null, '켜면, 차례가 아닌 사람이 방금 버려진 카드를 가져가며 곧바로 등록할 수 있습니다. 함께 낼 카드를 고르고 "땡큐!"를 누르세요. 차례는 땡큐한 사람에게 넘어갑니다.')),
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', onclick: close }, '닫기')))));
  }

  // ───────── 렌더 ─────────
  function render() {
    const app = document.getElementById('app');
    const kids = [];
    if (S.replaced) {
      kids.push(h('div', { class: 'center-wrap' }, h('div', { class: 'card-panel' }, h('p', { class: 'sub' }, '다른 창에서 같은 자리로 접속했습니다.'), h('button', { class: 'btn primary', style: 'width:100%', onclick: () => location.reload() }, '이 창에서 다시 접속'))));
    } else {
      if (S.status !== 'open') kids.push(h('div', { class: 'banner' }, S.status === 'connecting' ? '서버에 연결하는 중…' : '연결이 끊겼습니다. 다시 연결하는 중…'));
      if (!S.st) kids.push(renderHome());
      else if (S.st.phase === 'lobby') kids.push(renderLobby());
      else kids.push(renderTable());
    }
    app.replaceChildren.apply(app, kids);

    const root = document.getElementById('modal-root');
    if (S.st && S.st.phase === 'roundEnd' && !S.hideResult && S.st.game && S.st.game.result) {
      root.replaceChildren(renderResult());
    } else if (root.firstChild && root.firstChild.querySelector('.result-head')) {
      root.replaceChildren(); // 규칙 창은 사용자가 직접 닫을 때까지 유지, 결과 창만 정리
    }
    updateCountdown();
  }

  function updateCountdown() {
    const st = S.st;
    const els = document.querySelectorAll('.cd');
    if (!els.length) return;
    if (!st || !st.deadline) { els.forEach((e) => { e.textContent = ''; }); return; }
    const left = Math.max(0, Math.ceil((st.deadline - (Date.now() + S.clockOffset)) / 1000));
    els.forEach((e) => { e.textContent = left + '초'; });
  }
  setInterval(updateCountdown, 500);

  render();
  connect();
})();
