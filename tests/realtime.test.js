'use strict';
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { server, quiz, rooms, tickRooms, gameClock } = require('../server');
let baseURL;
const clients = [];
const ask = (socket, event, data = {}) => socket.timeout(3000).emitWithAck(event, data);
async function connect() {
  const socket = io(baseURL, { forceNew: true, reconnection: false, transports: ['websocket'] });
  socket.packets = [];
  socket.onAny((event, data) => {
    if (event === 'room:update') socket.latest = data;
    if (event === 'player:state') socket.own = data;
    socket.packets.push({ event, data, phase: socket.latest?.phase });
  });
  clients.push(socket);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  return socket;
}
function until(socket, event, predicate) {
  const current = event === 'room:update' ? socket.latest : socket.own;
  if (current && predicate(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, handler); reject(new Error(`Timed out waiting for ${event}`)); }, 3000);
    function handler(data) { if (predicate(data)) { clearTimeout(timer); socket.off(event, handler); resolve(data); } }
    socket.on(event, handler);
  });
}
function clock(t) {
  let now = Date.now();
  // Advance only game time; Socket.IO heartbeats keep using the real clock.
  t.mock.method(gameClock, 'now', () => now);
  return { set(value, runTimers = true) { now = value; if (runTimers) tickRooms(); }, now: () => now };
}
async function game(count = 1) {
  const host = await connect();
  const created = await ask(host, 'host:create');
  const players = [];
  for (let i = 0; i < count; i++) {
    const socket = await connect();
    const identity = await ask(socket, 'player:join', { code: created.code, name: `Player ${i}` });
    players.push({ socket, identity });
  }
  assert.equal((await ask(host, 'host:start')).ok, true);
  const room = rooms.get(created.code);
  await Promise.all(players.map(p => until(p.socket, 'room:update', d => d.phase === 'playing')));
  return { host, created, players, room };
}
const answer = (g, p, choice, extra = {}) => ask(p.socket, 'player:answer', { gameId: g.room.gameId, round: g.room.round, choice, ...extra });
function receipt(value) {
  assert.deepEqual(Object.keys(value).sort(), ['gameId', 'ok', 'round', 'submitted']);
  assert.equal(value.ok, true); assert.equal(value.submitted, true);
}
function pending(value, choice) {
  assert.deepEqual(value, { submitted: true, choice });
}
function hidden(state, expectedScores) {
  assert.equal(state.phase, 'playing');
  assert.equal(state.correct, null); assert.equal(state.explain, null); assert.equal(state.lesson, null);
  assert.deepEqual(state.players.map(p => p.score).sort((a,b) => a-b), [...expectedScores].sort((a,b) => a-b));
  for (const p of state.players) {
    assert.equal(p.correct, null);
    for (const key of ['choice','answer','answers','delta','bonus','submittedAt','token']) assert.equal(Object.hasOwn(p, key), false, key);
  }
}
function allPendingPackets(sockets, expectedScores) {
  for (const socket of sockets) for (const packet of socket.packets) {
    if (packet.event === 'room:update' && packet.phase === 'playing') hidden(packet.data, expectedScores);
    if (packet.event === 'player:state' && packet.phase === 'playing' && packet.data.answer) {
      assert.deepEqual(Object.keys(packet.data.answer).sort(), ['choice','submitted']);
    }
  }
}
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => { for (const socket of clients.splice(0)) socket.disconnect(); rooms.clear(); });
after(async () => { await new Promise(resolve => server.close(resolve)); });

test('assets, health and three fixed durations are complete', async () => {
  for (const asset of ['/', '/app.js', '/styles.css', '/socket.io/socket.io.js', '/health']) {
    const response = await fetch(baseURL + asset);
    assert.equal(response.status, 200, asset); assert.ok((await response.text()).length > 0);
  }
  assert.deepEqual(quiz.map(q => q.duration), [35, 40, 40]);
});

test('single early answer stays secret for all 35 seconds, then reveals for 15 seconds', async t => {
  const time = clock(t), g = await game(), p = g.players[0];
  const endsAt = g.room.endsAt;
  assert.equal(endsAt - time.now(), 35000);
  time.set(endsAt - 33750);
  receipt(await answer(g, p, 'BC', { score: 999999, submittedAt: endsAt - 35000 }));
  const record = g.room.players.get(p.identity.playerId).answers.get(0);
  assert.equal(record.submittedAt, time.now());
  assert.equal(Object.hasOwn(record, 'correct'), false);
  assert.equal(Object.hasOwn(record, 'delta'), false);
  assert.equal(g.room.players.get(p.identity.playerId).score, 0);
  assert.equal(g.room.phase, 'playing'); assert.equal(g.room.endsAt, endsAt);
  await until(p.socket, 'player:state', d => d.answer?.submitted);
  pending(p.socket.own.answer, 'BC');
  assert.equal((await answer(g, p, 'AB')).ok, false);
  time.set(endsAt - 1);
  assert.equal(g.room.phase, 'playing');
  allPendingPackets([g.host, p.socket], [0]);
  time.set(endsAt);
  const revealed = await until(p.socket, 'room:update', d => d.phase === 'intermission');
  const result = await until(p.socket, 'player:state', d => typeof d.answer?.correct === 'boolean');
  assert.equal(revealed.correct, 'BC'); assert.ok(revealed.explain);
  assert.equal(result.answer.correct, true); assert.equal(result.answer.delta, 830);
  assert.equal(revealed.players[0].score, 830);
  assert.equal(revealed.remainingMs, 15000); assert.equal(revealed.explanationDuration, 15);
  assert.equal((await answer(g, p, 'BC')).ok, false);
  time.set(endsAt + 14999); assert.equal(g.room.phase, 'intermission');
  time.set(endsAt + 15000);
  const next = await until(p.socket, 'room:update', d => d.phase === 'playing' && d.round === 1);
  hidden(next, [830]); assert.equal(next.remainingMs, 40000);
  await until(p.socket, 'player:state', d => d.round === 1);
  assert.equal(p.socket.own.answer, null);
});

test('multiple and all early answers never reveal through broadcasts, receipts or rankings', async t => {
  const time = clock(t), g = await game(3);
  const endsAt = g.room.endsAt;
  receipt(await answer(g, g.players[0], 'AB'));
  receipt(await answer(g, g.players[1], 'BC'));
  await until(g.players[1].socket, 'room:update', d => d.players.filter(p => p.answered).length === 2);
  hidden(g.players[1].socket.latest, [0,0,0]);
  time.set(endsAt - 20000);
  receipt(await answer(g, g.players[2], 'BC'));
  await Promise.all(g.players.map(p => until(p.socket, 'room:update', d => d.players.every(x => x.answered))));
  assert.equal(g.room.phase, 'playing'); assert.equal(g.room.endsAt, endsAt);
  allPendingPackets([g.host, ...g.players.map(p => p.socket)], [0,0,0]);
  time.set(endsAt - 1); assert.equal(g.room.phase, 'playing');
  time.set(endsAt);
  const state = await until(g.host, 'room:update', d => d.phase === 'intermission');
  assert.deepEqual(state.players.map(p => p.score), [850,700,0]);
  assert.equal(state.players[0].id, g.players[1].identity.playerId);
  assert.equal(state.players[1].id, g.players[2].identity.playerId);
  const wrong = await until(g.players[0].socket, 'player:state', d => d.answer?.correct === false);
  assert.equal(wrong.answer.delta, -100);
});

test('reconnect before and after reveal restores only the permitted private state', async t => {
  const time = clock(t), g = await game(2), p = g.players[0];
  const endsAt = g.room.endsAt;
  receipt(await answer(g, p, 'BC'));
  p.socket.disconnect(); p.socket = await connect();
  const restored = await ask(p.socket, 'player:join', { ...p.identity, name: 'Player 0' });
  pending(restored.answer, 'BC');
  await until(p.socket, 'room:update', d => d.phase === 'playing');
  await until(p.socket, 'player:state', d => !!d.answer);
  assert.equal(p.socket.latest.players.length, 2); hidden(p.socket.latest, [0,0]);
  assert.equal((await answer(g, p, 'AB')).ok, false);
  const other = await ask(g.players[1].socket, 'player:join', { ...g.players[1].identity, name: 'Player 1' });
  assert.equal(other.answer, null);
  allPendingPackets([g.host,p.socket,g.players[1].socket], [0,0]);
  p.socket.disconnect();
  time.set(endsAt);
  p.socket = await connect();
  const revealed = await ask(p.socket, 'player:join', { ...p.identity, name: 'Player 0' });
  assert.equal(revealed.answer.correct, true); assert.equal(revealed.answer.delta, 850);
  assert.equal(revealed.answer.explanation, quiz[0].explain);
  await until(p.socket, 'room:update', d => d.phase === 'intermission');
  assert.equal(p.socket.latest.players.find(x => x.id === p.identity.playerId).score, 850);
  const newHost = await connect();
  assert.equal((await ask(newHost, 'host:resume', g.created)).ok, true);
  assert.equal((await ask(g.host, 'host:next')).ok, false);
  assert.equal((await ask(newHost, 'host:next')).ok, true);
});

test('all rounds automatically expire with 35/40/40 answer and 15-second explanation periods', async t => {
  const time = clock(t), g = await game(), p = g.players[0];
  for (let round = 0; round < 3; round++) {
    assert.equal(g.room.round, round);
    const end = g.room.endsAt;
    assert.equal(end - time.now(), quiz[round].duration * 1000);
    time.set(end - 1); assert.equal(g.room.phase, 'playing');
    assert.equal((await ask(p.socket, 'player:answer', { gameId: g.room.gameId, round, choice: 'invalid' })).ok, false);
    time.set(end);
    assert.equal(g.room.phase, 'intermission'); assert.equal(g.room.completed, round + 1);
    assert.equal(g.room.endsAt - time.now(), 15000);
    time.set(end + 14999); assert.equal(g.room.phase, 'intermission');
    time.set(end + 15000);
    assert.equal(g.room.phase, round === 2 ? 'finished' : 'playing');
  }
  assert.equal(g.room.endsAt, null); assert.equal(g.room.players.get(p.identity.playerId).score, 0);
});

test('manual skips settle once, original speed and penalty rules survive restart, stale answers fail', async t => {
  const time = clock(t), g = await game(2), [p, other] = g.players;
  const oldGameId = g.room.gameId;
  const expectedDeltas = [820,-100,870];
  let score = 0;
  for (let round = 0; round < 3; round++) {
    const end = g.room.endsAt;
    time.set(end - (round === 0 ? 32500 : 37500));
    receipt(await answer(g, p, round === 1 ? 'CLOSE_AC' : quiz[round].correct));
    assert.equal(g.room.players.get(p.identity.playerId).score, score);
    assert.equal((await ask(other.socket, 'host:next')).ok, false);
    assert.equal((await ask(g.host, 'host:next')).ok, true);
    score = Math.max(0, score + expectedDeltas[round]);
    assert.equal(g.room.players.get(p.identity.playerId).score, score);
    assert.equal(g.room.players.get(p.identity.playerId).answers.get(round).delta, expectedDeltas[round]);
    time.set(time.now() + 1000);
    assert.equal(g.room.players.get(p.identity.playerId).score, score);
    assert.equal((await ask(g.host, 'host:next')).ok, true);
  }
  assert.equal(g.room.phase, 'finished'); assert.equal(g.room.completed, 3);
  assert.equal((await ask(other.socket, 'host:reset')).ok, false);
  assert.equal((await ask(g.host, 'host:reset')).ok, true);
  assert.notEqual(g.room.gameId, oldGameId);
  for (const player of g.room.players.values()) { assert.equal(player.score, 0); assert.equal(player.answers.size, 0); }
  await ask(g.host, 'host:start');
  assert.equal((await answer(g, p, 'BC', { gameId: oldGameId })).ok, false);
  assert.equal((await answer(g, p, 'BC', { round: 2 })).ok, false);
  receipt(await answer(g, p, 'BC'));
  assert.equal(g.room.phase, 'playing');
  const end = g.room.endsAt;
  // Deadline enforcement does not depend on whether the 250 ms scheduler has run yet.
  time.set(end, false);
  assert.equal((await answer(g, other, 'BC')).ok, false);
  assert.equal(g.room.players.get(other.identity.playerId).answers.has(0), false);
  tickRooms();
  assert.equal(g.room.phase, 'intermission');
});

test('room and host validation remains enforced', async () => {
  const host = await connect(), player = await connect();
  assert.equal((await ask(player, 'player:join', { code:'BAD123',name:'A' })).ok, false);
  const created = await ask(host, 'host:create'); assert.match(created.code, /^[A-Z2-9]{6}$/);
  assert.equal((await ask(host, 'host:start')).ok, false);
  assert.equal((await ask(player, 'player:join', { code:created.code,name:' ' })).ok, false);
  assert.equal((await ask(player, 'player:join', { code:created.code.toLowerCase(),name:'A' })).ok, true);
  assert.equal((await ask(player, 'host:start')).ok, false);
  assert.equal((await ask(player, 'host:resume', { ...created,hostToken:'wrong' })).ok, false);
  assert.equal((await ask(host, 'host:start')).ok, true);
  assert.equal((await ask(host, 'host:start')).ok, false);
});
