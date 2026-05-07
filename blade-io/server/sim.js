/* ================================================================
   BLADE.IO — Shared Simulation
   ----------------------------------------------------------------
   This module is loaded BOTH by the Node server (authoritative)
   and by the browser client (for prediction). It must have:
   - No DOM access
   - No network access
   - No use of `window` or `document`
   - Deterministic given inputs (so prediction matches server)
   ================================================================ */

const TAU = Math.PI * 2;
const WORLD = { w: 3600, h: 3600 };

const ARCHETYPES = {
  reaver: {
    name: 'REAVER',
    color: '#d94a5e',
    init: p => {
      p.blade.count = 2; p.blade.size = 22; p.blade.dmg = 22;
      p.blade.speed = 2.0; p.blade.radius = 80;
      p.maxHp = 130; p.hp = 130;
    }
  },
  dervish: {
    name: 'DERVISH',
    color: '#3a8db5',
    init: p => {
      p.blade.count = 4; p.blade.size = 10; p.blade.dmg = 9;
      p.blade.speed = 5.5; p.blade.radius = 80;
      p.maxHp = 90; p.hp = 90; p.speedMult = 1.1;
    }
  },
  warden: {
    name: 'WARDEN',
    color: '#8a5b9c',
    init: p => {
      p.blade.count = 3; p.blade.size = 14; p.blade.dmg = 14;
      p.blade.speed = 3.0; p.blade.radius = 130;
      p.maxHp = 110; p.hp = 110;
    }
  }
};

const UPGRADES = [
  { id:'blade_count',  name:'+1 BLADE',       desc:'Another orbiting blade', max:5, apply:p=>p.blade.count++ },
  { id:'blade_dmg',    name:'KEEN EDGE',      desc:'+25% blade damage', max:8, apply:p=>p.blade.dmg*=1.25 },
  { id:'blade_speed',  name:'WHIRL',          desc:'+20% rotation', max:5, apply:p=>p.blade.speed*=1.2 },
  { id:'blade_size',   name:'WIDE BLADE',     desc:'+25% size, -5% spin', max:4, apply:p=>{p.blade.size*=1.25; p.blade.speed*=0.95} },
  { id:'blade_radius', name:'LONG REACH',     desc:'+25% orbit, -5% dmg', max:4, apply:p=>{p.blade.radius*=1.25; p.blade.dmg*=0.95} },
  { id:'speed',        name:'SWIFT',          desc:'+15% move speed', max:5, apply:p=>p.speedMult*=1.15 },
  { id:'maxhp',        name:'IRON HEART',     desc:'+30 max HP, full heal', max:6, apply:p=>{p.maxHp+=30;p.hp=p.maxHp}, tag:'heal' },
  { id:'regen',        name:'REGEN',          desc:'+1 HP/sec', max:6, apply:p=>p.regen+=1 },
  { id:'magnet',       name:'MAGNETIZE',      desc:'+50% pickup range', max:4, apply:p=>p.magnet*=1.5 },
  { id:'dmg',          name:'BLOODLUST',      desc:'+15% all damage', max:6, apply:p=>p.dmgMult*=1.15 },
  { id:'dash_cd',      name:'KINETIC',        desc:'-25% dash cooldown', max:3, apply:p=>p.dashCdMult*=0.75 },
  { id:'reaver_swap',  name:'HEAVY BLADES',   desc:'Bigger, slower, harder', max:1, apply:p=>{p.blade.size*=1.5; p.blade.count=Math.max(1,p.blade.count-1); p.blade.dmg*=1.3}, tag:'shape' },
  { id:'dervish_swap', name:'BLADE STORM',    desc:'+2 blades, smaller, faster', max:1, apply:p=>{p.blade.count+=2; p.blade.size*=0.75; p.blade.speed*=1.3}, tag:'shape' },
  { id:'warden_swap',  name:'SWEEPING ORBIT', desc:'+50% reach, +1 blade', max:1, apply:p=>{p.blade.radius*=1.5; p.blade.dmg*=0.85; p.blade.count++}, tag:'shape' },
  { id:'glass_cannon', name:'GLASS EDGE',     desc:'+50% dmg, -30% HP', max:1, apply:p=>{p.dmgMult*=1.5; p.maxHp=Math.floor(p.maxHp*0.7); p.hp=Math.min(p.hp,p.maxHp)}, tag:'risk' },
  { id:'fortress',     name:'FORTRESS',       desc:'+60 HP, -15% speed', max:1, apply:p=>{p.maxHp+=60;p.hp+=60;p.speedMult*=0.85}, tag:'risk' },
  { id:'ravenous',     name:'RAVENOUS',       desc:'Eating gives +50% mass', max:1, apply:p=>{p.massMult*=1.5}, tag:'risk' },
];

const rand = (a,b) => a + Math.random() * (b-a);
const clamp = (v,a,b) => v<a?a:v>b?b:v;
const dist2 = (x1,y1,x2,y2) => { const dx=x2-x1,dy=y2-y1; return dx*dx+dy*dy; };

// ---------- Player factory ----------
function makePlayer({ id, x, y, name, archetype = 'dervish', isBot = false }) {
  const p = {
    id, x, y, vx: 0, vy: 0,
    name: (name || 'PLAYER').slice(0, 14),
    archetype,
    isBot,
    dead: false,
    mass: 10,
    hp: 100, maxHp: 100,
    iframes: 3.0,                    // grace period on spawn
    xp: 0, lv: 1, xpToNext: 5,
    blade: { count: 2, radius: 90, speed: 3.2, dmg: 14, size: 14 },
    magnet: 140, regen: 0,
    speedMult: 1, dmgMult: 1, massMult: 1, dashCdMult: 1,
    dashCd: 0, dashing: 0, dashDx: 0, dashDy: 0,
    spinPhase: Math.random() * TAU,
    upgradeUses: {},
    _respawnT: 0,
    _aiTargetT: 0, _aiTargetX: x, _aiTargetY: y,
    _killCount: 0,
  };
  ARCHETYPES[archetype].init(p);
  return p;
}

// ---------- Mass-derived getters ----------
const pRadius = p => 14 + Math.sqrt(p.mass) * 1.6;
const pSpeed  = p => Math.max(120, (260 - Math.sqrt(p.mass) * 7)) * p.speedMult;
const pBladeRadius = p => p.blade.radius + Math.sqrt(p.mass) * 1.8;
const pBladeSize   = p => p.blade.size   + Math.sqrt(p.mass) * 0.5;
const pBladeDmg    = p => p.blade.dmg    * p.dmgMult;
const pView        = p => 1 + Math.min(0.7, p.mass * 0.0022);

// ---------- World factory ----------
function newWorld() {
  return {
    t: 0,
    nextId: 1,
    players: new Map(),         // id -> player
    enemies: new Map(),         // id -> enemy
    gems: new Map(),            // id -> gem
    augments: new Map(),        // id -> augment orb (level-up pickup)
    shrines: [],                // fixed list
    spawnT: 0,
    events: [],                 // transient events (kills, hits) sent each tick
  };
}

function nid(world) { return world.nextId++; }

function initWorld(world) {
  // Place 6 healing shrines, well-separated.
  for (let i = 0; i < 6; i++) {
    let placed = false, attempts = 0;
    while (!placed && attempts++ < 30) {
      const x = rand(300, WORLD.w - 300), y = rand(300, WORLD.h - 300);
      const okay = world.shrines.every(s => dist2(s.x, s.y, x, y) > 700 * 700);
      if (okay) {
        world.shrines.push({ id: nid(world), x, y, cd: 0, charge: 1, r: 32 });
        placed = true;
      }
    }
  }
}

// ---------- Spawning ----------
function spawnEnemy(world) {
  const roll = Math.random();
  let ax, ay;
  const players = [...world.players.values()].filter(p => !p.dead);
  if (roll < 0.35 || players.length === 0) {
    ax = rand(150, WORLD.w - 150);
    ay = rand(150, WORLD.h - 150);
  } else {
    const target = players[Math.floor(Math.random() * players.length)];
    const ang = Math.random() * TAU, dist = rand(450, 800);
    ax = clamp(target.x + Math.cos(ang) * dist, 50, WORLD.w - 50);
    ay = clamp(target.y + Math.sin(ang) * dist, 50, WORLD.h - 50);
  }
  const tier = Math.random();
  const wave = 1 + Math.floor(world.t / 30);
  let e;
  if (wave >= 4 && tier < 0.12) {
    e = { x: ax, y: ay, r: 22, hp: 50 + wave*7, maxHp: 50 + wave*7, speed: 60 + wave*1.2, dmg: 18, xp: 5, kind: 'tank' };
  } else if (wave >= 2 && tier < 0.35) {
    e = { x: ax, y: ay, r: 9, hp: 14 + wave*2, maxHp: 14 + wave*2, speed: 140 + wave*3, dmg: 8, xp: 2, kind: 'fast' };
  } else {
    e = { x: ax, y: ay, r: 13, hp: 22 + wave*2.5, maxHp: 22 + wave*2.5, speed: 75 + wave*1.5, dmg: 10, xp: 1, kind: 'grunt' };
  }
  e.id = nid(world); e.hitT = 0;
  world.enemies.set(e.id, e);
}

// ---------- Damage ----------
function damageEnemy(world, e, dmg) {
  e.hp -= dmg; e.hitT = 0.08;
  if (e.hp <= 0) {
    world.enemies.delete(e.id);
    const g = { id: nid(world), x: e.x, y: e.y, xp: e.xp, mass: e.xp * 1.0, r: 5 };
    world.gems.set(g.id, g);
    world.events.push({ type: 'enemy_killed', x: e.x, y: e.y, color: e.kind });
    return true;
  }
  return false;
}

function damagePlayer(world, p, dmg, source) {
  if (p.iframes > 0 || p.dead) return;
  p.hp -= dmg;
  world.events.push({ type: 'hit', id: p.id, x: p.x, y: p.y });
  if (p.hp <= 0) {
    p.hp = 0; p.dead = true;
    onPlayerKilled(world, p, source);
  } else {
    p.iframes = 0.4;
  }
}

function onPlayerKilled(world, p, killer) {
  const drops = Math.min(50, Math.floor(p.mass * 0.6));
  for (let i = 0; i < drops; i++) {
    const ang = Math.random() * TAU, d = rand(20, 90);
    const g = {
      id: nid(world),
      x: p.x + Math.cos(ang) * d,
      y: p.y + Math.sin(ang) * d,
      xp: 2, mass: 1.5, r: 6, big: true,
    };
    world.gems.set(g.id, g);
  }
  if (killer && killer.id !== p.id && !killer.isBot) {
    killer._killCount = (killer._killCount || 0) + 1;
  }
  if (killer && killer.id !== p.id) {
    killer.mass += p.mass * 0.3; // killer gets a chunk directly
  }
  world.events.push({
    type: 'kill',
    victimId: p.id,
    victimName: p.name,
    killerId: killer ? killer.id : null,
    killerName: killer ? killer.name : null,
    x: p.x, y: p.y,
    color: ARCHETYPES[p.archetype].color,
    mass: Math.floor(p.mass),
  });
}

// ---------- Player tick ----------
function tickPlayer(world, p, dt, intent) {
  if (p.dead) return;
  if (p.iframes > 0) p.iframes -= dt;
  if (p.regen > 0 && p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + p.regen * dt);
  if (p.dashCd > 0) p.dashCd -= dt;
  if (p.dashing > 0) p.dashing -= dt;

  // Dash request from intent
  if (intent && intent.dash && p.dashCd <= 0 && !p.dead) {
    let mx = intent.mx || 0, my = intent.my || 0;
    const m = Math.hypot(mx, my);
    if (m < 0.1) {
      const vm = Math.hypot(p.vx, p.vy);
      if (vm > 5) { mx = p.vx / vm; my = p.vy / vm; } else { mx = my = 0; }
    } else { mx /= m; my /= m; }
    if (mx !== 0 || my !== 0) {
      p.dashDx = mx; p.dashDy = my;
      p.dashing = 0.18;
      p.dashCd = 1.6 * p.dashCdMult;
      p.iframes = Math.max(p.iframes, 0.18);
      world.events.push({ type: 'dash', id: p.id, x: p.x, y: p.y });
    }
  }

  const sp = pSpeed(p);
  let tvx, tvy;
  if (p.dashing > 0) {
    tvx = p.dashDx * sp * 4.5;
    tvy = p.dashDy * sp * 4.5;
  } else {
    let mx = (intent && intent.mx) || 0;
    let my = (intent && intent.my) || 0;
    const m = Math.hypot(mx, my);
    if (m > 1) { mx /= m; my /= m; }
    tvx = mx * sp; tvy = my * sp;
  }
  p.vx += (tvx - p.vx) * Math.min(1, dt * 8);
  p.vy += (tvy - p.vy) * Math.min(1, dt * 8);
  p.x = clamp(p.x + p.vx * dt, pRadius(p), WORLD.w - pRadius(p));
  p.y = clamp(p.y + p.vy * dt, pRadius(p), WORLD.h - pRadius(p));

  // Blades hit enemies + other players
  const b = p.blade;
  const br = pBladeRadius(p), bs = pBladeSize(p), bdmg = pBladeDmg(p);
  for (let i = 0; i < b.count; i++) {
    const ang = (p.isBot ? p.spinPhase : 0) + world.t * b.speed + (i / b.count) * TAU;
    const bx = p.x + Math.cos(ang) * br;
    const by = p.y + Math.sin(ang) * br;
    for (const e of world.enemies.values()) {
      const rr = bs + e.r;
      if (dist2(bx, by, e.x, e.y) < rr * rr) {
        const ddx = e.x - p.x, ddy = e.y - p.y, dd = Math.hypot(ddx, ddy) || 1;
        damageEnemy(world, e, bdmg * dt * 8);
        e.x += ddx / dd * 4 * dt * 60 * 0.016;
        e.y += ddy / dd * 4 * dt * 60 * 0.016;
      }
    }
    for (const o of world.players.values()) {
      if (o.id === p.id || o.dead) continue;
      const rr = bs + pRadius(o);
      if (dist2(bx, by, o.x, o.y) < rr * rr) {
        damagePlayer(world, o, bdmg * dt * 8, p);
      }
    }
  }

  // Gem pickup (with magnet pull)
  for (const g of world.gems.values()) {
    const dx = p.x - g.x, dy = p.y - g.y, d = Math.hypot(dx, dy);
    if (d < p.magnet) {
      const pull = (1 - d / p.magnet) * 600 + 80;
      g.x += dx / d * pull * dt;
      g.y += dy / d * pull * dt;
    }
    if (d < pRadius(p) + g.r + 4) {
      p.xp += g.xp;
      p.mass += g.mass * p.massMult;
      world.gems.delete(g.id);
      while (p.xp >= p.xpToNext) {
        p.xp -= p.xpToNext;
        p.lv++;
        p.xpToNext = Math.floor(p.xpToNext * 1.4 + 2);
        if (p.isBot) {
          botLevelUp(p);
        } else {
          spawnAugmentOrb(world, p);
        }
      }
    }
  }
}

// ---------- Augment orbs (in-world level-up pickups) ----------
function spawnAugmentOrb(world, p) {
  // Pick a random valid upgrade for this player
  const pool = UPGRADES.filter(u => (p.upgradeUses[u.id] || 0) < u.max);
  // Force-include heal if low HP
  let upg;
  if (p.hp / p.maxHp < 0.55 && Math.random() < 0.5) {
    upg = { id: 'instant_heal', name: 'PATCH UP', desc: 'Restore 50% HP', max: 99, tag: 'heal' };
  } else if (pool.length > 0) {
    upg = pool[Math.floor(Math.random() * pool.length)];
  } else {
    return; // nothing to give
  }
  // Spawn near the player but not on top
  const ang = Math.random() * TAU;
  const dist = 80 + Math.random() * 40;
  const orb = {
    id: nid(world),
    ownerId: p.id,
    x: p.x + Math.cos(ang) * dist,
    y: p.y + Math.sin(ang) * dist,
    upgradeId: upg.id,
    upgradeName: upg.name,
    tag: upg.tag || null,
    r: 18,
    life: 30,                  // disappears after 30s if not picked
    vx: Math.cos(ang) * 30,
    vy: Math.sin(ang) * 30,
  };
  // clamp inside world
  orb.x = clamp(orb.x, 50, WORLD.w - 50);
  orb.y = clamp(orb.y, 50, WORLD.h - 50);
  world.augments.set(orb.id, orb);
  world.events.push({ type: 'augment_spawn', x: orb.x, y: orb.y, ownerId: p.id });
}

// ---------- Augment orbs (in-world level-up pickups) END ----------

// ---------- AI bots ----------

function botIntent(world, b, dt) {
  b._aiTargetT -= dt;
  let dx = 0, dy = 0;
  const view = 700;
  let threat = null, threatD = Infinity;
  let prey = null, preyD = Infinity;
  for (const o of world.players.values()) {
    if (o.id === b.id || o.dead) continue;
    const d = Math.hypot(o.x - b.x, o.y - b.y);
    if (d > view) continue;
    if (o.mass > b.mass * 1.25) { if (d < threatD) { threatD = d; threat = o; } }
    else if (o.mass * 1.25 < b.mass) { if (d < preyD) { preyD = d; prey = o; } }
  }
  let shrine = null, shrineD = Infinity;
  if (b.hp / b.maxHp < 0.5) {
    for (const s of world.shrines) {
      if (s.charge < 1) continue;
      const d = Math.hypot(s.x - b.x, s.y - b.y);
      if (d < view * 1.3 && d < shrineD) { shrineD = d; shrine = s; }
    }
  }
  if (threat) {
    dx = b.x - threat.x; dy = b.y - threat.y;
  } else if (shrine) {
    dx = shrine.x - b.x; dy = shrine.y - b.y;
  } else if (prey) {
    dx = prey.x - b.x; dy = prey.y - b.y;
  } else {
    if (b._aiTargetT <= 0 || Math.hypot(b._aiTargetX - b.x, b._aiTargetY - b.y) < 60) {
      let bestG = null, bestD = Infinity;
      for (const g of world.gems.values()) {
        const d = Math.hypot(g.x - b.x, g.y - b.y);
        if (d < 700 && d < bestD) { bestD = d; bestG = g; }
      }
      if (bestG) { b._aiTargetX = bestG.x; b._aiTargetY = bestG.y; }
      else {
        b._aiTargetX = clamp(b.x + rand(-500, 500), 100, WORLD.w - 100);
        b._aiTargetY = clamp(b.y + rand(-500, 500), 100, WORLD.h - 100);
      }
      b._aiTargetT = rand(1.5, 3.5);
    }
    dx = b._aiTargetX - b.x; dy = b._aiTargetY - b.y;
  }
  const m = Math.hypot(dx, dy) || 1;
  return { mx: dx / m, my: dy / m, dash: false };
}

function botLevelUp(b) {
  const choices = [
    () => { if (b.blade.count < 7) b.blade.count++; },
    () => b.blade.dmg *= 1.2,
    () => b.blade.speed *= 1.15,
    () => { b.maxHp += 20; b.hp = b.maxHp; },
    () => b.dmgMult *= 1.15,
    () => b.blade.size *= 1.2,
    () => b.blade.radius *= 1.2,
    () => b.speedMult *= 1.1,
  ];
  choices[Math.floor(Math.random() * choices.length)]();
}

// ---------- Augment offering / picking (server-side) ----------
function generateLevelUpOptions(p) {
  const pool = UPGRADES.filter(u => (p.upgradeUses[u.id] || 0) < u.max);
  const picks = [];
  while (picks.length < 3 && pool.length > 0) {
    const i = Math.floor(Math.random() * pool.length);
    picks.push(pool.splice(i, 1)[0]);
  }
  if (p.hp / p.maxHp < 0.55) {
    const idx = picks.findIndex(o => o.tag === 'heal');
    if (idx < 0 && picks.length > 0) {
      picks[picks.length - 1] = {
        id: 'instant_heal', name: 'PATCH UP', desc: 'Restore 50% HP', max: 99, tag: 'heal',
      };
    }
  }
  return picks.map(o => ({ id: o.id, name: o.name, desc: o.desc, tag: o.tag || null }));
}

function applyUpgrade(p, upgradeId) {
  let upg = UPGRADES.find(u => u.id === upgradeId);
  if (!upg && upgradeId === 'instant_heal') {
    upg = { id: 'instant_heal', max: 99, apply: pp => { pp.hp = Math.min(pp.maxHp, pp.hp + pp.maxHp * 0.5); } };
  }
  if (!upg) return false;
  if ((p.upgradeUses[upg.id] || 0) >= upg.max) return false;
  upg.apply(p);
  p.upgradeUses[upg.id] = (p.upgradeUses[upg.id] || 0) + 1;
  return true;
}

// ---------- World tick ----------
function tickWorld(world, dt, intentsById) {
  world.t += dt;
  world.events.length = 0;

  // Players
  for (const p of world.players.values()) {
    if (p.dead) {
      p._respawnT = (p._respawnT || 0) + dt;
      continue;
    }
    if (p.isBot) {
      tickPlayer(world, p, dt, botIntent(world, p, dt));
    } else {
      tickPlayer(world, p, dt, intentsById.get(p.id) || { mx: 0, my: 0, dash: false });
    }
  }

  // Spawn mobs (halved from before — was too dense, was lagging)
  world.spawnT -= dt;
  if (world.spawnT <= 0) {
    const intensity = clamp(world.t / 60, 0.5, 2.0);
    world.spawnT = rand(0.30, 0.55) / intensity;
    const burstN = 1 + Math.floor(intensity * 0.5);
    for (let i = 0; i < burstN; i++) spawnEnemy(world);
  }
  if (world.enemies.size > 120) {
    const ids = [...world.enemies.keys()].slice(0, world.enemies.size - 120);
    for (const id of ids) world.enemies.delete(id);
  }

  // Mobs chase nearest alive player
  for (const e of world.enemies.values()) {
    e.hitT = Math.max(0, e.hitT - dt);
    let nearest = null, nd = Infinity;
    for (const p of world.players.values()) {
      if (p.dead) continue;
      const d = dist2(e.x, e.y, p.x, p.y);
      if (d < nd) { nd = d; nearest = p; }
    }
    if (!nearest) continue;
    const dx = nearest.x - e.x, dy = nearest.y - e.y, d = Math.hypot(dx, dy) || 1;
    e.x += dx / d * e.speed * dt;
    e.y += dy / d * e.speed * dt;
    const r2 = (pRadius(nearest) + e.r);
    if (dist2(nearest.x, nearest.y, e.x, e.y) < r2 * r2) {
      damagePlayer(world, nearest, e.dmg, e);
    }
  }

  // Augment orbs: drift, decay, pickup by owner OR anyone if old enough
  for (const orb of world.augments.values()) {
    orb.life -= dt;
    if (orb.life <= 0) {
      world.augments.delete(orb.id);
      continue;
    }
    // gentle drift, decay velocity
    orb.x += orb.vx * dt;
    orb.y += orb.vy * dt;
    orb.vx *= 0.96;
    orb.vy *= 0.96;
    orb.x = clamp(orb.x, 30, WORLD.w - 30);
    orb.y = clamp(orb.y, 30, WORLD.h - 30);

    // After 8 seconds, the orb becomes anyone's to pick up. Before that, owner-only.
    const anyoneCanGrab = orb.life < 22;

    for (const ply of world.players.values()) {
      if (ply.dead || ply.isBot) continue;
      if (!anyoneCanGrab && ply.id !== orb.ownerId) continue;
      const rr = pRadius(ply) + orb.r;
      if (dist2(ply.x, ply.y, orb.x, orb.y) < rr * rr) {
        applyUpgrade(ply, orb.upgradeId);
        world.events.push({
          type: 'augment_pickup',
          x: orb.x, y: orb.y,
          playerId: ply.id,
          name: orb.upgradeName,
          tag: orb.tag,
        });
        world.augments.delete(orb.id);
        break;
      }
    }
  }


  for (const s of world.shrines) {
    if (s.charge < 1) {
      s.cd -= dt;
      if (s.cd <= 0) { s.charge = 1; }
    } else {
      for (const ply of world.players.values()) {
        if (ply.dead) continue;
        if (dist2(ply.x, ply.y, s.x, s.y) < (pRadius(ply) + s.r) * (pRadius(ply) + s.r)) {
          if (ply.hp < ply.maxHp) {
            ply.hp = Math.min(ply.maxHp, ply.hp + ply.maxHp * 0.5);
            world.events.push({ type: 'shrine_used', x: s.x, y: s.y, playerId: ply.id });
            s.charge = 0; s.cd = 12;
            break;
          }
        }
      }
    }
  }
}

// ---------- Snapshot for network ----------
// Compact representation; only what the client needs to render.
function snapshot(world) {
  const players = [];
  for (const p of world.players.values()) {
    players.push({
      id: p.id,
      n: p.name,
      a: p.archetype,
      b: p.isBot ? 1 : 0,
      d: p.dead ? 1 : 0,
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      vx: Math.round(p.vx),
      vy: Math.round(p.vy),
      m: Math.round(p.mass * 10) / 10,
      h: Math.ceil(p.hp),
      mh: p.maxHp,
      l: p.lv,
      xp: p.xp,
      xn: p.xpToNext,
      if: Math.round(p.iframes * 10) / 10,
      bc: p.blade.count,
      br: p.blade.radius,
      bs: p.blade.speed,
      bd: p.blade.dmg,
      bz: p.blade.size,
      sp: Math.round(p.spinPhase * 100) / 100,
      ks: p._killCount || 0,
    });
  }
  const enemies = [];
  for (const e of world.enemies.values()) {
    enemies.push({
      id: e.id,
      x: Math.round(e.x), y: Math.round(e.y),
      r: e.r, h: Math.ceil(e.hp), mh: e.maxHp, k: e.kind,
    });
  }
  const gems = [];
  for (const g of world.gems.values()) {
    gems.push({ id: g.id, x: Math.round(g.x), y: Math.round(g.y), b: g.big ? 1 : 0 });
  }
  const augments = [];
  for (const a of world.augments.values()) {
    augments.push({
      id: a.id,
      x: Math.round(a.x), y: Math.round(a.y),
      o: a.ownerId,
      n: a.upgradeName,
      tg: a.tag || '',
      l: Math.round(a.life * 10) / 10,
    });
  }
  const shrines = world.shrines.map(s => ({ id: s.id, x: s.x, y: s.y, c: s.charge >= 1 ? 1 : 0, cd: Math.round(s.cd * 10) / 10 }));
  return {
    t: Math.round(world.t * 10) / 10,
    players, enemies, gems, augments, shrines,
    events: world.events.slice(),
  };
}

module.exports = {
  WORLD, ARCHETYPES, UPGRADES, TAU,
  newWorld, initWorld, makePlayer, nid,
  tickWorld, tickPlayer, botIntent, generateLevelUpOptions, applyUpgrade,
  pRadius, pSpeed, pBladeRadius, pBladeSize, pBladeDmg, pView,
  snapshot,
};
