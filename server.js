// server.js - MAHJONG CHICKEN HAND ONLINE - FULL FIX + DADU + TIMER + NAMA BOT + PASS + HOST CHECK + DUPLIKAT NAMA
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET","POST"] } });
const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => res.send('OK'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

let rooms = {};

// ============ TILE HELPERS ============
function tileKey(t){
  if(t.type==='suit') return 'suit-'+t.suit+'-'+t.num;
  if(t.type==='wind') return 'wind-'+t.num;
  if(t.type==='dragon') return 'dragon-'+t.num;
  return 'flower-'+t.num;
}
function tileName(t){
  if(!t) return '?';
  if(t.type==='flower') return '🌸 Bunga';
  if(t.type==='wind'){ let n=['Timur','Selatan','Barat','Utara']; return 'Angin '+n[t.num]; }
  if(t.type==='dragon'){ let n=['Merah','Hijau','Putih']; return 'Naga '+n[t.num]; }
  let s=['Bambu','Dot','Karakter'][t.suit];
  return s+' '+t.num;
}
function createTiles(){
  let tiles=[]; let id=1;
  for(let suit=0;suit<3;suit++) for(let n=1;n<=9;n++) for(let c=0;c<4;c++) tiles.push({id:id++, type:'suit', suit, num:n, key:'suit-'+suit+'-'+n});
  for(let n=0;n<4;n++) for(let c=0;c<4;c++) tiles.push({id:id++, type:'wind', suit:-1, num:n, key:'wind-'+n});
  for(let n=0;n<3;n++) for(let c=0;c<4;c++) tiles.push({id:id++, type:'dragon', suit:-1, num:n, key:'dragon-'+n});
  for(let n=0;n<8;n++) tiles.push({id:id++, type:'flower', suit:-1, num:n, key:'flower-'+n});
  return tiles;
}
function shuffle(arr){ for(let i=arr.length-1;i>0;i--){ let j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; } return arr; }
function sortHand(hand){
  let order=t=> t.type==='suit'?0 : t.type==='wind'?1 : t.type==='dragon'?2 : 3;
  return hand.sort((a,b)=>{ if(order(a)!==order(b)) return order(a)-order(b); if(a.suit!==b.suit) return a.suit-b.suit; return a.num-b.num; });
}
function genCode(){ let c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let r=''; for(let i=0;i<4;i++) r+=c[Math.floor(Math.random()*c.length)]; return r; }

// ============ ROOM HELPERS ============
function emitToRoom(room, ev, data){ io.to(room.code).emit(ev, data); }
function emitLobby(room){
  let payload = { code: room.code, players: publicPlayers(room), hostId: room.players.find(x=>x.isHost)?.id, turnTimeSec: room.turnTimeSec, turnTime: room.turnTimeSec };
  io.to(room.code).emit('lobbyUpdate', payload);
  io.to(room.code).emit('updateLobby', payload);
}
function addLog(room, msg){ emitToRoom(room, 'gameLog', { msg }); }

// FIX BUG 4: jangan kirim hand asli, cuma handCount
function publicPlayers(room){
  return room.players.map(p=>({
    name:p.name, isBot:p.isBot, level:p.level||'',
    botLevel: p.level||'easy',
    hostId: room.players.find(x=>x.isHost)?.id,
    id:p.id, isHost:p.isHost,
    handCount:p.hand.length,
    melds:p.melds, discards:p.discards, flowers:p.flowers
  }));
}
function clearTurnTimer(room){ if(room.turnTimer){ clearTimeout(room.turnTimer); room.turnTimer=null; } }
function startTurnTimer(room){
  clearTurnTimer(room);
  if(!room.turnTimeSec || room.turnTimeSec===0) return; // 0 = tanpa batas
  if(room.phase!=='playing') return;
  room.turnTimer = setTimeout(()=>{
    if(!room || room.phase!=='playing') return;
    let cur = room.players[room.turnIdx];
    if(!cur) return;
    if(room.waitingClaim) return;
    // Waktu habis -> auto buang 1 tile random (biar game gak macet)
    if(cur.isBot){ maybeBotTurn(room); return; }
    if(cur.hand.length>0){
      let tile = botChooseDiscard(cur);
      if(!tile) tile = cur.hand[0];
      let idx = cur.hand.findIndex(t=>t.id===tile.id);
      if(idx>=0) cur.hand.splice(idx,1);
      cur.discards.push(tile);
      room.lastDiscard = { tile, from:cur.name };
      emitToRoom(room, 'discarded', { from:cur.name, tile, tileName:tileName(tile), wallLeft:room.wall.length, players:publicPlayers(room), claims: getClaimsFor(room, tile, cur.name) });
      room.players.forEach(x=>sendHand(room,x));
      addLog(room, `⏰ ${cur.name} kehabisan waktu, auto buang ${tileName(tile)}!`);
      handleAfterDiscard(room, cur, tile);
    }
  }, room.turnTimeSec*1000);
}
function sendHand(room, p){
  if(!p.isBot){
    let canHu = canHuWithMelds(p.hand, p.melds);
    io.to(p.id).emit('yourHand', { hand:sortHand([...p.hand]), melds:p.melds, flowers:p.flowers, discards:p.discards, canHu });
  }
}
// FIX 1: normal tetep normal, jangan jadi medium - index ngecek 'normal'
function normalizeLevel(level){
  if(level==='normal') return 'normal';
  if(level==='medium') return 'normal';
  if(level==='hard') return 'hard';
  if(level==='easy') return 'easy';
  return 'easy';
}

// ============ CEK HU BENERAN ============
function checkHu(hand){
  if(!hand || hand.length!==14) return false;
  let tiles = hand.filter(t=>t.type!=='flower');
  if(tiles.length!==14) return false;
  let counts = {};
  tiles.forEach(t=>{ let k = t.type + '|' + t.suit + '|' + t.num; counts[k] = (counts[k]||0)+1; });
  for(let k in counts){
    if(counts[k] < 2) continue;
    let rest = {...counts}; rest[k] -= 2;
    if(canForm4Melds(rest)) return true;
  }
  return false;
}
// FIX BUG 5: HU yang bener kalau udah punya meld (set kebuka)
function canHuWithMelds(hand, melds){
  melds = melds || [];
  let meldCount = melds.length;
  let tiles = hand.filter(t=>t.type!=='flower');
  // Total harus 14: tangan + meld*3 = 14, dan tangan harus bisa jadi (4-meldCount) set + 1 pair
  if(tiles.length + meldCount*3 !== 14) return false;
  if(meldCount===0) return checkHu(hand);
  // Coba semua pair di tangan
  let counts = {};
  tiles.forEach(t=>{ let k = t.type + '|' + t.suit + '|' + t.num; counts[k]=(counts[k]||0)+1; });
  let needSets = 4 - meldCount;
  for(let k in counts){
    if(counts[k] < 2) continue;
    let rest = {...counts}; rest[k]-=2;
    if(canFormSets(rest, needSets)) return true;
  }
  // Kalau tangan tinggal pair doang (needSets 0)
  if(needSets===0 && tiles.length===2 && tiles[0].key===tiles[1].key) return true;
  return false;
}
function canFormSets(counts, needSets){
  let keys = Object.keys(counts).filter(k=>counts[k]>0);
  if(keys.length===0) return needSets===0;
  if(needSets===0) return false;
  let key = keys[0];
  let [type, suitStr, numStr] = key.split('|');
  let suit = parseInt(suitStr); let num = parseInt(numStr); let count = counts[key];
  if(count >= 3){ let next={...counts}; next[key]-=3; if(canFormSets(next, needSets-1)) return true; }
  if(type==='suit' && num <= 7){
    let k1 = `suit|${suit}|${num+1}`; let k2 = `suit|${suit}|${num+2}`;
    if((counts[k1]||0)>0 && (counts[k2]||0)>0){ let next={...counts}; next[key]-=1; next[k1]-=1; next[k2]-=1; if(canFormSets(next, needSets-1)) return true; }
  }
  return false;
}
function canForm4Melds(counts){
  let keys = Object.keys(counts).filter(k=>counts[k]>0);
  if(keys.length===0) return true;
  let key = keys[0];
  let [type, suitStr, numStr] = key.split('|');
  let suit = parseInt(suitStr); let num = parseInt(numStr); let count = counts[key];
  if(count >= 3){ let next = {...counts}; next[key] -= 3; if(canForm4Melds(next)) return true; }
  if(type==='suit' && num <= 7){
    let k1 = `suit|${suit}|${num+1}`; let k2 = `suit|${suit}|${num+2}`;
    if((counts[k1]||0) > 0 && (counts[k2]||0) > 0){ let next = {...counts}; next[key] -= 1; next[k1] -= 1; next[k2] -= 1; if(canForm4Melds(next)) return true; }
  }
  return false;
}
function canHuWithTile(hand, tile){ return checkHu([...hand, tile]); }
function canHuWithTileAndMelds(hand, melds, tile){ return canHuWithMelds([...hand, tile], melds); }

// ============ BOT AI ============
function botChooseDiscard(bot){
  let hand = bot.hand.filter(t=>t.type!=='flower');
  if(hand.length===0) return bot.hand[0];
  let counts={}; hand.forEach(t=>{ counts[t.key]=(counts[t.key]||0)+1; });
  let singles = hand.filter(t=>counts[t.key]===1);
  let honor = singles.filter(t=>t.type==='wind'||t.type==='dragon');
  if(honor.length>0) return honor[Math.floor(Math.random()*honor.length)];
  let terminal = singles.filter(t=>t.type==='suit' && (t.num===1||t.num===9));
  if(terminal.length>0) return terminal[Math.floor(Math.random()*terminal.length)];
  if(singles.length>0) return singles[Math.floor(Math.random()*singles.length)];
  return hand[Math.floor(Math.random()*hand.length)];
}
function botDecideClaim(bot, tile, isNext){
  if(tile.type==='flower') return null;
  if(canHuWithTileAndMelds(bot.hand, bot.melds, tile)) return { action:'hu' };
  let count = bot.hand.filter(t=>t.key===tile.key).length;
  if(count>=2) return { action:'pong' };
  if(isNext && tile.type==='suit'){
    let nums = bot.hand.filter(t=>t.type==='suit' && t.suit===tile.suit).map(t=>t.num);
    if(nums.includes(tile.num-2) && nums.includes(tile.num-1)) return { action:'chow', chowNums:[tile.num-2, tile.num-1] };
    if(nums.includes(tile.num-1) && nums.includes(tile.num+1)) return { action:'chow', chowNums:[tile.num-1, tile.num+1] };
    if(nums.includes(tile.num+1) && nums.includes(tile.num+2)) return { action:'chow', chowNums:[tile.num+1, tile.num+2] };
  }
  return null;
}
function botDrawAndDiscard(room, bot){
  if(!room || room.phase!=='playing') return;
  if(room.players[room.turnIdx].name!==bot.name) return;
  if(room.waitingClaim) return;
  if(room.wall.length===0){ endGameDraw(room); return; }
  let drawn = room.wall.pop();
  while(drawn && drawn.type==='flower'){ bot.flowers.push(drawn); if(room.wall.length===0) break; drawn=room.wall.pop(); }
  if(drawn) bot.hand.push(drawn);
  sendHand(room, bot);
  emitToRoom(room, 'playerDrew', { player:bot.name, wallLeft:room.wall.length });
  setTimeout(()=>botDiscard(room, bot), 900);
}
function botDiscard(room, bot){
  if(!room || room.phase!=='playing') return;
  if(room.players[room.turnIdx].name!==bot.name) return;
  if(canHuWithMelds(bot.hand, bot.melds)){ endGameWin(room, bot.name, 'Bot HU! Chicken Hand!'); return; }
  let tile = botChooseDiscard(bot);
  if(!tile) return;
  let idx = bot.hand.findIndex(t=>t.id===tile.id);
  if(idx>=0) bot.hand.splice(idx,1);
  bot.discards.push(tile);
  room.lastDiscard = { tile, from:bot.name };
  emitToRoom(room, 'discarded', { from:bot.name, tile, tileName:tileName(tile), wallLeft:room.wall.length, players:publicPlayers(room), claims: getClaimsFor(room, tile, bot.name) });
  emitToRoom(room, 'playerDiscarded', { player:bot.name, tile, wallLeft:room.wall.length });
  room.players.forEach(p=>sendHand(room,p));
  handleAfterDiscard(room, bot, tile);
}
function maybeBotTurn(room){
  if(!room || room.phase!=='playing') return;
  if(room.waitingClaim) return;
  let cur = room.players[room.turnIdx];
  if(!cur || !cur.isBot) return;
  if(cur.hand.length>=14){ setTimeout(()=>botDiscard(room, cur), 1000); return; }
  setTimeout(()=>botDrawAndDiscard(room, cur), 1000);
}
function getClaimsFor(room, tile, fromName){
  let claims=[];
  let fromIdx = room.players.findIndex(p=>p.name===fromName);
  room.players.forEach((p, idx)=>{
    if(p.name===fromName) return;
    if(p.isBot) return;
    let canHu = canHuWithTileAndMelds(p.hand, p.melds, tile);
    let pong = p.hand.filter(t=>t.key===tile.key).length>=2;
    let chow=[];
    let isNext = ((fromIdx+1)%room.players.length)===idx;
    if(isNext && tile.type==='suit'){
      let nums = p.hand.filter(t=>t.type==='suit' && t.suit===tile.suit).map(t=>t.num);
      if(nums.includes(tile.num-2)&&nums.includes(tile.num-1)) chow.push([tile.num-2,tile.num-1,tile.num]);
      if(nums.includes(tile.num-1)&&nums.includes(tile.num+1)) chow.push([tile.num-1,tile.num,tile.num+1]);
      if(nums.includes(tile.num+1)&&nums.includes(tile.num+2)) chow.push([tile.num,tile.num+1,tile.num+2]);
    }
    if(canHu||pong||chow.length>0) claims.push({ name:p.name, canHu, pong, chow });
  });
  return claims;
}

// ============ GAME FLOW ============
function startGame(room, turnTimeSec){
  if(turnTimeSec!==undefined && turnTimeSec!==null) room.turnTimeSec = turnTimeSec;
  let tiles = shuffle(createTiles());
  room.wall = tiles;
  room.phase='playing'; room.lastDiscard=null; room.waitingClaim=false; room.currentClaim=null; room.passCount=0; room.passNeeded=0; room.passedNames=[]; clearClaimTimer(room);
  // FITUR 2: LEMPAR DADU - tentukan dealer dari dadu
  let d1 = 1+Math.floor(Math.random()*6);
  let d2 = 1+Math.floor(Math.random()*6);
  let total = d1+d2;
  let dealerIdx = (total-1) % room.players.length;
  room.turnIdx = dealerIdx;
  room.lastDice = { d1, d2, total, dealer: room.players[dealerIdx].name };
  room.players.forEach((p, idx)=>{
    p.hand=[]; p.melds=[]; p.discards=[]; p.flowers=[];
    let count = idx===dealerIdx ? 14 : 13;
    for(let i=0;i<count;i++){
      let t = room.wall.pop();
      while(t && t.type==='flower'){ p.flowers.push(t); t=room.wall.pop(); }
      if(t) p.hand.push(t);
    }
    p.hand = sortHand(p.hand);
  });
  let dealer = room.players[dealerIdx];
  emitToRoom(room, 'diceRolled', { d1, d2, total, dealer: dealer.name });
  emitToRoom(room, 'gameStarted', { players:publicPlayers(room), wallLeft:room.wall.length, turn:dealer.name, turnTimeSec:room.turnTimeSec, dice:{d1,d2,total,dealer:dealer.name} });
  room.players.forEach(p=>sendHand(room,p));
  addLog(room, `🎲 Dadu: ${d1} + ${d2} = ${total}! Dealer: ${dealer.name}. Rebutan HU!`);
  setTimeout(()=>{ emitToRoom(room, 'turnChanged', { turn:dealer.name, wallLeft:room.wall.length }); }, 500);
  startTurnTimer(room);
  setTimeout(()=>maybeBotTurn(room), 1200);
}
function clearClaimTimer(room){ if(room.claimTimer){ clearTimeout(room.claimTimer); room.claimTimer=null; } }
function resolveClaimTimeout(room, discarder, tile){
  if(!room || room.phase!=='playing') return;
  if(!room.waitingClaim) return;
  clearClaimTimer(room);
  let discarderIdx = room.players.findIndex(p=>p.name===discarder.name);
  // 1. Bot HU dulu (paling prioritas)
  for(let i=0;i<room.players.length;i++){
    let p=room.players[i];
    if(p.name===discarder.name) continue;
    if(p.isBot && canHuWithTileAndMelds(p.hand, p.melds, tile)){ endGameWin(room, p.name, `${p.name} HU dari buangan ${discarder.name}!`); return; }
  }
  // 2. Bot PONG
  for(let i=0;i<room.players.length;i++){
    let p=room.players[i];
    if(p.name===discarder.name) continue;
    if(p.isBot){
      let dec=botDecideClaim(p, tile, false);
      if(dec && dec.action==='pong'){ doClaim(room, p, 'pong', null, tile, discarder); return; }
    }
  }
  // 3. Bot CHOW (next player)
  let nextIdx=(discarderIdx+1)%room.players.length;
  let nextP=room.players[nextIdx];
  if(nextP && nextP.isBot){
    let dec=botDecideClaim(nextP, tile, true);
    if(dec && dec.action==='chow'){ doClaim(room, nextP, 'chow', dec.chowNums, tile, discarder); return; }
  }
  // 4. Gak ada yang claim -> lanjut langsung
  room.waitingClaim=false; room.lastDiscard=null; room.currentClaim=null;
  advanceTurn(room, discarder);
}
function handleAfterDiscard(room, discarder, tile){
  clearTurnTimer(room);
  clearClaimTimer(room);
  room.waitingClaim=true;
  room.currentClaim={ tile, from:discarder.name };
  // Cuma manusia yang BISA claim yang harus PASS. Yang gak bisa claim gak usah ditunggu.
  let humanClaims = getClaimsFor(room, tile, discarder.name);
  room.passCount = 0;
  room.passNeeded = humanClaims.length;
  room.passedNames = [];
  emitToRoom(room, 'claimAvailable', { tile, from:discarder.name, claims: humanClaims });
  // Cek BOT bisa claim atau tidak
  let discarderIdx = room.players.findIndex(p=>p.name===discarder.name);
  let botCanClaim = false;
  for(let i=0;i<room.players.length;i++){
    let b = room.players[i];
    if(b.name===discarder.name || !b.isBot) continue;
    let isNext = ((discarderIdx+1)%room.players.length)===i;
    if(botDecideClaim(b, tile, isNext)){ botCanClaim = true; break; }
  }
  // JALUR CEPET 1: gak ada manusia bisa claim + gak ada BOT bisa claim -> LANGSUNG next, gak usah nunggu 7 detik
  if(humanClaims.length===0 && !botCanClaim){
    room.waitingClaim=false; room.lastDiscard=null; room.currentClaim=null;
    advanceTurn(room, discarder);
    return;
  }
  // JALUR CEPET 2: gak ada manusia bisa claim, cuma BOT yang bisa -> BOT langsung claim, gak usah nunggu 7 detik
  if(humanClaims.length===0 && botCanClaim){
    resolveClaimTimeout(room, discarder, tile);
    return;
  }
  // Ada manusia yang bisa claim -> kasih waktu 7 DETIK aja buat PONG / CHOW / HU / PASS.
  // Bukan nunggu timer giliran (30 detik). Kalau 7 detik habis / semua udah PASS, langsung next.
  room.claimTimer = setTimeout(()=>{ resolveClaimTimeout(room, discarder, tile); }, 7000);
}
function doClaim(room, claimer, action, chowNums, tile, discarder){
  clearTurnTimer(room);
  clearClaimTimer(room);
  if(action==='hu'){ endGameWin(room, claimer.name, `${claimer.name} HU!`); return; }
  let dIdx = discarder.discards.findIndex(t=>t.id===tile.id);
  if(dIdx>=0) discarder.discards.splice(dIdx,1);
  let need=[];
  if(action==='pong'){
    need = claimer.hand.filter(t=>t.key===tile.key).slice(0,2);
    if(need.length<2) return;
  } else if(action==='chow' && chowNums){
    chowNums.forEach(n=>{
      if(n===tile.num) return;
      let found = claimer.hand.find(t=>t.type==='suit' && t.suit===tile.suit && t.num===n);
      if(found) need.push(found);
    });
    if(need.length<2) return;
  }
  need.forEach(t=>{ let i=claimer.hand.findIndex(x=>x.id===t.id); if(i>=0) claimer.hand.splice(i,1); });
  claimer.melds.push({ type:action, tiles:[tile, ...need] });
  room.waitingClaim=false; room.lastDiscard=null; room.currentClaim=null;
  room.turnIdx = room.players.findIndex(p=>p.name===claimer.name);
  emitToRoom(room, 'meldMade', { by:claimer.name, meld:{type:action, tiles:[tile, ...need]}, players:publicPlayers(room) });
  emitToRoom(room, 'claimed', { claimer:claimer.name, action, tiles:[tile, ...need], turn:claimer.name });
  emitToRoom(room, 'turnChanged', { turn:claimer.name, wallLeft:room.wall.length });
  room.players.forEach(p=>sendHand(room,p));
  addLog(room, `⚡ ${claimer.name} ${action.toUpperCase()} ${tileName(tile)} dari ${discarder.name}!`);
  startTurnTimer(room);
  if(claimer.isBot){ setTimeout(()=>{ botDiscard(room, claimer); }, 1500); }
}
function advanceTurn(room, fromPlayer){
  if(!room || room.phase!=='playing') return;
  clearTurnTimer(room);
  let fromIdx = room.players.findIndex(p=>p.name===fromPlayer.name);
  if(fromIdx===-1) fromIdx = room.turnIdx;
  let nextIdx = (fromIdx+1)%room.players.length;
  room.turnIdx = nextIdx;
  let nextP = room.players[nextIdx];
  emitToRoom(room, 'turnChanged', { turn:nextP.name, wallLeft:room.wall.length });
  startTurnTimer(room);
  if(nextP.isBot){
    setTimeout(()=>maybeBotTurn(room), 800);
  } else {
    if(room.wall.length===0){ endGameDraw(room); return; }
    let drawn = room.wall.pop();
    while(drawn && drawn.type==='flower'){
      nextP.flowers.push(drawn);
      if(room.wall.length===0) break;
      drawn = room.wall.pop();
    }
    if(drawn) nextP.hand.push(drawn);
    sendHand(room, nextP);
    io.to(nextP.id).emit('youDrew', { tile:drawn, wallLeft:room.wall.length });
    emitToRoom(room, 'playerDrew', { player:nextP.name, wallLeft:room.wall.length });
  }
}
function endGameDraw(room){
  clearTurnTimer(room);
  room.phase='finished';
  emitToRoom(room, 'gameOver', { winner:null, message:'Tembok habis! Seri!', reason:'draw', msg:'Tembok habis! Seri!' });
  addLog(room, '🏳️ Tembok habis, seri!');
}
function endGameWin(room, winnerName, msg){
  clearTurnTimer(room);
  room.phase='finished'; room.waitingClaim=false;
  let winner = room.players.find(p=>p.name===winnerName);
  emitToRoom(room, 'gameOver', { winner:winnerName, message:msg, msg, hand: winner?winner.hand:[] });
  addLog(room, '🏆 '+msg);
}

// ============ SOCKET.IO ============
io.on('connection', (socket)=>{
  console.log('User connected:', socket.id);

  socket.on('createRoom', ({ name })=>{
    let code = genCode();
    let room = { code, players:[], wall:[], phase:'lobby', turnIdx:0, lastDiscard:null, waitingClaim:false, turnTimeSec:30, turnTimer:null, lastDice:null, passCount:0, passNeeded:0, passedNames:[], claimTimer:null };
    let cleanName = (name||'Player').trim() || 'Player';
    let p = { id:socket.id, name:cleanName, isBot:false, isHost:true, hand:[], melds:[], discards:[], flowers:[], level:'' };
    room.players.push(p);
    rooms[code]=room;
    socket.join(code);
    socket.emit('roomCreated', { code, players:publicPlayers(room) });
    emitLobby(room);
  });

  socket.on('joinRoom', ({ name, code })=>{
    code = (code||'').toUpperCase().trim();
    let room = rooms[code];
    if(!room){ socket.emit('errorMsg', 'Room tidak ditemukan! Cek kode!'); return; }
    if(room.players.length>=4){ socket.emit('errorMsg', 'Room penuh!'); return; }
    if(room.phase==='playing'){ socket.emit('errorMsg', 'Game sudah mulai!'); return; }
    let cleanName = (name||'Player').trim() || 'Player';
    // FIX 2: tolak nama kembar - index + server identifikasi pemain pake nama
    if(room.players.some(x=>x.name===cleanName)){ socket.emit('errorMsg','Nama udah dipake! Ganti nama lain!'); return; }
    let p = { id:socket.id, name:cleanName, isBot:false, isHost:false, hand:[], melds:[], discards:[], flowers:[], level:'' };
    room.players.push(p);
    socket.join(code);
    socket.emit('joinedRoom', { code, players:publicPlayers(room) });
    emitLobby(room);
  });

  // FIX BUG 1: pake botName dari client, jangan bikin Bot Gampang lagi
  socket.on('addBot', ({ code, level, botName })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
    // FIX 5: cuma HOST yang bisa tambah bot
    let me = room.players.find(p=>p.id===socket.id);
    if(!me || !me.isHost){ socket.emit('errorMsg','Cuma HOST yang bisa tambah BOT!'); return; }
    if(room.players.length>=4){ socket.emit('errorMsg', 'Sudah 4 pemain!'); return; }
    level = normalizeLevel(level);
    let base = (botName||'').trim();
    if(!base) base = 'BOT'+(room.players.filter(p=>p.isBot).length+1);
    // Biar gak kembar namanya
    let finalName = base; let n=2;
    while(room.players.some(p=>p.name===finalName)){ finalName = base+' '+n; n++; }
    let bot = { id:'bot-'+Date.now()+'-'+Math.random(), name:finalName, isBot:true, isHost:false, hand:[], melds:[], discards:[], flowers:[], level };
    room.players.push(bot);
    emitLobby(room);
    addLog(room, `🤖 ${bot.name} (${level.toUpperCase()} BOT) masuk!`);
  });

  socket.on('fillBots', ({ code, level })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
    let me = room.players.find(p=>p.id===socket.id);
    if(me && !me.isHost){ socket.emit('errorMsg','Cuma HOST!'); return; }
    level = normalizeLevel(level);
    let fallbacks = ['ANDI','BUDI','SARI','DEWI','EKO','FITRI'];
    while(room.players.length < 4){
      let base = fallbacks.find(n=>!room.players.some(p=>p.name===n)) || ('BOT'+(room.players.length+1));
      let bot = { id:'bot-'+Date.now()+'-'+Math.random(), name:base, isBot:true, isHost:false, hand:[], melds:[], discards:[], flowers:[], level };
      room.players.push(bot);
    }
    emitLobby(room);
    addLog(room, `🤖 Bot diisi full sampe 4 orang!`);
  });

  socket.on('removeBot', ({ code, botName })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
    let me = room.players.find(p=>p.id===socket.id);
    if(!me || !me.isHost){ socket.emit('errorMsg','Cuma HOST yang bisa hapus BOT!'); return; }
    let idx = room.players.findIndex(p=>p.isBot && p.name===botName);
    if(idx>=0) room.players.splice(idx,1);
    emitLobby(room);
  });

  // FIX BUG 2: handler setting waktu giliran (HOST ONLY)
  socket.on('setTurnTime', ({ code, seconds })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
    let me = room.players.find(p=>p.id===socket.id);
    if(!me || !me.isHost){ socket.emit('errorMsg','Cuma HOST yang bisa ganti waktu!'); return; }
    let sec = Number(seconds);
    if(isNaN(sec) || sec<0) sec = 30;
    if(sec!==0 && sec<5) sec = 5; // minimal 5 detik biar gak mustahil
    if(sec!==0 && sec>120) sec = 120;
    room.turnTimeSec = sec;
    emitToRoom(room, 'turnTimeUpdated', { seconds:sec });
    emitLobby(room);
    addLog(room, `⏱️ Waktu giliran diganti jadi ${sec===0?'Tanpa Batas':sec+' detik'}!`);
  });

  socket.on('startGame', ({ code, turnTimeSec })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
    // FIX 5: cuma HOST yang bisa mulai
    let me = room.players.find(p=>p.id===socket.id);
    if(!me || !me.isHost){ socket.emit('errorMsg','Cuma HOST yang bisa mulai game!'); return; }
    if(room.players.length<2){ socket.emit('errorMsg', 'Minimal 2 pemain buat mulai! Tambah bot!'); return; }
    startGame(room, turnTimeSec);
  });

  socket.on('playAgain', ({ code })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
    clearTurnTimer(room);
    room.phase='lobby';
    room.players.forEach(p=>{ p.hand=[]; p.melds=[]; p.discards=[]; p.flowers=[]; });
    emitLobby(room);
    emitToRoom(room, 'playAgainReady', { code });
  });

  socket.on('drawTile', ({ code })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room || room.phase!=='playing') return;
    let p = room.players.find(x=>x.id===socket.id);
    if(!p) return;
    if(room.players[room.turnIdx].name!==p.name) return;
    if(p.hand.length>=14) return;
    if(room.wall.length===0){ endGameDraw(room); return; }
    let drawn = room.wall.pop();
    while(drawn && drawn.type==='flower'){ p.flowers.push(drawn); if(room.wall.length===0) break; drawn=room.wall.pop(); }
    if(drawn) p.hand.push(drawn);
    sendHand(room, p);
    emitToRoom(room, 'playerDrew', { player:p.name, wallLeft:room.wall.length });
    io.to(p.id).emit('youDrew', { tile:drawn, wallLeft:room.wall.length });
  });

  socket.on('discard', ({ code, tileId })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room || room.phase!=='playing') return;
    let p = room.players.find(x=>x.id===socket.id);
    if(!p) return;
    if(room.players[room.turnIdx].name!==p.name) return;
    if(room.waitingClaim) return;
    if((p.hand.length - 2) % 3 !== 0){
      socket.emit('errorMsg', 'Ambil tile dulu! Tangan kamu masih ' + p.hand.length);
      return;
    }
    let idx = p.hand.findIndex(t=>t.id==tileId);
    if(idx<0) return;
    if(canHuWithMelds(p.hand, p.melds)){ endGameWin(room, p.name, `${p.name} HU! Chicken Hand!`); return; }
    let tile = p.hand.splice(idx,1)[0];
    p.discards.push(tile);
    room.lastDiscard = { tile, from:p.name };
    emitToRoom(room, 'discarded', { from:p.name, tile, tileName:tileName(tile), wallLeft:room.wall.length, players:publicPlayers(room), claims: getClaimsFor(room, tile, p.name) });
    emitToRoom(room, 'playerDiscarded', { player:p.name, tile, wallLeft:room.wall.length });
    room.players.forEach(x=>sendHand(room,x));
    handleAfterDiscard(room, p, tile);
  });

  socket.on('claim', ({ code, action, chowNums })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room || room.phase!=='playing') return;
    if(!room.waitingClaim || !room.currentClaim) return;
    let p = room.players.find(x=>x.id===socket.id);
    if(!p) return;
    let { tile, from } = room.currentClaim;
    let discarder = room.players.find(x=>x.name===from);
    if(!discarder) return;
    // FIX 3: PASS beneran jalan
    if(action==='pass'){
      if(!room.passedNames) room.passedNames=[];
      if(!room.passedNames.includes(p.name)){ room.passedNames.push(p.name); room.passCount = (room.passCount||0)+1; }
      // Kalau semua manusia yang BISA claim udah PASS -> langsung putusin detik itu juga, gak nunggu sisa 7 detik
      if((room.passCount||0) >= (room.passNeeded||0)){
        // resolveClaimTimeout udah ngurus: BOT HU/PONG/CHOW langsung claim, kalau gak ada langsung next
        resolveClaimTimeout(room, discarder, tile);
      }
      return;
    }
    if(action==='hu'){ doClaim(room, p, 'hu', null, tile, discarder); return; }
    if(action==='chow'){
      let discarderIdx = room.players.findIndex(x=>x.name===from);
      let nextIdx = (discarderIdx+1)%room.players.length;
      if(room.players[nextIdx].name!==p.name) return;
    }
    if(action==='pong'){
      let c = p.hand.filter(t=>t.key===tile.key).length;
      if(c<2) return;
    }
    doClaim(room, p, action, chowNums, tile, discarder);
  });

  socket.on('selfHu', ({ code })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room || room.phase!=='playing') return;
    let p = room.players.find(x=>x.id===socket.id);
    if(!p) return;
    if(canHuWithMelds(p.hand, p.melds)){ endGameWin(room, p.name, `${p.name} HU! Chicken Hand!`); }
  });

  socket.on('tableChat', ({ code, msg })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
    let p = room.players.find(x=>x.id===socket.id);
    let sender = p ? p.name : 'Player';
    let payload = { sender, name:sender, msg, time: new Date().toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'}) };
    emitToRoom(room, 'chatMsg', payload);
    emitToRoom(room, 'tableChatMsg', payload);
  });

  socket.on('disconnect', ()=>{
    for(let code in rooms){
      let room = rooms[code];
      let idx = room.players.findIndex(p=>p.id===socket.id);
      if(idx>=0){
        let left = room.players[idx];
        room.players.splice(idx,1);
        if(room.players.length===0){
          clearTurnTimer(room);
          delete rooms[code];
        } else {
          if(left.isHost && room.players.length>0) room.players[0].isHost = true;
          emitLobby(room);
          addLog(room, `👋 ${left.name} keluar!`);
          if(room.phase==='playing'){
            if(room.turnIdx >= room.players.length) room.turnIdx = 0;
            if(room.players[room.turnIdx] && room.players[room.turnIdx].name===left.name){
              advanceTurn(room, left);
            }
          }
        }
        break;
      }
    }
  });
});

server.listen(PORT, ()=>{ console.log(`🀄 MAHJONG ONLINE + BOT di port ${PORT}`); });
