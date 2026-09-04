import {
  PROTOCOL_VERSION,
  Anim,
  decodeSnapshot,
  encodeClient,
  type Input,
  type PlayerSnapshot,
  type ServerMessage,
} from '@tellus/protocol';
import { integrate, type MoveState } from '@tellus/world';

export interface RemoteSample {
  t: number; // seconds (performance.now/1000) the sample arrived
  x: number;
  z: number;
  yaw: number;
  anim: Anim;
}

export interface Remote {
  id: number;
  name: string;
  character: string;
  buf: RemoteSample[];
}

export type NetEvent =
  | { type: 'welcome'; self: PlayerSnapshot }
  | { type: 'players'; count: number }
  | { type: 'chat'; id: number; name: string; text: string }
  | { type: 'rejected'; reason: string }
  | { type: 'disconnect' };

export interface InputSample {
  f: number;
  r: number;
  yaw: number;
  run: boolean;
  dt: number;
}

/**
 * The client half of the netcode. Framework-agnostic on purpose: React reads
 * `local` / `remotes` every render frame, but nothing here depends on React.
 *
 *  • Prediction — `applyInput` runs the shared integrator locally so the avatar
 *    responds on the very frame a key is pressed.
 *  • Reconciliation — each snapshot carries the last input the server processed;
 *    we snap to that authoritative position and replay the not-yet-acked inputs.
 *  • Interpolation — other players are buffered and rendered a little in the past
 *    so their motion is smooth despite arriving in discrete snapshots.
 */
export class NetClient {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<(e: NetEvent) => void>();
  private seq = 0;
  private pending: Input[] = [];

  self: { id: number; name: string; character: string } | null = null;
  worldHalf = 120;
  online = 0;
  readonly local: MoveState = { x: 0, z: 0, yaw: 0, anim: Anim.Idle };
  readonly remotes = new Map<number, Remote>();

  constructor(private readonly url: string) {}

  on(fn: (e: NetEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: NetEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  connect(name: string, character: string): void {
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => ws.send(encodeClient({ t: 'hello', v: PROTOCOL_VERSION, name, character }));
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onclose = () => this.emit({ type: 'disconnect' });
    ws.onerror = () => this.emit({ type: 'disconnect' });
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  chat(text: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeClient({ t: 'chat', text }));
  }

  /** Predict one input frame and stream it to the server. */
  applyInput(s: InputSample): void {
    if (!this.self) return;
    const cmd: Input = { seq: ++this.seq, dt: s.dt, f: s.f, r: s.r, yaw: s.yaw, run: s.run };
    const next = integrate(this.local, cmd);
    this.local.x = next.x;
    this.local.z = next.z;
    this.local.yaw = next.yaw;
    this.local.anim = next.anim;
    this.pending.push(cmd);
    if (this.pending.length > 240) this.pending.shift();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeClient({ t: 'input', seq: cmd.seq, dt: cmd.dt, f: cmd.f, r: cmd.r, yaw: cmd.yaw, run: cmd.run }));
    }
  }

  private onMessage(data: unknown): void {
    if (typeof data === 'string') return this.onControl(JSON.parse(data) as ServerMessage);
    if (data instanceof ArrayBuffer) return this.onSnapshot(data);
  }

  private onControl(m: ServerMessage): void {
    switch (m.t) {
      case 'welcome':
        this.self = { id: m.id, name: m.you.name, character: m.you.character };
        this.worldHalf = m.worldHalf;
        this.local.x = m.you.x;
        this.local.z = m.you.z;
        this.local.yaw = m.you.yaw;
        this.local.anim = m.you.anim;
        this.online = 1;
        this.emit({ type: 'welcome', self: m.you });
        break;
      case 'join':
        this.remotes.set(m.player.id, { id: m.player.id, name: m.player.name, character: m.player.character, buf: [] });
        this.online = this.remotes.size + 1;
        this.emit({ type: 'players', count: this.online });
        break;
      case 'leave':
        this.remotes.delete(m.id);
        this.online = this.remotes.size + 1;
        this.emit({ type: 'players', count: this.online });
        break;
      case 'chat':
        this.emit({ type: 'chat', id: m.id, name: m.name, text: m.text });
        break;
      case 'reject':
        this.emit({ type: 'rejected', reason: m.reason });
        break;
      case 'pong':
        break;
    }
  }

  private onSnapshot(data: ArrayBuffer): void {
    const snap = decodeSnapshot(data);
    if (!snap || !this.self) return;
    const now = performance.now() / 1000;
    const selfId = this.self.id;

    for (const e of snap.ents) {
      if (e.id === selfId) {
        // reconcile: authoritative position + replay of un-acked inputs
        this.pending = this.pending.filter((c) => c.seq > snap.ackSeq);
        let s: MoveState = { x: e.x, z: e.z, yaw: e.yaw, anim: e.anim };
        for (const c of this.pending) s = integrate(s, c);
        this.local.x = s.x;
        this.local.z = s.z;
        this.local.yaw = s.yaw;
        this.local.anim = s.anim;
      } else {
        let r = this.remotes.get(e.id);
        if (!r) {
          r = { id: e.id, name: '…', character: e.id.toString(), buf: [] };
          this.remotes.set(e.id, r);
        }
        r.buf.push({ t: now, x: e.x, z: e.z, yaw: e.yaw, anim: e.anim });
        // keep ~1s of history for interpolation
        while (r.buf.length > 2 && r.buf[0]!.t < now - 1) r.buf.shift();
      }
    }
  }
}
