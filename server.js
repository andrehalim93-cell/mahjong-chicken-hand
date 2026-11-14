require('dotenv').config();
const express = require('express'), http = require('http'), socketIo = require('socket.io'), cors = require('cors'), path = require('path');
const app = express(); app.use(cors()); app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (req, res) => res.send('OK'));
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" }, transports: ["websocket", "polling"] });
const ROOMS = {};
function buildWall(){
  let wall = [];
  for(let s=0;s<3;s++) for(let n=1;n<=9;n++) for(let i=0;i<4;i++) wall.push({ type:'suit', suit:s, num:n, id:`s${s}-${n}-${i}` });
  for(let n=0;n<4;n++) for(let i=0;i<4;i++) wall.push({ type:'wind', num:n, id:`w${n}-${i}` });
  for(let n=0;n<3;n++) for(let i=0;i<4;i++) wall.push({ type:'dragon', num:n, id:`d${n}-${i}` });
  for(let n=0;n<8;n++) wall.push({ type:'flower', num:n, id:`f${n}` });
  return wall.sort(()=>0.5-Math.random());
}
function tileKey(t){ if(t.type==='suit') return `s${t.suit}-${t.num}`; if(t.type==='wind') return `w${t.num}`; if(t.type==='dragon') return `d${t.num}`; return `f${t.num}`; }
function tileName(t){
  if(t.type==='suit'){ const s=['🎋','🔴','🀄'][t.suit]; return `${s} ${t.num}`; }
  if(t.type==='wind') return ['💨 Timur','💨 Selatan','💨 Barat','💨 Utara'][t.num];
  if(t.type==='dragon') return ['🐲 Merah','🐲 Hijau','🐲 Putih'][t.num];
  return ['🌸 Bunga 1','🌸 Bunga 2','🌸 Bunga 3','🌸 Bunga 4','🍂 Musim 1','🍂 Musim 2','🍂 Musim 3','🍂 Musim 4'][t.num];
}
function isChickenWin(hand, melds){
  let counts = {};
  hand.forEach(t=>{ let k=tileKey(t); counts[k]=(counts[k]||0)+1; });
  let needSets = 4 - melds.length;
  for(let pairKey in counts){
    if(counts[pairKey] < 2) continue;
    let tmp = {...counts}; tmp[pairKey]-=2;
    let tiles = [];
    for(let k in tmp) for(let i=0;i<tmp[k];i++) tiles.push(k);
    if(canFormSets(tiles, needSets)) return true;
  }
  return false;
}
function canFormSets(keys, need){
  if(need===0) return keys.length===0;
  if(keys.length===0) return false;
  keys.sort();
  let first = keys[0];
  let same = keys.filter(k=>k===first).length;
  if(same>=3){
    let rest = [...keys]; for(let i=0;i<3;i++) rest.splice(rest.indexOf(first),1);
    if(canFormSets(rest, need-1)) return true;
  }
  if(first.startsWith('s')){
    let parts = first.split('-'); let suit=parseInt(parts[0].replace('s','')); let num=parseInt(parts[1]);
    if(num<=7){
      let k2=`s${suit}-${num+1}`, k3=`s${suit}-${num+2}`;
      if(keys.includes(k2) && keys.includes(k3)){
        let rest=[...keys]; rest.splice(rest.indexOf(first),1); rest.splice(rest.indexOf(k2),1); rest.splice(rest.indexOf(k3),1);
        if(canFormSets(rest, need-1)) return true;
      }
    }
  }
  return false;
}
function canPong(hand, discard){ return hand.filter(t=>tileKey(t)===tileKey(discard)).length>=2; }
function canChow(hand, discard){
  if(discard.type!=='suit') return [];
  let res=[]; let n=discard.num, s=discard.suit;
  let has=(num)=>hand.some(t=>t.type==='suit'&&t.suit===s&&t.num===num);
  if(n>=3 && has(n-2) && has(n-1)) res.push([n-2,n-1,n]);
  if(n>=2 && n<=8 && has(n-1) && has(n+1)) res.push([n-1,n,n+1]);
  if(n<=7 && has(n+1) && has(n+2)) res.push([n,n+1,n+2]);
  return res;
}
function usefulness(hand, tile){
  let k = tileKey(tile); let score = 0;
  hand.forEach(t=>{ if(tileKey(t)===k) score+=3; });
  if(tile.type==='suit'){ hand.forEach(t=>{ if(t.type==='suit' && t.suit===tile.suit && Math.abs(t.num-tile.num)<=2) score+=1; }); }
  if(tile.type==='wind' || tile.type==='dragon'){ let c = hand.filter(t=>tileKey(t)===k).length; if(c>=2) score+=2; else score-=1; }
  return score;
}
function botChooseDiscard(bot){
  let hand = bot.hand; if(hand.length===0) return null;
  if(bot.level==='easy') return hand[Math.floor(Math.random()*hand.length)];
  if(bot.level==='normal'){ let best=null, bestScore=999; hand.forEach(t=>{ let s = usefulness(hand, t) + Math.random()*1.5; if(s < bestScore){ bestScore=s; best=t; } }); return best; }
  let best=null, bestScore=999; hand.forEach(t=>{ let s = usefulness(hand, t); if(t.type==='suit' && (t.num===1 || t.num===9)) s-=0.5; if(s < bestScore){ bestScore=s; best=t; } }); return best;
}
function botDecideClaim(bot, discard, isNext){
  if(isChickenWin([...bot.hand, discard], bot.melds)) return { action:'hu' };
  if(bot.level==='easy'){ if(Math.random()<0.2 && canPong(bot.hand, discard)) return { action:'pong' }; return null; }
  if(bot.level==='normal'){ if(canPong(bot.hand, discard) && Math.random()<0.7) return { action:'pong' }; if(isNext){ let chows = canChow(bot.hand, discard); if(chows.length>0 && Math.random()<0.5) return { action:'chow', chowNums:chows[0] }; } return null; }
  if(canPong(bot.hand, discard)){ if(usefulness(bot.hand, discard) >= 2) return { action:'pong' }; }
  if(isNext){ let chows = canChow(bot.hand, discard); if(chows.length>0) return { action:'chow', chowNums:chows[0] }; }
  return null;
}
function publicPlayers(room){ return room.players.map(p=>({ name:p.name, isBot:!!p.isBot, botLevel:p.botLevel||null, handCount:p.hand.length, melds:p.melds, flowers:p.flowers, discards:p.discards })); }
function sendHand(room, p){ if(p.isBot) return; let s = io.sockets.sockets.get(p.id); if(s) s.emit('yourHand', { hand:p.hand, canHu:isChickenWin(p.hand, p.melds) }); }
function emitToRoom(room, ev, data){ io.to(room.code).emit(ev, data); }
function startGame(room){
  room.wall = buildWall();
  room.players.forEach(p=>{
    p.hand=[]; p.melds=[]; p.flowers=[]; p.discards=[];
    for(let i=0;i<13;i++) p.hand.push(room.wall.pop());
    let i=0; while(i<p.hand.length){ if(p.hand[i].type==='flower'){ p.flowers.push(p.hand.splice(i,1)[0]); if(room.wall.length) p.hand.push(room.wall.pop()); } else i++; }
    p.hand.sort((a,b)=>tileKey(a).localeCompare(tileKey(b)));
  });
  room.phase='playing'; room.turnIdx=0; room.lastDiscard=null; room.waitingClaim=null;
  let dealer = room.players[0];
  dealer.hand.push(room.wall.pop());
  dealer.hand.sort((a,b)=>tileKey(a).localeCompare(tileKey(b)));
    emitToRoom(room, 'gameStarted', { players:publicPlayers(room), wallLeft:room.wall.length, turn:dealer.name });
  room.players.forEach(p=>sendHand(room,p));
  setTimeout(()=>{ emitToRoom(room, 'turnChanged', { turn:dealer.name, wallLeft:room.wall.length }); }, 500);
  setTimeout(()=>maybeBotTurn(room), 1200);
}
function maybeBotTurn(room){
  if(!room || room.phase!=='playing') return;
  if(room.waitingClaim) return;
  let cur = room.players[room.turnIdx];
  if(!cur || !cur.isBot) return;
  if(cur.hand.length>=14){ setTimeout(()=>botDiscard(room, cur), 900 + Math.random()*800); }
  else if(cur.hand.length===13){ if(room.wall.length>0) cur.hand.push(room.wall.pop()); sendHand(room, cur); setTimeout(()=>botDiscard(room, cur), 900); }
}
function botDiscard(room, bot){
  if(!room || room.phase!=='playing') return;
  if(room.players[room.turnIdx].name!==bot.name) return;
  let tile = botChooseDiscard(bot); if(!tile) return;
  let idx = bot.hand.findIndex(t=>t.id===tile.id);
  bot.hand.splice(idx,1); bot.discards.push(tile); room.lastDiscard={ tile, from:bot.name };
  handleAfterDiscard(room, bot, tile);
}
function handleAfterDiscard(room, discarder, tile){
  let claims=[];
  room.players.forEach(p=>{
    if(p.name===discarder.name) return;
    let canHu = isChickenWin([...p.hand, tile], p.melds);
    let pong = canPong(p.hand, tile);
    let isNext = room.players[(room.players.indexOf(discarder)+1)%room.players.length].name===p.name;
    let chow = isNext ? canChow(p.hand, tile) : [];
    if(canHu||pong||chow.length>0) claims.push({ name:p.name, canHu, pong, chow, isBot:!!p.isBot });
  });
  emitToRoom(room, 'discarded', { from:discarder.name, tile, tileName:tileName(tile), wallLeft:room.wall.length, claims, players:publicPlayers(room) });
  if(claims.length===0){ advanceTurn(room, discarder); return; }
  room.waitingClaim={ tile, from:discarder.name, claims };
  let botClaims = claims.filter(c=>c.isBot);
  botClaims.sort((a,b)=> (b.canHu?1:0)-(a.canHu?1:0));
  let handled=false;
  botClaims.forEach((c, idx)=>{
    setTimeout(()=>{
      if(!room.waitingClaim || handled) return;
      let bot = room.players.find(p=>p.name===c.name); if(!bot) return;
      let isNext = room.players[(room.players.indexOf(discarder)+1)%room.players.length].name===bot.name;
      let dec = botDecideClaim(bot, tile, isNext);
      if(dec){ handled=true; doClaim(room, bot, dec.action, dec.chowNums, tile, discarder); }
    }, 800 + idx*700);
  });
  room.waitingClaim.timeout=setTimeout(()=>{ if(!room.waitingClaim) return; room.waitingClaim=null; advanceTurn(room, discarder); }, 8000);
}
function advanceTurn(room, fromPlayer){
  if(!room || room.phase!=='playing') return;
  room.turnIdx=(room.players.findIndex(p=>p.name===fromPlayer.name)+1)%room.players.length;
  let next=room.players[room.turnIdx];
  if(room.wall.length===0){ emitToRoom(room,'gameOver',{winner:null, message:'😐 Tembok habis! Seri, gak ada yang HU!'}); room.phase='ended'; return; }
  next.hand.push(room.wall.pop());
  next.hand.sort((a,b)=>tileKey(a).localeCompare(tileKey(b)));
  while(next.hand.some(t=>t.type==='flower')){ let fi=next.hand.findIndex(t=>t.type==='flower'); next.flowers.push(next.hand.splice(fi,1)[0]); if(room.wall.length>0) next.hand.push(room.wall.pop()); }
  emitToRoom(room,'turnChanged',{turn:next.name, wallLeft:room.wall.length});
  sendHand(room,next);
  setTimeout(()=>maybeBotTurn(room), 600);
}
function doClaim(room, claimer, action, chowNums, tile, discarder){
  if(room.waitingClaim && room.waitingClaim.timeout) clearTimeout(room.waitingClaim.timeout);
  room.waitingClaim=null;
  if(discarder){ let di = discarder.discards.findIndex(t=>t.id===tile.id); if(di!==-1) discarder.discards.splice(di,1); }
  if(action==='hu'){ claimer.hand.push(tile); emitToRoom(room,'gameOver',{winner:claimer.name, message:`🐔 CHICKEN HAND! ${claimer.name} HU! 4 Set + 1 Pasang!`, hand:claimer.hand, melds:claimer.melds, isBot:!!claimer.isBot}); room.phase='ended'; return; }
  if(action==='pong'){
    let taken=[]; for(let i=claimer.hand.length-1;i>=0 && taken.length<2;i--){ if(tileKey(claimer.hand[i])===tileKey(tile)) taken.push(claimer.hand.splice(i,1)[0]); }
    claimer.melds.push({type:'pong', tiles:[...taken, tile]});
    room.turnIdx=room.players.findIndex(p=>p.name===claimer.name);
    emitToRoom(room,'meldMade',{by:claimer.name, meld:claimer.melds[claimer.melds.length-1], players:publicPlayers(room)});
    emitToRoom(room,'turnChanged',{turn:claimer.name, wallLeft:room.wall.length, needDiscard:true});
    sendHand(room,claimer); setTimeout(()=>maybeBotTurn(room), 800); return;
  }
  if(action==='chow'){
    let taken=[]; chowNums.forEach(n=>{ if(n===tile.num) return; let i=claimer.hand.findIndex(t=>t.type==='suit'&&t.suit===tile.suit&&t.num===n); if(i!==-1) taken.push(claimer.hand.splice(i,1)[0]); });
    taken.push(tile); taken.sort((a,b)=>a.num-b.num);
    claimer.melds.push({type:'chow', tiles:taken});
    room.turnIdx=room.players.findIndex(p=>p.name===claimer.name);
    emitToRoom(room,'meldMade',{by:claimer.name, meld:claimer.melds[claimer.melds.length-1], players:publicPlayers(room)});
    emitToRoom(room,'turnChanged',{turn:claimer.name, wallLeft:room.wall.length, needDiscard:true});
    sendHand(room,claimer); setTimeout(()=>maybeBotTurn(room), 800); return;
  }
  if(action==='pass'){ advanceTurn(room, discarder); return; }
}
io.on('connection', socket=>{
  socket.on('createRoom', ({name})=>{
    name=String(name||'').trim().slice(0,15); if(!name) return socket.emit('errorMsg','Nama dulu!');
    let code=Math.random().toString(36).substring(2,6).toUpperCase();
    ROOMS[code]={ code, hostId:socket.id, players:[{id:socket.id,name,hand:[],melds:[],flowers:[],discards:[],isBot:false}], phase:'lobby', wall:[], turnIdx:0, lastDiscard:null, waitingClaim:null, botCount:0 };
    socket.join(code); socket.emit('roomCreated',{code}); io.to(code).emit('updateLobby', ROOMS[code]);
  });
  socket.on('joinRoom', ({code,name})=>{
    code=(code||'').toUpperCase(); name=String(name||'').trim().slice(0,15);
    let room=ROOMS[code]; if(!room) return socket.emit('errorMsg','Kode salah!');
    if(room.phase!=='lobby') return socket.emit('errorMsg','Game sudah mulai!');
    if(room.players.length>=4) return socket.emit('errorMsg','Meja penuh! Max 4 orang');
    if(room.players.some(p=>p.name.toLowerCase()===name.toLowerCase())) return socket.emit('errorMsg','Nama udah dipake!');
    room.players.push({id:socket.id,name,hand:[],melds:[],flowers:[],discards:[],isBot:false});
    socket.join(code); socket.emit('joinedRoom',{code}); io.to(code).emit('updateLobby', room);
  });
  socket.on('addBot', ({code, level})=>{
    let room=ROOMS[code]; if(!room) return; if(room.hostId!==socket.id) return socket.emit('errorMsg','Cuma HOST yang bisa tambah bot!');
    if(room.phase!=='lobby') return socket.emit('errorMsg','Game sudah mulai!');
    if(room.players.length>=4) return socket.emit('errorMsg','Meja penuh! Max 4');
    level=['easy','normal','hard'].includes(level)?level:'normal';
    room.botCount=(room.botCount||0)+1;
    let names={easy:'Bot Gampang', normal:'Bot Lumayan', hard:'Bot Pro'};
    let botName=`${names[level]} ${room.botCount}`;
    if(room.players.some(p=>p.name===botName)) botName+=` #${Date.now()%100}`;
    room.players.push({id:'bot-'+Date.now()+'-'+Math.random().toString(36).slice(2,5), name:botName, hand:[],melds:[],flowers:[],discards:[], isBot:true, botLevel:level});
    io.to(code).emit('updateLobby', room);
  });
  socket.on('removeBot', ({code, botName})=>{
    let room=ROOMS[code]; if(!room) return; if(room.hostId!==socket.id) return; if(room.phase!=='lobby') return;
    room.players=room.players.filter(p=>!(p.isBot && p.name===botName));
    io.to(code).emit('updateLobby', room);
  });
  socket.on('fillBots', ({code, level})=>{
    let room=ROOMS[code]; if(!room) return; if(room.hostId!==socket.id) return; if(room.phase!=='lobby') return;
    level=['easy','normal','hard'].includes(level)?level:'normal';
    while(room.players.length<4){ room.botCount=(room.botCount||0)+1; let names={easy:'Bot Gampang', normal:'Bot Lumayan', hard:'Bot Pro'}; room.players.push({id:'bot-'+Date.now()+'-'+Math.random().toString(36).slice(2,5), name:`${names[level]} ${room.botCount}`, hand:[],melds:[],flowers:[],discards:[], isBot:true, botLevel:level}); }
    io.to(code).emit('updateLobby', room);
  });
  socket.on('startGame', ({code})=>{
    let room=ROOMS[code]; if(!room||room.hostId!==socket.id) return;
    if(room.players.length<2) return socket.emit('errorMsg','Minimal 2 pemain! Tambah BOT kalau sendirian!');
    if(room.players.length>4) return socket.emit('errorMsg','Max 4 pemain!');
    startGame(room);
  });
  socket.on('discard', ({code, tileId})=>{
    let room=ROOMS[code]; if(!room||room.phase!=='playing') return;
    let me=room.players.find(p=>p.id===socket.id); if(!me||me.isBot) return;
    if(room.players[room.turnIdx].id!==socket.id) return socket.emit('errorMsg','Bukan giliran kamu!');
    if(room.waitingClaim) return;
    let idx=me.hand.findIndex(t=>t.id===tileId); if(idx===-1) return socket.emit('errorMsg','Tile gak ketemu!');
    let tile=me.hand.splice(idx,1)[0];
    me.discards.push(tile); room.lastDiscard={tile, from:me.name};
    handleAfterDiscard(room, me, tile);
  });
  socket.on('claim', ({code, action, chowNums})=>{
    let room=ROOMS[code]; if(!room||!room.waitingClaim) return;
    let me=room.players.find(p=>p.id===socket.id); if(!me||me.isBot) return;
    let can = room.waitingClaim.claims.find(c=>c.name===me.name);
    if(!can && action!=='pass') return socket.emit('errorMsg','Kamu gak bisa claim tile ini!');
    if(action==='pass'){
      if(room.waitingClaim.claims.length===1){ if(room.waitingClaim.timeout) clearTimeout(room.waitingClaim.timeout); room.waitingClaim=null; let discarder = room.players.find(p=>p.name===room.lastDiscard.from); advanceTurn(room, discarder); }
      return;
    }
    let tile = room.waitingClaim.tile;
    let discarder = room.players.find(p=>p.name===room.waitingClaim.from);
    doClaim(room, me, action, chowNums, tile, discarder);
  });
  socket.on('tableChat', ({code, msg})=>{
    let room=ROOMS[code]; if(!room) return;
    let me=room.players.find(p=>p.id===socket.id); if(!me) return;
    msg=String(msg||'').trim().slice(0,100); if(!msg) return;
    io.to(code).emit('tableChatMsg', { name:me.name, msg, time:new Date().toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'}) });
  });
  socket.on('selfHu', ({code})=>{
    let room=ROOMS[code]; if(!room||room.phase!=='playing') return;
    let me=room.players.find(p=>p.id===socket.id); if(!me||me.isBot) return;
    if(!isChickenWin(me.hand, me.melds)) return socket.emit('errorMsg','Belum HU! Belum 4 Set + 1 Pasang!');
    io.to(code).emit('gameOver',{winner:me.name, message:`🐔 CHICKEN HAND! ${me.name} HU SENDIRI!`, hand:me.hand, melds:me.melds});
    room.phase='ended';
  });
  socket.on('playAgain', ({code})=>{
    let room=ROOMS[code]; if(!room) return;
    if(room.waitingClaim && room.waitingClaim.timeout) clearTimeout(room.waitingClaim.timeout);
    room.phase='lobby'; room.wall=[]; room.lastDiscard=null; room.waitingClaim=null;
    room.players.forEach(p=>{ p.hand=[]; p.melds=[]; p.flowers=[]; p.discards=[]; });
    io.to(code).emit('playAgainReady',{code}); io.to(code).emit('updateLobby', room);
  });
  socket.on('disconnect', ()=>{
    for(let code in ROOMS){
      let room=ROOMS[code]; let was=room.players.some(p=>p.id===socket.id && !p.isBot); if(!was) continue;
      room.players=room.players.filter(p=>p.id!==socket.id);
      if(room.players.length===0){ delete ROOMS[code]; continue; }
      let humans = room.players.filter(p=>!p.isBot);
      if(room.hostId===socket.id && humans.length>0) room.hostId=humans[0].id;
      io.to(code).emit('updateLobby', room);
      if(room.phase==='playing' && !room.waitingClaim){ let cur = room.players[room.turnIdx]; if(cur && cur.id===socket.id){ advanceTurn(room, {name:'__left__'}); } }
    }
  });
});
const PORT=process.env.PORT||3000;
server.listen(PORT,'0.0.0.0',()=>console.log('🀄 MAHJONG ONLINE + BOT di port '+PORT));
