import { WebSocketServer } from 'ws';
import { TICK_MS, TICK_RATE, WORLD_HALF } from '@tellus/protocol';
import { Room } from './room.js';

const PORT = Number(process.env.PORT ?? 8787);

const wss = new WebSocketServer({ port: PORT });
const room = new Room(WORLD_HALF);

wss.on('connection', (ws) => room.attach(ws));
wss.on('listening', () =>
  console.log(
    `⚔  Tellus world server → ws://localhost:${PORT}\n   tick ${TICK_RATE}Hz · world ${WORLD_HALF * 2}m · waiting for travelers…`,
  ),
);

const loop = setInterval(() => {
  try {
    room.tick();
  } catch (err) {
    console.error('tick error:', err);
  }
}, TICK_MS);

const shutdown = (): void => {
  clearInterval(loop);
  wss.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
