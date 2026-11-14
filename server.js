// server.js - MAHJONG CHICKEN HAND ONLINE + BOT - FULL FIXED
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

// ============ TILE HELPERS ============
function tileKey(suit, num){ return suit + '-' + num; }
function tileName(t){
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
  // 3 suit x 1-9 x 4 copy = 108
  ['dot','bamboo','char'].forEach(suit=>{
    for(let n=1;n<=9;n++){
      for(let c=0;c<4;c++){
        tiles.push({ id:id++, suit, num:n, key:tileKey(suit,n) });
      }
    }
  });
  // Wind 4x4 = 16
  for(let n=1;n<=4;n++) for(let c=0;c<4;c++) tiles.push({ id:id++, suit:'wind', num:n, key:tileKey('wind',n) });
  // Dragon 3x4 = 12
  for(let n=1;n<=3;n++) for(let c=0;c<4;c++) tiles.push({ id:id++, suit:'dragon', num:n, key:tileKey('dragon',n) });
  // Flower 8 = 8 (1 copy each)
  for(let n=1;n<=8;n++) tiles.push({ id:id++, suit:'flower', num:n, key:tileKey('flower',n) });
  return tiles; // total 144
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

function botLog(room, botName, msg){
  // Buat debug di log aja, ga ganggu game
  console.log(`[BOT ${botName}] ${msg}`);
}

// ============ BOT AI ============
function botChooseDiscard(bot){
  let hand = bot.hand.filter(t=>t.suit!=='flower');
  if(hand.length===0) return bot.hand[0];
  // Hitung pasangan
  let counts = {};
  hand.forEach(t=>{ counts[t.key]=(counts[t.key]||0)+1; });
  // Cari tile yang jomblo (ga ada pasangan, ga nyambung)
  let candidates = hand.filter(t=>counts[t.key]===1);
  // Utamain buang honor yang jomblo dulu (wind/dragon)
  let honorSingle = candidates.filter(t=>t.suit==='wind'||t.suit==='dragon');
  if(honorSingle.length>0) return honorSingle[Math.floor(Math.random()*honorSingle.length)];
  // Terus buang terminal 1/9 yang jomblo
  let terminal = candidates.filter(t=>t.num===1||t.num===9);
  if(terminal.length>0) return terminal[Math.floor(Math.random()*terminal.length)];
  // Kalau ga ada, buang random dari yang jomblo
  if(candidates.length>0) return candidates[Math.floor(Math.random()*candidates.length)];
  // Kalau semua ada pasangan, buang random (jangan buang yang udah pair)
  return hand[Math.floor(Math.random()*hand.length)];
}

function botDecideClaim(bot, tile, isNext){
  if(tile.suit==='flower') return null;
  let count = bot.hand.filter(t=>t.key===tile.key).length;
  // PONG kalau punya 2
  if(count>=2) return { action:'pong' };
  // CHOW cuma kalau dia next player
  if(isNext && (tile.suit==='dot'||tile.suit==='bamboo'||tile.suit==='char')){
    let nums = bot.hand.filter(t=>t.suit===tile.suit).map(t=>t.num);
    // Cek pola chow: tile-2, tile-1, tile+1, tile+2
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
  // Ambil dari wall
  if(room.wall.length===0){ endGameDraw(room); return; }
  let drawn = room.wall.pop();
  // Kalau bunga, simpen jadi flower, ambil lagi
  while(drawn && drawn.suit==='flower'){
    bot.flowers.push(drawn);
    if(room.wall.length===0) break;
    drawn = room.wall.pop();
  }
  if(drawn) bot.hand.push(drawn);
  sendHand(room, bot);
  emitToRoom(room, 'turnChanged', { turn:bot.name, wallLeft:room.wall.length });
  emitToRoom(room, 'playerDrew', { player:bot.name, wallLeft:room.wall.length });
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

// FIX UTAMA: Abis PONG, bot langsung buang, ga usah ambil
function maybeBotTurn(room){
  if(!room || room.phase!=='playing') return;
  if(room.waitingClaim) return;
  let cur = room.players[room.turnIdx];
  if(!cur || !cur.isBot) return;
  // Kalau tangan bot udah 14 (abis PONG / abis ambil), langsung buang
  if(cur.hand.length >= 14){
    setTimeout(()=>botDiscard(room, cur), 1000);
    return;
  }
  // Kalau masih 13, giliran biasa: ambil dulu baru buang
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

  // Bagi tile: dealer 14, lain 13
  room.players.forEach((p, idx)=>{
    p.hand = [];
    p.melds = [];
    p.discards = [];
    p.flowers = [];
    let count = idx===0 ? 14 : 13;
    for(let i=0;i<count;i++){
      let t = room.wall.pop();
      // Kalau bunga, ganti
      while(t && t.suit==='flower'){
        p.flowers.push(t);
        t = room.wall.pop();
      }
      if(t) p.hand.push(t);
    }
    p.hand = sortHand(p.hand);
  });

  let dealer = room.players[0];
  emitToRoom(room, 'gameStarted', { players:publicPlayers(room), wallLeft:room.wall.length, turn:dealer.name });
  room.players.forEach(p=>sendHand(room,p));
  addLog(room, `🀄 Game mulai! Dealer: ${dealer.name}. Rebutan HU!`);
  // FIX: Kirim turnChanged juga biar client sinkron giliran pertama
  setTimeout(()=>{ emitToRoom(room, 'turnChanged', { turn:dealer.name, wallLeft:room.wall.length }); }, 500);
  setTimeout(()=>maybeBotTurn(room), 1200);
}

function handleAfterDiscard(room, discarder, tile){
  room.turnCount++;
  // Cek ada yang mau claim? Kasih waktu 1.2 detik buat bot mikir
  room.waitingClaim = true;
  room.currentClaim = { tile, from:discarder.name };

  // Bot lain cek claim
  setTimeout(()=>{
    if(!room || room.phase!=='playing') return;
    if(!room.waitingClaim) return; // Udah di-claim duluan

    let discarderIdx = room.players.findIndex(p=>p.name===discarder.name);
    // Urutan: PONG dulu (semua player), baru CHOW (next player)
    // 1. Cek PONG dari bot
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
    // 2. Cek CHOW dari next player kalau dia bot
    let nextIdx = (discarderIdx+1)%room.players.length;
    let nextP = room.players[nextIdx];
    if(nextP.isBot){
      let dec = botDecideClaim(nextP, tile, true);
      if(dec && dec.action==='chow'){
        doClaim(room, nextP, 'chow', dec.chowNums, tile, discarder);
        return;
      }
    }

    // 3. Ga ada yang claim -> lanjut giliran biasa
    room.waitingClaim = false;
    room.lastDiscard = null;
    room.currentClaim = null;
    advanceTurn(room, discarder);
  }, 1200);
}

function doClaim(room, claimer, action, chowNums, tile, discarder){
  // Hapus tile buangan dari discarder
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

  // FIX PONG MACET: Reset waitingClaim, pindah giliran ke claimer
  room.waitingClaim = false;
  room.lastDiscard = null;
  room.currentClaim = null;
  room.turnIdx = room.players.findIndex(p=>p.name===claimer.name);

  emitToRoom(room, 'claimed', { claimer:claimer.name, action, tiles:[tile, ...need], turn:claimer.name });
  emitToRoom(room, 'turnChanged', { turn:claimer.name, wallLeft:room.wall.length });
  room.players.forEach(p=>sendHand(room,p));
  addLog(room, `⚡ ${claimer.name} ${action.toUpperCase()} ${tileName(tile)} dari ${discarder.name}!`);

  // Kalau yang claim BOT, langsung suruh BUANG (tanpa ambil)
  if(claimer.isBot){
    setTimeout(()=>{ botDiscard(room, claimer); }, 1500);
  }
  // Kalau yang claim MANUSIA, client-nya udah tau dia harus buang karena turn = dia
}

function advanceTurn(room, fromPlayer){
  if(!room || room.phase!=='playing') return;
  let fromIdx = room.players.findIndex(p=>p.name===fromPlayer.name);
  let nextIdx = (fromIdx+1)%room.players.length;
  room.turnIdx = nextIdx;
  let nextP = room.players[nextIdx];

  emitToRoom(room, 'turnChanged', { turn:nextP.name, wallLeft:room.wall.length });

  if(nextP.isBot){
    setTimeout(()=>maybeBotTurn(room), 800);
  } else {
    // Giliran manusia: manusia harus ambil dulu via client 'drawTile'
    // Client akan emit drawTile, server kasih tile
    io.to(nextP.id).emit('yourTurnToDraw', { wallLeft:room.wall.length });
  }
}

function endGameDraw(room){
  room.phase = 'finished';
  emitToRoom(room, 'gameOver', { reason:'draw', msg:'Tembok habis! Seri!' });
  addLog(room, '🏳️ Tembok habis, seri!');
}

function checkWin(hand, melds){
  // Chicken Hand: semua tile bisa jadi meld + 1 pair, atau 7 pair, dll - versi simpel: cek total tile 14 dan bisa dipasangkan
  // Buat simpel, kita anggap HU kalau player punya 4 meld + 1 pair (total tile di tangan + meld = 14)
  // Ini cek sederhana buat demo, kalau mau akurat bisa diperluas
  if(hand.length + melds.length*3 !== 14) return false;
  // Cek 7 pair (khusus)
  let counts = {};
  hand.forEach(t=>{ counts[t.key]=(counts[t.key]||0)+1; });
  let pairs = Object.values(counts).filter(c=>c>=2).length;
  if(hand.length===14 && pairs>=7) return true;
  // Cek simpel: ada minimal 1 pair
  return pairs>=1;
}

// ============ SOCKET.IO ============
io.on('connection', (socket)=>{
  console.log('User connected:', socket.id);

  socket.on('createRoom', ({ name })=>{
    let code = genCode();
    let room = { code, players:[], wall:[], phase:'lobby', turnIdx:0, lastDiscard:null, waitingClaim:false };
    let p = { id:socket.id, name:name||'Player', isBot:false, isHost:true, hand:[], melds:[], discards:[], flowers:[], level:'' };
    room.players.push(p);
    rooms[code]=room;
    socket.join(code);
    socket.emit('roomCreated', { code, players:publicPlayers(room) });
    emitToRoom(room, 'lobbyUpdate', { players:publicPlayers(room) });
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
    socket.emit('joinedRoom', { code, players:publicPlayers(room) });
    emitToRoom(room, 'lobbyUpdate', { players:publicPlayers(room) });
  });

  socket.on('addBot', ({ code, level })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
    if(room.players.length>=4){ socket.emit('errorMsg', { msg:'Sudah 4 pemain!' }); return; }
    let botNum = room.players.filter(p=>p.isBot).length + 1;
    let levelName = level==='easy' ? 'Gampang' : level==='medium' ? 'Lumayan' : 'Pro';
    let bot = { id:'bot-'+Date.now()+'-'+Math.random(), name:`Bot ${levelName} ${botNum}`, isBot:true, isHost:false, hand:[], melds:[], discards:[], flowers:[], level:level||'easy' };
    room.players.push(bot);
    emitToRoom(room, 'lobbyUpdate', { players:publicPlayers(room) });
    addLog(room, `🤖 ${bot.name} masuk!`);
  });

  socket.on('startGame', ({ code })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
    if(room.players.length<2){ socket.emit('errorMsg', { msg:'Minimal 2 pemain buat mulai! Tambah bot!' }); return; }
    startGame(room);
  });

  socket.on('drawTile', ({ code })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room || room.phase!=='playing') return;
    let p = room.players.find(x=>x.id===socket.id);
    if(!p) return;
    if(room.players[room.turnIdx].name!==p.name) return;
    if(p.hand.length>=14) return; // Udah punya 14, tinggal buang
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
    // Validasi chow cuma buat next player
    if(action==='chow'){
      let discarderIdx = room.players.findIndex(x=>x.name===from);
      let nextIdx = (discarderIdx+1)%room.players.length;
      if(room.players[nextIdx].name!==p.name) return;
    }
    // Validasi pong
    if(action==='pong'){
      let c = p.hand.filter(t=>t.key===tile.key).length;
      if(c<2) return;
    }
    doClaim(room, p, action, chowNums, tile, discarder);
  });

  socket.on('passClaim', ({ code })=>{
    // Manusia pass, biar bot lain tetep bisa claim di handleAfterDiscard (udah ada timeout)
    // Kita ga perlu apa-apa, timeout akan jalan
  });

  socket.on('tableChat', ({ code, msg })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
    let p = room.players.find(x=>x.id===socket.id);
    let sender = p ? p.name : 'Player';
    emitToRoom(room, 'chatMsg', { sender, msg });
  });

  socket.on('disconnect', ()=>{
    // Cari room yang ada player ini
    for(let code in rooms){
      let room = rooms[code];
      let idx = room.players.findIndex(p=>p.id===socket.id);
      if(idx>=0){
        let left = room.players[idx];
        room.players.splice(idx,1);
        if(room.players.length===0){
          delete rooms[code];
        } else {
          // Kalau host keluar, host pindah
          if(left.isHost && room.players.length>0) room.players[0].isHost = true;
          emitToRoom(room, 'lobbyUpdate', { players:publicPlayers(room) });
          addLog(room, `👋 ${left.name} keluar!`);
          // Kalau game lagi jalan dan yang keluar lagi giliran, skip
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
