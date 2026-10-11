'use strict';
/*
  SISCO multiplayer server.
  No npm install needed. Just: node server.js
  Uses only Node.js built-ins (needs Node 16 or newer).
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 5;
const LETTERS = ['S', 'I', 'S', 'C', 'O'];
const LINES = [];
for (let r = 0; r < 5; r++) LINES.push([0, 1, 2, 3, 4].map(c => r * 5 + c));
for (let c = 0; c < 5; c++) LINES.push([0, 1, 2, 3, 4].map(r => r * 5 + c));
LINES.push([0, 6, 12, 18, 24], [4, 8, 12, 16, 20]);

const rooms = new Map();

/* ---------- accounts (saved to data/users.json) ---------- */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
let db = { users: {}, sessions: {} };
try { db = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) { /* first run */ }
db.users = db.users || {}; db.sessions = db.sessions || {};
/* Optional cloud storage so accounts survive on hosts that wipe files (set both env variables to turn on). */
const REMOTE_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const REMOTE_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REMOTE_KEY = 'sisco-db';
let remoteWritable = false;
async function remoteCmd(cmd) {
  const r = await fetch(REMOTE_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + REMOTE_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return (await r.json()).result;
}
async function loadRemote() {
  if (!REMOTE_URL || !REMOTE_TOKEN) return;
  for (let i = 0; i < 3; i++) {
    try {
      const v = await remoteCmd(['GET', REMOTE_KEY]);
      if (v) { const d = JSON.parse(v); db = { users: d.users || {}, sessions: d.sessions || {} }; }
      remoteWritable = true;
      console.log('  Accounts are stored in cloud storage.');
      return;
    } catch (e) { console.error('  Cloud storage load failed (' + e.message + '), attempt ' + (i + 1)); await new Promise(r => setTimeout(r, 1000)); }
  }
  console.error('  WARNING: cloud storage unavailable. Accounts will only be kept on this server disk.');
}
let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (remoteWritable) remoteCmd(['SET', REMOTE_KEY, JSON.stringify(db)]).catch(e => console.error('Cloud save failed:', e.message));
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(USERS_FILE + '.tmp', JSON.stringify(db));
      fs.renameSync(USERS_FILE + '.tmp', USERS_FILE);
    } catch (e) { console.error('Could not save accounts:', e.message); }
  }, 300);
}
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const publicUser = u => ({ name: u.name, wins: u.wins, played: u.played });
const userFromToken = t => { const k = t && db.sessions[t]; return k && db.users[k] ? { key: k, user: db.users[k] } : null; };
const attempts = new Map();
function throttle(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  if (list.length >= 12) throw new HttpErr(429, 'Too many attempts. Try again in a few minutes.');
  list.push(now); attempts.set(ip, list);
}

/* ---------- helpers ---------- */
class HttpErr extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const rid = n => crypto.randomBytes(n).toString('hex');
function newCode() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = ''; for (let i = 0; i < 4; i++) c += a[crypto.randomInt(a.length)]; } while (rooms.has(c));
  return c;
}
function shuffled() {
  const a = []; for (let i = 1; i <= 25; i++) a.push(i);
  for (let j = 24; j > 0; j--) { const k = Math.floor(Math.random() * (j + 1)); [a[j], a[k]] = [a[k], a[j]]; }
  return a;
}
const lineCount = p => LINES.filter(l => l.every(i => p.crossed[i])).length;
const cleanName = s => String(s || '').replace(/[<>&"']/g, '').trim().slice(0, 14);

function makePlayer(name, bot, level, userKey) {
  return { id: rid(4), token: rid(16), name, bot: !!bot, level: bot ? (level || 'medium') : null, userKey: userKey || null, board: null, crossed: new Array(25).fill(false), ready: false, connected: false, discAt: 0, voice: false, muted: false, inbox: [] };
}
function uniqueName(room, base) {
  let name = base || 'Player', n = 2;
  while (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) name = (base || 'Player') + ' ' + n++;
  return name;
}

/* ---------- state ---------- */
function view(room, pid) {
  const me = room.players.find(p => p.id === pid);
  const cur = room.players[room.turn];
  return {
    code: room.code, v: room.version || 0, rounds: room.rounds, round: room.round, scores: room.scores, seriesOver: room.seriesOver, champions: room.champions, phase: room.phase, hostId: room.hostId, you: pid,
    turn: room.turn, turnId: cur ? cur.id : null,
    players: room.players.map(p => ({ id: p.id, name: p.name, bot: p.bot, level: p.level, member: !!p.userKey, voice: !!p.voice, muted: !!p.muted, connected: p.bot || p.connected, ready: p.ready, lines: lineCount(p) })),
    board: me ? me.board : null, crossed: me ? me.crossed : null,
    called: room.called, last: room.last, lastBy: room.lastBy, notes: room.notes,
    winners: room.winners, fresh: room.fresh
  };
}
function send(s, room) {
  try { s.res.write('event: state\ndata: ' + JSON.stringify(view(room, s.pid)) + '\n\n'); } catch (e) { /* closed */ }
}
function broadcast(room) {
  room.updated = Date.now(); room.version = (room.version || 0) + 1;
  room.streams.forEach(s => send(s, room));
}

/* ---------- game logic ---------- */
function startPlay(room) {
  room.phase = 'play'; room.turn = 0; room.called = []; room.last = null; room.lastBy = null; room.notes = []; room.fresh = {}; room.winners = [];
  afterTurn(room);
}
function afterTurn(room) {
  clearTimeout(room.botTimer);
  if (room.phase !== 'play') return;
  const cur = room.players[room.turn];
  if (cur && cur.bot) {
    const idx = room.turn;
    room.botTimer = setTimeout(() => {
      if (room.phase === 'play' && room.turn === idx) doCall(room, idx, cpuPick(room.players[idx]));
    }, 1100 + Math.floor(Math.random() * 700));
  }
}
function cpuPick(p) {
  if (p.level === 'easy') return randomUncrossed(p);
  let best = -1, pool = [];
  for (let i = 0; i < 25; i++) {
    if (p.crossed[i]) continue;
    let score = 0;
    LINES.forEach(l => {
      if (!l.includes(i)) return;
      const k = l.filter(j => p.crossed[j]).length;
      score += p.level === 'hard' ? Math.pow(6, k) : k;
    });
    if (score > best) { best = score; pool = [i]; } else if (score === best) pool.push(i);
  }
  return p.board[pool[Math.floor(Math.random() * pool.length)]];
}
function randomUncrossed(p) {
  const opts = []; for (let i = 0; i < 25; i++) if (!p.crossed[i]) opts.push(p.board[i]);
  return opts[Math.floor(Math.random() * opts.length)];
}
function doCall(room, idx, n) {
  if (room.phase !== 'play' || room.called.includes(n)) return;
  const caller = room.players[idx];
  const before = room.players.map(lineCount);
  room.called.push(n); room.last = n; room.lastBy = caller.id; room.fresh = {};
  room.players.forEach(p => { const i = p.board.indexOf(n); if (i > -1) p.crossed[i] = true; });
  const notes = [];
  room.players.forEach((p, i) => {
    const after = lineCount(p);
    const from = Math.min(before[i], 5), to = Math.min(after, 5);
    if (to > from) { room.fresh[p.id] = { from, to }; notes.push(p.name + ' unlocked ' + LETTERS.slice(from, to).join(' ')); }
  });
  room.notes = notes;
  const winners = room.players.filter(p => lineCount(p) >= 5).map(p => p.id);
  if (winners.length) { room.winners = winners; room.phase = 'end'; clearTimeout(room.botTimer); recordStats(room);
    winners.forEach(id => { room.scores[id] = (room.scores[id] || 0) + 1; });
    if (room.round >= room.rounds) {
      room.seriesOver = true;
      const max = Math.max(...room.players.map(p => room.scores[p.id] || 0));
      room.champions = room.players.filter(p => (room.scores[p.id] || 0) === max).map(p => p.id);
    }
  }
  else { room.turn = (room.turn + 1) % room.players.length; afterTurn(room); }
  broadcast(room);
}
function recordStats(room) {
  room.players.forEach(p => {
    const u = p.userKey && db.users[p.userKey];
    if (!u) return;
    u.played++; if (room.winners.includes(p.id)) u.wins++;
  });
  saveDb();
}
function beginPlacement(room) {
  room.phase = 'place'; room.winners = []; room.called = []; room.last = null; room.notes = []; room.fresh = {};
  room.players.forEach(p => { p.crossed = new Array(25).fill(false); p.board = p.bot ? shuffled() : null; p.ready = p.bot; });
}
const LEVELS = ['easy', 'medium', 'hard'];
function validBoard(b) {
  if (!Array.isArray(b) || b.length !== 25) return false;
  const seen = new Set();
  for (const v of b) { if (!Number.isInteger(v) || v < 1 || v > 25 || seen.has(v)) return false; seen.add(v); }
  return true;
}

/* ---------- API ---------- */
function getRoom(code) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) throw new HttpErr(404, 'Room not found. Check the code.');
  return room;
}
function auth(room, pid, token) {
  const p = room.players.find(x => x.id === pid && x.token === token);
  if (!p) throw new HttpErr(401, 'You are not in this room.');
  return p;
}
function who(b) {
  const a = userFromToken(b.auth);
  return a ? { name: a.user.name, key: a.key } : { name: cleanName(b.name), key: null };
}
function makeRoom(b) {
  const w = who(b);
  const room = { code: newCode(), rounds: 1, round: 1, scores: {}, seriesOver: false, champions: [], phase: 'lobby', players: [], hostId: null, turn: 0, called: [], last: null, lastBy: null, notes: [], winners: [], fresh: {}, streams: new Set(), botTimer: null, updated: Date.now() };
  const host = makePlayer(uniqueName(room, w.name || 'Host'), false, null, w.key);
  room.players.push(host); room.hostId = host.id;
  rooms.set(room.code, room);
  return { room, host };
}

const handlers = {
  register(b, ctx) {
    throttle(ctx.ip);
    const username = String(b.username || '').trim();
    const pw = String(b.password || '');
    if (!/^[A-Za-z0-9_]{3,14}$/.test(username)) throw new HttpErr(400, 'Username: 3 to 14 letters, numbers or underscore.');
    if (pw.length < 6 || pw.length > 64) throw new HttpErr(400, 'Password must be 6 to 64 characters.');
    const key = username.toLowerCase();
    if (db.users[key]) throw new HttpErr(409, 'That username is taken.');
    const salt = rid(16);
    db.users[key] = { name: username, salt, hash: hashPw(pw, salt), wins: 0, played: 0, created: Date.now() };
    const token = rid(24); db.sessions[token] = key; saveDb();
    return { token, user: publicUser(db.users[key]) };
  },
  login(b, ctx) {
    throttle(ctx.ip);
    const key = String(b.username || '').trim().toLowerCase();
    const u = db.users[key];
    const pw = String(b.password || '');
    if (!u) throw new HttpErr(401, 'Wrong username or password.');
    const a = Buffer.from(hashPw(pw, u.salt), 'hex'), h = Buffer.from(u.hash, 'hex');
    if (a.length !== h.length || !crypto.timingSafeEqual(a, h)) throw new HttpErr(401, 'Wrong username or password.');
    const token = rid(24); db.sessions[token] = key; saveDb();
    return { token, user: publicUser(u) };
  },
  state(b) {
    const room = getRoom(b.room); const p = auth(room, b.pid, b.token);
    p.lastSeen = Date.now();
    if (!p.connected) { p.connected = true; broadcast(room); }
    if (b.v === room.version) return { same: true };
    return view(room, p.id);
  },
  ice() {
    const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
    const turn = (process.env.TURN_URLS || '').split(',').map(x => x.trim()).filter(Boolean);
    if (turn.length) servers.push({ urls: turn, username: process.env.TURN_USERNAME || '', credential: process.env.TURN_CREDENTIAL || '' });
    return { iceServers: servers };
  },
  signal(b) {
    const room = getRoom(b.room); const me = auth(room, b.pid, b.token);
    const to = room.players.find(p => p.id === b.to && !p.bot);
    if (!to || !me.voice || !to.voice) return { ok: false };
    if (to.inbox.length < 300) to.inbox.push({ from: me.id, data: b.data });
    return { ok: true };
  },
  signals(b) {
    const room = getRoom(b.room); const me = auth(room, b.pid, b.token);
    me.lastSeen = Date.now();
    return { items: me.inbox.splice(0) };
  },
  leaderboard() {
    const top = Object.values(db.users).filter(u => u.played > 0)
      .sort((a, b) => b.wins - a.wins || (b.wins / b.played) - (a.wins / a.played) || b.played - a.played)
      .slice(0, 10).map(u => ({ name: u.name, wins: u.wins, played: u.played }));
    return { top };
  },
  me(b) {
    const a = userFromToken(b.auth);
    if (!a) throw new HttpErr(401, 'Please log in again.');
    return { user: publicUser(a.user) };
  },
  logout(b) {
    if (b.auth && db.sessions[b.auth]) { delete db.sessions[b.auth]; saveDb(); }
    return { ok: true };
  },
  create(b) {
    const { room, host } = makeRoom(b);
    if (b.solo) {
      const n = Math.min(4, Math.max(1, parseInt(b.bots, 10) || 1));
      const level = LEVELS.includes(b.level) ? b.level : 'medium';
      for (let i = 0; i < n; i++) room.players.push(makePlayer(uniqueName(room, i === 0 ? 'Claude' : 'Computer'), true, level));
      beginPlacement(room);
    }
    return { room: room.code, pid: host.id, token: host.token };
  },
  join(b) {
    const room = getRoom(b.room);
    if (room.phase !== 'lobby') throw new HttpErr(400, 'That game has already started.');
    if (room.players.length >= MAX_PLAYERS) throw new HttpErr(400, 'Room is full (5 players max).');
    const w = who(b);
    const p = makePlayer(uniqueName(room, w.name || 'Player'), false, null, w.key);
    room.players.push(p); broadcast(room);
    return { room: room.code, pid: p.id, token: p.token };
  },
  rejoin(b) {
    const room = getRoom(b.room); auth(room, b.pid, b.token);
    return { ok: true };
  },
  action(b) {
    const room = getRoom(b.room); const me = auth(room, b.pid, b.token);
    const isHost = room.hostId === me.id;
    switch (b.type) {
      case 'addBot': {
        if (!isHost || room.phase !== 'lobby') throw new HttpErr(403, 'Only the host can add players in the lobby.');
        if (room.players.length >= MAX_PLAYERS) throw new HttpErr(400, 'Room is full.');
        const base = room.players.some(p => p.name === 'Claude') ? 'Computer' : 'Claude';
        room.players.push(makePlayer(uniqueName(room, base), true, LEVELS.includes(b.level) ? b.level : 'medium'));
        break;
      }
      case 'remove': {
        if (!isHost || room.phase !== 'lobby') throw new HttpErr(403, 'Only the host can remove players in the lobby.');
        const i = room.players.findIndex(p => p.id === b.target);
        if (i < 0 || room.players[i].id === me.id) throw new HttpErr(400, 'Cannot remove that player.');
        const gone = room.players.splice(i, 1)[0];
        room.streams.forEach(s => { if (s.pid === gone.id) { try { s.res.write('event: kicked\ndata: {}\n\n'); s.res.end(); } catch (e) {} } });
        break;
      }
      case 'setRounds': {
        if (!isHost || room.phase !== 'lobby') throw new HttpErr(403, 'Only the host can change the rounds.');
        const n = parseInt(b.rounds, 10);
        if (!(n >= 1 && n <= 10)) throw new HttpErr(400, 'Rounds must be 1 to 10.');
        room.rounds = n;
        break;
      }
      case 'start': {
        if (!isHost || room.phase !== 'lobby') throw new HttpErr(403, 'Only the host can start the game.');
        if (room.players.length < 2) throw new HttpErr(400, 'Need at least 2 players.');
        room.round = 1; room.scores = {}; room.seriesOver = false; room.champions = [];
        beginPlacement(room);
        break;
      }
      case 'submitBoard': {
        if (room.phase !== 'place') throw new HttpErr(400, 'Not in the arranging stage.');
        if (!validBoard(b.board)) throw new HttpErr(400, 'Grid must contain each number 1 to 25 exactly once.');
        me.board = b.board.slice(); me.ready = true;
        if (room.players.every(p => p.ready)) startPlay(room);
        break;
      }
      case 'call': {
        if (room.phase !== 'play') throw new HttpErr(400, 'Game is not in progress.');
        if (room.players[room.turn].id !== me.id) throw new HttpErr(400, 'Not your turn.');
        const n = Number(b.n);
        const i = me.board.indexOf(n);
        if (i < 0 || me.crossed[i]) throw new HttpErr(400, 'Pick a number that is not crossed out.');
        doCall(room, room.turn, n);
        return { ok: true };
      }
      case 'next': {
        const hostP = room.players.find(p => p.id === room.hostId);
        if (!(isHost || !hostP || !hostP.connected) || room.phase !== 'end' || room.seriesOver) throw new HttpErr(403, 'Only the host can start the next round.');
        room.round++;
        beginPlacement(room);
        break;
      }
      case 'voice': {
        const on = !!b.on;
        if (on !== me.voice) me.inbox = [];
        me.voice = on; me.muted = on && !!b.muted;
        break;
      }
      case 'again': {
        const hostP = room.players.find(p => p.id === room.hostId);
        if (!(isHost || !hostP || !hostP.connected) || room.phase !== 'end' || !room.seriesOver) throw new HttpErr(403, 'Only the host can reset after the match.');
        room.round = 1; room.scores = {}; room.seriesOver = false; room.champions = [];
        room.phase = 'lobby'; clearTimeout(room.botTimer);
        room.players = room.players.filter(p => p.bot || p.connected || p.id === me.id);
        room.players.forEach(p => { p.board = null; p.ready = false; p.crossed = new Array(25).fill(false); });
        room.called = []; room.last = null; room.notes = []; room.winners = []; room.fresh = {}; room.turn = 0;
        break;
      }
      case 'leave': {
        if (room.phase === 'lobby') {
          room.players = room.players.filter(p => p.id !== me.id);
          if (room.hostId === me.id) {
            const next = room.players.find(p => !p.bot);
            if (next) room.hostId = next.id; else { rooms.delete(room.code); room.streams.forEach(s => { try { s.res.end(); } catch (e) {} }); return { ok: true }; }
          }
        }
        break;
      }
      default: throw new HttpErr(400, 'Unknown action.');
    }
    broadcast(room);
    return { ok: true };
  }
};

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/icon-maskable-512.png': ['icon-maskable-512.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png']
};

function lanUrls() {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(k => ifs[k].forEach(a => { if (a.family === 'IPv4' && !a.internal) out.push('http://' + a.address + ':' + PORT); }));
  return out;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 20000) { reject(new HttpErr(413, 'Too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new HttpErr(400, 'Bad JSON')); } });
    req.on('error', reject);
  });
}
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const f = STATIC[url.pathname];
      const file = fs.readFileSync(path.join(__dirname, f[0]));
      res.writeHead(200, { 'Content-Type': f[1], 'Cache-Control': f[0] === 'sw.js' || f[0] === 'index.html' ? 'no-cache' : 'public, max-age=86400' });
      return res.end(file);
    }
    if (req.method === 'GET' && url.pathname === '/api/info') {
      return json(res, 200, { urls: lanUrls() });
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      const room = rooms.get(String(url.searchParams.get('room') || '').toUpperCase());
      const pid = url.searchParams.get('pid'), token = url.searchParams.get('token');
      const p = room && room.players.find(x => x.id === pid && x.token === token);
      if (!p) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(':' + ' '.repeat(2048) + '\n');
      res.write('retry: 2000\n\n');
      const s = { res, pid };
      room.streams.add(s); p.connected = true; p.lastSeen = Date.now();
      broadcast(room);
      req.on('close', () => {
        room.streams.delete(s);
        if (![...room.streams].some(x => x.pid === pid)) { p.connected = false; p.discAt = Date.now(); }
        broadcast(room);
      });
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5);
      if (!handlers[name]) throw new HttpErr(404, 'Not found');
      const body = await readJson(req);
      return json(res, 200, handlers[name](body, { ip: req.socket.remoteAddress || 'x' }));
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    json(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
  }
});

/* heartbeat, auto-play for disconnected players, cleanup */
setInterval(() => {
  rooms.forEach(room => room.streams.forEach(s => { try { s.res.write(': ping\n\n'); } catch (e) {} }));
}, 20000);
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    room.players.forEach(p => {
      if (p.voice && !p.bot && !p.connected && now - p.discAt > 8000) { p.voice = false; p.muted = false; p.inbox = []; broadcast(room); }
    });
    room.players.forEach(p => {
      if (p.bot || !p.connected) return;
      const hasStream = [...room.streams].some(x => x.pid === p.id);
      if (!hasStream && now - (p.lastSeen || 0) > 6000) { p.connected = false; p.discAt = now; broadcast(room); }
    });
    if (room.phase === 'place') {
      let changed = false;
      room.players.forEach(p => { if (!p.ready && !p.bot && !p.connected && now - p.discAt > 20000) { p.board = shuffled(); p.ready = true; changed = true; } });
      if (changed) { if (room.players.every(p => p.ready)) startPlay(room); broadcast(room); }
    }
    if (room.phase === 'play') {
      const cur = room.players[room.turn];
      if (cur && !cur.bot && !cur.connected && now - cur.discAt > 20000) doCall(room, room.turn, randomUncrossed(cur));
    }
    if (room.streams.size === 0 && now - room.updated > 3 * 3600 * 1000) { clearTimeout(room.botTimer); rooms.delete(code); }
  });
}, 2000);

(async () => {
  console.log('\n  Starting SISCO...');
  await loadRemote();
  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n  SISCO is running.\n');
    console.log('  On this computer:      http://localhost:' + PORT);
    const urls = lanUrls();
    if (urls.length) {
      console.log('  Other devices on the same Wi-Fi / cable (phones, laptops), open:');
      urls.forEach(u => console.log('      ' + u));
    }
    console.log('\n  Keep this window open while you play. Press Ctrl+C to stop.\n');
  });
})();
