/* ================================================================
   BLADE.IO — Server
   ================================================================
   - Authoritative simulation at 30 Hz
   - WebSocket per connected player
   - Bot fill: 5 bots when human count < 6
   - Snapshot broadcast every tick
   ================================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const sim = require('./sim');

const PORT = process.env.PORT || 3000;
const TICK_HZ = 30;
const TICK_DT = 1 / TICK_HZ;
const MAX_PLAYERS = 50;
const BOT_FILL_TARGET = 5;
const BOT_FILL_MIN_HUMANS = 6; // when humans >= this, bots start leaving

const BOT_NAMES = ['VOID','HEX','NEON','GHOST','RAZE','PYRE','ZED','JINX','OMEN','LUMA','ECHO','RIFT','HUSK','VANE','CINDR'];

// ---------- Static file serving (the client) ----------
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

const httpServer = http.createServer((req, res) => {
  // Health check for Fly.io
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);
  // prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(data);
  });
});

// ---------- WebSocket ----------
// perMessageDeflate cuts JSON snapshot bandwidth ~70% — meaningful on mobile data
// plans and for battery. Tuned light: small mem footprint, no per-message context
// takeover so each frame compresses independently (lower CPU, slightly worse ratio).
const wss = new WebSocketServer({
  server: httpServer,
  path: '/ws',
  perMessageDeflate: {
    zlibDeflateOptions: { level: 3, memLevel: 7 },
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    threshold: 256,
  },
});

// ---------- World ----------
const world = sim.newWorld();
sim.initWorld(world);

// ws -> { id, name }   only for humans
const sockets = new Map();
// id -> { ws, intent: { mx, my, dash } }
const humanState = new Map();
// id -> bot internal id list
const botIds = new Set();

let nextWelcome = 1;

function send(ws, msg) {
  if (ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(msg)); } catch (e) {}
}

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const ws of sockets.keys()) {
    if (ws.readyState === 1) {
      try { ws.send(s); } catch (e) {}
    }
  }
}

function spawnBot() {
  const ang = Math.random() * sim.TAU;
  const r = 700 + Math.random() * 800;
  const arches = ['reaver', 'dervish', 'warden'];
  const id = sim.nid(world);
  const name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + Math.floor(Math.random() * 99);
  const p = sim.makePlayer({
    id,
    x: sim.WORLD.w / 2 + Math.cos(ang) * r,
    y: sim.WORLD.h / 2 + Math.sin(ang) * r,
    name,
    archetype: arches[Math.floor(Math.random() * 3)],
    isBot: true,
  });
  p.iframes = 1.5;
  world.players.set(id, p);
  botIds.add(id);
  return p;
}

function rebalanceBots() {
  const humans = [...world.players.values()].filter(p => !p.isBot);
  const bots = [...world.players.values()].filter(p => p.isBot && !p.dead);
  // Always keep at least BOT_FILL_TARGET bots, unless we have enough humans
  let desired;
  if (humans.length >= BOT_FILL_MIN_HUMANS) {
    desired = Math.max(0, BOT_FILL_TARGET - (humans.length - BOT_FILL_MIN_HUMANS + 1));
    desired = Math.max(0, desired);
  } else {
    desired = BOT_FILL_TARGET;
  }
  while (bots.length > desired) {
    const b = bots.pop();
    world.players.delete(b.id);
    botIds.delete(b.id);
  }
  while (bots.length < desired && (bots.length + humans.length) < MAX_PLAYERS) {
    bots.push(spawnBot());
  }
}

// ---------- Connection lifecycle ----------
wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const wsState = { id: null, name: null, joinedAt: Date.now(), ip, lastMsgAt: Date.now() };
  sockets.set(ws, wsState);

  // Soft rate limit per-socket: messages per second
  let msgCount = 0;
  let msgWindowStart = Date.now();

  send(ws, { type: 'hello', maxPlayers: MAX_PLAYERS, world: { w: sim.WORLD.w, h: sim.WORLD.h } });

  ws.on('message', (raw) => {
    // rate limit: > 100 msgs/sec → kick
    const now = Date.now();
    if (now - msgWindowStart > 1000) { msgWindowStart = now; msgCount = 0; }
    msgCount++;
    if (msgCount > 100) { ws.close(1008, 'rate limit'); return; }
    wsState.lastMsgAt = now;

    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'join') {
      if (wsState.id) return; // already joined
      const humans = [...world.players.values()].filter(p => !p.isBot);
      if (humans.length >= MAX_PLAYERS) {
        send(ws, { type: 'reject', reason: 'Server full. Try again in a minute.' });
        ws.close(1013, 'full');
        return;
      }
      const name = sanitizeName(msg.name);
      const arche = (['reaver','dervish','warden'].includes(msg.archetype) ? msg.archetype : 'dervish');
      const id = sim.nid(world);
      const ang = Math.random() * sim.TAU;
      const r = 600 + Math.random() * 400;
      const p = sim.makePlayer({
        id,
        x: sim.WORLD.w / 2 + Math.cos(ang) * r,
        y: sim.WORLD.h / 2 + Math.sin(ang) * r,
        name, archetype: arche, isBot: false,
      });
      world.players.set(id, p);
      wsState.id = id; wsState.name = name;
      humanState.set(id, { ws, intent: { mx: 0, my: 0, dash: false } });
      send(ws, { type: 'joined', id, archetype: arche });
      console.log(`+ ${name} joined (id=${id}, ip=${ip}). humans=${humans.length + 1}, bots=${botIds.size}`);
      rebalanceBots();
    } else if (msg.type === 'input') {
      const id = wsState.id;
      if (!id) return;
      const hs = humanState.get(id);
      if (!hs) return;
      hs.intent.mx = clampNum(msg.mx, -1, 1);
      hs.intent.my = clampNum(msg.my, -1, 1);
      hs.intent.dash = !!msg.dash;
    } else if (msg.type === 'respawn') {
      const id = wsState.id;
      if (!id) return;
      const old = world.players.get(id);
      if (!old || !old.dead) return;
      const ang = Math.random() * sim.TAU, rr = 600 + Math.random() * 400;
      const arche = (['reaver','dervish','warden'].includes(msg.archetype) ? msg.archetype : old.archetype);
      const fresh = sim.makePlayer({
        id, x: sim.WORLD.w/2 + Math.cos(ang)*rr, y: sim.WORLD.h/2 + Math.sin(ang)*rr,
        name: old.name, archetype: arche, isBot: false,
      });
      world.players.set(id, fresh);
      send(ws, { type: 'joined', id, archetype: arche });
    } else if (msg.type === 'ping') {
      send(ws, { type: 'pong', t: msg.t });
    }
  });

  ws.on('close', () => {
    sockets.delete(ws);
    const id = wsState.id;
    if (id) {
      world.players.delete(id);
      humanState.delete(id);
      console.log(`- ${wsState.name || id} left.`);
      rebalanceBots();
    }
  });

  ws.on('error', () => {});
});

function sanitizeName(n) {
  if (typeof n !== 'string') return 'PLAYER' + Math.floor(Math.random() * 99);
  let s = n.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 14);
  if (!s) s = 'PLAYER' + Math.floor(Math.random() * 99);
  return s;
}
function clampNum(v, lo, hi) {
  v = Number(v);
  if (!Number.isFinite(v)) return 0;
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------- Bot respawn handling ----------
function respawnDeadBots() {
  for (const id of botIds) {
    const p = world.players.get(id);
    if (!p) { botIds.delete(id); continue; }
    if (p.dead && p._respawnT > 3) {
      const ang = Math.random() * sim.TAU, r = 900 + Math.random() * 600;
      const arches = ['reaver', 'dervish', 'warden'];
      const fresh = sim.makePlayer({
        id, x: sim.WORLD.w/2 + Math.cos(ang)*r, y: sim.WORLD.h/2 + Math.sin(ang)*r,
        name: p.name, archetype: arches[Math.floor(Math.random()*3)], isBot: true,
      });
      fresh.iframes = 1.5;
      world.players.set(id, fresh);
    }
  }
}

// ---------- Main tick loop ----------
let lastTick = Date.now();
function tick() {
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastTick) / 1000);
  lastTick = now;

  // build intent map for humans
  const intents = new Map();
  for (const [id, hs] of humanState) {
    const p = world.players.get(id);
    if (!p || p.dead) continue;
    // Snapshot intent fields — must be a copy, not a shared reference, or
    // consuming the dash flag below wipes the value before tickWorld reads it.
    intents.set(id, { mx: hs.intent.mx, my: hs.intent.my, dash: hs.intent.dash });
    // Consume the dash flag — it's edge-triggered
    if (hs.intent.dash) hs.intent.dash = false;
  }

  sim.tickWorld(world, dt, intents);

  respawnDeadBots();

  // Death notifications to clients (kill events from sim get broadcast in snapshot)
  // Snapshot
  const snap = sim.snapshot(world);
  // Per-client message: include their pending-LU state so they don't desync
  const baseMsg = { type: 'snap', s: snap };
  const baseStr = JSON.stringify(baseMsg);
  for (const [ws] of sockets) {
    if (ws.readyState === 1) {
      try { ws.send(baseStr); } catch (e) {}
    }
  }
}

setInterval(tick, 1000 / TICK_HZ);

// idle WS cleanup (45s)
setInterval(() => {
  const now = Date.now();
  for (const [ws, st] of sockets) {
    if (now - st.lastMsgAt > 45000) {
      try { ws.close(1000, 'idle'); } catch(e) {}
    }
  }
}, 15000);

// Memory pressure logging — visibility on the 512 MB hosting tier.
// Prints RSS + heap + entity counts every 60s so we can correlate growth
// with player activity. If RSS climbs past ~400 MB we're getting close to
// the hard cap and something's still leaking.
setInterval(() => {
  const m = process.memoryUsage();
  const mb = b => (b / 1024 / 1024).toFixed(1);
  const humans = [...world.players.values()].filter(p => !p.isBot).length;
  console.log(
    `[mem] rss=${mb(m.rss)}MB  heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB  ` +
    `ext=${mb(m.external)}MB  | players=${world.players.size}(h${humans})  ` +
    `enemies=${world.enemies.size}  gems=${world.gems.size}  ` +
    `augments=${world.augments.size}  sockets=${sockets.size}`
  );
}, 60000);

// ---------- Boot ----------
httpServer.listen(PORT, () => {
  console.log(`BLADE.IO server listening on :${PORT}`);
  console.log(`  HTTP:   http://localhost:${PORT}/`);
  console.log(`  WS:     ws://localhost:${PORT}/ws`);
  // seed initial bots
  rebalanceBots();
});

process.on('SIGTERM', () => { console.log('SIGTERM, shutting down'); httpServer.close(()=>process.exit(0)); });
process.on('SIGINT',  () => { console.log('SIGINT, shutting down');  httpServer.close(()=>process.exit(0)); });
