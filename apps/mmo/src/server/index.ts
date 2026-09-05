// Tellus MMO server: any user connects as a guest; each shell joins the ONE shared
// world and gets a live third-person 3D view rendered to their terminal.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';
import ssh2 from 'ssh2';
import { World } from '../world/world.js';
import { WorldRenderer } from '../render/renderer.js';
import { MmoSession } from '../session.js';
import { RenderPool } from '../render/pool.js';

const { Server } = ssh2;
const HERE = dirname(fileURLToPath(import.meta.url));
const KEY_PATH = join(HERE, '../../assets/host.key');
const PORT = parseInt(process.env.MMO_PORT ?? '4020', 10);
const HOST = process.env.MMO_HOST ?? '0.0.0.0';

if (!existsSync(KEY_PATH)) {
  console.error(`Missing SSH host key at ${KEY_PATH}. Generate: ssh-keygen -t ed25519 -f ${KEY_PATH} -N ""`);
  process.exit(1);
}

const world = new World();
const renderer = new WorldRenderer(world);

// Render pool: rasterization runs on worker threads so it never blocks the event loop
// and many players render in parallel across cores. Falls back to inline if disabled.
const POOL_SIZE = Math.max(2, Math.min(6, os.cpus().length - 2));
const pool = process.env.MMO_NO_POOL === '1' ? null : new RenderPool(POOL_SIZE);
if (pool) console.log(`[tellus-mmo] render pool: ${POOL_SIZE} workers`);

// the world's own heartbeat: creatures wander even when nobody's watching
setInterval(() => world.tick(1 / 20), 50).unref?.();

let guestNo = 0;
function pickName(user?: string): string {
  const clean = (user ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 14);
  return clean && clean.toLowerCase() !== 'guest' ? clean : `wanderer-${++guestNo}`;
}

const server = new Server(
  {
    hostKeys: [readFileSync(KEY_PATH)],
    banner: 'TELLUS — a small shared world. Run around.\r\n',
    algorithms: { compress: ['zlib@openssh.com', 'zlib'] },
  },
  (client) => {
    let username: string | undefined;
    let sess: MmoSession | null = null;
    client.on('authentication', (ctx) => {
      username = ctx.username;
      ctx.accept();
    });
    // Any way the connection ends must remove the player — otherwise ghosts pile up.
    client.on('error', () => sess?.close());
    client.on('close', () => sess?.close());
    client.on('end', () => sess?.close());
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        let cols = 100;
        let rows = 32;
        session.on('pty', (a, _r, info) => {
          cols = info.cols || cols;
          rows = info.rows || rows;
          if (typeof a === 'function') a();
        });
        session.on('window-change', (a, _r, info) => {
          cols = info.cols || cols;
          rows = info.rows || rows;
          sess?.resize(cols, rows);
          if (typeof a === 'function') a();
        });
        session.on('shell', (accept2) => {
          const stream = accept2();
          const player = world.join(pickName(username));
          sess = new MmoSession(stream, world, renderer, player, cols, rows, pool);
          stream.on('data', (d: Buffer) => sess?.onData(d));
          stream.on('close', () => sess?.close());
          stream.on('error', () => {
            /* client gone */
          });
          sess.start();
          console.log(`+ ${player.name} entered (${world.population} online)`);
        });
      });
    });
  },
);

server.on('error', (e: Error) => console.error('[tellus-mmo] listen error:', e.message));
server.listen(PORT, HOST, () => console.log(`[tellus-mmo] listening on ${HOST}:${PORT}  —  connect: ssh -p ${PORT} <host>`));
