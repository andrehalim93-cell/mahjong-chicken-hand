// server.js - MAHJONG CHICKEN HAND ONLINE + BOT + TURN TIMER SETTING HOST - FULL
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

// Health check buat UptimeRobot biar ga tidur
app.get('/health', (req, res) => res.send('OK'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

let rooms = {}; // code -> room

// ===== TURN TIMER SETTING =====
const DEFAULT_TURN_TIME = 30000; // Default 30 detik

function clearTurnTimer(room){
  if(room && room.turnTimer){ clearTimeout(room.turnTimer); room.turnTimer = null; }
}

function startTurnTimer(room){
  clearTurnTimer(room);
  if(!room || room.phase!=='playing') return;
  let turnAtStart = room.turnIdx;
  let playerAtStart = room.players[turnAtStart]?.name;
  let turnTime = room.turnTime || DEFAULT_TURN_TIME;

  // Kasih tau semua client timer mulai + total waktu biar bar-nya bener
  emitToRoom(room, 'turnTimer', { turn: playerAtStart, timeLeft: turnTime, totalTime: turnTime });

  room.turnTimer = setTimeout(()=>{
    if(!room || room.phase!=='playing') return;
    if(room.waitingClaim) return;
    if(room.turnIdx !== turnAtStart) return;
    let cur = room.players[room.turnIdx];
    if(!cur) return;

    addLog(room, `⏰ Waktu ${cur.name} habis! Auto buang random!`);

    if(cur.isBot){
      if(cur.hand.length >= 14) botDiscard(room, cur);
      else botDrawAndDiscard(room, cur);
      return;
    }

    // MANUSIA TIMEOUT: auto ambil dulu kalau belum ambil
    if(cur.hand.length < 14){
      if(room.wall.length>0){
        let drawn = room.wall.pop();
        while(drawn && drawn.suit==='flower'){ cur.flowers.push(drawn); if(room.wall.length===0) break; drawn = room.wall.pop(); }
        if(drawn) cur.hand.push(drawn);
        sendHand(room, cur);
        emitToRoom(room, 'playerDrew', { player:cur.name, wallLeft:room.wall.length, auto:true });
      }
    }
    // Auto buang random
    let playable = cur.hand.filter(t=>t.suit!=='flower');
    let randomTile = playable[Math.floor(Math.random()*playable.length)] || cur.hand[0];
    if(randomTile){
      let idx = cur.hand.findIndex(t=>t.id===randomTile.id);
      cur.hand.splice(idx,1);
      cur.discards.push(randomTile);
      room.lastDiscard = { tile:randomTile, from:cur.name };
      emitToRoom(room, 'playerDiscarded', { player:cur.name, tile:randomTile, wallLeft:room.wall.length, auto:true });
      room.players.forEach(p=>sendHand(room,p));
      addLog(room, `🤖 Auto: ${cur.name} buang ${tileName(randomTile)} (random)`);
      handleAfterDiscard(room, cur, randomTile);
    }
  }, turnTime);
}

// ============ TILE HELPERS ============
function tileKey(suit, num){ return suit + '-' + num; }
function tileName(t){
  if(!t) return '?';
  if(t.suit==='flower') return '🌸 Bunga ' + t.num;
  if(t.suit==='wind') {
    let names = {1:'Timur',2:'Selatan',3:'Barat',4:'Utara'};
    return names[t.num] || 'Angin';
  }
  if(t.suit==='dragon') {
    let names = {1:'Naga Merah',2:'Naga Hijau',3:'Naga Putih'};
    return names[t.num] || 'Naga';
  }
  let s = t.suit==='dot' ? '🔴 Tong' : t.suit==='bamboo' ? '🎋 Tiao' : '🀄 Wan';
  return s + ' ' + t.num;
}

function createTiles(){
  let tiles = [];
  let id = 1;
  ['dot','bamboo','char'].forEach(suit=>{
    for(let n=1;n<=9;n++){
      for(let c=0;c<4;c++){
        tiles.push({ id:id++, suit, num:n, key:tileKey(suit,n) });
      }
    }
  });
  for(let n=1;n<=4;n++) for(let c=0;c<4;c++) tiles.push({ id:id++, suit:'wind', num:n, key:tileKey('wind',n) });
  for(let n=1;n<=3;n++) for(let c=0;c<4;c++) tiles.push({ id:id++, suit:'dragon', num:n, key:tileKey('dragon',n) });
  for(let n=1;n<=8;n++) tiles.push({ id:id++, suit:'flower', num:n, key:tileKey('flower',n) });
  return tiles;
}

function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    let j = Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}

function sortHand(hand){
  let order = { 'dot':0, 'bamboo':1, 'char':2, 'wind':3, 'dragon':4, 'flower':5 };
  return hand.sort((a,b)=>{
    if(order[a.suit]!==order[b.suit]) return order[a.suit]-order[b.suit];
    return a.num-b.num;
  });
}

function genCode(){
  let chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c='';
  for(let i=0;i<4;i++) c+=chars[Math.floor(Math.random()*chars.length)];
  return c;
}

// ============ ROOM HELPERS ============
function emitToRoom(room, ev, data){ io.to(room.code).emit(ev, data); }
function addLog(room, msg){ emitToRoom(room, 'gameLog', { msg }); }

function publicPlayers(room){
  return room.players.map(p=>({
    name:p.name, isBot:p.isBot, level:p.level||'',
    handCount:p.hand.length, melds:p.melds, discards:p.discards,
    flowers:p.flowers, isHost:p.isHost
  }));
}

function sendHand(room, p){
  if(!p.isBot){
    io.to(p.id).emit('yourHand', { hand:sortHand([...p.hand]), melds:p.melds, flowers:p.flowers, discards:p.discards });
  }
}

// ============ BOT AI ============
function botChooseDiscard(bot){
  let hand = bot.hand.filter(t=>t.suit!=='flower');
  if(hand.length===0) return bot.hand[0];
  let counts = {};
  hand.forEach(t=>{ counts[t.key]=(counts[t.key]||0)+1; });
  let candidates = hand.filter(t=>counts[t.key]===1);
  let honorSingle = candidates.filter(t=>t.suit==='wind'||t.suit==='dragon');
  if(honorSingle.length>0) return honorSingle[Math.floor(Math.random()*honorSingle.length)];
  let terminal = candidates.filter(t=>t.num===1||t.num===9);
  if(terminal.length>0) return terminal[Math.floor(Math.random()*terminal.length)];
  if(candidates.length>0) return candidates[Math.floor(Math.random()*candidates.length)];
  return hand[Math.floor(Math.random()*hand.length)];
}

function botDecideClaim(bot, tile, isNext){
  if(tile.suit==='flower') return null;
  let count = bot.hand.filter(t=>t.key===tile.key).length;
  if(count>=2) return { action:'pong' };
  if(isNext && (tile.suit==='dot'||tile.suit==='bamboo'||tile.suit==='char')){
    let nums = bot.hand.filter(t=>t.suit===tile.suit).map(t=>t.num);
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
  while(drawn && drawn.suit==='flower'){
    bot.flowers.push(drawn);
    if(room.wall.length===0) break;
    drawn = room.wall.pop();
  }
  if(drawn) bot.hand.push(drawn);
  sendHand(room, bot);
  emitToRoom(room, 'playerDrew', { player:bot.name, wallLeft:room.wall.length });
  emitToRoom(room, 'turnChanged', { turn:bot.name, wallLeft:room.wall.length });
  setTimeout(()=>botDiscard(room, bot), 900);
}

function botDiscard(room, bot){
  if(!room || room.phase!=='playing') return;
  if(room.players[room.turnIdx].name!==bot.name) return;
  let tile = botChooseDiscard(bot);
  if(!tile) return;
  let idx = bot.hand.findIndex(t=>t.id===tile.id);
  if(idx>=0) bot.hand.splice(idx,1);
  bot.discards.push(tile);
  room.lastDiscard = { tile, from:bot.name };
  emitToRoom(room, 'playerDiscarded', { player:bot.name, tile, wallLeft:room.wall.length });
  room.players.forEach(p=>sendHand(room,p));
  handleAfterDiscard(room, bot, tile);
}

function maybeBotTurn(room){
  if(!room || room.phase!=='playing') return;
  if(room.waitingClaim) return;
  let cur = room.players[room.turnIdx];
  if(!cur || !cur.isBot) return;
  if(cur.hand.length >= 14){
    setTimeout(()=>botDiscard(room, cur), 1000);
    return;
  }
  setTimeout(()=>botDrawAndDiscard(room, cur), 1000);
}

// ============ GAME FLOW ============
function startGame(room){
  let tiles = shuffle(createTiles());
  room.wall = tiles;
  room.phase = 'playing';
  room.turnIdx = 0;
  room.lastDiscard = null;
  room.waitingClaim = false;
  room.currentClaim = null;
  room.turnCount = 0;

  room.players.forEach((p, idx)=>{
    p.hand = [];
    p.melds = [];
    p.discards = [];
    p.flowers = [];
    let count = idx===0 ? 14 : 13;
    for(let i=0;i<count;i++){
      let t = room.wall.pop();
      while(t && t.suit==='flower'){
        p.flowers.push(t);
        t = room.wall.pop();
      }
      if(t) p.hand.push(t);
    }
    p.hand = sortHand(p.hand);
  });

  let dealer = room.players[0];
  emitToRoom(room, 'gameStarted', { players:publicPlayers(room), wallLeft:room.wall.length, turn:dealer.name, turnTime: room.turnTime || DEFAULT_TURN_TIME });
  room.players.forEach(p=>sendHand(room,p));
  addLog(room, `🀄 Game mulai! Dealer: ${dealer.name}. Waktu giliran: ${(room.turnTime||DEFAULT_TURN_TIME)/1000} detik!`);
  setTimeout(()=>{ emitToRoom(room, 'turnChanged', { turn:dealer.name, wallLeft:room.wall.length }); startTurnTimer(room); }, 500);
  setTimeout(()=>maybeBotTurn(room), 1200);
}

function handleAfterDiscard(room, discarder, tile){
  clearTurnTimer(room);
  room.turnCount++;
  room.waitingClaim = true;
  room.currentClaim = { tile, from:discarder.name };

  setTimeout(()=>{
    if(!room || room.phase!=='playing') return;
    if(!room.waitingClaim) return;

    let discarderIdx = room.players.findIndex(p=>p.name===discarder.name);
    for(let i=0;i<room.players.length;i++){
      let p = room.players[i];
      if(p.name===discarder.name) continue;
      if(p.isBot){
        let dec = botDecideClaim(p, tile, false);
        if(dec && dec.action==='pong'){
          doClaim(room, p, 'pong', null, tile, discarder);
          return;
        }
      }
    }
    let nextIdx = (discarderIdx+1)%room.players.length;
    let nextP = room.players[nextIdx];
    if(nextP.isBot){
      let dec = botDecideClaim(nextP, tile, true);
      if(dec && dec.action==='chow'){
        doClaim(room, nextP, 'chow', dec.chowNums, tile, discarder);
        return;
      }
    }

    room.waitingClaim = false;
    room.lastDiscard = null;
    room.currentClaim = null;
    advanceTurn(room, discarder);
  }, 1200);
}

function doClaim(room, claimer, action, chowNums, tile, discarder){
  let dIdx = discarder.discards.findIndex(t=>t.id===tile.id);
  if(dIdx>=0) discarder.discards.splice(dIdx,1);

  let need = [];
  if(action==='pong'){
    need = claimer.hand.filter(t=>t.key===tile.key).slice(0,2);
  } else if(action==='chow' && chowNums){
    chowNums.forEach(n=>{
      let found = claimer.hand.find(t=>t.suit===tile.suit && t.num===n);
      if(found) need.push(found);
    });
  }

  need.forEach(t=>{
    let i = claimer.hand.findIndex(x=>x.id===t.id);
    if(i>=0) claimer.hand.splice(i,1);
  });
  claimer.melds.push({ type:action, tiles:[tile, ...need] });

  room.waitingClaim = false;
  room.lastDiscard = null;
  room.currentClaim = null;
  room.turnIdx = room.players.findIndex(p=>p.name===claimer.name);

  emitToRoom(room, 'claimed', { claimer:claimer.name, action, tiles:[tile, ...need], turn:claimer.name });
  emitToRoom(room, 'turnChanged', { turn:claimer.name, wallLeft:room.wall.length });
  startTurnTimer(room);
  room.players.forEach(p=>sendHand(room,p));
  addLog(room, `⚡ ${claimer.name} ${action.toUpperCase()} ${tileName(tile)} dari ${discarder.name}!`);

  if(claimer.isBot){
    setTimeout(()=>{ botDiscard(room, claimer); }, 1500);
  }
}

function advanceTurn(room, fromPlayer){
  if(!room || room.phase!=='playing') return;
  let fromIdx = room.players.findIndex(p=>p.name===fromPlayer.name);
  let nextIdx = (fromIdx+1)%room.players.length;
  room.turnIdx = nextIdx;
  let nextP = room.players[nextIdx];

  emitToRoom(room, 'turnChanged', { turn:nextP.name, wallLeft:room.wall.length });
  startTurnTimer(room);

  if(nextP.isBot){
    setTimeout(()=>maybeBotTurn(room), 800);
  } else {
    io.to(nextP.id).emit('yourTurnToDraw', { wallLeft:room.wall.length });
  }
}

function endGameDraw(room){
  clearTurnTimer(room);
  room.phase = 'finished';
  emitToRoom(room, 'gameOver', { reason:'draw', msg:'Tembok habis! Seri!' });
  addLog(room, '🏳️ Tembok habis, seri!');
}

// ============ SOCKET.IO ============
io.on('connection', (socket)=>{
  console.log('User connected:', socket.id);

  socket.on('createRoom', ({ name })=>{
    let code = genCode();
    let room = { code, players:[], wall:[], phase:'lobby', turnIdx:0, lastDiscard:null, waitingClaim:false, turnTime: DEFAULT_TURN_TIME, turnTimer:null };
    let p = { id:socket.id, name:name||'Player', isBot:false, isHost:true, hand:[], melds:[], discards:[], flowers:[], level:'' };
    room.players.push(p);
    rooms[code]=room;
    socket.join(code);
    socket.emit('roomCreated', { code, players:publicPlayers(room), turnTime: room.turnTime });
    emitToRoom(room, 'lobbyUpdate', { players:publicPlayers(room), turnTime: room.turnTime });
  });

  socket.on('joinRoom', ({ name, code })=>{
    code = (code||'').toUpperCase().trim();
    let room = rooms[code];
    if(!room){ socket.emit('errorMsg', { msg:'Room tidak ditemukan! Cek kode!' }); return; }
    if(room.players.length>=4){ socket.emit('errorMsg', { msg:'Room penuh!' }); return; }
    if(room.phase==='playing'){ socket.emit('errorMsg', { msg:'Game sudah mulai!' }); return; }
    let p = { id:socket.id, name:name||'Player', isBot:false, isHost:false, hand:[], melds:[], discards:[], flowers:[], level:'' };
    room.players.push(p);
    socket.join(code);
    socket.emit('joinedRoom', { code, players:publicPlayers(room), turnTime: room.turnTime });
    emitToRoom(room, 'lobbyUpdate', { players:publicPlayers(room), turnTime: room.turnTime });
  });

  socket.on('addBot', ({ code, level })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
    if(room.players.length>=4){ socket.emit('errorMsg', { msg:'Sudah 4 pemain!' }); return; }
    let botNum = room.players.filter(p=>p.isBot).length + 1;
    let levelName = level==='easy' ? 'Gampang' : level==='medium' ? 'Lumayan' : 'Pro';
    let bot = { id:'bot-'+Date.now()+'-'+Math.random(), name:`Bot ${levelName} ${botNum}`, isBot:true, isHost:false, hand:[], melds:[], discards:[], flowers:[], level:level||'easy' };
    room.players.push(bot);
    emitToRoom(room, 'lobbyUpdate', { players:publicPlayers(room), turnTime: room.turnTime });
    addLog(room, `🤖 ${bot.name} masuk!`);
  });

  // ===== SETTING WAKTU GILIRAN OLEH HOST =====
  socket.on('setTurnTime', ({ code, turnTime })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
    let p = room.players.find(x=>x.id===socket.id);
    if(!p || !p.isHost) return;
    if(room.phase!=='lobby') return;
    // Validasi: cuma 10s, 15s, 30s, 60s yang boleh
    if(![10000,15000,30000,60000].includes(turnTime)) return;
    room.turnTime = turnTime;
    emitToRoom(room, 'turnTimeChanged', { turnTime: room.turnTime });
    addLog(room, `⏰ Host ganti waktu giliran jadi ${turnTime/1000} detik!`);
  });

  socket.on('startGame', ({ code, turnTime })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
    if(room.players.length<2){ socket.emit('errorMsg', { msg:'Minimal 2 pemain buat mulai! Tambah bot!' }); return; }
    if(turnTime && [10000,15000,30000,60000].includes(turnTime)) room.turnTime = turnTime;
    startGame(room);
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
    while(drawn && drawn.suit==='flower'){
      p.flowers.push(drawn);
      if(room.wall.length===0) break;
      drawn = room.wall.pop();
    }
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
    let tile = p.hand.splice(idx,1)[0];
    p.discards.push(tile);
    room.lastDiscard = { tile, from:p.name };
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

  socket.on('passClaim', ({ code })=>{});

  socket.on('tableChat', ({ code, msg })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
    let p = room.players.find(x=>x.id===socket.id);
    let sender = p ? p.name : 'Player';
    emitToRoom(room, 'chatMsg', { sender, msg });
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
          emitToRoom(room, 'lobbyUpdate', { players:publicPlayers(room), turnTime: room.turnTime });
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

server.listen(PORT, ()=>{
  console.log(`🀄 MAHJONG ONLINE + BOT di port ${PORT}`);
});
