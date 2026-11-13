'use strict';
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false }, pingTimeout: 20000 });
const PORT = Number(process.env.PORT || 3000);
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
const rooms = new Map();
const MAX_PLAYERS = 120;
const PHASE_BREAK_MS = 7500;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const quiz = [
  {
    id: 'loop', stage: '01 / 偵測迴圈', headline: '紅色警報！找出造成迴圈的線路',
    story: '三台交換器 A、B、C 形成三角形，A—B 與 A—C 是指定的主線，B—C 是備援線。STP 被關閉，三條線都在轉送廣播封包！',
    question: '為了阻止 Loop，並保留兩條指定主線 A—B、A—C 的轉送，應阻擋哪條備援線？',
    duration: 35, options: [
      { id: 'AB', label: '切斷 A—B', sub: '中斷一條通道' },
      { id: 'BC', label: '切斷 B—C', sub: '保留 A—B、A—C' },
      { id: 'AC', label: '切斷 A—C', sub: '中斷一條通道' },
      { id: 'ALL', label: '切斷全部線路', sub: '徹底停止轉送' }
    ], correct: 'BC',
    explain: '三角形有一條循環路徑。阻擋任一條適當的冗餘鏈路可打破 Loop；本關指定 B—C 以保留 A—B 與 A—C 兩條主要路徑。實際 STP/RSTP 由拓樸計算選定阻擋埠，不是永遠阻擋 B—C。',
    lesson: 'Layer 2 Loop → 廣播幀反覆轉送 → 頻寬與交換器資源被占用。'
  },
  {
    id: 'backup', stage: '02 / 備援搶修', headline: '主線斷了！啟用正確的備援',
    story: '上一關已阻擋 B—C，現在 A—B 主線突然斷線！B 與其他設備失去連通，倒數計時仍在繼續。',
    question: 'RSTP 收斂後，哪個操作最適合恢復 B 的連通性且不形成 Loop？',
    duration: 40, options: [
      { id: 'OPEN_BC', label: '讓 B—C 恢復轉送', sub: '走 A—C—B 備援路徑' },
      { id: 'CLOSE_AC', label: '再阻擋 A—C', sub: '讓網路更安全' },
      { id: 'IGNORE', label: '不必處理', sub: '等待封包自行修復' },
      { id: 'DISABLE_ALL', label: '關閉所有交換器', sub: '強制重置' }
    ], correct: 'OPEN_BC',
    explain: 'A—B 故障後，若 B—C 仍阻擋，B 將無法經 A 通訊。RSTP 可以在拓樸變動後讓適當的備援埠進入轉送狀態，形成 A—C—B 路徑，且不產生循環。',
    lesson: 'RSTP 在正常狀態避免 Loop，並能在連線故障後較快收斂至新的無迴圈拓樸。'
  },
  {
    id: 'control', stage: '03 / 最終拆彈', headline: '最後一關！守住全校網路！',
    story: '流量再度暴增。工程師打開 Storm Control 後，廣播流量降低，但錯誤的 Layer 2 Loop 依然存在。',
    question: '若要修復根本原因並降低異常廣播流量風險，最佳做法是什麼？',
    duration: 40, options: [
      { id: 'CONTROL_ONLY', label: '只開 Storm Control', sub: '限流就代表已經沒有 Loop' },
      { id: 'VLAN_ONLY', label: '只切分 VLAN', sub: '自動消除所有迴圈' },
      { id: 'RSTP_CONTROL', label: '修復 Loop ＋ Storm Control', sub: '啟用 RSTP 並適當限流' },
      { id: 'MORE_LINKS', label: '再加兩條備援線', sub: '流量會自行分散' }
    ], correct: 'RSTP_CONTROL',
    explain: 'STP/RSTP 與正確的接線設定用來避免或解除 Layer 2 Loop；Storm Control 可以對超過門檻的廣播流量限流，但它本身不能消除 Loop。VLAN 則是縮小廣播網域，不能單獨解決 VLAN 內部的 Loop。',
    lesson: '解除迴圈是治本；Storm Control 是限流防護；VLAN 是限制廣播範圍。'
  }
];
function code() {
  let c;
  do { c = Array.from({length: 6}, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join(''); } while(rooms.has(c));
  return c;
}
function emitAck(ack, data) { if (typeof ack === 'function') ack(data); }
function safeName(raw) { return String(raw || '').replace(/[<>\\\n\r\t]/g, '').trim().slice(0, 18); }
function genToken() { return crypto.randomBytes(24).toString('hex'); }
function roomSummary(r) {
  const current = quiz[r.round];
  return {
    code: r.code, phase: r.phase, round: r.round, roundCount: quiz.length,
    stage: current?.stage || null, headline: current?.headline || null,
    story: current?.story || null, question: current?.question || null,
    options: current?.options || [], lesson: r.phase === 'intermission' || r.phase === 'finished' ? current?.lesson : null,
    correct: r.phase === 'intermission' || r.phase === 'finished' ? current?.correct : null,
    explain: r.phase === 'intermission' || r.phase === 'finished' ? current?.explain : null,
    remainingMs: r.endsAt ? Math.max(0, r.endsAt - Date.now()) : 0,
    endsAt: r.endsAt,
    duration: current?.duration || 0,
    players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, score: p.score, connected: !!p.socketId, answered: r.round >= 0 && p.answers.has(r.round), correct: r.round >= 0 && (r.phase === 'intermission' || r.phase === 'finished') ? p.answers.get(r.round)?.correct ?? null : null })).sort((a,b) => b.score - a.score || a.name.localeCompare(b.name, 'zh-Hant')),
    completed: r.completed,
  };
}
function update(r) {
  r.touched = Date.now();
  io.to(r.code).emit('room:update', roomSummary(r));
}
function startRound(r, i) {
  r.round = i; r.phase = 'playing'; r.endsAt = Date.now() + quiz[i].duration * 1000;
  update(r);
}
function resolveRound(r) {
  if (r.phase !== 'playing') return;
  r.phase = 'intermission'; r.endsAt = Date.now() + PHASE_BREAK_MS;
  r.completed = Math.max(r.completed, r.round + 1);
  update(r);
}
function advance(r) {
  if (r.phase !== 'intermission') return;
  if (r.round + 1 >= quiz.length) {
    r.phase = 'finished'; r.endsAt = null;
    update(r);
  } else startRound(r, r.round + 1);
}
function detachFromOldRoom(socket) {
  if (!socket.data.code) return;
  const old = rooms.get(socket.data.code);
  if (old && socket.data.role === 'player') {
    const p = old.players.get(socket.data.playerId);
    if (p?.socketId === socket.id) { p.socketId = null; update(old); }
  }
  socket.leave(socket.data.code);
  socket.data.code = null;
}
io.on('connection', socket => {
  socket.on('host:create', (_, ack) => {
    detachFromOldRoom(socket);
    const c = code(); const token = genToken();
    const r = { code: c, hostToken: token, hostSocketId: socket.id, players: new Map(), round: -1, phase: 'lobby', endsAt: null, completed: 0, touched: Date.now() };
    rooms.set(c, r);
    socket.join(c); socket.data.code = c; socket.data.role = 'host';
    emitAck(ack, { ok: true, code: c, hostToken: token }); update(r);
  });
  socket.on('host:resume', (data, ack) => {
    const r = rooms.get(String(data?.code || '').trim().toUpperCase());
    if (!r || r.hostToken !== data?.hostToken) return emitAck(ack, { ok: false, error: '主持憑證已失效，請重新開房。' });
    detachFromOldRoom(socket);
    socket.join(r.code); socket.data.code = r.code; socket.data.role = 'host'; r.hostSocketId = socket.id;
    emitAck(ack, { ok: true, code: r.code }); update(r);
  });
  socket.on('player:join', (data, ack) => {
    const r = rooms.get(String(data?.code || '').trim().toUpperCase());
    if (!r) return emitAck(ack, { ok: false, error: '查無房間，請檢查 6 位代碼。' });
    const name = safeName(data?.name);
    if (!name) return emitAck(ack, { ok: false, error: '請先輸入玩家暱稱。' });
    let player = null;
    if (data?.playerId && data?.playerToken) {
      const old = r.players.get(data.playerId);
      if (old?.token === data.playerToken) player = old;
    }
    if (!player) {
      if (r.players.size >= MAX_PLAYERS) return emitAck(ack, { ok: false, error: '房間已達人數上限。' });
      player = { id: crypto.randomUUID(), token: genToken(), name, score: 0, socketId: null, answers: new Map() };
      r.players.set(player.id, player);
    }
    detachFromOldRoom(socket);
    if (player.socketId && player.socketId !== socket.id) io.sockets.sockets.get(player.socketId)?.disconnect(true);
    player.socketId = socket.id; socket.join(r.code); socket.data.code = r.code; socket.data.role = 'player'; socket.data.playerId = player.id;
    const previousAnswer = player.answers.get(r.round);
    emitAck(ack, {
      ok: true, code: r.code, playerId: player.id, playerToken: player.token, name: player.name,
      answerRound: r.round,
      answer: previousAnswer ? { ...previousAnswer, explanation: quiz[r.round].explain } : null,
    });
    update(r);
  });
  socket.on('host:start', (_, ack) => {
    const r = rooms.get(socket.data.code);
    if (!r || r.hostSocketId !== socket.id || socket.data.role !== 'host') return emitAck(ack, {ok: false, error: '無主持權限'});
    if (r.phase !== 'lobby') return emitAck(ack, {ok: false, error: '遊戲已開始'});
    if (r.players.size === 0) return emitAck(ack, {ok: false, error: '至少需要 1 位玩家加入'});
    startRound(r, 0); emitAck(ack, { ok: true });
  });
  socket.on('host:next', (_, ack) => {
    const r = rooms.get(socket.data.code);
    if (!r || r.hostSocketId !== socket.id || socket.data.role !== 'host') return emitAck(ack, {ok: false, error: '無主持權限'});
    if (r.phase === 'playing') resolveRound(r);
    else if (r.phase === 'intermission') advance(r);
    else return emitAck(ack, {ok: false, error: '此時無法跳關'});
    emitAck(ack, {ok: true});
  });
  socket.on('host:reset', (_, ack) => {
    const r = rooms.get(socket.data.code);
    if (!r || r.hostSocketId !== socket.id || socket.data.role !== 'host') return emitAck(ack, {ok: false, error: '無主持權限'});
    r.phase = 'lobby'; r.round = -1; r.endsAt = null; r.completed = 0;
    for(const p of r.players.values()) { p.score = 0; p.answers.clear(); }
    update(r); emitAck(ack, { ok:true });
  });
  socket.on('player:answer', (data, ack) => {
    const r = rooms.get(socket.data.code);
    const p = r?.players.get(socket.data.playerId);
    if (!r || !p || p.socketId !== socket.id || r.phase !== 'playing' || Date.now() >= r.endsAt) return emitAck(ack, {ok:false, error:'本關已結束，請等待下一關。'});
    if (p.answers.has(r.round)) return emitAck(ack, {ok:false, error:'本關只能拆一次線。'});
    const q = quiz[r.round];
    const picked = String(data?.choice || '');
    if (!q.options.some(x => x.id === picked)) return emitAck(ack, {ok:false, error:'選項不正確。'});
    const correct = picked === q.correct;
    const bonus = correct ? Math.floor(Math.max(0,r.endsAt-Date.now())/1000)*10 : 0;
    const delta = correct ? 500 + bonus : -100;
    p.score = Math.max(0, p.score + delta);
    p.answers.set(r.round, { choice: picked, correct, delta });
    emitAck(ack, {ok:true, correct, delta, answer:q.correct, explanation:q.explain});
    update(r);
    if ([...r.players.values()].filter(x => x.socketId).every(x => x.answers.has(r.round))) resolveRound(r);
  });
  socket.on('disconnect', () => {
    const r = rooms.get(socket.data.code);
    if (!r) return;
    if (socket.data.role === 'player') {
      const p = r.players.get(socket.data.playerId);
      if (p?.socketId === socket.id) p.socketId = null;
    } else if (socket.data.role === 'host' && r.hostSocketId === socket.id) r.hostSocketId = null;
    update(r);
  });
});
setInterval(() => {
  const now = Date.now();
  for(const [c, r] of rooms) {
    if(now-r.touched > 3 * 60 * 60 * 1000) { rooms.delete(c); continue; }
    if (r.endsAt && now >= r.endsAt) {
      if (r.phase === 'playing') resolveRound(r);
      else if (r.phase === 'intermission') advance(r);
    }
  }
}, 250).unref();
if (require.main === module) server.listen(PORT, '0.0.0.0', () => console.log(`Bomb Squad http://localhost:${PORT}`));
module.exports = { app, server, quiz, rooms };
