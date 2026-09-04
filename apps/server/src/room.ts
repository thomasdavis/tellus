import type { WebSocket } from 'ws';
import {
  AOI_RADIUS,
  Anim,
  PROTOCOL_VERSION,
  clamp,
  encodeSnapshot,
  type ClientMessage,
  type EntityState,
  type Input,
  type PlayerSnapshot,
  type ServerMessage,
} from '@tellus/protocol';
import { Registry, SpatialHashGrid, Store, integrate, type Entity } from '@tellus/world';

interface Player {
  id: Entity;
  ws: WebSocket;
  name: string;
  character: string;
  x: number;
  z: number;
  yaw: number;
  anim: Anim;
  queue: Input[]; // pending input commands, processed in order each tick
  lastSeq: number; // last input seq applied (echoed back so the client can reconcile)
  known: Set<Entity>; // entities currently inside this client's area of interest
}

const AOI_SQ = AOI_RADIUS * AOI_RADIUS;
const MAX_QUEUE = 120;

/** The authoritative simulation of one shared world instance. */
export class Room {
  private readonly registry = new Registry();
  private readonly players = new Store<Player>();
  private readonly grid = new SpatialHashGrid();
  private readonly pending = new WeakMap<WebSocket, true>(); // connected, not yet joined
  private tickNo = 0;

  constructor(private readonly worldHalf: number) {}

  attach(ws: WebSocket): void {
    this.pending.set(ws, true);
    ws.on('message', (data: Buffer) => this.onMessage(ws, data));
    ws.on('close', () => this.onClose(ws));
    ws.on('error', () => ws.terminate());
  }

  private snapshotOf(p: Player): PlayerSnapshot {
    return { id: p.id, name: p.name, character: p.character, x: p.x, z: p.z, yaw: p.yaw, anim: p.anim };
  }

  private send(ws: WebSocket, m: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  }

  private onMessage(ws: WebSocket, data: Buffer): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString('utf8')) as ClientMessage;
    } catch {
      return;
    }
    const player = (ws as WebSocket & { _pid?: Entity })._pid;
    if (msg.t === 'hello') return void this.join(ws, msg.name, msg.character, msg.v);
    if (player === undefined) return; // must join first
    const p = this.players.get(player);
    if (!p) return;

    switch (msg.t) {
      case 'input': {
        const seq = msg.seq | 0;
        if (seq <= p.lastSeq) return; // stale / duplicate
        p.queue.push({
          seq,
          dt: clamp(Number(msg.dt) || 0, 0, 0.1),
          f: clamp(Number(msg.f) || 0, -1, 1),
          r: clamp(Number(msg.r) || 0, -1, 1),
          yaw: Number.isFinite(msg.yaw) ? msg.yaw : p.yaw,
          run: !!msg.run,
        });
        if (p.queue.length > MAX_QUEUE) p.queue.splice(0, p.queue.length - MAX_QUEUE);
        break;
      }
      case 'chat': {
        const text = String(msg.text ?? '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 160);
        if (text) this.broadcast({ t: 'chat', id: p.id, name: p.name, text });
        break;
      }
      case 'ping':
        this.send(ws, { t: 'pong', time: msg.time });
        break;
    }
  }

  private join(ws: WebSocket, name: string, character: string, v: number): void {
    if (!this.pending.has(ws)) return; // already joined
    if (v !== PROTOCOL_VERSION) return this.send(ws, { t: 'reject', reason: 'protocol version mismatch' });
    this.pending.delete(ws);

    const id = this.registry.create();
    const spawn = (this.worldHalf - 4) * 0.25;
    const p: Player = {
      id,
      ws,
      name: (name || 'traveler').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 16) || 'traveler',
      character: String(character || '').slice(0, 64),
      x: (Math.random() * 2 - 1) * spawn,
      z: (Math.random() * 2 - 1) * spawn,
      yaw: Math.random() * Math.PI * 2,
      anim: Anim.Idle,
      queue: [],
      lastSeq: 0,
      known: new Set([id]),
    };
    this.players.set(id, p);
    (ws as WebSocket & { _pid?: Entity })._pid = id;

    // Neighbours are streamed in by the first tick's enter-detection, keeping one
    // code path for "someone entered view". Welcome just seeds you + the world.
    this.send(ws, { t: 'welcome', id, tick: this.tickNo, you: this.snapshotOf(p), players: [], worldHalf: this.worldHalf });
    console.log(`+ ${p.name} joined as ${p.character || '?'} (${this.players.size} online)`);
  }

  private onClose(ws: WebSocket): void {
    this.pending.delete(ws);
    const id = (ws as WebSocket & { _pid?: Entity })._pid;
    if (id === undefined) return;
    const p = this.players.get(id);
    if (!p) return;
    this.players.remove(id);
    this.registry.destroy(id);
    for (const [, other] of this.players) {
      if (other.known.delete(id)) this.send(other.ws, { t: 'leave', id });
    }
    console.log(`- ${p.name} left (${this.players.size} online)`);
  }

  private broadcast(m: ServerMessage): void {
    for (const p of this.players.values()) this.send(p.ws, m);
  }

  /** One authoritative step: apply inputs, rebuild the grid, stream interest sets. */
  tick(): void {
    this.tickNo++;

    // 1) advance every player through its buffered input commands
    for (const p of this.players.values()) {
      for (const cmd of p.queue) {
        const next = integrate(p, cmd);
        p.x = next.x;
        p.z = next.z;
        p.yaw = next.yaw;
        p.anim = next.anim;
        p.lastSeq = cmd.seq;
      }
      p.queue.length = 0;
    }

    // 2) rebuild the spatial index
    this.grid.clear();
    for (const [id, p] of this.players) this.grid.insert(id, p.x, p.z);

    // 3) per-viewer area-of-interest: enter/leave events + a binary position frame
    const candidates: number[] = [];
    for (const [, viewer] of this.players) {
      candidates.length = 0;
      this.grid.queryRadius(viewer.x, viewer.z, AOI_RADIUS, candidates);

      const ents: EntityState[] = [];
      const visible = new Set<Entity>();
      for (const cid of candidates) {
        const q = this.players.get(cid);
        if (!q) continue;
        const dx = q.x - viewer.x;
        const dz = q.z - viewer.z;
        if (dx * dx + dz * dz > AOI_SQ) continue;
        visible.add(cid);
        ents.push({ id: cid, x: q.x, z: q.z, yaw: q.yaw, anim: q.anim });
        if (cid !== viewer.id && !viewer.known.has(cid)) {
          this.send(viewer.ws, { t: 'join', player: this.snapshotOf(q) });
        }
      }
      for (const cid of viewer.known) {
        if (!visible.has(cid)) this.send(viewer.ws, { t: 'leave', id: cid });
      }
      viewer.known = visible;

      if (viewer.ws.readyState === viewer.ws.OPEN) {
        viewer.ws.send(Buffer.from(encodeSnapshot(this.tickNo, viewer.lastSeq, ents)));
      }
    }
  }

  get population(): number {
    return this.players.size;
  }
}
