// SSH Sailing server. Any user connects as a guest; each shell gets a 3D sailing session.
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import ssh2 from 'ssh2';
import { SailingSession } from './session.js';

const { Server } = ssh2;
const HERE = dirname(fileURLToPath(import.meta.url));
const KEY_PATH = join(HERE, '../../assets/host.key');
const PORT = parseInt(process.env.SAIL_PORT ?? '4000', 10);
const HOST = process.env.SAIL_HOST ?? '0.0.0.0';

if (!existsSync(KEY_PATH)) {
  console.error(`Missing SSH host key at ${KEY_PATH}. Generate with:\n  ssh-keygen -t ed25519 -f ${KEY_PATH} -N ""`);
  process.exit(1);
}

const server = new Server(
  {
    hostKeys: [readFileSync(KEY_PATH)],
    banner: 'SSH SAILING — hoist the main\r\n',
    // Force zlib: terminal ANSI frames compress hugely, and dropping 'none'
    // makes every client negotiate compression instead of defaulting it off.
    algorithms: { compress: ['zlib@openssh.com', 'zlib'] },
  },
  (client) => {
    client.on('authentication', (ctx) => ctx.accept());   // open guest access
    client.on('error', () => { /* ignore transport errors */ });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        let cols = 100, rows = 30;
        let sess: SailingSession | null = null;
        session.on('pty', (a, _r, info) => {
          cols = info.cols || cols; rows = info.rows || rows;
          if (typeof a === 'function') a();
        });
        session.on('window-change', (a, _r, info) => {
          cols = info.cols || cols; rows = info.rows || rows;
          sess?.resize(cols, rows);
          if (typeof a === 'function') a();
        });
        session.on('shell', (accept2) => {
          const stream = accept2();
          sess = new SailingSession(stream, cols, rows);
          stream.on('data', (d: Buffer) => sess?.onData(d));
          stream.on('close', () => sess?.close());
          stream.on('error', () => { /* client gone */ });
          sess.start();
        });
      });
    });
  },
);

server.on('error', (e: Error) => console.error('[ssh-sailing] listen error:', e.message));
server.listen(PORT, HOST, () => {
  console.log(`[ssh-sailing] listening on ${HOST}:${PORT}  —  connect: ssh -p ${PORT} <host>`);
});
