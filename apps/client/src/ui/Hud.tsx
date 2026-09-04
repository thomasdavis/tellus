import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { NetClient } from '../net/NetClient.js';

interface Line {
  key: number;
  name: string;
  text: string;
}

export function Hud({ net }: { net: NetClient }) {
  const [online, setOnline] = useState(net.online);
  const [log, setLog] = useState<Line[]>([]);
  const [text, setText] = useState('');
  const keyRef = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      net.on((e) => {
        if (e.type === 'players' || e.type === 'welcome') setOnline(net.online);
        if (e.type === 'chat') setLog((l) => [...l.slice(-49), { key: keyRef.current++, name: e.name, text: e.text }]);
      }),
    [net],
  );

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [log]);

  const send = (e: FormEvent): void => {
    e.preventDefault();
    const t = text.trim();
    if (t) {
      net.chat(t);
      setText('');
    }
  };

  return (
    <>
      <div className="hud-top">
        <span className="badge">
          <span className="dot" /> {online} online
        </span>
        <span className="hint">WASD move · Shift run · drag to look · scroll to zoom</span>
      </div>

      <div className="chat">
        <div className="chat__log" ref={logRef}>
          {log.map((m) => (
            <div key={m.key} className="chat__line">
              <b>{m.name}</b> {m.text}
            </div>
          ))}
        </div>
        <form className="chat__form" onSubmit={send}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="say something…  (Enter)"
            maxLength={160}
          />
        </form>
      </div>
    </>
  );
}
