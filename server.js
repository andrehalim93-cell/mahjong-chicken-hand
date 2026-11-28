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
const io = new Server(server, { cors: { origin: "*", methods: ["GET","POST"] }, pingTimeout: 60000, pingInterval: 25000 });
const PORT = process.env.PORT || 3000;
function formatWIB(tanggal){
  if(!tanggal) return '-';
  return new Date(tanggal).toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  }) + ' WIB';
}
// ============ TAMBAHAN BARU: AUTH + SUPABASE + HASH - JANGAN UBAH YANG LAIN ============
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
// Token HU sekali pakai - gak perlu disimpen di DB, cuma di memori server
const HU_SECRET = process.env.HU_SECRET || ('hu-secret-' + Date.now() + '-' + Math.random());
const authTokens = new Map(); // token -> { userId, exp }
function makeAuthToken(userId){ let tok = crypto.randomBytes(32).toString('hex'); authTokens.set(tok,{userId:String(userId).toLowerCase(),exp:Date.now()+7*24*60*60*1000}); for(let [k,v] of authTokens){ if(v.exp<Date.now()) authTokens.delete(k); } return tok; }
const huTokens = new Map(); // token -> { exp, ownerId, ownerSocketId }
function makeHuToken(roomCode, winnerSocketId, ownerId){
  let token = crypto.createHash('sha256').update(roomCode + '|' + winnerSocketId + '|' + Date.now() + '|' + Math.random() + '|' + HU_SECRET).digest('hex');
  huTokens.set(token, { exp: Date.now() + 5*60*1000, ownerId: ownerId ? String(ownerId).toLowerCase() : '', ownerSocketId: winnerSocketId });
  return token;
}
const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if(!SUPABASE_URL || !SUPABASE_ANON_KEY){ console.error('SUPABASE ENV BELUM KEISI DI RENDER!'); }

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
// ============ TEMEN - ONLINE + FRIENDS - JANGAN UBAH YANG LAIN ============
const onlineUsers = new Map(); // userId(lowercase) -> { socketId, id, display_name, avatar, roomCode }
function normId(v){ return String(v||'').trim().toLowerCase(); }
function getOnlineList(){
  return [...onlineUsers.values()].map(u=>({ id:u.id, display_name:u.display_name, avatar:u.avatar||'🧑', roomCode:u.roomCode||'', status: u.roomCode ? 'Di Meja' : 'Online' }));
}
function broadcastOnline(){ io.emit('onlineUsersUpdated', getOnlineList()); }
function getSocketByUserId(uid){
  let u = onlineUsers.get(normId(uid));
  return u ? io.sockets.sockets.get(u.socketId) : null;
}
async function getUserPublicById(uid){
  let { data } = await supabase.from('users').select('id, display_name, avatar, hu').eq('id', normId(uid)).maybeSingle();
  return data || null;
}
async function getFriendsFor(uid){
  uid = normId(uid);
  let { data } = await supabase.from('friends').select('*').or(`from_id.eq.${uid},to_id.eq.${uid}`).eq('status','accepted');
  let out = [];
  for(let r of (data||[])){
    let otherId = r.from_id===uid ? r.to_id : r.from_id;
    let p = await getUserPublicById(otherId);
    let on = onlineUsers.get(otherId);
    out.push({ id: otherId, display_name: p?.display_name||otherId, avatar: p?.avatar||'🧑', hu: p?.hu||0, status: on ? (on.roomCode ? 'Di Meja' : 'Online') : 'Offline', roomCode: on?.roomCode||'' });
  }
  return out;
}
async function getPendingFor(uid){
  uid = normId(uid);
  let { data } = await supabase.from('friends').select('*').eq('to_id', uid).eq('status','pending');
  let out = [];
  for(let r of (data||[])){
    let p = await getUserPublicById(r.from_id);
    out.push({ from_id: r.from_id, display_name: p?.display_name||r.from_id, avatar: p?.avatar||'🧑' });
  }
  return out;
}

// --- Helper validasi ---
function isValidUserId(id){
  return typeof id === 'string' && /^[a-zA-Z0-9_]{3,20}$/.test(id);
}
function cleanStr(s, max){
  return String(s || '').trim().slice(0, max || 50);
}

// --- REGISTER: ID + Password di-hash dulu baru disimpen ---
app.post('/api/register', async (req, res) => {
  try{
    let { id, password, display_name, gender, avatar, question, answerHash } = req.body || {};
    question = cleanStr(question, 20);
    answerHash = cleanStr(answerHash, 100);
    id = cleanStr(id, 20).toLowerCase();
    display_name = cleanStr(display_name, 20);
    gender = cleanStr(gender, 10);
    avatar = cleanStr(avatar, 100);

    if(!isValidUserId(id)) return res.status(400).json({ ok:false, error:'ID harus 3-20 karakter, huruf/angka/_ aja, tanpa spasi!' });
    if(!password || String(password).length < 6) return res.status(400).json({ ok:false, error:'Password minimal 6 karakter!' });
    if(!display_name) return res.status(400).json({ ok:false, error:'Nama tampilan wajib diisi!' });
    if(gender !== 'male' && gender !== 'female') return res.status(400).json({ ok:false, error:'Gender harus male / female!' });
    if(!['hewan','kota','sekolah','ibu'].includes(question)) return res.status(400).json({ ok:false, error:'Pertanyaan keamanan wajib dipilih!' });
    if(!answerHash || answerHash.length !== 64) return res.status(400).json({ ok:false, error:'Jawaban keamanan wajib diisi!' });

    // Cek ID udah dipake belum
    let { data: existing } = await supabase.from('users').select('id').eq('id', id).maybeSingle();
    if(existing) return res.status(400).json({ ok:false, error:'ID udah dipake! Coba ID lain!' });

    // HASH PASSWORD - yang disimpen ke DB cuma hash-nya, bukan password asli
    let password_hash = await bcrypt.hash(String(password), 10);

    let { data, error } = await supabase.from('users').insert([{
      id, password_hash, display_name, gender, avatar, question, answer_hash: answerHash
    }]).select('id, display_name, gender, avatar, created_at').single();

    if(error){
      console.log('REGISTER ERROR:', error);
      return res.status(500).json({ ok:false, error:'Gagal daftar: ' + error.message });
    }
    return res.json({ ok:true, user: { ...data, created_at_wib: formatWIB(data.created_at) }, authToken: makeAuthToken(data.id) });
  }catch(e){
    console.log('REGISTER EX:', e);
    return res.status(500).json({ ok:false, error:'Server error saat daftar!' });
  }
});

// --- LOGIN: Cek password pake bcrypt.compare ---
app.post('/api/login', async (req, res) => {
  try{
    let { id, password } = req.body || {};
    id = cleanStr(id, 20).toLowerCase();
    if(!id || !password) return res.status(400).json({ ok:false, error:'ID & Password wajib diisi!' });

    let { data: user, error } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
    if(error || !user) return res.status(400).json({ ok:false, error:'ID tidak ditemukan!' });

    // Bandingin password ketikan vs hash di DB
    let match = await bcrypt.compare(String(password), user.password_hash);
    if(!match) return res.status(400).json({ ok:false, error:'Password salah!' });

       // JANGAN kirim hash ke client! Ini yang paling penting.
    delete user.password_hash;
    delete user.answer_hash;
    return res.json({ ok:true, user: { ...user, created_at_wib: formatWIB(user.created_at) }, authToken: makeAuthToken(user.id) });
  }catch(e){
    console.log('LOGIN EX:', e);
    return res.status(500).json({ ok:false, error:'Server error saat login!' });
  }
});

// --- LUPA PASSWORD: cek HASH jawaban, bukan jawaban polosan ---
app.post('/api/forgot-password', async (req, res) => {
  try{
    let { id, question, answerHash, newPassword } = req.body || {};
    id = cleanStr(id, 20).toLowerCase();
    question = cleanStr(question, 20);
    answerHash = cleanStr(answerHash, 100);
    if(!id || !question || !answerHash) return res.status(400).json({ ok:false, error:'Isi ID, pertanyaan & jawaban!' });
    if(!newPassword || String(newPassword).length < 6) return res.status(400).json({ ok:false, error:'Password baru minimal 6 karakter!' });

    let { data: user, error } = await supabase.from('users').select('id, question, answer_hash').eq('id', id).maybeSingle();
    if(error || !user) return res.status(400).json({ ok:false, error:'ID tidak ditemukan!' });
    if(!user.answer_hash) return res.status(400).json({ ok:false, error:'Akun ini belum setting pertanyaan keamanan! Daftar ulang!' });

    // Bandingin HASH vs HASH - jawaban aslinya gak pernah keluar dari HP user
    if(user.question !== question || user.answer_hash !== answerHash)
      return res.status(400).json({ ok:false, error:'Pertanyaan / jawaban salah!' });

    // Kalo cocok, baru ganti password - pake bcrypt kayak register
    let newHash = await bcrypt.hash(String(newPassword), 10);
    let { error: updErr } = await supabase.from('users').update({ password_hash: newHash }).eq('id', id);
    if(updErr) return res.status(500).json({ ok:false, error:'Gagal ganti password: ' + updErr.message });

    return res.json({ ok:true });
  }catch(e){
    console.log('FORGOT EX:', e);
    return res.status(500).json({ ok:false, error:'Server error saat reset!' });
  }
});
app.post('/api/add-hu', async (req, res)=>{
  try{
    let {id, mode, playerCount, huToken} = req.body || {};
    if(mode!=='tanding' && mode!=='pro') return res.json({ok:false, counted:false, reason:'latihan'});
    if(Number(playerCount)!==4) return res.json({ok:false, counted:false, reason:'need-4-players'});
    if(!id) return res.json({ok:false, counted:false, reason:'no-id'});
    // INI KUNCINYA: tanpa token yang valid, ditolak. Token cuma didapat dari menang beneran.
    if(!huToken || !huTokens.has(huToken)) return res.json({ok:false, counted:false, reason:'no-token'});
    let tok = huTokens.get(huToken);
huTokens.delete(huToken);
if(tok.exp < Date.now()) return res.json({ok:false, counted:false, reason:'token-expired'});
if(tok.ownerId && normId(id) !== tok.ownerId) return res.json({ok:false, counted:false, reason:'token-owner-mismatch'});

let { data:u } = await supabase.from('users').select('hu').eq('id', normId(id)).maybeSingle();
let oldHu = u?.hu||0; let newHu = oldHu + 1;
let { data:upd, error:updErr } = await supabase.from('users').update({hu: newHu}).eq('id', normId(id)).eq('hu', oldHu).select('hu').maybeSingle();
if(updErr || !upd){
  // Gagal nulis pertama, karena HU-nya udah berubah duluan. Ambil HU terbaru, baru +1 lagi.
  let { data:u2 } = await supabase.from('users').select('hu').eq('id', normId(id)).maybeSingle();
  let h2 = u2?.hu || 0;
  let { data:upd2 } = await supabase.from('users').update({hu: h2 + 1}).eq('id', normId(id)).eq('hu', h2).select('hu').maybeSingle();
  if(!upd2) return res.json({ok:false, counted:false, reason:'db-retry-failed'});
  return res.json({ok:true, counted:true, hu: upd2.hu});
}
return res.json({ok:true, counted:true, hu: upd.hu});
  }catch(e){
    console.log('ADD-HU EX:', e);
    return res.json({ok:false, counted:false});
  }
});
app.get('/api/get-hu', async (req,res)=>{
  let { data:u } = await supabase.from('users').select('hu').eq('id', req.query.id).maybeSingle();
  res.json({ok:true, hu: u?.hu||0});
});
// ===== BOLANG - 6C: GET + SAVE LEVEL / FLOOR / TITLES / ACTIVE_TITLE =====
const BOLANG_VALID_TITLES_6C = ['SANG PETUALANG','JAWARA JAKARTA','SINGA MERLION','PENDEKAR MALAYA','RONIN MAHJONG','NAGA FORMOSA','BINTANG SEOUL','RAJA KOWLOON','NAGA PUTIH MACAO','KAISAR NAGA','KING OF MAHJONG'];
// Migrasi: akun lama yang masih nyimpen ADVENTURE, ubah jadi SANG PETUALANG
function bolangMapTitle_6D(t){
  let m = {
    'ADVENTURE':'SANG PETUALANG',
    'JAKARTA CHAMPION':'JAWARA JAKARTA',
    'SINGAPORE CHAMPION':'SINGA MERLION',
    'MALAYSIA CHAMPION':'PENDEKAR MALAYA',
    'JAPAN CHAMPION':'RONIN MAHJONG',
    'TAIWAN CHAMPION':'NAGA FORMOSA',
    'KOREAN CHAMPION':'BINTANG SEOUL',
    'HONGKONG CHAMPION':'RAJA KOWLOON',
    'MACAO CHAMPION':'NAGA PUTIH MACAO',
    'BANDAR MACAO':'NAGA PUTIH MACAO',
    'CHINA CHAMPION':'KAISAR NAGA',
    'RAJA MAHJONG':'KING OF MAHJONG'
  };
  return m[t] || t;
}
app.get('/api/bolang-get', async (req,res)=>{
  try{
    let id = normId(req.query.id);
    if(!id) return res.json({ok:false, error:'ID kosong!'});
    // Coba baca kolom baru dulu. Kalo kolom belum ada di Supabase (belum migrasi), fallback ke kolom lama, biar gak crash.
    let { data, error } = await supabase.from('bolang_progress').select('user_id, coins, story_done, has_entered, level, floor, titles, active_title, updated_at').eq('user_id', id).maybeSingle();
    if(error && String(error.message||'').toLowerCase().includes('column')){
      let r2 = await supabase.from('bolang_progress').select('user_id, coins, story_done, has_entered').eq('user_id', id).maybeSingle();
      if(r2.error) throw r2.error;
      data = r2.data;
    } else if(error) throw error;
    if(!data) return res.json({ok:true, data:null});
    let tt = Array.isArray(data.titles) ? data.titles.map(t=>bolangMapTitle_6D(t)).filter(t=>BOLANG_VALID_TITLES_6C.includes(t)) : [];
    return res.json({ok:true, data:{
      coins: data.coins || 0,
      story_done: !!data.story_done,
      has_entered: !!data.has_entered,
      level: (typeof data.level === 'number' ? data.level : 0),
      floor: (typeof data.floor === 'number' ? data.floor : 0),
      titles: tt,
      active_title: (typeof data.active_title === 'string' && tt.includes(bolangMapTitle_6D(data.active_title)) ? bolangMapTitle_6D(data.active_title) : tt[tt.length-1]),
      updated_at: data.updated_at || null
    }});
  }catch(e){ console.log('BOLANG-GET EX:', e); return res.json({ok:false, error:'Server error'}); }
});

app.post('/api/bolang-save', async (req,res)=>{
  try{
    let { id, coins, story_done, has_entered, level, floor, titles, active_title, authToken } = req.body || {};
    id = normId(id);
    if(!id) return res.json({ok:false, error:'ID kosong!'});
    if(authToken){
      let at = authTokens.get(authToken);
      if(!at || at.exp < Date.now() || at.userId !== id) return res.status(403).json({ok:false, error:'Sesi kadaluarsa, login ulang!'});
    }
    let safeCoins = Math.max(0, Math.min(999999999, Math.floor(Number(coins) || 0)));
    // 6C: validasi level/floor, jangan percaya HP mentah-mentah
    let lv = Number(level);
    if(!Number.isFinite(lv) || lv < 0 || lv > 10) lv = 0;
    let fl = Number(floor);
    if(!Number.isFinite(fl) || fl < 0 || fl > 5) fl = 0;
       // 6D: validasi titles pake daftar asli BOLANG_LEVELS. RAJA MAHJONG cuma boleh kalo udah tamat, dicek di TAHAP 7.
    let tt = Array.isArray(titles) ? titles.map(t=>bolangMapTitle_6D(t)).filter(t=>BOLANG_VALID_TITLES_6C.includes(t)) : [];
    // Jangan unshift ADVENTURE lagi. ADVENTURE cuma masuk kalo beneran udah lewat Desa (dari bolangBuyTicket).
    // lv = level sekarang. Kalo lv 0 (masih di Desa), belum boleh punya title apa-apa. Kalo lv 1 (udah di Jakarta), boleh punya ADVENTURE (index 0). Kalo lv 2, boleh punya sampe JAKARTA CHAMPION (index 1), dst.
    let maxIdx = lv - 1;
    if(lv >= 10) maxIdx = 10;
    tt = tt.filter(t=>BOLANG_VALID_TITLES_6C.indexOf(t) <= maxIdx);
        let at2raw = bolangMapTitle_6D(active_title);
    let at2 = (typeof at2raw === 'string' && tt.includes(at2raw)) ? at2raw : (tt.length ? tt[tt.length-1] : '');
    let payload = {
      user_id: id,
      coins: safeCoins,
      story_done: !!story_done,
      has_entered: !!has_entered,
      level: lv,
      floor: fl,
      titles: tt,
      active_title: at2,
      updated_at: new Date().toISOString()
    };
    let { data, error } = await supabase.from('bolang_progress').upsert(payload, { onConflict: 'user_id' }).select().maybeSingle();
    // Kalo kolom baru belum ada di Supabase, fallback ke save lama (koin doang), biar game gak mati total
    if(error && String(error.message||'').toLowerCase().includes('column')){
      let r2 = await supabase.from('bolang_progress').upsert({
        user_id: id, coins: safeCoins, story_done: !!story_done, has_entered: !!has_entered, updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' }).select().maybeSingle();
      if(r2.error) throw r2.error;
      return res.json({ok:true, data: r2.data, warn:'BOLANG_COLUMNS_MISSING'});
    }
    if(error) throw error;
    return res.json({ok:true, data: data});
  }catch(e){ console.log('BOLANG-SAVE EX:', e); return res.json({ok:false, error:'Server error'}); }
});
app.post('/api/me', async (req, res)=>{
  try{
    let { id, authToken } = req.body||{};
    id = normId(id);
    if(!id || !authToken) return res.json({ok:false, error:'No session'});
    let at = authTokens.get(authToken);
    if(!at || at.exp<Date.now() || at.userId!==id) return res.json({ok:false, error:'Session expired'});
    let { data:user } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
    if(!user) return res.json({ok:false, error:'User tidak ditemukan!'});
    delete user.password_hash; delete user.answer_hash;
    return res.json({ok:true, user:{...user, created_at_wib: formatWIB(user.created_at)}, authToken});
  }catch(e){ return res.json({ok:false, error:'Server error'}); }
});
app.get('/api/leaderboard', async (req,res)=>{
  try{
    let { data, error } = await supabase.from('users').select('id, display_name, avatar, hu').order('hu', { ascending:false }).limit(100);
    if(error) throw error;
    let users = (data||[]).map(u=>({ id:u.id, display_name:u.display_name, avatar:u.avatar||'🧑', hu:u.hu||0 }));
    res.json({ ok:true, users });
  }catch(e){ console.log('LEADERBOARD EX:', e); res.json({ ok:false, users:[] }); }
});
app.post('/api/change-avatar', async (req,res)=>{
  try{
       let {id, avatar, password, authToken} = req.body || {};
    if(!id || !avatar) return res.status(400).json({ok:false, error:'ID & avatar wajib!'});
    let { data: user } = await supabase.from('users').select('password_hash, ach').eq('id', id).maybeSingle();
    if(!user) return res.status(400).json({ok:false, error:'ID tidak ditemukan!'});
    if(authToken){ let at = authTokens.get(authToken); if(!at || at.exp<Date.now() || at.userId!==normId(id)) return res.status(403).json({ok:false, error:'Sesi kadaluarsa, login ulang!'}); }
    else { if(!password) return res.status(400).json({ok:false, error:'Butuh auth!'}); let match = await bcrypt.compare(String(password), user.password_hash); if(!match) return res.status(403).json({ok:false, error:'Password salah!'}); }

    // ===== CEK AVATAR SPESIAL - JANGAN PERCAYA HP DOANG =====
    let av = String(avatar).slice(0,100);
    if(av.startsWith('/avatars/special-')){
      let ach = user.ach || {unlocked:[]};
      if(typeof ach==='string'){ try{ ach=JSON.parse(ach); }catch(e){ ach={unlocked:[]}; } }
      let unlocked = new Set(ach.unlocked||[]);
      // Harus sama persis kayak ACH_CATS di index.html
      const REQ = {
        'special-teknik.png': ['first_pong','first_chow','first_kong','pong10','pong20','pong35','pong50','pong100','chow10','chow20','chow35','chow50','chow100','kong10','kong2','meld100','combo_meld'],
        'special-menang.png': ['first_game','first_hu','hu10','hu25','hu50','hu100','fast_hu','clean_win','hu_from_discard','streak3','streak5','streak10','perfect_hu','comeback','last_tile_hu','flower4','unlucky_to_lucky','self_hu5','login7','login30','games10','games100','games500'],
        'special-bot.png': ['bot1','bot10','bot20','bot50','bot_streak10','bot_fast'],
        'special-sosial.png': ['play_friend','friend5','friend10','friend20','friend30','invite10','invite50','chat100','chat500','emote50','emote200','loyal_friend','best_friend'],
        'special-rahasia.png': ['ninja','owl','revenge','midnight_hu','silent_killer','first_try','lose10','perfect_defense','maraton5','maraton10','tukang_intip','no_flower_win','kembar','kalah_tipis','bangkit3'],
      };
      let file = av.split('/').pop();
      if(file==='special-legend.png'){
        let allOk = Object.values(REQ).every(list=>list.every(x=>unlocked.has(x)));
        if(!allOk) return res.status(403).json({ok:false, error:'Avatar LEGEND belum kebuka! Semua kategori harus 100% dulu.'});
      } else {
        let need = REQ[file];
        if(!need) return res.status(403).json({ok:false, error:'Avatar spesial tidak dikenal!'});
        let missing = need.filter(x=>!unlocked.has(x));
        if(missing.length) return res.status(403).json({ok:false, error:'Avatar ini belum kebuka! Masih kurang '+missing.length+' achievement di kategori itu.'});
      }
    }

    await supabase.from('users').update({ avatar: av }).eq('id', id);
    res.json({ok:true});
  }catch(e){ res.status(500).json({ok:false}); }
});
// ===== ACHIEVEMENT PERMANEN - nyimpen di Supabase, bukan cuma di HP =====
app.get('/api/get-ach', async (req,res)=>{
  try{
    let { data:u } = await supabase.from('users').select('ach').eq('id', normId(req.query.id)).maybeSingle();
    let ach = u?.ach || {unlocked:[],stats:{}};
    if(typeof ach==='string'){ try{ ach=JSON.parse(ach); }catch(e){ ach={unlocked:[],stats:{}}; } }
    res.json({ok:true, ach});
  }catch(e){ console.log('GET-ACH EX:', e); res.json({ok:false, ach:{unlocked:[],stats:{}}}); }
});
app.post('/api/save-ach', async (req,res)=>{
  try{
        let {id, password, authToken, ach} = req.body || {};
    if(!id || !ach) return res.status(400).json({ok:false});
    if(authToken){ let at = authTokens.get(authToken); if(!at || at.exp<Date.now() || at.userId!==normId(id)) return res.status(403).json({ok:false}); }
    else { if(!password) return res.status(400).json({ok:false}); let { data:user } = await supabase.from('users').select('password_hash').eq('id', normId(id)).maybeSingle(); if(!user) return res.status(400).json({ok:false}); let match = await bcrypt.compare(String(password), user.password_hash); if(!match) return res.status(403).json({ok:false}); }
const KNOWN_ACH = ['first_pong','first_chow','first_kong','pong10','pong20','pong35','pong50','pong100','chow10','chow20','chow35','chow50','chow100','kong10','kong2','meld100','combo_meld','first_game','first_hu','hu10','hu25','hu50','hu100','fast_hu','clean_win','hu_from_discard','streak3','streak5','streak10','perfect_hu','comeback','last_tile_hu','flower4','unlucky_to_lucky','self_hu5','login7','login30','games10','games100','games500','bot1','bot10','bot20','bot50','bot_streak10','bot_fast','play_friend','friend5','friend10','friend20','friend30','invite10','invite50','chat100','chat500','emote50','emote200','loyal_friend','best_friend','ninja','owl','revenge','midnight_hu','silent_killer','first_try','lose10','perfect_defense','maraton5','maraton10','tukang_intip','no_flower_win','kembar','kalah_tipis','bangkit3','pro_hu1','pro_hu10','pro_hu25','pro_hu50','pro_kong1','pro_meld100'];
let { data:oldRow } = await supabase.from('users').select('ach').eq('id', normId(id)).maybeSingle();
let oldAch = oldRow?.ach||{unlocked:[],stats:{}}; if(typeof oldAch==='string'){ try{ oldAch=JSON.parse(oldAch); }catch(e){ oldAch={unlocked:[],stats:{}}; } }
let oldSet = new Set(oldAch.unlocked||[]);
let incoming = Array.isArray(ach.unlocked)?[...new Set(ach.unlocked.filter(x=>KNOWN_ACH.includes(x)))]:[];
let added = incoming.filter(x=>!oldSet.has(x));
if(added.length>10) added = added.slice(0,10);
let merged = [...oldSet, ...added];
let cleanStats = {}; if(ach.stats&&typeof ach.stats==='object'){ for(let k in ach.stats){ let v=Number(ach.stats[k]); if(Number.isFinite(v)) cleanStats[k]=Math.max(0,Math.min(v,1000000)); } }
for(let k in (oldAch.stats||{})){ if(cleanStats[k]===undefined) cleanStats[k]=oldAch.stats[k]; }
let clean = {unlocked:merged, stats:cleanStats};
await supabase.from('users').update({ach: clean}).eq('id', normId(id));
    res.json({ok:true});
  }catch(e){ console.log('SAVE-ACH EX:', e); res.status(500).json({ok:false}); }
});
// ============ AKHIR TAMBAHAN BARU ============
app.get('/health', (req, res) => res.send('OK'))
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
  let payload = { code: room.code, players: publicPlayers(room), hostId: room.players.find(x=>x.isHost)?.id, turnTimeSec: room.turnTimeSec, turnTime: room.turnTimeSec, mode: room.mode || 'latihan', roomName: room.roomName || 'Meja Mahjong', name: room.roomName || 'Meja Mahjong', skin: room.skin || 'hijau' };
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
    avatar:p.avatar||'🧑',
    melds:p.melds, discards:p.discards, flowers:p.flowers
  }));
}
function clearTurnTimer(room){ if(room.turnTimer){ clearTimeout(room.turnTimer); room.turnTimer=null; } }
// ===== MODE PRO TAHAP 3: hukuman HU palsu, potong 3 detik giliran SEKARANG =====
function applyProFakeHuPenalty(room, p){
  if(!room || room.mode!=='pro') return;
  // Hitung sisa giliran dari server, bukan dari HP, biar adil
  let total = room.turnTotalSec || room.proTurnSec || 15;
  let elapsed = room.turnStartedAt ? Math.floor((Date.now() - room.turnStartedAt) / 1000) : 0;
  let sisa = Math.max(0, total - elapsed);
  let sisaBaru = Math.max(0, sisa - 3);
  clearTurnTimer(room);
  if(sisaBaru<=0){
    // Sisa tinggal 3 detik / kurang -> giliran langsung HABIS
    io.to(p.id).emit('proHuPenalty', { cut: 3, sisa: sisa, remaining: 0, ended: true });
    addLog(room, `❌ ${p.name} HU palsu! Sisa ${sisa} detik -> langsung HABIS!`);
    // Biar game gak macet (tangan masih 14 tile), paksa timer 0.1 detik, nanti timeout yang auto-buang 1 tile kayak biasa
    room.proTurnSec = 15;
    room.turnTotalSec = 0;
    room.turnStartedAt = Date.now();
    room.turnTimer = setTimeout(()=>{ startTurnTimer(room); }, 100);
    return;
  }
  // Masih sisa -> lanjutin giliran dengan sisa yang udah dipotong
  room.proTurnSec = sisaBaru;
  room.turnTotalSec = sisaBaru;
  room.turnStartedAt = Date.now();
  io.to(p.id).emit('proHuPenalty', { cut: 3, sisa: sisa, remaining: sisaBaru, ended: false });
  addLog(room, `❌ ${p.name} HU palsu! Giliran dipotong 3 detik, sisa ${sisaBaru} detik!`);
  startTurnTimer(room);
}
function startTurnTimer(room){
  clearTurnTimer(room);
  let sec = (room.mode==='pro' ? (room.proTurnSec || 15) : room.turnTimeSec);
  if(!sec || sec===0) return; // 0 = tanpa batas
  if(room.phase!=='playing') return;
  room.turnStartedAt = Date.now(); // <-- TAMBAHIN INI
  room.turnTotalSec = sec; // <-- TAMBAHIN INI
  room.turnTimer = setTimeout(()=>{
    if(!room || room.phase!=='playing') return;
    let cur = room.players[room.turnIdx];
    if(!cur) return;
    if(room.waitingClaim){ room.turnTimer = setTimeout(()=>{ startTurnTimer(room); }, 2000); return; }

    // FIX PUTUS: Kalau yang giliran lagi putus, JANGAN auto-buang kartunya.
    // Tunggu dia balik. Cek lagi tiap 5 detik.
    // Kalau udah putus lebih dari 120 detik, baru boleh auto-buang biar game gak macet selamanya.
       if(cur.disconnected){
      let putusBerapaLama = Date.now() - (cur.disconnectedAt || Date.now());
      // FIX: jangan nunggu 120 detik, kelamaan, game keliatan stuck. 15 detik cukup buat balik, abis itu auto-buang biar jalan terus. Kursi tetep disimpen, dia bisa rejoin kapanpun.
      if(putusBerapaLama < 15000){
        room.turnTimer = setTimeout(()=>{ startTurnTimer(room); }, 5000);
        return;
      }
      // Udah 15 detik gak balik, baru lanjut ke auto-buang di bawah
    }

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
  }, sec*1000);
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
let tiles = hand.filter(t=>t.type!=='flower');
let kongCount = melds.filter(m=>m.type==='kong').length;
let meldTiles = melds.reduce((s,m)=>s + (m.type==='kong' ? 3 : (m.tiles||[]).length), 0);
if(tiles.length + meldTiles !== 14) return false;
  let meldCount = melds.length;
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
function sortedKeys(counts){
  let order = t => t==='suit'?0 : t==='wind'?1 : t==='dragon'?2 : 3;
  return Object.keys(counts).filter(k=>counts[k]>0).sort((a,b)=>{
    let [ta,sa,na] = a.split('|'); let [tb,sb,nb] = b.split('|');
    if(order(ta)!==order(tb)) return order(ta)-order(tb);
    if(parseInt(sa)!==parseInt(sb)) return parseInt(sa)-parseInt(sb);
    return parseInt(na)-parseInt(nb);
  });
}
function canFormSets(counts, needSets){
  let keys = sortedKeys(counts);
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
  let keys = sortedKeys(counts);
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
// ===== BOT LEVEL: biar GAMPANG / NORMAL / SUSAH beneran kerasa beda =====
function botLevelOf(bot){ let l = String((bot&&bot.level)||'normal').toLowerCase(); if(l==='medium') return 'normal'; if(l==='hard'||l==='easy'||l==='normal') return l; return 'normal'; }
function botThinkMs(bot, base){ let l = botLevelOf(bot); if(l==='easy') return Math.round(base*1.6); if(l==='hard') return Math.round(base*0.55); return base; }
// Seberapa berguna 1 tile di tangan. Makin kecil = makin aman dibuang.
// Pair = berguna, tetangga deket (bisa jadi CHOW) = berguna, honor pair = berguna.
function botTileUsefulness(hand, tile){
  let same = hand.filter(t=>t.key===tile.key).length;
  let score = (same-1)*3;
  if(tile.type==='suit'){
    hand.forEach(t=>{
      if(t.type==='suit' && t.suit===tile.suit && t.key!==tile.key){
        let d = Math.abs(t.num - tile.num);
        if(d===1) score += 1.5;
        else if(d===2) score += 0.7;
      }
    });
  }
  if((tile.type==='wind'||tile.type==='dragon') && same>=2) score += 2;
  return score;
}
function botChooseDiscard(bot, room){
  let hand = bot.hand.filter(t=>t.type!=='flower');
  if(hand.length===0) return bot.hand[0];
  let lvl = botLevelOf(bot);
  // --- GAMPANG: 60% buang NGASAL, sampe pair pun bisa kebuang. Ini yang bikin dia sering kalah. ---
  if(lvl==='easy' && Math.random()<0.6) return hand[Math.floor(Math.random()*hand.length)];
  // --- NORMAL: yang lama, buang single honor > terminal > single acak. ---
  if(lvl==='normal'){
    let counts={}; hand.forEach(t=>{ counts[t.key]=(counts[t.key]||0)+1; });
    let singles = hand.filter(t=>counts[t.key]===1);
    let honor = singles.filter(t=>t.type==='wind'||t.type==='dragon');
    if(honor.length>0) return honor[Math.floor(Math.random()*honor.length)];
    let terminal = singles.filter(t=>t.type==='suit' && (t.num===1||t.num===9));
    if(terminal.length>0) return terminal[Math.floor(Math.random()*terminal.length)];
    if(singles.length>0) return singles[Math.floor(Math.random()*singles.length)];
    return hand[Math.floor(Math.random()*hand.length)];
  }
  // --- SUSAH: pilih tile yang PALING GAK BERGUNA. Jaga pair, jaga yang bisa jadi CHOW. ---
  // Kalo nilainya seri, pilih yang udah paling banyak dibuang orang lain = paling aman dibuang.
  let seen = {};
  if(room) room.players.forEach(p=>(p.discards||[]).forEach(t=>{ seen[t.key]=(seen[t.key]||0)+1; }));
  let best = null, bestScore = Infinity, bestSafe = -1;
  hand.forEach(t=>{
    let s = botTileUsefulness(hand, t);
    let safe = seen[t.key]||0;
    if(s<bestScore || (s===bestScore && safe>bestSafe)){
      best = t; bestScore = s; bestSafe = safe;
    }
  });
  return best || hand[Math.floor(Math.random()*hand.length)];
}
function botDecideClaim(bot, tile, isNext){
  if(tile.type==='flower') return null;
  let lvl = botLevelOf(bot);
  // HU: semua level selalu HU. Ini yang bikin game tetep fair, gak ada BOT yang sengaja ngalah.
  if(canHuWithTileAndMelds(bot.hand, bot.melds, tile)) return { action:'hu' };
  let count = bot.hand.filter(t=>t.key===tile.key).length;
  // KONG: kalo punya 3, ambil. Dulu gak pernah KONG, sekarang semua level bisa, tapi GAMPANG sering ragu.
  if(count>=3){
    if(lvl==='easy' && Math.random()<0.8) return null;
    return { action:'kong' };
  }
  // PONG: GAMPANG sering ragu (65% skip), NORMAL selalu, SUSAH selalu.
  if(count>=2){
    if(lvl==='easy' && Math.random()<0.65) return null;
    return { action:'pong' };
  }
  // CHOW: cuma boleh dari pemain sebelumnya, aturan lama tetep dipake.
  if(isNext && tile.type==='suit'){
    let nums = bot.hand.filter(t=>t.type==='suit' && t.suit===tile.suit).map(t=>t.num);
    let options = [];
    if(nums.includes(tile.num-2) && nums.includes(tile.num-1)) options.push([tile.num-2, tile.num-1]);
    if(nums.includes(tile.num-1) && nums.includes(tile.num+1)) options.push([tile.num-1, tile.num+1]);
    if(nums.includes(tile.num+1) && nums.includes(tile.num+2)) options.push([tile.num+1, tile.num+2]);
    if(!options.length) return null;
    // GAMPANG: 75% skip CHOW, biar tangannya lambat jadi set.
    if(lvl==='easy' && Math.random()<0.75) return null;
    // SUSAH: jangan CHOW kalo 2 tile-nya itu pair yang lagi dijaga. Cari yang 2-2nya single dulu.
    if(lvl==='hard'){
      let counts = {}; bot.hand.forEach(t=>{ counts[t.key]=(counts[t.key]||0)+1; });
      let clean = options.filter(opt=>opt.every(n=>{
        let k = bot.hand.find(t=>t.type==='suit' && t.suit===tile.suit && t.num===n);
        return k && counts[k.key]===1;
      }));
      if(clean.length) return { action:'chow', chowNums: clean[Math.floor(Math.random()*clean.length)] };
      return null;
    }
    return { action:'chow', chowNums: options[Math.floor(Math.random()*options.length)] };
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
      if(drawn){ bot.hand.push(drawn); bot.hand = sortHand(bot.hand); }
  sendHand(room, bot);
  emitToRoom(room, 'playerDrew', { player:bot.name, wallLeft:room.wall.length });
  setTimeout(()=>botDiscard(room, bot), botThinkMs(bot, 900));
}
function botDiscard(room, bot){
  if(!room || room.phase!=='playing') return;
  if(room.players[room.turnIdx].name!==bot.name) return;
  if(canHuWithMelds(bot.hand, bot.melds)){ endGameWin(room, bot.name, 'Bot HU! Chicken Hand!'); return; }
  let tile = botChooseDiscard(bot, room);
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
   if(cur.hand.length>=14){ setTimeout(()=>botDiscard(room, cur), botThinkMs(cur, 1000)); return; }
  setTimeout(()=>botDrawAndDiscard(room, cur), botThinkMs(cur, 1000));
}
function getClaimsFor(room, tile, fromName){
  let claims=[];
  let fromIdx = room.players.findIndex(p=>p.name===fromName);
  room.players.forEach((p, idx)=>{
    if(p.name===fromName) return;
    if(p.isBot) return;
    let canHu = canHuWithTileAndMelds(p.hand, p.melds, tile);
    let kong = p.hand.filter(t=>t.key===tile.key).length>=3;
    let pong = p.hand.filter(t=>t.key===tile.key).length>=2;
    let chow=[];
    // ATURAN REAL: CHOW cuma boleh ambil buangan pemain SEBELUMNYA (yang baru buang).
    // Artinya: cuma pemain yang gilirannya persis SETELAH yang buang yang boleh CHOW.
    // PONG / HU boleh dari siapa aja.
    let isNext = ((fromIdx+1)%room.players.length)===idx;
    if(isNext && tile.type==='suit'){
      let nums = p.hand.filter(t=>t.type==='suit' && t.suit===tile.suit).map(t=>t.num);
      if(nums.includes(tile.num-2)&&nums.includes(tile.num-1)) chow.push([tile.num-2,tile.num-1,tile.num]);
      if(nums.includes(tile.num-1)&&nums.includes(tile.num+1)) chow.push([tile.num-1,tile.num,tile.num+1]);
      if(nums.includes(tile.num+1)&&nums.includes(tile.num+2)) chow.push([tile.num,tile.num+1,tile.num+2]);
    }
    if(canHu||pong||kong||chow.length>0) claims.push({ name:p.name, canHu, pong: pong && !kong, kong, chow });
  });
  return claims;
}

// ============ GAME FLOW ============
function startGame(room, turnTimeSec){
  if(turnTimeSec!==undefined && turnTimeSec!==null) room.turnTimeSec = turnTimeSec;
  if(room.mode==='pro') room.turnTimeSec = 15;
  let tiles = shuffle(createTiles());
  room.wall = tiles;
  room.phase='playing'; room.lastDiscard=null; room.waitingClaim=false; room.currentClaim=null; room.passCount=0; room.passNeeded=0; room.passedNames=[]; clearClaimTimer(room);
  room.proPenaltyNext = {}; // <-- TAMBAHIN INI. Isinya: { 'NamaPemain': 2, 'NamaLain': 4 } = total detik yang dipotong di giliran berikutnya
  room.proTurnSec = 15; // <-- TAMBAHIN INI. Waktu giliran yang lagi jalan, bisa berubah kalo kena hukuman
  // FITUR 2: LEMPAR DADU - tentukan dealer dari dadu
  let d1 = 1+Math.floor(Math.random()*6);
  let d2 = 1+Math.floor(Math.random()*6);
  let total = d1+d2;
  let dealerIdx = (total-1) % room.players.length;
  room.turnIdx = dealerIdx;
  room.lastDice = { d1, d2, total, dealer: room.players[dealerIdx].name };
  let dealerDrawnTile = null;
  room.players.forEach((p, idx)=>{
    p.hand=[]; p.melds=[]; p.discards=[]; p.flowers=[];
    let count = idx===dealerIdx ? 14 : 13;
    for(let i=0;i<count;i++){
      let t = room.wall.pop();
      while(t && t.type==='flower'){ p.flowers.push(t); t=room.wall.pop(); }
      if(t){ p.hand.push(t); if(idx===dealerIdx) dealerDrawnTile = t; }
    }
    p.hand = sortHand(p.hand);
  });
  let dealer = room.players[dealerIdx];
  emitToRoom(room, 'diceRolled', { d1, d2, total, dealer: dealer.name });
  emitToRoom(room, 'gameStarted', { players:publicPlayers(room), wallLeft:room.wall.length, turn:dealer.name, turnTimeSec:room.turnTimeSec, dice:{d1,d2,total,dealer:dealer.name} });
  room.players.forEach(p=>sendHand(room,p));
  if(dealer && !dealer.isBot && dealerDrawnTile){ io.to(dealer.id).emit('youDrew', { tile: dealerDrawnTile, wallLeft: room.wall.length }); }
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
  // ===== MODE PRO: gak ada BOT yang claim otomatis. Kalo 7 detik habis, langsung lanjut. =====
  if(room.mode==='pro'){
    room.waitingClaim=false; room.lastDiscard=null; room.currentClaim=null;
    emitToRoom(room, 'proClaimExpired', { from: discarder.name, tile: tile });
    advanceTurn(room, discarder);
    return;
  }
  let discarderIdx = room.players.findIndex(p=>p.name===discarder.name);
  // 1. Bot HU dulu (paling prioritas)
  for(let i=0;i<room.players.length;i++){
    let p=room.players[i];
    if(p.name===discarder.name) continue;
    if(p.isBot && canHuWithTileAndMelds(p.hand, p.melds, tile)){ endGameWin(room, p.name, `${p.name} HU dari buangan ${discarder.name}!`, tile); return; }
  }
   // 2. Bot KONG (baru, dulu gak ada, makanya BOT gak pernah KONG)
  for(let i=0;i<room.players.length;i++){
    let p=room.players[i];
    if(p.name===discarder.name) continue;
    if(p.isBot){
      let dec=botDecideClaim(p, tile, false);
      if(dec && dec.action==='kong'){ doClaim(room, p, 'kong', null, tile, discarder); return; }
    }
  }
  // 3. Bot PONG
  for(let i=0;i<room.players.length;i++){
    let p=room.players[i];
    if(p.name===discarder.name) continue;
    if(p.isBot){
      let dec=botDecideClaim(p, tile, false);
      if(dec && dec.action==='pong'){ doClaim(room, p, 'pong', null, tile, discarder); return; }
    }
  }
  // 4. Bot CHOW (next player)
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
  emitToRoom(room, 'claimAvailable', { tile, from:discarder.name, claims: humanClaims, claimTimeSec: room.mode==='pro' ? 7 : (room.turnTimeSec||0) });
  // ===== MODE PRO: gak ada BOT, gak ada jalur cepet BOT, tunggu klik manual 7 detik =====
  if(room.mode==='pro'){
    // Kalo gak ada yang bisa claim sama sekali, tetep tunggu 7 detik? ENGGAK.
    // Kalo gak ada yang bisa claim, langsung lanjut aja, biar game gak lemot.
    // Tapi tetep kasih kesempatan 1 detik biar tile-nya keliatan dulu di tengah.
    if(humanClaims.length===0){
      room.claimTimer = setTimeout(()=>{ resolveClaimTimeout(room, discarder, tile); }, 1000);
      return;
    }
    // Ada yang bisa claim -> tunggu klik manual, 7 detik, dihitung di SERVER.
    room.claimTimer = setTimeout(()=>{ resolveClaimTimeout(room, discarder, tile); }, 7000);
    return;
  }
  // ===== LATIHAN / TANDING: cara lama, jangan diubah =====
  let discarderIdx = room.players.findIndex(p=>p.name===discarder.name);
  let botCanClaim = false;
  for(let i=0;i<room.players.length;i++){
    let b = room.players[i];
    if(b.name===discarder.name || !b.isBot) continue;
    let isNext = ((discarderIdx+1)%room.players.length)===i;
    if(botDecideClaim(b, tile, isNext)){ botCanClaim = true; break; }
  }
  if(humanClaims.length===0 && !botCanClaim){
    room.waitingClaim=false; room.lastDiscard=null; room.currentClaim=null;
    advanceTurn(room, discarder);
    return;
  }
  if(humanClaims.length==0 && botCanClaim){
    resolveClaimTimeout(room, discarder, tile);
    return;
  }
  room.claimTimer = setTimeout(()=>{ resolveClaimTimeout(room, discarder, tile); }, (room.turnTimeSec||15)*1000);
}
function doClaim(room, claimer, action, chowNums, tile, discarder){
  clearTurnTimer(room);
  clearClaimTimer(room);
  if(action==='hu'){
    if(!canHuWithTileAndMelds(claimer.hand, claimer.melds, tile)){
           if(room.mode==='pro'){
        // HU palsu dari buangan = anggap PASS, jangan bikin game macet
        // Hukuman -3 detik tetep dicatat buat giliran berikutnya
        room.proPenaltyNext = room.proPenaltyNext || {};
        room.proPenaltyNext[claimer.name] = (room.proPenaltyNext[claimer.name] || 0) + 3;
        io.to(claimer.id).emit('proHuPenalty', { cut: 3, sisa: 0, remaining: 0, ended: false, nextTurn: true });
        // Lanjutin flow claim kayak orang PASS, biar gak stuck di waitingClaim
        room.passCount = (room.passCount || 0) + 1;
        if(room.passCount >= room.passNeeded){
          resolveClaimTimeout(room, discarder, tile);
        } else {
          // Masih ada yang belum PASS, idupin lagi timer claim 7 detik
          clearClaimTimer(room);
          room.claimTimer = setTimeout(()=>{ resolveClaimTimeout(room, discarder, tile); }, 7000);
        }
      }
      return;
    }
    endGameWin(room, claimer.name, `${claimer.name} HU!`, tile);
    return;
  }
  if(action==='chow'){
    // 1. Harus pemain setelah yang buang (pemain sebelumnya yang buang)
    let discarderIdx = room.players.findIndex(p=>p.name===discarder.name);
    let nextIdx = (discarderIdx+1)%room.players.length;
    if(room.players[nextIdx].name!==claimer.name) return;
    // 2. Harus tile suit, dan chowNums harus 2 angka yang + tile buangan = urut 3
    if(!chowNums || (chowNums.length!==2 && chowNums.length!==3)) return;
    if(chowNums.length===3) chowNums = chowNums.filter(n=>n!==tile.num);
    if(tile.type!=='suit') return;
    let all = [...chowNums, tile.num].sort((a,b)=>a-b);
    if(!(all[1]===all[0]+1 && all[2]===all[1]+1)) return;
  }
  let dIdx = discarder.discards.findIndex(t=>t.id===tile.id);
  if(dIdx>=0) discarder.discards.splice(dIdx,1);
  let need=[];
if(action==='kong'){
  let c = claimer.hand.filter(t=>t.key===tile.key).length;
  if(c<3) return;
}
if(action==='pong'){
  need = claimer.hand.filter(t=>t.key===tile.key).slice(0,2);
  if(need.length<2) return;
}
else if(action==='kong'){
  need = claimer.hand.filter(t=>t.key===tile.key).slice(0,3);
  if(need.length<3) return;
}
  else if(action==='chow' && chowNums){
    chowNums.forEach(n=>{
      if(n===tile.num) return;
      let found = claimer.hand.find(t=>t.type==='suit' && t.suit===tile.suit && t.num===n);
      if(found) need.push(found);
    });
    if(need.length<2) return;
  }
  need.forEach(t=>{ let i=claimer.hand.findIndex(x=>x.id===t.id); if(i>=0) claimer.hand.splice(i,1); });
  claimer.melds.push({ type:action, tiles:[tile, ...need], kongType: action==='kong' ? 'ming' : action });
  room.waitingClaim=false; room.lastDiscard=null; room.currentClaim=null;
  room.turnIdx = room.players.findIndex(p=>p.name===claimer.name);
  emitToRoom(room, 'meldMade', { by:claimer.name, meld:{type:action, tiles:[tile, ...need]}, players:publicPlayers(room) });
  room.lastMeldAt = Date.now();
  emitToRoom(room, 'claimed', { claimer:claimer.name, action, tiles:[tile, ...need], turn:claimer.name });
  emitToRoom(room, 'turnChanged', { turn:claimer.name, wallLeft:room.wall.length });
  room.players.forEach(p=>sendHand(room,p));
  addLog(room, `⚡ ${claimer.name} ${action.toUpperCase()} ${tileName(tile)} dari ${discarder.name}!`);
  // Tile ganti habis KONG
if(action==='kong' && room.wall.length>0){
  let rep = room.wall.pop();
  while(rep && rep.type==='flower'){ claimer.flowers.push(rep); if(room.wall.length===0) break; rep=room.wall.pop(); }
  if(rep) claimer.hand.push(rep);
  room.players.forEach(p2=>sendHand(room,p2));
}
 startTurnTimer(room);
  if(claimer.isBot){ setTimeout(()=>{ botDiscard(room, claimer); }, botThinkMs(claimer, 6500)); }
}
function advanceTurn(room, fromPlayer){
  if(!room || room.phase!=='playing') return;
  clearTurnTimer(room);
  let fromIdx = room.players.findIndex(p=>p.name===fromPlayer.name);
  if(fromIdx===-1) fromIdx = room.turnIdx;
  let nextIdx = (fromIdx+1)%room.players.length;
  room.turnIdx = nextIdx;
  let nextP = room.players[nextIdx];
  // ===== MODE PRO: cek hukuman spam klik buangan, potong di giliran berikutnya =====
  if(room.mode==='pro'){
    room.proPenaltyNext = room.proPenaltyNext || {};
    let potong = room.proPenaltyNext[nextP.name] || 0;
    if(potong>0){
      delete room.proPenaltyNext[nextP.name]; // hukuman udah dipake, jangan dipotong 2x
      room.proTurnSec = Math.max(3, 15 - potong); // minimal 3 detik, biar gak 0 detik, masih bisa main
      io.to(nextP.id).emit('proPenaltyApplied', { cut: potong, turnSec: room.proTurnSec });
      addLog(room, `⚠️ ${nextP.name} kena hukuman spam klik, giliran ini cuma ${room.proTurnSec} detik!`);
    } else {
      room.proTurnSec = 15; // gak kena hukuman, balik normal 15 detik
    }
  }
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
// BUKA KARTU: tangan akhir semua pemain (meld kebuka + sisa tangan + tile HU buat pemenang)
function buildFinalHands(room, winnerName, winningTile){
  return room.players.map(p=>{
    let full = [];
    (p.melds||[]).forEach(m=>{ (m.tiles||[]).forEach(t=>full.push(t)); });
    (p.hand||[]).forEach(t=>full.push(t));
    let isWinner = p.name===winnerName;
    if(isWinner && winningTile && !full.some(t=>t.id===winningTile.id)) full.push(winningTile);
    return { name: p.name, avatar: p.avatar||'🧑', isWinner: isWinner, isBot: !!p.isBot, hand: sortHand(full), winTileId: (isWinner && winningTile) ? winningTile.id : null };
  });
}
function endGameDraw(room){
  clearTurnTimer(room);
  room.phase='finished';
  emitToRoom(room, 'gameOver', { winner:null, message:'Tembok habis! Seri!', reason:'draw', msg:'Tembok habis! Seri!', finalHands: buildFinalHands(room, null, null) });
  addLog(room, '🏳️ Tembok habis, seri!');
}
function endGameWin(room, winnerName, msg, winningTile){
  clearTurnTimer(room); clearClaimTimer(room);
  room.phase='finished'; room.waitingClaim=false;
  let winner = room.players.find(p=>p.name===winnerName);
  // FIX HU 14 TILE: jangan cuma kirim winner.hand (sisa tangan, bisa cuma 4 tile kalau udah ada meld).
  // Full = semua meld PONG/CHOW yang udah kebuka + sisa tangan + tile HU (kalau HU dari buangan orang, tile itu belum masuk tangan).
  let fullHand = [];
  if(winner){
    (winner.melds||[]).forEach(m=>{ (m.tiles||[]).forEach(t=>fullHand.push(t)); });
    (winner.hand||[]).forEach(t=>fullHand.push(t));
    if(winningTile && !fullHand.some(t=>t.id===winningTile.id)) fullHand.push(winningTile);
  }
  // BARU: hitung berapa orang asli (bot gak dihitung) + HU dihitung apa engga
  let realCount = room.players.filter(p=>!p.isBot).length;
  let counted = ((room.mode==='tanding' || room.mode==='pro') && realCount===4);
  emitToRoom(room, 'gameOver', { winner:winnerName, message:msg, msg, hand: fullHand, melds: winner?winner.melds:[], winningTile: winningTile||null, mode: room.mode, playerCount: realCount, counted: counted, finalHands: buildFinalHands(room, winnerName, winningTile) });
  addLog(room, '🏆 '+msg);
    if(winner && !winner.isBot){
    // Cuma kalo counted, baru kasih token. Kalo latihan / gak full 4, gak dikasih token.
    let huToken = counted ? makeHuToken(room.code, winner.id, winner.userId || winner.name) : null;
    io.to(winner.id).emit('youHu', { mode: room.mode, playerCount: realCount, counted: counted, huToken: huToken });
  }
}

// ============ SOCKET.IO ============
io.on('connection', (socket)=>{
  console.log('User connected:', socket.id);
  // ----- TEMEN: DAFTAR ONLINE -----
  socket.on('registerOnline', async ({ id, display_name, avatar, authToken })=>{
  id = normId(id); if(!id) return;
  // FIX OFFLINE: status online jangan ditolak cuma karena token basi / server abis restart (authTokens di memori kehapus). Daftar online aja, token cuma buat validasi aksi sensitif.
  if(authToken){ let at = authTokens.get(authToken); if(at && at.exp>Date.now() && at.userId===id) socket.authToken=authToken; }
  socket.myUserId = id;
    onlineUsers.set(id, { socketId: socket.id, id, display_name: display_name||id, avatar: avatar||'🧑', roomCode: socket.myRoomCode||'' });
    broadcastOnline();
  });

  // ----- TEMEN: CARI PAKE NAMA / @ID -----
  socket.on('searchUser', async ({ q, myId })=>{
    q = String(q||'').trim().replace(/[%_\\]/g,''); myId = normId(myId);
    if(!q) return socket.emit('searchUserResult', []);
    // Cari di display_name ATAU id, biar ketik HANI / @hani1 sama-sama ketemu
    let { data } = await supabase.from('users').select('id, display_name, avatar, hu').or(`display_name.ilike.%${q}%,id.ilike.%${q}%`).limit(10);
    let list = (data||[]).filter(u=>u.id!==myId).map(u=>{
      let on = onlineUsers.get(u.id);
      return { id:u.id, display_name:u.display_name, avatar:u.avatar||'🧑', hu:u.hu||0, status: on ? (on.roomCode ? 'Di Meja' : 'Online') : 'Offline' };
    });
    socket.emit('searchUserResult', list);
  });

  // ----- TEMEN: KIRIM REQUEST -----
  socket.on('sendFriendRequest', async ({ fromId, toId })=>{
  if(socket.myUserId) fromId = socket.myUserId;
  fromId = normId(fromId); toId = normId(toId);
    if(!fromId || !toId || fromId===toId) return socket.emit('friendError', 'Gak bisa add diri sendiri!');
    let target = await getUserPublicById(toId);
    if(!target) return socket.emit('friendError', 'User @'+toId+' gak ketemu!');
    // Cek udah ada request / udah temenan belum (bolak-balik)
    let { data: ex } = await supabase.from('friends').select('*').or(`and(from_id.eq.${fromId},to_id.eq.${toId}),and(from_id.eq.${toId},to_id.eq.${fromId})`).maybeSingle();
    if(ex){
      if(ex.status==='accepted') return socket.emit('friendError', 'Udah temenan!');
      return socket.emit('friendError', 'Request udah dikirim, tinggal nunggu diterima!');
    }
    await supabase.from('friends').insert({ from_id: fromId, to_id: toId, status: 'pending' });
    let me = await getUserPublicById(fromId);
    // Kasih notif langsung ke yang dituju kalo dia lagi online
    let ts = getSocketByUserId(toId);
    if(ts) ts.emit('friendRequestIncoming', { from_id: fromId, display_name: me?.display_name||fromId, avatar: me?.avatar||'🧑' });
    socket.emit('friendOk', 'Request ke '+ (me ? '' : '') + (target.display_name||toId) + ' udah dikirim!');
    // Refresh list pending si tujuan biar langsung muncul
    if(ts) ts.emit('friendPending', await getPendingFor(toId));
  });

  // ----- TEMEN: TERIMA / TOLAK -----
  socket.on('respondFriendRequest', async ({ myId, fromId, accept })=>{
  if(socket.myUserId) myId = socket.myUserId;
  myId = normId(myId); fromId = normId(fromId);
    if(accept){
      await supabase.from('friends').update({ status:'accepted' }).eq('from_id', fromId).eq('to_id', myId).eq('status','pending');
    } else {
      await supabase.from('friends').delete().eq('from_id', fromId).eq('to_id', myId).eq('status','pending');
    }
    socket.emit('friendList', await getFriendsFor(myId));
    socket.emit('friendPending', await getPendingFor(myId));
    let other = getSocketByUserId(fromId);
    if(other){
      other.emit('friendList', await getFriendsFor(fromId));
      if(accept) other.emit('friendOk', 'Request lu diterima!');
      else other.emit('friendError', 'Request lu ditolak!');
    }
  });

  // ----- TEMEN: AMBIL LIST TEMEN + PENDING + ONLINE -----
  socket.on('getFriends', async ({ myId })=>{ if(socket.myUserId) myId=socket.myUserId; socket.emit('friendList', await getFriendsFor(myId)); });
  socket.on('getFriendPending', async ({ myId })=>{ if(socket.myUserId) myId=socket.myUserId; socket.emit('friendPending', await getPendingFor(myId)); });
  socket.on('getOnlineUsers', ()=>{ socket.emit('onlineUsersUpdated', getOnlineList()); });

  // ----- TEMEN: HAPUS TEMEN -----
  socket.on('removeFriend', async ({ myId, friendId })=>{
  if(socket.myUserId) myId = socket.myUserId;
  myId = normId(myId); friendId = normId(friendId);
    await supabase.from('friends').delete().or(`and(from_id.eq.${myId},to_id.eq.${friendId}),and(from_id.eq.${friendId},to_id.eq.${myId})`).eq('status','accepted');
    socket.emit('friendList', await getFriendsFor(myId));
    let other = getSocketByUserId(friendId);
    if(other) other.emit('friendList', await getFriendsFor(friendId));
  });

  // ----- TEMEN: UNDANG KE MEJA -----
  socket.on('inviteFriend', async ({ fromId, toId, code, roomName })=>{
    fromId = normId(fromId); toId = normId(toId);
    let me = await getUserPublicById(fromId);
    let ts = getSocketByUserId(toId);
    if(!ts) return socket.emit('friendError', 'Temen lu lagi offline!');
    ts.emit('friendInvite', { from_id: fromId, from_name: me?.display_name||fromId, avatar: me?.avatar||'🧑', code: code||'', roomName: roomName||'Meja' });
    socket.emit('friendOk', 'Undangan udah dikirim!');
  });

  // ----- TEMEN: CHAT PRIBADI 1 LAWAN 1 -----
  socket.on('privateChat', async ({ fromId, toId, msg })=>{
  if(socket.myUserId) fromId = socket.myUserId;
  fromId = normId(fromId); toId = normId(toId); msg = String(msg||'').trim().slice(0,500);
    if(!fromId || !toId || !msg) return;
    await supabase.from('private_messages').insert({ from_id: fromId, to_id: toId, msg });
    let payload = { from_id: fromId, to_id: toId, msg, created_at: new Date().toISOString() };
    let ts = getSocketByUserId(toId);
    if(ts) ts.emit('privateChatIncoming', payload);
    socket.emit('privateChatSent', payload);
  });
  socket.on('getPrivateChat', async ({ myId, friendId })=>{
  if(socket.myUserId) myId = socket.myUserId;
  myId = normId(myId); friendId = normId(friendId);
  if(socket.myUserId && socket.myUserId!==myId) return;
    let { data } = await supabase.from('private_messages').select('*').or(`and(from_id.eq.${myId},to_id.eq.${friendId}),and(from_id.eq.${friendId},to_id.eq.${myId})`).order('created_at', { ascending:true }).limit(100);
    socket.emit('privateChatHistory', { friendId, messages: data||[] });
  });
  socket.on('createRoom', ({ name, roomName, isPrivate, password, mode, avatar })=>{ let _uid = socket.myUserId||'';
  let code = genCode();
  let room = { code, players:[], wall:[], phase:'lobby', turnIdx:0, lastDiscard:null, waitingClaim:false, turnTimeSec: mode==='pro' ? 15 : 30, turnTimer:null, lastDice:null, passCount:0, passNeeded:0, passedNames:[], claimTimer:null, skin:'hijau',
    roomName: (roomName||'Meja '+(name||'Player')).trim(),
    isPrivate: !!isPrivate, password: isPrivate ? (password||'') : '',
    mode: mode==='tanding' ? 'tanding' : (mode==='pro' ? 'pro' : 'latihan'),
    hostName: (name||'Player').trim()
  };
    let host = { id:socket.id, name:(name||'Player').trim(), isBot:false, isHost:true, hand:[], melds:[], discards:[], flowers:[], level:'', avatar: avatar||'🧑', userId:_uid };
  room.players.push(host);
    rooms[code]=room; socket.join(code);
  if(socket.myUserId){ let u = onlineUsers.get(socket.myUserId); if(u){ u.roomCode = code; onlineUsers.set(socket.myUserId, u); } socket.myRoomCode = code; broadcastOnline(); }
  socket.emit('roomCreated', { code, players:publicPlayers(room) }); emitLobby(room);
  io.emit('roomListUpdated');
});

  socket.on('joinRoom', ({ name, code, password, avatar })=>{
    code = (code||'').toUpperCase().trim();
    let room = rooms[code];
    if(!room){ socket.emit('errorMsg', 'Room tidak ditemukan! Cek kode!'); return; }
    if(room.players.length>=4){ socket.emit('errorMsg', 'Room penuh!'); return; }
    if(room.phase==='playing'){ socket.emit('errorMsg', 'Game sudah mulai!'); return; }
    if(room.isPrivate && room.password!==(password||'')){ socket.emit('errorMsg','Password salah!'); return; }
      let cleanName = (name||'Player').trim() || 'Player';
       let oldP = room.players.find(x=>x.name===cleanName && !x.isBot);
       if(oldP && oldP.userId && socket.myUserId && oldP.userId!==socket.myUserId){ socket.emit('errorMsg','Kursi ini milik user lain!'); return; }
       if(oldP){
       if(oldP.disconnected){
        if(oldP.disconnectTimer){ clearTimeout(oldP.disconnectTimer); oldP.disconnectTimer = null; }
        oldP.id = socket.id;
        oldP.disconnected = false;
        oldP.disconnectedAt = null;
        if(avatar) oldP.avatar = avatar;
        socket.join(code);
        if(socket.myUserId){ let u = onlineUsers.get(socket.myUserId); if(u){ u.roomCode = code; onlineUsers.set(socket.myUserId, u); } socket.myRoomCode = code; broadcastOnline(); }
        socket.emit('rejoinedRoom', { code, phase: room.phase, players: publicPlayers(room) });
        emitLobby(room);
        if(room.phase==='playing') sendHand(room, oldP);
        return;
      }
      socket.emit('errorMsg','Nama udah dipake! Ganti nama lain!'); return;
    }
    let p = { id:socket.id, name:cleanName, isBot:false, isHost:false, hand:[], melds:[], discards:[], flowers:[], level:'', avatar: avatar || '🧑', userId: socket.myUserId||'' };
       room.players.push(p);
    socket.join(code);
    if(socket.myUserId){ let u = onlineUsers.get(socket.myUserId); if(u){ u.roomCode = code; onlineUsers.set(socket.myUserId, u); } socket.myRoomCode = code; broadcastOnline(); }
    socket.emit('joinedRoom', { code, players:publicPlayers(room) });
    emitLobby(room);
  });

  // FIX BUG 1: pake botName dari client, jangan bikin Bot Gampang lagi
  socket.on('addBot', ({ code, level, botName })=>{
  let room=rooms[(code||'').toUpperCase()]; if(!room) return;
  if(room.mode==='tanding' || room.mode==='pro') return socket.emit('errorMsg','Mode PRO gak bisa tambah BOT!');
  let me = room.players.find(p=>p.id===socket.id);
  if(!me || !me.isHost){ socket.emit('errorMsg','Cuma HOST yang bisa tambah BOT!'); return; }
  if(room.players.length>=4){ socket.emit('errorMsg', 'Sudah 4 pemain!'); return; }
    level = (level||'normal').toLowerCase();
  let base = (botName||'').trim() || ('BOT'+(room.players.filter(p=>p.isBot).length+1));
  let finalName = base; let n=2;
  while(room.players.some(p=>p.name===finalName)){ finalName = base+' '+n; n++; }
  let bot = { id:'bot-'+Date.now()+'-'+Math.random(), name:finalName, isBot:true, isHost:false, hand:[], melds:[], discards:[], flowers:[], level, avatar:'🤖' };
  room.players.push(bot);
  emitLobby(room);
  addLog(room, `🤖 ${bot.name} (${level.toUpperCase()} BOT) masuk!`);
});

socket.on('fillBots', ({ code, level })=>{
  let room = rooms[(code||'').toUpperCase()];
  if(!room) return;
  if(room.mode==='tanding' || room.mode==='pro') return socket.emit('errorMsg','Mode PRO gak bisa tambah BOT!');
  let me = room.players.find(p=>p.id===socket.id);
  if(me && !me.isHost){ socket.emit('errorMsg','Cuma HOST!'); return; }
  level = (level||'normal').toLowerCase();
  let fallbacks = ['ANDI','BUDI','SARI','DEWI','EKO','FITRI'];
  while(room.players.length < 4){
    let base = fallbacks.find(n=>!room.players.some(p=>p.name===n)) || ('BOT'+(room.players.length+1));
    let bot = { id:'bot-'+Date.now()+'-'+Math.random(), name:base, isBot:true, isHost:false, hand:[], melds:[], discards:[], flowers:[], level, avatar:'🤖' };
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
  socket.on('getRooms', ()=>{
  let list = Object.values(rooms).filter(r=>r.phase==='lobby' && r.players.some(p=>!p.isBot && !p.disconnected)).map(r=>({
    code:r.code,
    roomName:r.roomName,
    hostName:r.hostName,
    players:r.players.filter(p=>!p.isBot && !p.disconnected).length,
    isPrivate:!!r.isPrivate,
    mode:r.mode||'latihan'
  }));
  socket.emit('roomList', list);
});

  // FIX BUG 2: handler setting waktu giliran (HOST ONLY)
  socket.on('setTurnTime', ({ code, seconds })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
    let me = room.players.find(p=>p.id===socket.id);
    if(!me || !me.isHost){ socket.emit('errorMsg','Cuma HOST yang bisa ganti waktu!'); return; }
    if(room.mode==='pro'){ socket.emit('errorMsg','Mode PRO waktu dikunci 15 detik!'); return; }
    let sec = Number(seconds);
    if(isNaN(sec) || sec<0) sec = 30;
    if(sec!==0 && sec<5) sec = 5; // minimal 5 detik biar gak mustahil
    if(sec!==0 && sec>120) sec = 120;
    room.turnTimeSec = sec;
    emitToRoom(room, 'turnTimeUpdated', { seconds:sec });
    emitLobby(room);
    addLog(room, `⏱️ Waktu giliran diganti jadi ${sec===0?'Tanpa Batas':sec+' detik'}!`);
  });

  socket.on('setSkin', ({ code, skin })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
    let me = room.players.find(p=>p.id===socket.id);
    if(!me || !me.isHost){ socket.emit('errorMsg','Cuma HOST yang bisa ganti skin!'); return; }
    let ok = ['hijau','merah','biru','kayu'];
    if(!ok.includes(skin)) return;
    room.skin = skin;
    emitToRoom(room, 'skinUpdated', { skin });
    emitLobby(room);
    addLog(room, `🎨 Skin meja diganti jadi ${skin}!`);
  });

  socket.on('startGame', ({ code, turnTimeSec })=>{ if(turnTimeSec!==undefined){ turnTimeSec=Number(turnTimeSec); if(!Number.isFinite(turnTimeSec)||(turnTimeSec!==0&&(turnTimeSec<5||turnTimeSec>120))) turnTimeSec=30; }
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
    // FIX 5: cuma HOST yang bisa mulai
    let me = room.players.find(p=>p.id===socket.id);
    if(!me || !me.isHost){ socket.emit('errorMsg','Cuma HOST yang bisa mulai game!'); return; }
    if(room.mode==='pro' && room.players.length<4){ socket.emit('errorMsg','Mode PRO wajib 4 pemain baru bisa mulai!'); return; }
if(room.mode==='pro' && room.players.some(p=>p.isBot)){ socket.emit('errorMsg','Mode PRO gak boleh ada BOT!'); return; }
if(room.mode==='pro') turnTimeSec = 15;
if(room.players.length<2){ socket.emit('errorMsg', 'Minimal 2 pemain buat mulai! Tambah bot!'); return; }
    startGame(room, turnTimeSec);
  });

   socket.on('playAgain', ({ code })=>{ socket.emit('errorMsg','Pake tombol Rematch, bukan Play Again!'); });
  socket.on('rematch', ({ code })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
    let me = room.players.find(p=>p.id===socket.id);
    if(!me || me.isBot) return;
    if(!room.rematchVotes) room.rematchVotes = [];
    if(!room.rematchVotes.includes(me.name)) room.rematchVotes.push(me.name);
    let humans = room.players.filter(p=>!p.isBot && !p.disconnected);
    let count = room.rematchVotes.filter(n=>humans.some(p=>p.name===n)).length;
    emitToRoom(room, 'rematchUpdate', { count, total: humans.length, voters: room.rematchVotes });
    if(count >= humans.length && humans.length>0){
      room.rematchVotes = [];
      room.phase='lobby';
      room.players.forEach(p=>{ p.hand=[]; p.melds=[]; p.discards=[]; p.flowers=[]; });
      // Langsung mulai lagi, gak balik lobby, pemain sama persis
      startGame(room, room.turnTimeSec);
    }
  });
  socket.on('cancelRematch', ({ code })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
    room.rematchVotes = [];
    emitToRoom(room, 'rematchUpdate', { count: 0, total: room.players.filter(p=>!p.isBot).length, voters: [] });
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
    emitToRoom(room, 'discarded', { from:p.name, tile, tileName:tileName(tile), wallLeft:room.wall.length, players:publicPlayers(room), claims: getClaimsFor(room, tile, p.name), claimTimeSec: room.turnTimeSec||0 });
    emitToRoom(room, 'playerDiscarded', { player:p.name, tile, wallLeft:room.wall.length });
    room.players.forEach(x=>sendHand(room,x));
    handleAfterDiscard(room, p, tile);
  });
  // ===== MODE PRO TAHAP 2: klik tile buangan -> cek bisa claim apa engga =====
  socket.on('proCheckClaim', ({ code })=>{
    let room = rooms[(code||'').toUpperCase()];
    if(!room || room.phase!=='playing') return;
    if(room.mode!=='pro') return;
    if(!room.waitingClaim || !room.currentClaim) return socket.emit('proClaimDenied', { reason:'expired', msg:'Buangan udah hangus, udah lewat 7 detik!' });
    let p = room.players.find(x=>x.id===socket.id);
    if(!p) return;
    let { tile, from } = room.currentClaim;
    if(p.name===from) return socket.emit('proClaimDenied', { reason:'own', msg:'Itu buangan lu sendiri, gak bisa diambil!' });
    // Cek claim KHUSUS buat pemain ini aja, bukan semua orang
    let all = getClaimsFor(room, tile, from);
    let mine = all.find(c=>c.name===p.name);
    if(!mine){
      // ===== GAK BISA = LANGSUNG KENA HUKUMAN -2 DETIK GILIRAN BERIKUTNYA, 1x aja =====
      room.proPenaltyNext = room.proPenaltyNext || {};
      room.proPenaltyNext[p.name] = (room.proPenaltyNext[p.name] || 0) + 2;
      socket.emit('proClaimDenied', { reason:'cant', msg:'❌ Tile ini gak bisa diambil! Giliran berikutnya -2 detik!', cut: 2, totalCut: room.proPenaltyNext[p.name] });
      return;
    }
    // Bisa -> kirim pilihan ke pemain ini aja, jangan ke semua orang
    socket.emit('proClaimOptions', { tile, from, claim: mine });
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
      // Kalau semua manusia yang BISA claim udah PASS -> langsung putusin detik itu juga, gak nunggu sisa waktu giliran
      if((room.passCount||0) >= (room.passNeeded||0)){
        // resolveClaimTimeout udah ngurus: BOT HU/PONG/CHOW langsung claim, kalau gak ada langsung next
        resolveClaimTimeout(room, discarder, tile);
      }
      return;
    }
    if(action==='hu'){ doClaim(room, p, 'hu', null, tile, discarder); return; }
    if(action==='chow'){
      // ATURAN REAL: CHOW cuma dari pemain sebelumnya (yang baru buang)
      let discarderIdx = room.players.findIndex(x=>x.name===from);
      let nextIdx = (discarderIdx+1)%room.players.length;
      if(room.players[nextIdx].name!==p.name) return;
      // chowNums harus 2 angka, dan bareng tile buangan harus jadi urut 3
      if(!chowNums || (chowNums.length!==2 && chowNums.length!==3)) return;
      if(chowNums.length===3) chowNums = chowNums.filter(n=>n!==tile.num);
      let all = [...chowNums, tile.num].sort((a,b)=>a-b);
      if(!(all[1]===all[0]+1 && all[2]===all[1]+1)) return;
    }
    if(action==='pong'){
      let c = p.hand.filter(t=>t.key===tile.key).length;
      if(c<2) return;
    }
    doClaim(room, p, action, chowNums, tile, discarder);
  });

  socket.on('selfHu', ({code})=>{
  let room = rooms[(code||'').toUpperCase()];
  if(!room || room.phase!=='playing') return;
  let p = room.players.find(x=>x.id===socket.id);
  if(!p) return;
  if(room.waitingClaim) return;
  if(room.players[room.turnIdx].name!==p.name) return;
  if(canHuWithMelds(p.hand, p.melds)){ endGameWin(room, p.name, `${p.name} SELF HU!`, null); return; }
  // ===== MODE PRO: HU palsu = langsung kena -3 detik giliran sekarang =====
  if(room.mode==='pro'){
    applyProFakeHuPenalty(room, p);
    return;
  }
  // ===== LATIHAN / TANDING: cara lama, jangan diubah =====
  socket.emit('errorMsg', 'Server bilang BUKAN HU...');
});
  // An Kong: 4 sama di tangan sendiri habis draw
socket.on('anKong', ({ code, tileKey })=>{
  let _r = rooms[(code||'').toUpperCase()]; if(_r && _r.waitingClaim) return;
  let room = rooms[(code||'').toUpperCase()];
  if(!room || room.phase!=='playing') return;
  let p = room.players.find(x=>x.id===socket.id);
  if(!p) return;
  if(room.players[room.turnIdx].name!==p.name) return;
  let four = p.hand.filter(t=>t.key===tileKey).slice(0,4);
  if(four.length<4) return;
  four.forEach(t=>{ let i=p.hand.findIndex(x=>x.id===t.id); if(i>=0) p.hand.splice(i,1); });
  p.melds.push({ type:'kong', tiles:four, kongType:'an', concealed:true });
  // Tile ganti
  if(room.wall.length>0){ let rep=room.wall.pop(); while(rep && rep.type==='flower'){ p.flowers.push(rep); if(room.wall.length===0) break; rep=room.wall.pop(); } if(rep) p.hand.push(rep); }
  emitToRoom(room, 'meldMade', { by:p.name, meld:{type:'kong', tiles:four}, players:publicPlayers(room) });
  room.players.forEach(x=>sendHand(room,x));
});

// Jia Kong: PONG yang udah kebuka + dapet tile ke-4 pas draw
socket.on('jiaKong', ({ code, tileId })=>{
  let _r2 = rooms[(code||'').toUpperCase()]; if(_r2 && _r2.waitingClaim) return;
  let room = rooms[(code||'').toUpperCase()];
  if(!room || room.phase!=='playing') return;
  let p = room.players.find(x=>x.id===socket.id);
  if(!p) return;
  if(room.players[room.turnIdx].name!==p.name) return;
  let tile = p.hand.find(t=>t.id==tileId);
  if(!tile) return;
  let meld = p.melds.find(m=>m.type==='pong' && m.tiles[0].key===tile.key);
  if(!meld) return;
  let i=p.hand.findIndex(x=>x.id===tile.id); p.hand.splice(i,1);
  meld.tiles.push(tile); meld.type='kong'; meld.kongType='jia';
  if(room.wall.length>0){ let rep=room.wall.pop(); while(rep && rep.type==='flower'){ p.flowers.push(rep); if(room.wall.length===0) break; rep=room.wall.pop(); } if(rep) p.hand.push(rep); }
  emitToRoom(room, 'meldMade', { by:p.name, meld:{type:'kong', tiles:meld.tiles}, players:publicPlayers(room) });
  room.players.forEach(x=>sendHand(room,x));
});
  socket.on('tableChat', ({ code, msg })=>{
    msg = String(msg||'').trim().slice(0,500); if(!msg) return;
    let room = rooms[(code||'').toUpperCase()];
    if(!room) return;
    let p = room.players.find(x=>x.id===socket.id);
    let sender = p ? p.name : 'Player';
    let payload = { sender, name:sender, msg, time: new Date().toLocaleTimeString('id-ID',{timeZone:'Asia/Jakarta',hour:'2-digit',minute:'2-digit'}) };
    emitToRoom(room, 'chatMsg', payload);
    emitToRoom(room, 'tableChatMsg', payload);
  });
  socket.on('leaveRoom', ({ code })=>{
    code = (code||'').toUpperCase().trim();
    let room = rooms[code]; if(!room) return;
    let idx = room.players.findIndex(p=>p.id===socket.id);
    if(idx>=0){
      let left = room.players[idx];
      room.players.splice(idx,1);
      socket.leave(code);
      if(room.players.length===0){
        clearTurnTimer(room);
        delete rooms[code];
            } else {
        // Kalau udah gak ada manusia, hapus meja + semua BOT-nya, jangan ditinggal zombie
        let humansLeft = room.players.filter(p=>!p.isBot);
        if(humansLeft.length===0){
          clearTurnTimer(room);
          delete rooms[code];
          io.emit('roomListUpdated');
          return;
        }
        // Kalau host keluar, oper ke MANUSIA pertama, JANGAN ke BOT
        if(left.isHost) humansLeft[0].isHost = true;
        emitLobby(room);
        addLog(room, `👋 ${left.name} keluar!`);
        if(room.phase==='playing'){
          if(room.turnIdx >= room.players.length) room.turnIdx = 0;
        }
      }
      io.emit('roomListUpdated');
    }
  });
      socket.on('rejoinRoom', ({ name, code, avatar })=>{
    code = (code||'').toUpperCase().trim();
    let room = rooms[code]; if(!room) return socket.emit('rejoinFailed', 'Meja udah bubar!');
    let cleanName = (name||'').trim();
    // Cari pemain lama yang namanya sama, gak peduli masih putus atau belum ke-detect putus
    let p = room.players.find(x=>x.name===cleanName && !x.isBot);
    if(!p) return socket.emit('rejoinFailed', 'Kursi kamu udah diambil orang / udah kehapus!');
    // Balikin kursi: ganti socket.id lama ke yang baru
    if(p.disconnectTimer){ clearTimeout(p.disconnectTimer); p.disconnectTimer = null; }
    p.id = socket.id;
    p.disconnected = false;
    p.disconnectedAt = null;
    if(avatar) p.avatar = avatar;
        socket.join(code);
    // FIX OFFLINE PAS MAIN: rejoin harus daftarin online lagi, jangan cuma balikin kursi. Kalo gak, dia main tapi di daftar temen tetep Offline.
    if(socket.myUserId){
      let u = onlineUsers.get(socket.myUserId);
      if(u){ u.socketId = socket.id; u.roomCode = code; onlineUsers.set(socket.myUserId, u); }
      else { onlineUsers.set(socket.myUserId, { socketId: socket.id, id: socket.myUserId, display_name: cleanName, avatar: avatar||'🧑', roomCode: code }); }
      socket.myRoomCode = code;
      broadcastOnline();
    }
    socket.emit('rejoinedRoom', { code, phase: room.phase, players: publicPlayers(room) });
    emitLobby(room);
    // Kalau lagi main, kirim lagi tangan dia + kasih tau lagi giliran siapa
    if(room.phase==='playing'){
      sendHand(room, p);
      socket.emit('turnChanged', { turn: room.players[room.turnIdx]?.name, wallLeft: room.wall.length });
      socket.emit('playerDrew', { player: p.name, wallLeft: room.wall.length });
    }
    addLog(room, `🔄 ${p.name} nyambung lagi!`);
    io.emit('roomListUpdated');
  });
   socket.on('disconnect', ()=>{
   if(socket.myUserId){ onlineUsers.delete(socket.myUserId); broadcastOnline(); }
   for(let code in rooms){
       let room = rooms[code];
       let p = room.players.find(x=>x.id===socket.id);
      if(!p) continue;
      // JANGAN langsung hapus. Tandain putus, kasih 120 detik buat balik.
      p.disconnected = true;
      p.disconnectedAt = Date.now();
      addLog(room, `📶 ${p.name} putus... nunggu 120 detik buat balik!`);
      emitLobby(room);
      // Kalau 120 detik gak balik, baru beneran hapus
      p.disconnectTimer = setTimeout(()=>{
        // JANGAN hapus kursi kalau game lagi jalan - biar bisa balik kapanpun
        if(room.phase==='playing') return;
        let idx = room.players.findIndex(x=>x.name===p.name && x.disconnected);
        if(idx<0) return;
        let left = room.players[idx];
        room.players.splice(idx,1);
        if(room.players.length===0){
          clearTurnTimer(room);
          delete rooms[code];
        } else {
          let humansLeft = room.players.filter(p=>!p.isBot);
          if(humansLeft.length===0){
            clearTurnTimer(room);
            delete rooms[code];
            io.emit('roomListUpdated');
            return;
          }
          if(left.isHost) humansLeft[0].isHost = true;
          emitLobby(room);
          addLog(room, `👋 ${left.name} keluar! (gak balik 120 detik)`);
          if(room.phase==='playing'){
            if(room.turnIdx >= room.players.length) room.turnIdx = 0;
            if(room.players[room.turnIdx] && room.players[room.turnIdx].name===left.name){
              advanceTurn(room, left);
            }
          }
        }
        io.emit('roomListUpdated');
      }, 120000);
      break;
    }
  });
});
// SAPU MEJA ZOMBIE TIAP 10 DETIK: kalau udah gak ada manusia aktif, hapus meja + BOT-nya
setInterval(()=>{
  let changed = false;
  for(let code in rooms){
    let room = rooms[code];
    if(!room) continue;
    let humans = room.players.filter(p=>!p.isBot);
    let activeHumans = humans.filter(p=>!p.disconnected);
    if(humans.length===0){
      clearTurnTimer(room);
      delete rooms[code];
      changed = true;
      continue;
    }
    if(room.phase==='playing' && humans.length>0 && activeHumans.length===0){
  let allOldPlaying = humans.every(p=>p.disconnectedAt && (Date.now() - p.disconnectedAt > 600000));
  if(allOldPlaying){ clearTurnTimer(room); delete rooms[code]; changed=true; continue; }
}
        if(room.phase!=='playing' && activeHumans.length===0 && humans.length>0){
      let allOld = humans.every(p=>p.disconnectedAt && (Date.now() - p.disconnectedAt > 120000));
      if(allOld){
        clearTurnTimer(room);
        delete rooms[code];
        changed = true;
      }
    }
  }
  if(changed) io.emit('roomListUpdated');
}, 10000);
server.listen(PORT, ()=>{ console.log(`🀄 MAHJONG ONLINE + BOT di port ${PORT}`); });


