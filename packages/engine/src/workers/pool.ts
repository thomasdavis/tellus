// A small, resilient worker-thread pool for frame-shaped work: fire a request at
// the next worker round-robin, await its reply, time out rather than hang, and
// respawn any worker that dies. Workers are assumed stateless — any request can
// go to any worker — which is what makes the pool this simple.
//
// Protocol: the pool posts `{ reqId, ...request }`; the worker must reply with
// `{ reqId, ...response }` (posting transferables as it likes). Any other message
// (e.g. a `{ ready }` hello) is ignored.
import { Worker } from 'node:worker_threads';

export interface WorkerPoolOptions {
  /** ms before an outstanding request rejects (caller can fall back inline). */
  timeoutMs?: number;
  /** Node exec args for spawned workers (pass process.execArgv to keep loaders). */
  execArgv?: string[];
}

interface Pending<TRes> {
  resolve: (r: TRes) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class WorkerPool<TReq extends object, TRes> {
  private workers: Worker[] = [];
  private readonly ready = new Set<Worker>(); // said hello — safe to dispatch to
  private next = 0;
  private seq = 1;
  private readonly pending = new Map<number, Pending<TRes>>();
  private readonly timeoutMs: number;
  private readonly execArgv?: string[];

  constructor(
    private readonly workerUrl: URL,
    size: number,
    opts: WorkerPoolOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 1000;
    this.execArgv = opts.execArgv;
    for (let i = 0; i < size; i++) this.spawn();
  }

  get size(): number {
    return this.workers.length;
  }

  /** Workers that finished initializing and can take requests right now. */
  get readySize(): number {
    return this.ready.size;
  }

  private spawn(): void {
    const w = new Worker(this.workerUrl, { execArgv: this.execArgv });
    w.on('message', (m: (TRes & { reqId: number }) | object) => {
      if (!('reqId' in m)) {
        this.ready.add(w); // the hello — init (world build, mesh loading) is done
        return;
      }
      const p = this.pending.get(m.reqId as number);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(m.reqId as number);
      p.resolve(m as TRes);
    });
    w.on('error', () => this.replace(w));
    w.on('exit', () => this.replace(w));
    this.workers.push(w);
  }

  private replace(dead: Worker): void {
    const i = this.workers.indexOf(dead);
    if (i === -1) return; // already replaced
    this.workers.splice(i, 1);
    this.ready.delete(dead);
    try {
      dead.terminate();
    } catch {
      /* */
    }
    this.spawn();
  }

  /** Run one request on some READY worker. Rejects immediately when none are ready
   *  (e.g. during startup) and on timeout/worker death — callers fall back inline. */
  run(req: TReq): Promise<TRes> {
    const pool = this.workers.filter((w) => this.ready.has(w));
    if (!pool.length) return Promise.reject(new Error('no ready workers'));
    const worker = pool[this.next++ % pool.length]!;
    const reqId = this.seq++;
    return new Promise<TRes>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error('worker timeout'));
      }, this.timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      worker.postMessage({ reqId, ...req });
    });
  }

  close(): void {
    for (const w of this.workers) {
      try {
        w.terminate();
      } catch {
        /* */
      }
    }
    this.workers = [];
  }
}
