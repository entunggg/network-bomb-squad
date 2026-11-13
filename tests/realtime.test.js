'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { server, quiz, rooms } = require('../server');
let baseURL;
const clients = [];
const ask = (socket, event, data = {}) => socket.timeout(3000).emitWithAck(event, data);
async function connect() {
  const socket = io(baseURL, { forceNew: true, reconnection: false, transports: ['websocket'] });
  clients.push(socket);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  return socket;
}
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  for (const socket of clients) socket.disconnect();
  await new Promise(resolve => server.close(resolve));
});

test('static assets, health and configured round durations are complete', async () => {
  for (const asset of ['/', '/app.js', '/styles.css', '/socket.io/socket.io.js', '/health']) {
    const response = await fetch(baseURL + asset);
    assert.equal(response.status, 200, asset);
    assert.ok((await response.text()).length > 0);
  }
  assert.deepEqual(quiz.map(q => q.duration), [35, 40, 40]);
});

test('room validation, permissions, scoring, duplicate answers, private restore and reset', async () => {
  const host = await connect(), first = await connect(), second = await connect();
  assert.equal((await ask(first, 'player:join', { code: 'BAD123', name: 'A' })).ok, false);
  const created = await ask(host, 'host:create');
  assert.match(created.code, /^[A-Z2-9]{6}$/);
  assert.equal((await ask(host, 'host:start')).ok, false);
  assert.equal((await ask(first, 'player:join', { code: created.code, name: '  ' })).ok, false);
  const identity = await ask(first, 'player:join', { code: created.code.toLowerCase(), name: 'Alpha' });
  const secondIdentity = await ask(second, 'player:join', { code: created.code, name: 'Beta' });
  assert.ok(identity.ok && secondIdentity.ok);
  assert.equal((await ask(first, 'host:start')).ok, false);
  assert.equal((await ask(first, 'host:next')).ok, false);
  assert.equal((await ask(first, 'host:reset')).ok, false);
  assert.equal((await ask(second, 'host:resume', { code: created.code, hostToken: 'wrong' })).ok, false);
  assert.equal((await ask(host, 'host:start')).ok, true);
  const room = rooms.get(created.code);
  assert.equal(room.phase, 'playing');
  assert.equal((await ask(first, 'player:answer', { choice: 'invalid' })).ok, false);
  const answer = await ask(first, 'player:answer', { choice: quiz[0].correct, score: 999999 });
  assert.ok(answer.ok && answer.correct);
  assert.ok(answer.delta >= 500 && answer.delta <= 850);
  assert.equal(room.players.get(identity.playerId).score, answer.delta);
  assert.equal((await ask(first, 'player:answer', { choice: quiz[0].correct })).ok, false);
  const resumed = await ask(first, 'player:join', { code: created.code, name: 'Alpha', ...identity });
  assert.equal(resumed.answer.choice, quiz[0].correct);
  assert.equal(resumed.answer.delta, answer.delta);
  const unAnswered = await ask(second, 'player:join', { code: created.code, name: 'Beta', ...secondIdentity });
  assert.equal(unAnswered.answer, null);
  const wrong = await ask(second, 'player:answer', { choice: 'AB' });
  assert.equal(wrong.correct, false);
  assert.equal(wrong.delta, -100);
  assert.equal(room.players.get(secondIdentity.playerId).score, 0);
  assert.equal(room.phase, 'intermission');
  assert.equal((await ask(host, 'host:next')).ok, true);
  assert.equal(room.round, 1);
  const secondAnswer = await ask(first, 'player:answer', { choice: quiz[1].correct });
  assert.ok(secondAnswer.ok && secondAnswer.correct);
  await ask(second, 'player:answer', { choice: quiz[1].correct });
  assert.equal(room.phase, 'intermission');
  await ask(host, 'host:next');
  assert.equal(room.round, 2);
  await ask(first, 'player:answer', { choice: quiz[2].correct });
  await ask(second, 'player:answer', { choice: quiz[2].correct });
  await ask(host, 'host:next');
  assert.equal(room.phase, 'finished');
  assert.equal(room.completed, 3);
  assert.equal((await ask(first, 'player:answer', { choice: quiz[2].correct })).ok, false);
  assert.equal((await ask(host, 'host:reset')).ok, true);
  assert.equal(room.phase, 'lobby');
  for (const player of room.players.values()) {
    assert.equal(player.score, 0);
    assert.equal(player.answers.size, 0);
  }
});
