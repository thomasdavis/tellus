import { useEffect, useRef, useState } from 'react';
import type { Manifest } from '@tellus/assets';
import { SERVER_URL } from './config.js';
import { loadManifest } from './manifest.js';
import { NetClient } from './net/NetClient.js';
import { CharacterSelect } from './ui/CharacterSelect.js';
import { Hud } from './ui/Hud.js';
import { GameCanvas } from './game/GameCanvas.js';
import './ui/styles.css';

type Phase =
  | { k: 'loading' }
  | { k: 'select'; manifest: Manifest }
  | { k: 'playing'; manifest: Manifest }
  | { k: 'error'; msg: string };

export function App() {
  const [phase, setPhase] = useState<Phase>({ k: 'loading' });
  const netRef = useRef<NetClient | null>(null);

  useEffect(() => {
    loadManifest()
      .then((m) =>
        setPhase(
          m.characters.length
            ? { k: 'select', manifest: m }
            : { k: 'error', msg: 'No characters in the manifest yet. Run `pnpm assets` at the repo root.' },
        ),
      )
      .catch((err: Error) => setPhase({ k: 'error', msg: err.message }));
  }, []);

  useEffect(() => () => netRef.current?.disconnect(), []);

  const enter = (name: string, character: string, manifest: Manifest): void => {
    const net = new NetClient(SERVER_URL);
    netRef.current = net;
    net.on((e) => {
      if (e.type === 'welcome') setPhase({ k: 'playing', manifest });
      else if (e.type === 'rejected') setPhase({ k: 'error', msg: e.reason });
      else if (e.type === 'disconnect')
        setPhase((prev) => (prev.k === 'error' ? prev : { k: 'error', msg: 'Lost connection to the world server.' }));
    });
    net.connect(name, character);
  };

  if (phase.k === 'loading') return <div className="fs">Loading Tellus…</div>;
  if (phase.k === 'error')
    return (
      <div className="fs fs--err">
        <div>
          <h2>Can’t enter Tellus</h2>
          <p>{phase.msg}</p>
        </div>
      </div>
    );
  if (phase.k === 'select')
    return <CharacterSelect characters={phase.manifest.characters} onEnter={(n, c) => enter(n, c, phase.manifest)} />;

  const net = netRef.current;
  if (!net) return <div className="fs">Connecting…</div>;
  return (
    <>
      <GameCanvas net={net} characters={phase.manifest.characters} worldProps={phase.manifest.props} />
      <Hud net={net} />
    </>
  );
}
