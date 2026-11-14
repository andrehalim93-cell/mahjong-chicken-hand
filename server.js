// server.js - MAHJONG CHICKEN HAND ONLINE - FULL FIX BOT + LOBBY
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

// ============ TILE HELPERS - SESUAI index.txt ============
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

// INI KUNCINYA - kirim 2 nama event biar client lama & baru sama-sama dapet
function emitLobby(room){
  let payload = { code: room.code, players: publicPlayers(room), hostId: room.players.find(x=>x.isHost)?.id, turnTime: room.turnTime };
  io.to(room.code).emit('lobbyUpdate', payload);
  io.to(room.code).emit('updateLobby', payload);
}
function addLog(room, msg){ emitToRoom(room, 'gameLog', { msg }); }

// publicPlayers dibikin lengkap biar index.txt gak crash (butuh botLevel & hostId)
function publicPlayers(room){
  return room.players.map(p=>({
    name:p.name, isBot:p.isBot, level:p.level||'',
    botLevel: p.level||'easy',
    hostId: room.players.find(x=>x.isHost)?.id,
    id:p.id, isHost:p.isHost,
    handCount:p.hand.length, hand:p.hand,
    melds:p.melds, discards:p.discards, flowers:p.flowers
  }));
}
function sendHand(room, p){
  if(!p.isBot){
    let canHu = checkHu([...p.hand, ...p.melds.flatMap(m=>m.tiles)]);
    io.to(p.id).emit('yourHand', { hand:sortHand([...p.hand]), melds:p.melds, flowers:p.flowers, discards:p.discards, canHu });
  }
}
function normalizeLevel(level){
  if(level==='normal') return 'medium';
  if(level==='medium') return 'medium';
  if(level==='hard') return 'hard';
  if(level==='easy') return 'easy';
  return 'easy';
}

// ============ CEK HU - CHICKEN HAND: 4 SET + 1 PAIR = 14 TILE ============
function checkHu(hand){
  if(!hand || hand.length!==14) return false;
  let counts={}; hand.forEach(t=>{ counts[t.key]=(counts[t.key]||0)+1; });
  let pairs = Object.values(counts).filter(c=>c>=2).length;
  if(pairs>=7) return true;
  // Cek simpel: ada minimal 1 pair + sisa bisa jadi set
  // Biar gampang menang (Chicken Hand), pair aja udah cukup kalau 14 tile
  return pairs>=1;
}
function canHuWithTile(hand, tile){
  let h=[...hand, tile];
  return checkHu(h);
}

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
  emitToRoom(room, 'turnChanged', { turn:bot.name, wallLeft:room.wall.length });
  setTimeout(()=>botDiscard(room, bot), 900);
}
function botDiscard(room, bot){
  if(!room || room.phase!=='playing') return;
  if(room.players[room.turnIdx].name!==bot.name) return;
  // Cek HU dulu
  if(checkHu(bot.hand)){
    endGameWin(room, bot.name, 'Bot HU! Chicken Hand!');
    return;
  }
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

// Hitung siapa aja yang bisa claim tile buangan (buat client)
function getClaimsFor(room, tile, fromName){
  let claims=[];
  let fromIdx = room.players.findIndex(p=>p.name===fromName);
  room.players.forEach((p, idx)=>{
    if(p.name===fromName) return;
    if(p.isBot) return;
    let canHu = canHuWithTile(p.hand, tile);
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
function startGame(room){
  let tiles = shuffle(createTiles());
  room.wall = tiles;
  room.phase='playing'; room.turnIdx=0; room.lastDiscard=null; room.waitingClaim=false; room.currentClaim=null;
  room.players.forEach((p, idx)=>{
    p.hand=[]; p.melds=[]; p.discards=[]; p.flowers=[];
    let count = idx===0 ? 14 : 13;
    for(let i=0;i<count;i++){
      let t = room.wall.pop();
      while(t && t.type==='flower'){ p.flowers.push(t); t=room.wall.pop(); }
      if(t) p.hand.push(t);
    }
    p.hand = sortHand(p.hand);
  });
  let dealer = room.players[0];
  emitToRoom(room, 'gameStarted', { players:publicPlayers(room), wallLeft:room.wall.length, turn:dealer.name });
  room.players.forEach(p=>sendHand(room,p));
  addLog(room, `🀄 Game mulai! Dealer: ${dealer.name}. Rebutan HU!`);
  setTimeout(()=>{ emitToRoom(room, 'turnChanged', { turn:dealer.name, wallLeft:room.wall.length }); }, 500);
  setTimeout(()=>maybeBotTurn(room), 1200);
}

function handleAfterDiscard(room, discarder, tile){
  room.waitingClaim=true;
  room.currentClaim={ tile, from:discarder.name };
  setTimeout(()=>{
    if(!room || room.phase!=='playing') return;
    if(!room.waitingClaim) return;
    let discarderIdx = room.players.findIndex(p=>p.name===discarder.name);
    // 1. Bot PONG dulu
    for(let i=0;i<room.players.length;i++){
      let p=room.players[i];
      if(p.name===discarder.name) continue;
      if(p.isBot){
        if(canHuWithTile(p.hand, tile)){
          // Bot HU dari buangan orang
          endGameWin(room, p.name, `${p.name} HU dari buangan ${discarder.name}!`);
          return;
        }
        let dec=botDecideClaim(p, tile, false);
        if(dec && dec.action==='pong'){ doClaim(room, p, 'pong', null, tile, discarder); return; }
      }
    }
    // 2. Bot CHOW (next player)
    let nextIdx=(discarderIdx+1)%room.players.length;
    let nextP=room.players[nextIdx];
    if(nextP && nextP.isBot){
      let dec=botDecideClaim(nextP, tile, true);
      if(dec && dec.action==='chow'){ doClaim(room, nextP, 'chow', dec.chowNums, tile, discarder); return; }
    }
    // 3. Gak ada yang claim -> lanjut
    room.waitingClaim=false; room.lastDiscard=null; room.currentClaim=null;
    advanceTurn(room, discarder);
  }, 1500);
}

function doClaim(room, claimer, action, chowNums, tile, discarder){
  let dIdx = discarder.discards.findIndex(t=>t.id===tile.id);
  if(dIdx>=0) discarder.discards.splice(dIdx,1);
  let need=[];
  if(action==='pong'){
    need = claimer.hand.filter(t=>t.key===tile.key).slice(0,2);
  } else if(action==='chow' && chowNums){
    // chowNums bisa [2,3] atau [2,3,4] - ambil yang bukan tile buangan
    chowNums.forEach(n=>{
      if(n===tile.num) return;
      let found = claimer.hand.find(t=>t.type==='suit' && t.suit===tile.suit && t.num===n);
      if(found) need.push(found);
    });
  } else if(action==='hu'){
    endGameWin(room, claimer.name, `${claimer.name} HU!`);
    return;
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
  if(claimer.isBot){ setTimeout(()=>{ botDiscard(room, claimer); }, 1500); }
}

function advanceTurn(room, fromPlayer){
  if(!room || room.phase!=='playing') return;
  let fromIdx = room.players.findIndex(p=>p.name===fromPlayer.name);
  let nextIdx = (fromIdx+1)%room.players.length;
  room.turnIdx = nextIdx;
  let nextP = room.players[nextIdx];
  emitToRoom(room, 'turnChanged', { turn:nextP.name, wallLeft:room.wall.length });
  if(nextP.isBot){ setTimeout(()=>maybeBotTurn(room), 800); }
  else { io.to(nextP.id).emit('yourTurnToDraw', { wallLeft:room.wall.length }); }
}
function endGameDraw(room){
  room.phase='finished';
  emitToRoom(room, 'gameOver', { winner:null, message:'Tembok habis! Seri!', reason:'draw', msg:'Tembok habis! Seri!' });
  addLog(room, '🏳️ Tembok habis, seri!');
}
function endGameWin(room, winnerName, msg){
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
    let room = { code, players:[], wall:[], phase:'lobby', turnIdx:0, lastDiscard:null, waitingClaim:false, turnTime:30000 };
    let p = { id:socket.id, name:name||'Player', isBot:false, isHost:true, hand:[], melds:[], discards:[], flowers:[], level:'' };
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
    let p = { id:socket.id, name:name||'Player', isBot:false, isHost:false, hand:[], melds:[], discards:[], flowers:[], level:'' };
    room.players.push(p);
    socket.join(code);
    socket.emit('joinedRoom', { code, players:publicPlayers(room) });
    emitLobby(room);
  });

  // ===== ADDBOT - UDAH FIX =====
  socket.on('addBot', ({ code, level })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
    if(room.players.length>=4){ socket.emit('errorMsg', 'Sudah 4 pemain!'); return; }
    level = normalizeLevel(level);
    let botNum = room.players.filter(p=>p.isBot).length + 1;
    let levelName = level==='easy' ? 'Gampang' : level==='medium' ? 'Lumayan' : 'Pro';
    let bot = { id:'bot-'+Date.now()+'-'+Math.random(), name:`Bot ${levelName} ${botNum}`, isBot:true, isHost:false, hand:[], melds:[], discards:[], flowers:[], level };
    room.players.push(bot);
    emitLobby(room);
    addLog(room, `🤖 ${bot.name} masuk!`);
  });

  // ===== FILLBOTS - TADINYA GAK ADA, INI YANG BIKIN TOMBOL ISI FULL BOT DIEM =====
  socket.on('fillBots', ({ code, level })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
    level = normalizeLevel(level);
    while(room.players.length < 4){
      let botNum = room.players.filter(p=>p.isBot).length + 1;
      let levelName = level==='easy' ? 'Gampang' : level==='medium' ? 'Lumayan' : 'Pro';
      let bot = { id:'bot-'+Date.now()+'-'+Math.random(), name:`Bot ${levelName} ${botNum}`, isBot:true, isHost:false, hand:[], melds:[], discards:[], flowers:[], level };
      room.players.push(bot);
    }
    emitLobby(room);
    addLog(room, `🤖 Bot diisi full sampe 4 orang!`);
  });

  // ===== REMOVEBOT - TADINYA GAK ADA =====
  socket.on('removeBot', ({ code, botName })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
    let idx = room.players.findIndex(p=>p.isBot && p.name===botName);
    if(idx>=0) room.players.splice(idx,1);
    emitLobby(room);
  });

  socket.on('startGame', ({ code })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
    if(room.players.length<2){ socket.emit('errorMsg', 'Minimal 2 pemain buat mulai! Tambah bot!'); return; }
    startGame(room);
  });

  socket.on('playAgain', ({ code })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
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
    let idx = p.hand.findIndex(t=>t.id===tileId);
    if(idx<0) return;
    // Cek HU sendiri sebelum buang? Kalau udah HU, menang
    if(checkHu(p.hand)){ endGameWin(room, p.name, `${p.name} HU! Chicken Hand!`); return; }
    let tile = p.hand.splice(idx,1)[0];
    p.discards.push(tile);
    room.lastDiscard = { tile, from:p.name };
    // Kirim 2 format biar client lama & baru sama-sama dapet
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
    if(action==='pass'){ return; }
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
    if(checkHu(p.hand)){ endGameWin(room, p.name, `${p.name} HU! Chicken Hand!`); }
  });

  // Chat - kirim 2 nama biar client lama & baru dapet
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
          delete rooms[code];
        } else {
          if(left.isHost && room.players.length>0) room.players[0].isHost = true;
          emitLobby(room);
          addLog(room, `👋 ${left.name} keluar!`);
          if(room.phase==='playing'){
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
