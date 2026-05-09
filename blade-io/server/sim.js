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

// Memory caps — designed for 512 MB free-tier hosting.
// ENEMY_CAP 120 → 80: with summoners + boss waves the world was a mosh pit.
// At 80 there's still plenty of pressure but each individual mob registers.
const GEM_LIFE        = 60;   // seconds; uncollected gems decay
const GEM_CAP         = 200;  // hard ceiling on simultaneous gems
const AUGMENT_CAP     = 20;   // hard ceiling on level-up orbs
const ENEMY_CAP       = 80;   // hard ceiling on simultaneous enemies

// Boss wave escalation — every BOSS_WAVE_INTERVAL seconds, N champions
// spawn at once with a pre-warning event. Number scales with elapsed time.
const BOSS_WAVE_INTERVAL = 90;   // s between waves
const BOSS_WAVE_TELEGRAPH = 3;   // s warning before champs spawn

// Player-killer "hot" aura — eat another player, glow red for KILL_GLOW_S.
// Visible signal to everyone else that you just took a kill.
const KILL_GLOW_S = 8;

// Power-ups — rare floating buffs that spawn every POWERUP_INTERVAL_*.
// Pick up by walking over. Effects last POWERUP_DURATIONS[type] seconds.
const POWERUP_LIFE = 60;             // seconds before despawn
const POWERUP_INTERVAL_MIN = 25;
const POWERUP_INTERVAL_MAX = 40;
const POWERUP_CAP = 3;
const POWERUP_TYPES = ['shield', 'berserk', 'magnet', 'slowmo'];
const POWERUP_DURATIONS = { shield: 4, berserk: 5, magnet: 8, slowmo: 3 };

// Dash-execute: a kill within EXECUTE_WINDOW seconds of dashing earns
// a bonus XP gem + dramatic event. Rewards aggressive engage-dashing.
const EXECUTE_WINDOW = 0.6;

// Center "danger zone" — 30% of mobs spawn in a 600 px ring around the
// world center. Mobs in zone are tougher (HP×1.4, dmg×1.2) but drop
// double XP. Risk/reward heart of the map.
const DANGER_ZONE_R = 600;
const DANGER_ZONE_R2 = DANGER_ZONE_R * DANGER_ZONE_R;
function inDangerZone(x, y) {
  const dx = x - WORLD.w / 2, dy = y - WORLD.h / 2;
  return dx * dx + dy * dy < DANGER_ZONE_R2;
}

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

// Each upgrade has a `weight` that biases the augment-orb pool. Damage upgrades
// (KEEN EDGE, BLOODLUST) are 2.0× weighted so the build actually scales.
// Shape-swaps are rare (0.5×) AND now strictly additive — no more "HEAVY
// BLADES wiped my progression" — and `weight` defaults to 1 if omitted.
const UPGRADES = [
  { id:'blade_count',  name:'+1 BLADE',       desc:'Another orbiting blade',     max:5, weight:1.6, apply:p=>p.blade.count++ },
  { id:'blade_dmg',    name:'KEEN EDGE',      desc:'+25% blade damage',          max:8, weight:2.2, apply:p=>p.blade.dmg*=1.25 },
  { id:'blade_speed',  name:'WHIRL',          desc:'+20% rotation',              max:5, weight:1.4, apply:p=>p.blade.speed*=1.2 },
  // WIDE BLADE was a 25 % bump on a stat already inflated by sqrt(mass)*0.5,
  // so it felt invisible. New: 40 % size + 10 % damage. Stacks 4× so a fully-
  // committed build = (1.4)^4 = 3.84× width. Will be visible.
  { id:'blade_size',   name:'WIDE BLADE',     desc:'+40% size, +10% damage',     max:4, weight:1.5, apply:p=>{p.blade.size*=1.40; p.blade.dmg*=1.10} },
  { id:'blade_radius', name:'LONG REACH',     desc:'+25% reach',                 max:4, weight:1.2, apply:p=>p.blade.radius*=1.25 },
  { id:'speed',        name:'SWIFT',          desc:'+15% move speed',            max:5, weight:1.0, apply:p=>p.speedMult*=1.15 },
  { id:'maxhp',        name:'IRON HEART',     desc:'+30 max HP, full heal',      max:6, weight:1.0, apply:p=>{p.maxHp+=30;p.hp=p.maxHp}, tag:'heal' },
  { id:'regen',        name:'REGEN',          desc:'+1 HP/sec',                  max:6, weight:0.9, apply:p=>p.regen+=1 },
  { id:'magnet',       name:'MAGNETIZE',      desc:'+50% pickup range',          max:4, weight:0.7, apply:p=>p.magnet*=1.5 },
  { id:'dmg',          name:'BLOODLUST',      desc:'+15% all damage',            max:6, weight:2.0, apply:p=>p.dmgMult*=1.15 },
  { id:'dash_cd',      name:'KINETIC',        desc:'-25% dash cooldown',         max:3, weight:0.8, apply:p=>p.dashCdMult*=0.75 },
  // SHAPE-SWAPS — strictly additive transformations. No more subtracting the
  // blades the player just earned. These are still rare (weight 0.5) and 1-shot.
  // HEAVY BLADES — the classic Reaver tradeoff: lose 1 blade, gain size +
  // damage. Floor at 2 (not 1) so a Reaver who already starts with 2 doesn't
  // get gutted. From 4+ blades you give up one for the power bump, which is
  // the intended deal. From 2 blades you just get the buffs free.
  { id:'reaver_swap',  name:'HEAVY BLADES',   desc:'-1 blade, +60% size, +50% dmg, -15% spin', max:1, weight:0.5, apply:p=>{p.blade.count=Math.max(2,p.blade.count-1); p.blade.size*=1.6; p.blade.dmg*=1.5; p.blade.speed*=0.85}, tag:'shape' },
  { id:'dervish_swap', name:'BLADE STORM',    desc:'+2 blades, -15% size, +25% spin', max:1, weight:0.5, apply:p=>{p.blade.count=Math.min(7,p.blade.count+2); p.blade.size*=0.85; p.blade.speed*=1.25}, tag:'shape' },
  { id:'warden_swap',  name:'SWEEPING ORBIT', desc:'+50% reach, +1 blade',            max:1, weight:0.5, apply:p=>{p.blade.radius*=1.5; p.blade.count=Math.min(7,p.blade.count+1)}, tag:'shape' },
  { id:'glass_cannon', name:'GLASS EDGE',     desc:'+50% dmg, -30% HP',          max:1, weight:0.6, apply:p=>{p.dmgMult*=1.5; p.maxHp=Math.floor(p.maxHp*0.7); p.hp=Math.min(p.hp,p.maxHp)}, tag:'risk' },
  { id:'fortress',     name:'FORTRESS',       desc:'+60 HP, -15% speed',         max:1, weight:0.6, apply:p=>{p.maxHp+=60;p.hp+=60;p.speedMult*=0.85}, tag:'risk' },
  { id:'ravenous',     name:'RAVENOUS',       desc:'Eating gives +50% mass',     max:1, weight:0.6, apply:p=>p.massMult*=1.5, tag:'risk' },
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
    // Power-up effect timers (seconds remaining).
    shieldT: 0, berserkT: 0, magnetT: 0, slowmoT: 0,
    // Dash-execute window — set when dashing, ticks down. Kills while >0
    // count as executes.
    _executeT: 0,
    killGlow: 0,
  };
  ARCHETYPES[archetype].init(p);
  return p;
}

// ---------- Mass-derived getters ----------
const pRadius = p => 14 + Math.sqrt(p.mass) * 1.6;
// Speed floor lifted to 140 so fast mobs (140 + wave*3) don't outpace big
// players. The line-blade now covers the body-edge gap, but the player still
// needs to be able to disengage occasionally.
const pSpeed  = p => Math.max(140, (260 - Math.sqrt(p.mass) * 7)) * p.speedMult;
// pBladeRadius is the OUTER tip distance — the far end of the blade line.
// pBladeInner is where the blade starts (just outside the body), so the line
// covers every radius from body edge out to the tip. Mobs that get close
// can no longer slip "inside the orbit" — the line is already there.
const pBladeRadius = p => p.blade.radius + Math.sqrt(p.mass) * 1.8;
const pBladeInner  = p => pRadius(p) + 2;
const pBladeSize   = p => p.blade.size   + Math.sqrt(p.mass) * 0.5;
// Damage scales with sqrt(mass) so growing the player IS itself a power curve
// — not just upgrade-gated. Without this term, mob HP scales with wave-time
// while the player stays static unless RNG hands them KEEN EDGE. The user's
// "the bigger I am the LESS damage I do to mobs" complaint is the perceived
// inverse-feel of that mismatch. mass=10 → +2.2 dmg. mass=400 → +14 dmg.
const pBladeDmg    = p => (p.blade.dmg + Math.sqrt(p.mass) * 0.7) * p.dmgMult;
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
    powerups: new Map(),        // id -> powerup orb (shield/berserk/magnet/slowmo)
    shrines: [],                // fixed list
    spawnT: 0,
    events: [],                 // transient events (kills, hits) sent each tick
    // Reused per-tick scratch space to avoid GC churn at 30 Hz.
    _sepGrid: new Map(),        // cellKey -> enemy[]
    _sepCellPool: [],           // recycled empty arrays
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
  // 30% of spawns happen inside the danger zone — concentration of risk
  // and reward at the heart of the map.
  if (roll < 0.30) {
    const ang = Math.random() * TAU, dist = Math.random() * (DANGER_ZONE_R - 60);
    ax = WORLD.w / 2 + Math.cos(ang) * dist;
    ay = WORLD.h / 2 + Math.sin(ang) * dist;
  } else if (roll < 0.50 || players.length === 0) {
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
  if (wave >= 3 && tier < 0.04) {
    // Champion: rare elite mob — fat HP, fat reward. Drops a cluster of gems.
    e = { x: ax, y: ay, r: 28, hp: 180 + wave*14, maxHp: 180 + wave*14, speed: 55 + wave*0.8, dmg: 22, xp: 18, kind: 'champion', atkRate: 0.85 };
  } else if (wave >= 5 && tier < 0.05) {
    // Summoner — kites, periodically spawns fast minions. Rarer than other
    // elites (5%) because each one acts as a spawner, multiplying density.
    e = { x: ax, y: ay, r: 18, hp: 60 + wave*5, maxHp: 60 + wave*5, speed: 35, dmg: 14, xp: 5, kind: 'summoner', atkRate: 1.2, _summonT: rand(6, 10) };
  } else if (wave >= 4 && tier < 0.14) {
    // Exploder — slow, modest HP, but bursts AOE on death. Punishes
    // bunching mobs near the player and "kill everything fast" play.
    e = { x: ax, y: ay, r: 15, hp: 30 + wave*3, maxHp: 30 + wave*3, speed: 75, dmg: 18, xp: 3, kind: 'exploder', atkRate: 0.6 };
  } else if (wave >= 4 && tier < 0.20) {
    e = { x: ax, y: ay, r: 22, hp: 50 + wave*7, maxHp: 50 + wave*7, speed: 60 + wave*1.2, dmg: 18, xp: 5, kind: 'tank', atkRate: 0.7 };
  } else if (wave >= 2 && tier < 0.40) {
    e = { x: ax, y: ay, r: 9, hp: 14 + wave*2, maxHp: 14 + wave*2, speed: 140 + wave*3, dmg: 8, xp: 2, kind: 'fast', atkRate: 0.4 };
  } else {
    e = { x: ax, y: ay, r: 13, hp: 22 + wave*2.5, maxHp: 22 + wave*2.5, speed: 75 + wave*1.5, dmg: 10, xp: 1, kind: 'grunt', atkRate: 0.55 };
  }
  // Danger-zone enemies are tougher (×1.4 HP, ×1.2 dmg) but drop double XP.
  if (inDangerZone(e.x, e.y)) {
    e.hp = Math.ceil(e.hp * 1.4);
    e.maxHp = e.hp;
    e.dmg = Math.ceil(e.dmg * 1.2);
    e.xp *= 2;
    e.dz = 1;
  }
  e.id = nid(world); e.hitT = 0; e.atkCd = Math.random() * 0.3;
  e._dmgAcc = 0; e._dmgEmitT = 0;
  world.enemies.set(e.id, e);
  if (e.kind === 'champion') {
    world.events.push({ type: 'champion_spawn', x: e.x, y: e.y, id: e.id });
  }
}

// ---------- Damage ----------
function damageEnemy(world, e, dmg, killer, hitX, hitY) {
  e.hp -= dmg; e.hitT = 0.08;
  // Damage events fire at the BLADE-TIP impact point, not the enemy center,
  // so the client can visually correlate hits with the blade that struck.
  e._dmgAcc = (e._dmgAcc || 0) + dmg;
  if (hitX != null) { e._lastHitX = hitX; e._lastHitY = hitY; }
  // Tight throttle so each blade swing-through registers as a discrete hit.
  if (world.t - (e._dmgEmitT || 0) > 0.08 && e._dmgAcc >= 0.5) {
    world.events.push({
      type: 'dmg',
      x: e._lastHitX != null ? e._lastHitX : e.x,
      y: e._lastHitY != null ? e._lastHitY : e.y,
      dmg: Math.round(e._dmgAcc * 10) / 10,
      killerId: killer ? killer.id : null,
    });
    e._dmgAcc = 0;
    e._dmgEmitT = world.t;
  }
  if (e.hp <= 0) {
    world.enemies.delete(e.id);
    // Champions drop a cluster of gems for that "boss kill" payoff.
    // .life is the decay timer — gems left unpicked vanish after GEM_LIFE
    // seconds so they can't pile up forever on a 512 MB free-tier server.
    if (e.kind === 'champion') {
      for (let i = 0; i < 8; i++) {
        const ang = Math.random() * TAU, d = rand(8, 36);
        const g = { id: nid(world), x: e.x + Math.cos(ang)*d, y: e.y + Math.sin(ang)*d, xp: 2, mass: 2.2, r: 6, big: true, life: GEM_LIFE };
        world.gems.set(g.id, g);
      }
    } else {
      const g = { id: nid(world), x: e.x, y: e.y, xp: e.xp, mass: e.xp * 1.0, r: 5, life: GEM_LIFE };
      world.gems.set(g.id, g);
    }
    // Exploders detonate on death — radial AOE + visual + audio cue.
    if (e.kind === 'exploder') {
      const ER = 90;
      for (const pl of world.players.values()) {
        if (pl.dead) continue;
        if (dist2(e.x, e.y, pl.x, pl.y) < ER * ER) {
          // Killer-of-record is the exploder so the killing player isn't
          // credited with their own AOE-self-damage.
          damagePlayer(world, pl, 18, e);
        }
      }
      world.events.push({ type: 'explode', x: e.x, y: e.y, r: ER });
    }
    // Dash-execute: kill landed during the execute window after a dash.
    // Bonus XP gem + dramatic event (golden "EXECUTE" pop on the client).
    if (killer && killer._executeT > 0 && e.kind !== 'champion') {
      const bonusG = { id: nid(world), x: e.x, y: e.y, xp: 2, mass: 1.5, r: 6, big: true, life: GEM_LIFE };
      world.gems.set(bonusG.id, bonusG);
      world.events.push({ type: 'execute', x: e.x, y: e.y, killerId: killer.id, kind: e.kind });
    }
    world.events.push({
      type: 'enemy_killed',
      x: e.x, y: e.y,
      kind: e.kind,
      xp: e.xp,
      killerId: killer ? killer.id : null,
    });
    return true;
  }
  return false;
}

function damagePlayer(world, p, dmg, source) {
  // Shield powerup absorbs hits same as iframes — but we visualise differently
  // on the client so the player knows which is active.
  if (p.iframes > 0 || p.shieldT > 0 || p.dead) return;
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
      xp: 2, mass: 1.5, r: 6, big: true, life: GEM_LIFE,
    };
    world.gems.set(g.id, g);
  }
  if (killer && killer.id !== p.id && !killer.isBot) {
    killer._killCount = (killer._killCount || 0) + 1;
  }
  if (killer && killer.id !== p.id) {
    killer.mass += p.mass * 0.3; // killer gets a chunk directly
    // "Hot" aura — visible to everyone for KILL_GLOW_S seconds. Stacks but caps.
    killer.killGlow = Math.min(KILL_GLOW_S * 2, (killer.killGlow || 0) + KILL_GLOW_S);
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
  if (p.killGlow > 0) p.killGlow = Math.max(0, p.killGlow - dt);
  // Power-up effect timers — all in seconds remaining.
  if (p.shieldT > 0)  p.shieldT  = Math.max(0, p.shieldT  - dt);
  if (p.berserkT > 0) p.berserkT = Math.max(0, p.berserkT - dt);
  if (p.magnetT > 0)  p.magnetT  = Math.max(0, p.magnetT  - dt);
  if (p.slowmoT > 0)  p.slowmoT  = Math.max(0, p.slowmoT  - dt);
  if (p._executeT > 0) p._executeT = Math.max(0, p._executeT - dt);

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
      // Open the execute window — kills landed in the next EXECUTE_WINDOW
      // seconds count as dash-executes (bonus XP + visual flourish).
      p._executeT = EXECUTE_WINDOW;
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

  // Blades hit enemies + other players via segment-vs-circle. Each blade is a
  // LINE from innerR to outerR along its rotating angle — anything within the
  // line's perpendicular tolerance (bs + target.r) gets hit, regardless of
  // where along the line. This is the difference between "magnetic dot
  // orbiting" and "sword sweeping": close enemies can't slip past a fixed
  // orbit ring anymore because the whole ray is the hitbox.
  const b = p.blade;
  const innerR = pBladeInner(p), outerR = pBladeRadius(p);
  const bs = pBladeSize(p);
  // Berserk powerup: +50% blade damage during the buff window.
  const bdmg = pBladeDmg(p) * (p.berserkT > 0 ? 1.5 : 1);
  for (let i = 0; i < b.count; i++) {
    const ang = (p.isBot ? p.spinPhase : 0) + world.t * b.speed + (i / b.count) * TAU;
    const ux = Math.cos(ang), uy = Math.sin(ang);
    for (const e of world.enemies.values()) {
      const dxp = e.x - p.x, dyp = e.y - p.y;
      const proj = dxp * ux + dyp * uy;          // distance along blade axis
      if (proj < innerR - bs || proj > outerR + bs) continue;
      const tProj = proj < innerR ? innerR : (proj > outerR ? outerR : proj);
      const cx = p.x + ux * tProj, cy = p.y + uy * tProj;
      const px2 = e.x - cx, py2 = e.y - cy;
      const rr = bs + e.r;
      if (px2 * px2 + py2 * py2 < rr * rr) {
        // Hit point is the closest point on the segment (not enemy center).
        damageEnemy(world, e, bdmg * dt * 8, p, cx, cy);
        // Knockback radially out from the player so blades sweep enemies
        // outward, never trapping them against the body.
        const ddx = e.x - p.x, ddy = e.y - p.y, dd = Math.hypot(ddx, ddy) || 1;
        e.x += ddx / dd * 4 * dt * 60 * 0.016;
        e.y += ddy / dd * 4 * dt * 60 * 0.016;
      }
    }
    for (const o of world.players.values()) {
      if (o.id === p.id || o.dead) continue;
      const dxp = o.x - p.x, dyp = o.y - p.y;
      const proj = dxp * ux + dyp * uy;
      if (proj < innerR - bs || proj > outerR + bs) continue;
      const tProj = proj < innerR ? innerR : (proj > outerR ? outerR : proj);
      const cx = p.x + ux * tProj, cy = p.y + uy * tProj;
      const px2 = o.x - cx, py2 = o.y - cy;
      const rr = bs + pRadius(o);
      if (px2 * px2 + py2 * py2 < rr * rr) {
        damagePlayer(world, o, bdmg * dt * 8, p);
      }
    }
  }

  // Gem pickup (with magnet pull). Magnet powerup: 3× range + 1.5× pull.
  const magnetR = p.magnet * (p.magnetT > 0 ? 3 : 1);
  const magnetPullMul = p.magnetT > 0 ? 1.5 : 1;
  for (const g of world.gems.values()) {
    const dx = p.x - g.x, dy = p.y - g.y, d = Math.hypot(dx, dy);
    if (d < magnetR) {
      const pull = ((1 - d / magnetR) * 600 + 80) * magnetPullMul;
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

// Weighted pick — used by augment-orb spawn. Damage upgrades are 2× weighted
// so a build actually scales toward damage instead of accumulating random
// utility picks. Without this, the chance of any specific damage upgrade was
// 1/17 and stacking KEEN EDGE three times was a coin-flip-cubed event.
function weightedPick(pool) {
  let total = 0;
  for (let i = 0; i < pool.length; i++) total += (pool[i].weight || 1);
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= (pool[i].weight || 1);
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

// ---------- Augment orbs (in-world level-up pickups) ----------
function spawnAugmentOrb(world, p) {
  // Pool of usable upgrades for this player.
  const pool = UPGRADES.filter(u => (p.upgradeUses[u.id] || 0) < u.max);
  let upg;
  // PATCH UP — only when truly low (HP < 35 %), modest probability (30 %),
  // AND with a 15 s cooldown so chained level-ups during a fight don't all
  // become heals. Was 55 % threshold + 50 % chance + no cooldown, which
  // turned every levelup-during-combat into PATCH UP.
  const lowHp = p.hp / p.maxHp < 0.35;
  const healCdElapsed = world.t - (p._lastHealOffer != null ? p._lastHealOffer : -100) > 15;
  if (lowHp && healCdElapsed && Math.random() < 0.30) {
    upg = { id: 'instant_heal', name: 'PATCH UP', desc: 'Restore 50% HP', max: 99, tag: 'heal' };
    p._lastHealOffer = world.t;
  } else if (pool.length > 0) {
    upg = weightedPick(pool);
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
  const bRad = pRadius(b);
  let threat = null, threatD = Infinity;
  let humanTarget = null, humanTargetD = Infinity;
  let botTarget = null, botTargetD = Infinity;
  let sx = 0, sy = 0; // separation accumulator (away from nearby entities)
  for (const o of world.players.values()) {
    if (o.id === b.id || o.dead) continue;
    const ox = o.x - b.x, oy = o.y - b.y;
    const d = Math.hypot(ox, oy);
    // Tight personal-bubble separation: scaled by both bodies' radii.
    const bubble = (bRad + pRadius(o)) * 1.6;
    if (d > 0 && d < bubble) {
      const w = (1 - d / bubble);
      sx -= (ox / d) * w;
      sy -= (oy / d) * w;
    }
    if (d > view) continue;
    if (o.mass > b.mass * 1.5) {
      // Clearly bigger — flee.
      if (d < threatD) { threatD = d; threat = o; }
    } else if (!o.isBot) {
      // Humans always preferred targets — bots focus combat on the real player.
      if (d < humanTargetD) { humanTargetD = d; humanTarget = o; }
    } else {
      // Other bots are fallback targets when no human is in view.
      if (d < botTargetD) { botTargetD = d; botTarget = o; }
    }
  }
  const target = humanTarget || botTarget;
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
    b._aiTargetId = -1;
  } else if (shrine) {
    dx = shrine.x - b.x; dy = shrine.y - b.y;
    b._aiTargetId = -1;
  } else if (target) {
    // Orbit at ~70 % of outer reach so target sits in the MIDDLE of the blade
    // line (not at the tip). With line-blades, the further inside the segment
    // the target is, the more frequently the rotating line passes through it
    // — every rotation guaranteed contact instead of a near-miss at the tip.
    if (b._aiTargetId !== target.id) {
      b._aiTargetId = target.id;
      b._orbitDir = Math.random() < 0.5 ? 1 : -1;
    }
    if (Math.random() < 0.004) b._orbitDir = -b._orbitDir; // occasional juke
    const px = target.x - b.x, py = target.y - b.y;
    const pd = Math.hypot(px, py) || 1;
    const optimalDist = Math.max(
      pRadius(b) + pRadius(target) + 6,
      pBladeRadius(b) * 0.7
    );
    const radialErr = pd - optimalDist;
    const radial = Math.tanh(radialErr / 150); // gentler — spiral in, never rush
    const ux = px / pd, uy = py / pd;
    const tangential = Math.max(0.5, 1 - Math.abs(radial) * 0.45); // strong swirl always present
    dx = ux * radial + (-uy) * b._orbitDir * tangential;
    dy = uy * radial + ( ux) * b._orbitDir * tangential;
  } else {
    b._aiTargetId = -1;
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
  // Cap separation so it can't dominate the chase / wander vector.
  const sm = Math.hypot(sx, sy);
  if (sm > 1) { sx /= sm; sy /= sm; }
  const tm = Math.hypot(dx, dy) || 1;
  const mx = (dx / tm) + sx * 0.55;
  const my = (dy / tm) + sy * 0.55;
  const m = Math.hypot(mx, my) || 1;
  return { mx: mx / m, my: my / m, dash: false };
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
  // Weighted draw without replacement — pick, remove, re-roll on remaining.
  while (picks.length < 3 && pool.length > 0) {
    const u = weightedPick(pool);
    const idx = pool.indexOf(u);
    if (idx >= 0) pool.splice(idx, 1);
    picks.push(u);
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

  // Player body collision — solid bodies. A small player can no longer
  // hide INSIDE a bigger one (which kept them out of blade reach). Mass-
  // weighted overlap resolution: lighter player gets pushed more.
  for (const p of world.players.values()) {
    if (p.dead) continue;
    for (const o of world.players.values()) {
      if (o.id <= p.id || o.dead) continue;     // each pair processed once
      const dx = o.x - p.x, dy = o.y - p.y;
      const d2 = dx * dx + dy * dy;
      const pR = pRadius(p), oR = pRadius(o);
      const minD = pR + oR;
      if (d2 > 0 && d2 < minD * minD) {
        const d = Math.sqrt(d2);
        const overlap = minD - d;
        const total = p.mass + o.mass;
        const pShare = o.mass / total;       // p moves a share proportional to o's mass
        const oShare = p.mass / total;
        const ux = dx / d, uy = dy / d;
        p.x -= ux * overlap * pShare;
        p.y -= uy * overlap * pShare;
        o.x += ux * overlap * oShare;
        o.y += uy * overlap * oShare;
        p.x = clamp(p.x, pR, WORLD.w - pR);
        p.y = clamp(p.y, pR, WORLD.h - pR);
        o.x = clamp(o.x, oR, WORLD.w - oR);
        o.y = clamp(o.y, oR, WORLD.h - oR);
      }
    }
  }

  // Boss waves — every BOSS_WAVE_INTERVAL seconds, a swarm of champions
  // descends. We emit a `boss_wave_warning` event BOSS_WAVE_TELEGRAPH
  // seconds before so the client can ramp tension (toast + dramatic audio).
  // The swarm size grows with each wave: 1, 2, 3, 4, 5(cap).
  const nextWave = world._nextBossWave || BOSS_WAVE_INTERVAL;
  if (!world._bossWaveWarned && world.t >= nextWave - BOSS_WAVE_TELEGRAPH) {
    const waveNum = Math.floor(nextWave / BOSS_WAVE_INTERVAL);
    world._bossWaveWarned = true;
    world.events.push({ type: 'boss_wave_warning', n: Math.min(5, waveNum), wave: waveNum });
  }
  if (world.t >= nextWave) {
    const waveNum = Math.floor(nextWave / BOSS_WAVE_INTERVAL);
    const champCount = Math.min(5, waveNum);
    const players = [...world.players.values()].filter(p => !p.dead);
    if (players.length > 0) {
      const wave = 1 + Math.floor(world.t / 30);
      for (let i = 0; i < champCount; i++) {
        const target = players[Math.floor(Math.random() * players.length)];
        const ang = Math.random() * TAU;
        const dist = rand(700, 1100);
        const ex = clamp(target.x + Math.cos(ang) * dist, 50, WORLD.w - 50);
        const ey = clamp(target.y + Math.sin(ang) * dist, 50, WORLD.h - 50);
        const e = {
          id: nid(world),
          x: ex, y: ey, r: 32,
          hp: 280 + wave * 16, maxHp: 280 + wave * 16,
          speed: 60 + wave * 0.9, dmg: 26, xp: 24,
          kind: 'champion', atkRate: 0.85,
          hitT: 0, atkCd: Math.random() * 0.3,
          _dmgAcc: 0, _dmgEmitT: 0,
        };
        world.enemies.set(e.id, e);
        world.events.push({ type: 'champion_spawn', x: e.x, y: e.y, id: e.id });
      }
      world.events.push({ type: 'boss_wave', n: champCount, wave: waveNum });
    }
    world._nextBossWave = nextWave + BOSS_WAVE_INTERVAL;
    world._bossWaveWarned = false;
  }

  // Spawn mobs. Tuned down from earlier values — peak spawn was hitting
  // 7-13 mobs/sec which saturated ENEMY_CAP and created visual mosh-pit
  // chaos. New cap: ~2.5 mobs/sec at peak intensity.
  world.spawnT -= dt;
  if (world.spawnT <= 0) {
    const intensity = clamp(world.t / 60, 0.5, 1.4);
    world.spawnT = rand(0.50, 0.85) / intensity;
    const burstN = 1 + Math.floor(intensity * 0.3);
    for (let i = 0; i < burstN; i++) spawnEnemy(world);
  }
  if (world.enemies.size > ENEMY_CAP) {
    // Map keys are insertion-ordered → oldest first.
    const drop = world.enemies.size - ENEMY_CAP;
    let i = 0;
    for (const id of world.enemies.keys()) {
      world.enemies.delete(id);
      if (++i >= drop) break;
    }
  }

  // Spatial grid of enemies for cheap separation queries.
  // Recycle the inner arrays through a pool so we don't allocate ~25
  // arrays per tick (= 750/sec at 30 Hz) — a real GC pressure source.
  const SEP_CELL = 220;
  const sepGrid = world._sepGrid;
  const sepPool = world._sepCellPool;
  for (const arr of sepGrid.values()) { arr.length = 0; sepPool.push(arr); }
  sepGrid.clear();
  for (const e of world.enemies.values()) {
    const key = (Math.floor(e.x / SEP_CELL) + 100) * 1000 + (Math.floor(e.y / SEP_CELL) + 100);
    let arr = sepGrid.get(key);
    if (!arr) {
      arr = sepPool.pop() || [];
      sepGrid.set(key, arr);
    }
    arr.push(e);
  }

  // Mobs chase nearest alive player, with separation + per-enemy attack cooldown
  for (const e of world.enemies.values()) {
    e.hitT = Math.max(0, e.hitT - dt);
    if (e.atkCd > 0) e.atkCd -= dt;

    let nearest = null, nd = Infinity;
    for (const p of world.players.values()) {
      if (p.dead) continue;
      const d = dist2(e.x, e.y, p.x, p.y);
      if (d < nd) { nd = d; nearest = p; }
    }
    if (!nearest) continue;

    const cdx = nearest.x - e.x, cdy = nearest.y - e.y;
    const cd = Math.hypot(cdx, cdy) || 1;
    let mx = cdx / cd, my = cdy / cd;

    // Summoner — kites at ~400 px and periodically summons ONE fast minion.
    // Earlier version pumped 2 minions every 5-8 s and overflowed the map;
    // even a single summoner could fill ENEMY_CAP in under a minute. Now:
    // 1 minion every 9-14 s, and only when we're under 85 % of the cap.
    if (e.kind === 'summoner') {
      e._summonT = (e._summonT || 8) - dt;
      if (e._summonT <= 0 && world.enemies.size < ENEMY_CAP * 0.85) {
        e._summonT = rand(9, 14);
        const ang = Math.random() * TAU;
        const m = {
          id: nid(world),
          x: e.x + Math.cos(ang) * 30,
          y: e.y + Math.sin(ang) * 30,
          r: 9, hp: 8, maxHp: 8, speed: 130, dmg: 6, xp: 1,
          kind: 'fast', atkRate: 0.4,
          hitT: 0, atkCd: 0, _dmgAcc: 0, _dmgEmitT: 0,
        };
        world.enemies.set(m.id, m);
        world.events.push({ type: 'summon', x: e.x, y: e.y });
      } else if (e._summonT <= 0) {
        // Cap-throttled — recheck shortly. Stops the timer from firing
        // every tick once we've cleared the cap.
        e._summonT = 1.5;
      }
      if (cd < 400) { mx = -mx; my = -my; }    // kite away
    }

    // Separation: 3x3 neighborhood
    const ecx = Math.floor(e.x / SEP_CELL), ecy = Math.floor(e.y / SEP_CELL);
    let sx = 0, sy = 0;
    for (let gx = -1; gx <= 1; gx++) {
      for (let gy = -1; gy <= 1; gy++) {
        const arr = sepGrid.get((ecx + gx + 100) * 1000 + (ecy + gy + 100));
        if (!arr) continue;
        for (const o of arr) {
          if (o === e) continue;
          const ox = e.x - o.x, oy = e.y - o.y;
          const od2 = ox * ox + oy * oy;
          const minD = (e.r + o.r) * 1.6;
          if (od2 > 0 && od2 < minD * minD) {
            const od = Math.sqrt(od2);
            const w = 1 - od / minD;
            sx += (ox / od) * w;
            sy += (oy / od) * w;
          }
        }
      }
    }

    // Cap separation so it can't reverse the chase direction.
    const sm = Math.hypot(sx, sy);
    if (sm > 1) { sx /= sm; sy /= sm; }
    mx = mx + sx * 0.45;
    my = my + sy * 0.45;
    const ml = Math.hypot(mx, my) || 1;
    // Slow-mo powerup: enemies near a buffed player move at half speed.
    const speedMul = nearest.slowmoT > 0 ? 0.5 : 1;
    e.x += (mx / ml) * e.speed * speedMul * dt;
    e.y += (my / ml) * e.speed * speedMul * dt;

    const r2 = pRadius(nearest) + e.r;
    if (e.atkCd <= 0 && dist2(nearest.x, nearest.y, e.x, e.y) < r2 * r2) {
      damagePlayer(world, nearest, e.dmg, e);
      e.atkCd = e.atkRate || 0.55;
    }
  }

  // Gems: decay uncollected drops + hard cap. Without this, kill 500 mobs
  // in distant corners and you've got 500 gem objects allocated forever
  // until someone walks them. On 512 MB free tier that's the leak.
  for (const g of world.gems.values()) {
    g.life = (g.life != null ? g.life : GEM_LIFE) - dt;
    if (g.life <= 0) world.gems.delete(g.id);
  }
  if (world.gems.size > GEM_CAP) {
    const drop = world.gems.size - GEM_CAP;
    let i = 0;
    for (const id of world.gems.keys()) {
      world.gems.delete(id);
      if (++i >= drop) break;
    }
  }

  // Augment orb hard cap — bots can't spawn them but humans leveling up fast
  // could in theory pile orbs if they ignore them. Prune oldest first.
  if (world.augments.size > AUGMENT_CAP) {
    const drop = world.augments.size - AUGMENT_CAP;
    let i = 0;
    for (const id of world.augments.keys()) {
      world.augments.delete(id);
      if (++i >= drop) break;
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


  // Power-up orbs — rare floating buffs. Spawn timer ticks; when it fires
  // and we're under the cap, pop one in at a random map location.
  world._powerupT = (world._powerupT != null ? world._powerupT : POWERUP_INTERVAL_MIN) - dt;
  if (world._powerupT <= 0) {
    if (world.powerups.size < POWERUP_CAP) {
      const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
      const px = rand(200, WORLD.w - 200);
      const py = rand(200, WORLD.h - 200);
      const pu = { id: nid(world), x: px, y: py, r: 22, type, life: POWERUP_LIFE };
      world.powerups.set(pu.id, pu);
      world.events.push({ type: 'powerup_spawn', x: px, y: py, kind: type });
    }
    world._powerupT = rand(POWERUP_INTERVAL_MIN, POWERUP_INTERVAL_MAX);
  }
  // Decay + pickup pass.
  for (const pu of world.powerups.values()) {
    pu.life -= dt;
    if (pu.life <= 0) { world.powerups.delete(pu.id); continue; }
    for (const ply of world.players.values()) {
      if (ply.dead) continue;
      const rr = pRadius(ply) + pu.r;
      if (dist2(ply.x, ply.y, pu.x, pu.y) < rr * rr) {
        const dur = POWERUP_DURATIONS[pu.type] || 5;
        // Buffs stack up to their max duration — picking up two shields in
        // a row gives you the longer remaining timer, not 2× the duration.
        if      (pu.type === 'shield')  ply.shieldT  = Math.max(ply.shieldT,  dur);
        else if (pu.type === 'berserk') ply.berserkT = Math.max(ply.berserkT, dur);
        else if (pu.type === 'magnet')  ply.magnetT  = Math.max(ply.magnetT,  dur);
        else if (pu.type === 'slowmo')  ply.slowmoT  = Math.max(ply.slowmoT,  dur);
        world.events.push({
          type: 'powerup_pickup',
          x: pu.x, y: pu.y, playerId: ply.id, kind: pu.type,
        });
        world.powerups.delete(pu.id);
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

// ---------- Per-viewer snapshot culling ----------
// Each client only needs entities within its view + a margin. Without this,
// every connected client receives every enemy/gem/augment in the world every
// tick. With 50 clients and ~120 enemies + ~250 gems, that's 50× the same
// data hitting the wire. Culling keeps each client's snap to ~30 enemies +
// ~50 gems — the data they actually need to render.
const VIEW_CULL_R = 1300;             // viewport diagonal at min zoom + slack
const VIEW_CULL_R2 = VIEW_CULL_R * VIEW_CULL_R;

function cullSnapshot(full, viewerId, vx, vy) {
  const enemies = [];
  for (let i = 0; i < full.enemies.length; i++) {
    const e = full.enemies[i];
    const dx = e.x - vx, dy = e.y - vy;
    if (dx * dx + dy * dy < VIEW_CULL_R2) enemies.push(e);
  }
  const gems = [];
  for (let i = 0; i < full.gems.length; i++) {
    const g = full.gems[i];
    const dx = g.x - vx, dy = g.y - vy;
    if (dx * dx + dy * dy < VIEW_CULL_R2) gems.push(g);
  }
  const augments = [];
  for (let i = 0; i < full.augments.length; i++) {
    const a = full.augments[i];
    // Always include orbs owned by viewer so they can navigate to them
    // even if the orb drifted off-screen.
    if (a.o === viewerId) { augments.push(a); continue; }
    const dx = a.x - vx, dy = a.y - vy;
    if (dx * dx + dy * dy < VIEW_CULL_R2) augments.push(a);
  }
  const powerups = [];
  for (let i = 0; i < full.powerups.length; i++) {
    const pu = full.powerups[i];
    const dx = pu.x - vx, dy = pu.y - vy;
    if (dx * dx + dy * dy < VIEW_CULL_R2) powerups.push(pu);
  }
  return {
    t: full.t,
    players: full.players,    // keep all — needed for leaderboard + minimap
    enemies, gems, augments, powerups,
    shrines: full.shrines,
    events: full.events,
  };
}

// ---------- Snapshot for network ----------
// Compact representation; only what the client needs to render.
function snapshot(world) {
  const players = [];
  for (const p of world.players.values()) {
    // Build the base — the always-present fields. Effect timers below
    // are conditionally added so a clean player isn't shipping six
    // zero fields per tick × 50 players × 30 Hz.
    const sp = {
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
    };
    // Effect timers — only emitted when active. Client treats undefined
    // as 0 (everything is `if (p.kg > 0)`-style). Saves ~30 bytes/player
    // /tick × 50 players × 30 Hz = ~45 KB/sec of zero fields.
    if (p.killGlow > 0) sp.kg = Math.round(p.killGlow * 10) / 10;
    if (p.shieldT  > 0) sp.sh = Math.round(p.shieldT  * 10) / 10;
    if (p.berserkT > 0) sp.bk = Math.round(p.berserkT * 10) / 10;
    if (p.magnetT  > 0) sp.mg = Math.round(p.magnetT  * 10) / 10;
    if (p.slowmoT  > 0) sp.sm = Math.round(p.slowmoT  * 10) / 10;
    if (p._executeT > 0) sp.ex = Math.round(p._executeT * 10) / 10;
    players.push(sp);
  }
  const enemies = [];
  for (const e of world.enemies.values()) {
    enemies.push({
      id: e.id,
      x: Math.round(e.x), y: Math.round(e.y),
      r: e.r, h: Math.ceil(e.hp), mh: e.maxHp, k: e.kind,
      dz: e.dz ? 1 : 0,                        // danger-zone tint flag
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
  const powerups = [];
  for (const pu of world.powerups.values()) {
    powerups.push({
      id: pu.id,
      x: Math.round(pu.x), y: Math.round(pu.y),
      k: pu.type,
      l: Math.round(pu.life * 10) / 10,
    });
  }
  return {
    // Precise enough to drive client-side blade-angle sync without visible jitter.
    t: Math.round(world.t * 1000) / 1000,
    players, enemies, gems, augments, powerups, shrines,
    events: world.events.slice(),
  };
}

module.exports = {
  WORLD, ARCHETYPES, UPGRADES, TAU,
  newWorld, initWorld, makePlayer, nid,
  tickWorld, tickPlayer, botIntent, generateLevelUpOptions, applyUpgrade,
  pRadius, pSpeed, pBladeRadius, pBladeInner, pBladeSize, pBladeDmg, pView,
  snapshot, cullSnapshot,
};
