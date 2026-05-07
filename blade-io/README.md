# BLADE.IO

Multiplayer survivor-like .io game. Eat shards, grow, hunt smaller players, run from bigger ones.

## Run locally

```
npm install
npm start
```

Open http://localhost:3000/

## Deploy

See [DEPLOY.md](./DEPLOY.md). Short version: install flyctl, run `fly launch --copy-config --no-deploy`, then `fly deploy`. Public URL in ~90 seconds.

## Architecture

- **Server** (`server/index.js`) — Node.js + `ws`. Authoritative simulation at 30 Hz. Broadcasts JSON snapshots to all connected clients.
- **Sim** (`server/sim.js`) — pure simulation logic. No DOM, no network. Runs server-side; client could load it for prediction (currently uses a simpler hand-rolled local predictor for the player).
- **Client** (`public/index.html`) — single HTML file. Sends inputs at 30 Hz, renders snapshots at 60 fps with 100ms interpolation buffer.

### Wire protocol

Client → server:
- `{type:'join', name, archetype}` — request to join
- `{type:'input', mx, my, dash}` — movement intent (sent ~30 Hz)
- `{type:'pick_upgrade', id}` — choose an augment after level up
- `{type:'respawn', archetype}` — rejoin after death
- `{type:'ping', t}` — ping for RTT

Server → client:
- `{type:'hello', maxPlayers, world:{w,h}}` — on connect
- `{type:'joined', id, archetype}` — your player is in the world
- `{type:'reject', reason}` — server full or bad request
- `{type:'snap', s}` — full state snapshot every tick (~30 Hz)
- `{type:'level_up', options}` — choose an augment
- `{type:'pong', t}` — ping reply

## Bot fill

Server keeps 5 bots alive when human count is < 6. Once you have ~6+ humans connected, bots gradually leave.

## Anti-abuse (alpha-grade)

- Names sanitized to `[A-Z0-9_-]`, max 14 chars
- Inputs clamped to `[-1, 1]` and required to be finite
- Unknown archetypes fall back to `dervish`
- 100 messages/sec rate limit per socket; over → kick
- Idle sockets (45s no message) closed
- Server is fully authoritative; clients can't move faster, hit harder, or eat farther

## Known limitations

- Single global room. Multi-room is a refactor away.
- No persistence. Every refresh is a fresh session.
- JSON snapshots are larger than they need to be. A binary protocol (e.g. flatbuffers or hand-rolled) is the obvious next perf win at scale.
- Local prediction is intentionally light (just the player). Other entities are interpolated between snapshots, which means quick blade swings have a 100ms latency to display.
