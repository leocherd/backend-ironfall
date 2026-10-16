'use strict';

const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('@colyseus/core');
const { WebSocketTransport } = require('@colyseus/ws-transport');

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '32kb' }));

const roomByCode = new Map();

app.get('/', (_req, res) => res.json({ name: 'IRONFALL ARENA Colyseus Server', status: 'ok' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', activeRooms: roomByCode.size }));
app.get('/find-room/:code', (req, res) => {
  const code = String(req.params.code || '');
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Invalid room code.' });
  const room = roomByCode.get(code);
  if (!room || room._disposed) return res.status(404).json({ error: 'Room code not found.' });
  return res.json({ roomId: room.roomId, roomCode: code, mode: room.mode });
});

const httpServer = http.createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer })
});

function makeCode() {
  let code;
  do { code = String(Math.floor(100000 + Math.random() * 900000)); }
  while (roomByCode.has(code));
  return code;
}

function safeName(value) {
  const s = String(value || 'OPERATOR').replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 20);
  return s || 'OPERATOR';
}

class IronfallRoom extends require('@colyseus/core').Room {
  onCreate(options = {}) {
    this.mode = options.mode === 'coop' ? 'coop' : 'ffa';
    this.maxClients = this.mode === 'coop' ? 4 : 8;
    this.roomCode = makeCode();
    this.hostId = null;
    this.started = false;
    this.round = 0;
    this.maxRounds = 5;
    this.roundEnding = false;
    this.players = new Map();
    this.npcs = new Map();
    this.npcKills = 0;
    this.reviveTokens = 0;
    this.wave = 0;
    this.npcHitCounts = new Map();
    roomByCode.set(this.roomCode, this);

    this.onMessage('move', (client, data = {}) => this.handleMove(client, data));
    this.onMessage('shoot', (client, data = {}) => {
      const p = this.players.get(client.sessionId);
      if (!p || !this.started || !data.origin || !data.end) return;
      this.broadcast('remoteShoot', {
        id: client.sessionId,
        origin: this.vector(data.origin),
        end: this.vector(data.end)
      }, { except: client });
    });
    this.onMessage('startMatch', client => this.startMatch(client));
    this.onMessage('hitPlayer', (client, data = {}) => this.handlePlayerHit(client, data));
    this.onMessage('hitNpc', (client, data = {}) => this.handleNpcHit(client, data));
    this.onMessage('npcHitPlayer', client => this.handleNpcAttack(client));
    this.onMessage('reviveTeammate', (client, data = {}) => this.handleRevive(client, data));
    this.onMessage('vendingBuy', (client, data = {}) => this.handlePurchase(client, data));
    this.onMessage('kickPlayer', (client, targetId) => this.kickPlayer(client, targetId));
    this.onMessage('returnToLobby', client => this.returnToLobby(client));
  }

  vector(v) {
    const n = value => Number.isFinite(Number(value)) ? Math.max(-1000, Math.min(1000, Number(value))) : 0;
    return { x: n(v.x), y: n(v.y), z: n(v.z) };
  }

  onAuth(_client, _options) {
    if (this.started) throw new Error('MATCH ALREADY STARTED.');
    return true;
  }

  onJoin(client, options = {}) {
    if (!this.hostId) this.hostId = client.sessionId;
    const p = {
      id: client.sessionId,
      name: safeName(options.name),
      gun: Number.isInteger(options.primary) ? options.primary : 0,
      secondary: Number.isInteger(options.secondary) ? options.secondary : 1,
      coins: Math.max(0, Math.min(1000000, Number(options.coins) || 200)),
      x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
      hp: 100, armor: 40, alive: true, downed: false,
      roundWins: 0, kills: 0, deaths: 0, bulletsTaken: 0
    };
    this.players.set(client.sessionId, p);
    this.broadcastLobbyState();
  }

  onLeave(client) {
    const left = this.players.get(client.sessionId);
    this.players.delete(client.sessionId);
    this.npcHitCounts.delete(client.sessionId);
    this.broadcast('playerLeft', { id: client.sessionId, name: left?.name || 'PLAYER' });
    if (this.hostId === client.sessionId) {
      this.hostId = this.players.keys().next().value || null;
    }
    this.broadcastLobbyState();
    if (this.started && this.mode === 'ffa') this.checkRoundEnd();
  }

  onDispose() {
    if (roomByCode.get(this.roomCode) === this) roomByCode.delete(this.roomCode);
  }

  publicPlayers() {
    const out = {};
    for (const [id, p] of this.players) out[id] = { ...p };
    return out;
  }

  broadcastLobbyState() {
    this.broadcast('lobbyState', {
      roomCode: this.roomCode,
      mode: this.mode,
      hostId: this.hostId,
      players: this.publicPlayers()
    });
  }

  handleMove(client, data) {
    const p = this.players.get(client.sessionId);
    if (!p) return;
    const pos = this.vector(data);
    p.x = pos.x; p.y = pos.y; p.z = pos.z;
    p.yaw = Number.isFinite(Number(data.yaw)) ? Number(data.yaw) : 0;
    p.pitch = Number.isFinite(Number(data.pitch)) ? Number(data.pitch) : 0;
    p.parachute = !!data.parachute;
    p.downed = p.downed || !!data.downed;
    if (Number.isInteger(data.gun) && data.gun >= 0 && data.gun < 20) p.gun = data.gun;
    this.broadcast('playerMoved', {
      id: p.id, name: p.name, x: p.x, y: p.y, z: p.z,
      yaw: p.yaw, pitch: p.pitch, parachute: p.parachute, downed: p.downed, gun: p.gun
    }, { except: client });
  }

  startMatch(client) {
    if (client.sessionId !== this.hostId) return this.error(client, 'ONLY THE HOST CAN START THE MATCH.');
    if (this.started) return;
    if (this.mode === 'ffa' && this.players.size < 2) return this.error(client, 'FFA REQUIRES AT LEAST TWO PLAYERS.');
    this.started = true;
    if (this.mode === 'ffa') {
      this.round = 1;
      for (const p of this.players.values()) { p.roundWins = 0; p.kills = 0; p.deaths = 0; }
      this.startFfaRound();
    } else {
      this.npcKills = 0; this.reviveTokens = 0; this.wave = 0; this.npcs.clear();
      this.broadcast('coopStartAirdrop', { players: this.publicPlayers() });
      setTimeout(() => { if (this.started && this.mode === 'coop') this.startCoopWave(); }, 4500);
    }
  }

  startFfaRound() {
    this.roundEnding = false;
    for (const [i, p] of [...this.players.values()].entries()) {
      p.alive = true; p.downed = false; p.hp = 100; p.armor = 40; p.bulletsTaken = 0;
      const angle = (i / Math.max(1, this.players.size)) * Math.PI * 2;
      p.x = Math.cos(angle) * 12; p.y = 0; p.z = Math.sin(angle) * 12;
    }
    this.broadcast('ffaRoundStart', { round: this.round, maxRounds: this.maxRounds, players: this.publicPlayers() });
  }

  handlePlayerHit(client, data) {
    if (!this.started || this.mode !== 'ffa' || this.roundEnding) return;
    const attacker = this.players.get(client.sessionId);
    const target = this.players.get(String(data.targetId || ''));
    if (!attacker || !target || attacker === target || !attacker.alive || !target.alive) return;
    const raw = Math.max(1, Math.min(200, Number(data.dmg) || 1));
    const absorbed = Math.min(target.armor, Math.round(raw * 0.35));
    target.armor -= absorbed;
    target.hp = Math.max(0, target.hp - (raw - absorbed));
    this.broadcast('playerDamaged', { targetId: target.id, hp: target.hp, armor: target.armor });
    if (target.hp <= 0) {
      target.alive = false; target.deaths++;
      attacker.kills++;
      this.broadcast('playerEliminated', {
        attackerId: attacker.id, attackerName: attacker.name,
        targetId: target.id, victimName: target.name, isHead: !!data.isHead
      });
      this.checkRoundEnd();
    }
  }

  checkRoundEnd() {
    if (!this.started || this.mode !== 'ffa' || this.roundEnding) return;
    const alive = [...this.players.values()].filter(p => p.alive);
    if (alive.length > 1) return;
    this.roundEnding = true;
    const winner = alive[0] || null;
    if (winner) winner.roundWins++;
    this.broadcast('ffaRoundEnd', { round: this.round, winnerName: winner?.name || 'NO WINNER', winnerId: winner?.id || null });
    setTimeout(() => {
      if (!this.started || this.mode !== 'ffa') return;
      if (this.round >= this.maxRounds) {
        const sorted = [...this.players.values()].sort((a, b) => b.roundWins - a.roundWins || b.kills - a.kills);
        const top = sorted[0];
        const overallWinner = top ? { id: top.id, name: top.name } : null;
        this.broadcast('ffaMatchEnd', { overallWinner, players: this.publicPlayers() });
        this.started = false;
        this.broadcastLobbyState();
      } else {
        this.round++;
        this.startFfaRound();
      }
    }, 3500);
  }

  startCoopWave() {
    if (!this.started || this.mode !== 'coop') return;
    this.wave++;
    const npcs = {};
    for (let i = 1; i <= 10; i++) {
      const index = (this.wave - 1) * 10 + i;
      const angle = (i / 10) * Math.PI * 2;
      const radius = 82 + Math.random() * 24;
      const hp = 90 + this.wave * 28;
      const npc = { id: `npc_${index}`, index, wave: this.wave, x: Math.cos(angle) * radius, z: Math.sin(angle) * radius, hp, maxHp: hp, dead: false };
      this.npcs.set(npc.id, npc); npcs[npc.id] = { ...npc };
    }
    this.broadcast('coopWaveStart', { wave: this.wave, npcsRemaining: 10, npcs });
  }

  handleNpcHit(client, data) {
    if (!this.started || this.mode !== 'coop') return;
    const npc = this.npcs.get(String(data.npcId || ''));
    const player = this.players.get(client.sessionId);
    if (!npc || npc.dead || !player) return;
    const damage = Math.max(1, Math.min(250, Number(data.dmg) || 1));
    npc.hp = Math.max(0, npc.hp - damage);
    if (npc.hp > 0) return;
    npc.dead = true;
    this.npcKills++;
    let tokenAwarded = false;
    if (this.npcKills > 0 && this.npcKills % 5 === 0) { this.reviveTokens++; tokenAwarded = true; }
    player.coins += 250; player.kills++;
    const remaining = [...this.npcs.values()].filter(n => !n.dead).length;
    this.broadcast('npcEliminated', {
      npcId: npc.id, killerId: client.sessionId, npcsRemaining: remaining,
      totalNpcsKilled: this.npcKills, reviveTokens: this.reviveTokens, tokenAwarded
    });
    if (this.npcKills >= 50) {
      this.broadcast('coopVictory', { totalNpcsKilled: this.npcKills });
      this.started = false;
      return;
    }
    if (remaining === 0) setTimeout(() => { if (this.started && this.mode === 'coop') this.startCoopWave(); }, 2500);
  }

  handleNpcAttack(client) {
    if (!this.started || this.mode !== 'coop') return;
    const p = this.players.get(client.sessionId);
    if (!p || p.downed) return;
    const hits = (this.npcHitCounts.get(client.sessionId) || 0) + 1;
    this.npcHitCounts.set(client.sessionId, hits);
    if (hits >= 5) {
      p.downed = true; p.hp = 0;
      this.broadcast('playerDowned', { id: p.id, name: p.name });
      const allDown = [...this.players.values()].every(player => player.downed);
      if (allDown) this.broadcast('coopDefeat', { totalNpcsKilled: this.npcKills, wave: this.wave });
    }
  }

  handleRevive(client, data) {
    if (!this.started || this.mode !== 'coop') return;
    const reviver = this.players.get(client.sessionId);
    const target = this.players.get(String(data.targetId || ''));
    if (!reviver || !target || !target.downed) return;
    if (data.useToken) {
      if (this.reviveTokens <= 0 || target.id !== reviver.id) return this.error(client, 'NO REVIVE TOKENS AVAILABLE.');
      this.reviveTokens--;
    } else {
      const distance = Math.hypot(reviver.x - target.x, reviver.y - target.y, reviver.z - target.z);
      if (distance > 3.5 || reviver.downed) return this.error(client, 'MOVE WITHIN 3 METRES AND HOLD TAB TO REVIVE.');
    }
    target.downed = false; target.hp = 65; target.armor = Math.max(target.armor, 0); target.bulletsTaken = 0;
    this.npcHitCounts.set(target.id, 0);
    this.broadcast('playerRevived', { targetId: target.id, reviveTokens: this.reviveTokens });
  }

  handlePurchase(client, data) {
    const p = this.players.get(client.sessionId);
    if (!p) return;
    const prices = { ammo: 75, frag: 100, smoke: 100, armor: 150, medkit: 125 };
    let price = prices[String(data.kind || '')];
    if (data.kind === 'weapon') {
      const costs = [0,150,250,300,400,600,700,800,1100,1300,1500,1800,2200,2600,2800,3500,3800,4200,4600,5000];
      const idx = Number(data.weaponIdx);
      if (!Number.isInteger(idx) || idx < 0 || idx >= costs.length) return this.error(client, 'INVALID WEAPON.');
      price = costs[idx];
    }
    if (!Number.isFinite(price)) return this.error(client, 'UNKNOWN ITEM.');
    if (p.coins < price) return this.error(client, 'INSUFFICIENT SERVER CREDITS.');
    p.coins -= price;
    this.sendWallet(client.sessionId);
  }

  sendWallet(id) {
    const p = this.players.get(id);
    const client = this.clients.find(c => c.sessionId === id);
    if (p && client) client.send('walletUpdate', { coins: p.coins });
  }

  kickPlayer(client, targetId) {
    if (client.sessionId !== this.hostId || !this.players.has(String(targetId))) return;
    const target = this.clients.find(c => c.sessionId === String(targetId));
    if (target) {
      target.send('kicked', {});
      target.leave(4001, 'Removed by room host');
    }
  }

  returnToLobby(client) {
    if (!this.players.has(client.sessionId)) return;
    this.started = false; this.roundEnding = false; this.npcs.clear();
    for (const p of this.players.values()) { p.alive = true; p.downed = false; p.hp = 100; p.armor = 40; }
    this.broadcastLobbyState();
  }

  error(client, message) { client.send('errorMsg', message); }
}

gameServer.define('ironfall_room', IronfallRoom);

const port = Number(process.env.PORT || 2567);
httpServer.listen(port, '0.0.0.0', () => {
  console.log(`IRONFALL ARENA Colyseus server listening on port ${port}`);
});
