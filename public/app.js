'use strict';
const socket = io({ reconnection: true, reconnectionDelay: 600 });
const $ = id => document.getElementById(id);
const view = { role: null, code: null, hostToken: null, playerId: null, playerToken: null, current: null, answer: null, answerRound: -1, gameId: null, lastPhase: null, submitting: false, deadline: 0 };
// Keep each tab's identity independent so one browser can host and play.
const stash = key => { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; } };
const save = () => sessionStorage.setItem('bombSquadSession', JSON.stringify({role: view.role,code:view.code,hostToken:view.hostToken,playerId:view.playerId,playerToken:view.playerToken,name:view.name}));
const clearSession = () => sessionStorage.removeItem('bombSquadSession');
const escapeHtml = val => String(val ?? '').replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add('hidden'), 3100); }
function ask(event,data) { return new Promise(resolve => { socket.timeout(6500).emit(event,data,(err,result)=>resolve(err ? {ok:false,error:'伺服器暫時無法回應，請重新嘗試。'} : result)); }); }
function enter(role, data) { view.role=role; view.code=data.code; if(role==='host') view.hostToken=data.hostToken || view.hostToken; else {view.playerId=data.playerId;view.playerToken=data.playerToken;view.name=data.name;view.answer=data.answer || null;view.answerRound=data.round ?? -1;view.gameId=data.gameId;} save(); $('landing').classList.add('hidden'); $('game').classList.remove('hidden'); $('roleTag').textContent= role==='host'?'MISSION CONTROL / 主持人視角':'FIELD AGENT / 玩家視角'; $('roomCode').textContent=view.code; history.replaceState(null,'',`/?room=${encodeURIComponent(view.code)}`); }
async function createRoom() { $('createBtn').disabled=true; const r=await ask('host:create',{}); $('createBtn').disabled=false; if(!r?.ok) return toast(r?.error || '建立失敗'); enter('host',r); toast('房間已建立！把代碼投影給全班。'); }
async function joinRoom() { const code=$('joinCode').value.trim().toUpperCase(),name=$('nickname').value.trim(); if(code.length!==6) return toast('請輸入 6 位教室代碼'); if(!name) return toast('請輸入暱稱'); $('joinBtn').disabled=true; const r=await ask('player:join',{code,name}); $('joinBtn').disabled=false; if(!r?.ok) return toast(r?.error||'加入失敗'); enter('player',r); toast('加入成功！準備拆彈。'); }
async function restore() { const session=stash('bombSquadSession'); if(!session?.code || !session?.role) return; let r; if(session.role==='host') r=await ask('host:resume',{code:session.code,hostToken:session.hostToken}); else r=await ask('player:join',{code:session.code,name:session.name,playerId:session.playerId,playerToken:session.playerToken}); if(r?.ok) enter(session.role,{...r,hostToken:session.hostToken}); else {clearSession(); if(!view.role){ $('landing').classList.remove('hidden');$('game').classList.add('hidden'); } } }
function countText(ms) { if(!ms) return '00:00'; let sec=Math.max(0,Math.ceil(ms/1000));return `${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`; }
function drawDiagram(data) {
  ['lineAB','lineAC','lineBC'].forEach(id=>$(id).setAttribute('class',''));
  let caption='SW A、SW B、SW C：主要交換器拓樸';
  if(data.round===0 && data.phase!=='lobby'){ ['lineAB','lineAC','lineBC'].forEach(id=>$(id).setAttribute('class','danger')); caption='危險！三角形所有鏈路轉送中 → 可能形成 Loop'; }
  if(data.round===1){ $('lineBC').setAttribute('class','blocked');$('lineAB').setAttribute('class','failed');caption='A—B 已故障（紅色虛線）；B—C 目前仍被阻擋（黃色虛線）'; }
  if(data.round===2){ ['lineAB','lineAC','lineBC'].forEach(id=>$(id).setAttribute('class','danger'));caption='警報！限流降低影響，但 Loop 仍未被解除'; }
  $('diagramCaption').textContent=caption;
}
function renderOptions(data) {
  const area=$('questionArea'), holder=$('options');
  const show=['playing','intermission','finished'].includes(data.phase) && data.round >= 0;
  area.classList.toggle('hidden',!show);
  if(!show){holder.replaceChildren();return;}
  $('missionQuestion').textContent=data.question;
  holder.replaceChildren();
  const locked=view.submitting || (!!view.answer && view.answerRound===data.round) || data.players.some(p=>p.id===view.playerId && p.answered);
  data.options.forEach((opt,i)=>{
    const btn=document.createElement('button'); btn.className='option'; btn.type='button';
    if(locked && view.answer?.choice===opt.id) btn.classList.add(data.phase==='playing'||typeof view.answer.correct!=='boolean'?'selected':view.answer.correct?'correct':'wrong');
    if(data.phase!=='playing' && data.correct===opt.id) btn.classList.add('correct');
    btn.disabled=!socket.connected||view.role!=='player'||data.phase!=='playing'||locked;
    btn.innerHTML=`<div class="option-icon">${'ABCD'[i]}</div><div><strong>${escapeHtml(opt.label)}</strong><small>${escapeHtml(opt.sub)}</small></div>`;
    btn.addEventListener('click',()=>submit(opt.id));
    holder.appendChild(btn);
  });
}
async function submit(choice){
  const d=view.current;
  if(!socket.connected||!d||d.phase!=='playing'||view.submitting||(view.answer&&view.answerRound===d.round))return;
  view.submitting=true;render(d);
  const r=await ask('player:answer',{choice,gameId:d.gameId,round:d.round});
  view.submitting=false;
  if(!r?.ok){render(view.current);return toast(r?.error||'提交失敗');}
  // Ignore delayed receipts from an older round or a previous game.
  if(view.current?.gameId===r.gameId&&view.current.round===r.round&&view.current.phase==='playing'){
    view.answer={submitted:true,choice};view.answerRound=r.round;toast('答案已提交，等待本關結束');
  }
  render(view.current);
}
function renderFeedback(d) {
  const box=$('feedback'); let heading='',message='',variant='';
  if(view.role==='player'&&d.phase==='playing'&&(view.answer||d.players.some(p=>p.id===view.playerId&&p.answered))){heading='答案已提交，等待本關結束';}
  else if(view.role==='player' && d.phase!=='playing' && typeof view.answer?.correct==='boolean' && view.answerRound===d.round){ const a=view.answer;heading=a.correct?'✓ 拆彈成功！': '✕ 操作失敗！';message=`${a.delta>=0?'+':''}${a.delta} 分。${a.explanation}`;variant=a.correct?'good':'bad'; }
  else if(d.phase==='intermission'||d.phase==='finished'){heading=view.role==='player'&&!view.answer?'本關未作答｜+0 分':'📡 技術解密';message=d.explain||'';}
  else if(view.role==='player'&&d.phase==='playing'){heading='⚠ 一次機會';message='每關只能作答一次。答案、對錯及本關得分會在作答結束後統一公布。';}
  else{box.classList.add('hidden');return;}
  box.className='feedback '+variant;box.innerHTML=`<strong>${escapeHtml(heading)}</strong>${escapeHtml(message)}`;
}
function renderPlayers(d){const holder=$('playerList');holder.replaceChildren();$('peopleCount').textContent=`${d.players.length} 位玩家 · ${d.players.filter(x=>x.connected).length} 人在線`;if(!d.players.length){holder.innerHTML='<div class="empty">目前尚無玩家加入</div>';return;}d.players.forEach((p,i)=>{const el=document.createElement('div');el.className='player'; const marker=d.phase==='playing' ? (p.answered?' · 已提交':' · 思考中') : '';el.innerHTML=`<div class="rank">${i+1}</div><div class="name">${escapeHtml(p.name)}<small>${p.connected?'● 在線':'○ 離線'}${marker}</small></div><div class="score">${p.score}</div>`;holder.appendChild(el);});const mine=d.players.find(x=>x.id===view.playerId);$('myScore').classList.toggle('hidden',!(view.role==='player'&&mine));if(mine)$('myScore').textContent=`你的排名 #${d.players.findIndex(x=>x.id===mine.id)+1}｜已結算總分 ${mine.score} 分`;}
function render(d){if(!d || !view.role)return;view.current=d;const phase=d.phase;const headings={lobby:'作戰集結中',playing:d.headline,intermission:'答案解說與本關結算',finished:'🎉 拆彈任務結束'};
  $('gameTitle').textContent=headings[phase]||'網路拆彈';$('gameSub').textContent= phase==='lobby'?'分享代碼，準備與全班同步開始':phase==='playing'?'固定作答時間；提交後請等待統一揭曉':phase==='intermission'?'答案與得分已公布｜15 秒解說後自動繼續':'查看最終排名，恭喜所有完成任務的特工';
  $('countdownLabel').textContent=phase==='playing'?'作答倒數':phase==='intermission'?'解說倒數':'倒數計時';
  $('leaderboardNote').textContent=phase==='playing'?'顯示已結算總分；本關得分於作答結束後更新。':phase==='lobby'?'等待主持人啟動競賽。':'本關結果與總分已同步更新。';
  $('stageBadge').textContent=phase==='lobby'?'LOBBY':phase==='finished'?'COMPLETE':`${d.round+1} / ${d.roundCount}`;
  $('networkStatus').textContent=phase==='lobby'?'穩定待命':phase==='playing'?'⚠ 危險':phase==='intermission'?'✓ 已結算':'✓ 任務結束';
  $('missionTag').textContent=phase==='lobby'?'MISSION BRIEFING':phase==='finished'?'MISSION COMPLETE':d.stage;
  $('missionTitle').textContent=phase==='lobby'?'拯救網路的三道關卡':phase==='finished'?'拆彈行動結束！':phase==='intermission'?'本關完成｜公布正確處置':d.headline;
  $('missionStory').textContent=phase==='lobby'?'全班使用手機加入作戰室。主持人啟動後，每個人都要在倒數內選擇網路搶修方案；答對越快分數越高。':phase==='finished'?`共有 ${d.players.length} 名玩家參與！排行榜已經公布，主持人可重新開始。`:d.story;
  $('startBtn').classList.toggle('hidden',!(view.role==='host'&&phase==='lobby'));
  $('nextBtn').classList.toggle('hidden',!(view.role==='host'&&['playing','intermission'].includes(phase)));
  $('nextBtn').textContent=phase==='playing'?'手動結束作答並揭曉（跳關） →':'略過剩餘解說，進入下一階段 →';
  $('resetBtn').classList.toggle('hidden',!(view.role==='host'&&phase==='finished'));
  $('helperText').textContent=phase==='lobby'?view.role==='host'?'請等同學加入，再按「啟動拆彈競賽」。':'已加入！請看投影等待主持人開始。':phase==='playing'?'所有人答完仍會繼續倒數；主持人可手動結束本關。':phase==='intermission'?'15 秒解說後自動切換；主持人也可略過解說。':'最終排名已鎖定。';
  $('hintText').textContent= phase==='lobby'?'Layer 2 的廣播幀沒有像 IP TTL 那樣逐跳遞減的欄位。若形成轉送迴圈，可能造成廣播風暴。':d.lesson||'廣播風暴不等於單純很多人按按鈕；關鍵是 Layer 2 迴圈使廣播封包重複轉送。';
  if(view.gameId!==d.gameId||view.answerRound!==d.round){view.answer=null;view.answerRound=d.round;view.gameId=d.gameId;}
  drawDiagram(d);renderOptions(d);renderFeedback(d);renderPlayers(d);tick();
  if(phase==='finished'&&view.lastPhase!=='finished')toast('任務完成！快看最後排名！');view.lastPhase=phase;
}
function tick(){const d=view.current;if(!d)return;const remaining=Math.max(0,view.deadline-performance.now());$('countdown').textContent=d.phase==='lobby'?'--:--':d.phase==='finished'?'00:00':countText(remaining);$('countdown').closest('.time-cell').classList.toggle('danger',d.phase==='playing'&&remaining<11000);}
$('createBtn').addEventListener('click',createRoom);$('joinBtn').addEventListener('click',joinRoom);
$('joinCode').addEventListener('input',e=>{e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'');});
$('joinCode').addEventListener('keydown',e=>{if(e.key==='Enter')$('nickname').focus();});$('nickname').addEventListener('keydown',e=>{if(e.key==='Enter')joinRoom();});
$('copyCode').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(view.code);toast('教室代碼已複製');}catch{toast(`教室代碼：${view.code}`);}});
$('startBtn').addEventListener('click',async()=>{const r=await ask('host:start',{});if(!r?.ok)toast(r?.error||'無法開始');});
$('nextBtn').addEventListener('click',async()=>{const r=await ask('host:next',{});if(!r?.ok)toast(r?.error||'操作失敗');});
$('resetBtn').addEventListener('click',async()=>{const r=await ask('host:reset',{});if(!r?.ok)toast(r?.error||'操作失敗');});
socket.on('room:update',d=>{view.deadline=performance.now()+d.remainingMs;render(d);});
socket.on('player:state',state=>{
  if(view.role!=='player'||state.gameId!==view.current?.gameId||state.round!==view.current.round)return;
  view.answer=state.answer;view.answerRound=state.round;render(view.current);
});
socket.on('connect',()=>{ $('connection').classList.add('online');$('connection').querySelector('span').textContent='伺服器已連線';if(view.role||stash('bombSquadSession'))restore(); });
socket.on('disconnect',()=>{ $('connection').classList.remove('online');$('connection').querySelector('span').textContent='重新連線中';render(view.current); });
const linkRoom=new URLSearchParams(location.search).get('room');if(linkRoom)$('joinCode').value=linkRoom.toUpperCase().slice(0,6);
setInterval(tick,200);
