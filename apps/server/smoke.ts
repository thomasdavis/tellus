/**
 * End-to-end netcode smoke test: boots a real Room, connects two headless
 * clients, and asserts the handshake, input acknowledgement, interest events and
 * binary snapshots all flow. Run: `pnpm exec tsx apps/server/smoke.ts`
 */
import { WebSocketServer, WebSocket } from 'ws';
import { PROTOCOL_VERSION, TICK_MS, encodeClient, decodeSnapshot } from '@tellus/protocol';
import { Room } from './src/room.js';

const PORT = 8799;

interface ClientState {
  id: number;
  ws: WebSocket;
  sawSelf: boolean;
  sawOthers: Set<number>;
  snaps: number;
  ack: number;
}

function connect(name: string, character: string): Promise<ClientState> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.binaryType = 'arraybuffer';
    const st: ClientState = { id: 0, ws, sawSelf: false, sawOthers: new Set(), snaps: 0, ack: 0 };
    const timeout = setTimeout(() => reject(new Error(`${name} never got welcome`)), 3000);
    ws.on('open', () => ws.send(encodeClient({ t: 'hello', v: PROTOCOL_VERSION, name, character })));
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        const m = JSON.parse(data.toString('utf8'));
        if (m.t === 'welcome') {
          st.id = m.id;
          clearTimeout(timeout);
          resolve(st);
        } else if (m.t === 'join') st.sawOthers.add(m.player.id);
        else if (m.t === 'leave') st.sawOthers.delete(m.id);
      } else {
        const ab =
          data instanceof ArrayBuffer
            ? data
            : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        const snap = decodeSnapshot(ab);
        if (snap) {
          st.snaps++;
          st.ack = snap.ackSeq;
          if (snap.ents.some((e) => e.id === st.id)) st.sawSelf = true;
        }
      }
    });
    ws.on('error', reject);
  });
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const wss = new WebSocketServer({ port: PORT });
  const room = new Room(120);
  wss.on('connection', (ws) => room.attach(ws));
  const loop = setInterval(() => room.tick(), TICK_MS);

  let pass = true;
  const check = (label: string, cond: boolean, extra = ''): void => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}  ${extra}`);
    if (!cond) pass = false;
  };

  try {
    const alice = await connect('Alice', 'char-a');
    const bob = await connect('Bob', 'char-b');
    check('both clients received distinct ids', alice.id > 0 && bob.id > 0 && alice.id !== bob.id, `a=${alice.id} b=${bob.id}`);

    // Alice walks forward for ~0.5s; server should ack her inputs & move her.
    for (let seq = 1; seq <= 20; seq++) {
      alice.ws.send(encodeClient({ t: 'input', seq, dt: 0.025, f: 1, r: 0, yaw: 0, run: true }));
      await wait(15);
    }
    await wait(200);

    check('server acked Alice’s inputs', alice.ack >= 18, `ack=${alice.ack}`);
    check('Alice receives binary snapshots', alice.snaps > 3, `snaps=${alice.snaps}`);
    check('Alice sees herself in snapshots', alice.sawSelf);
    check('Alice was told Bob entered view', alice.sawOthers.has(bob.id));
    check('Bob was told Alice entered view', bob.sawOthers.has(alice.id));

    // Bob leaves; Alice should get a leave event within a couple ticks.
    bob.ws.close();
    await wait(200);
    check('Alice sees Bob leave', !alice.sawOthers.has(bob.id));

    alice.ws.close();
  } catch (err) {
    check(`no exceptions (${(err as Error).message})`, false);
  } finally {
    clearInterval(loop);
    wss.close();
  }

  console.log(pass ? '\nNETCODE SMOKE: PASS' : '\nNETCODE SMOKE: FAIL');
  process.exit(pass ? 0 : 1);
}

main();
