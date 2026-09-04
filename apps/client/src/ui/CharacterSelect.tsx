import { useState } from 'react';
import type { ModelEntry } from '@tellus/assets';

export function CharacterSelect({
  characters,
  onEnter,
}: {
  characters: ModelEntry[];
  onEnter: (name: string, character: string) => void;
}) {
  const [name, setName] = useState('');
  const [sel, setSel] = useState(characters[0]?.id ?? '');

  return (
    <div className="menu">
      <div className="menu__panel">
        <div className="menu__brand">TELLUS</div>
        <p className="menu__sub">a shared world — choose who you are, then run around together</p>

        <div className="grid">
          {characters.map((c) => (
            <button
              key={c.id}
              type="button"
              className={'card' + (c.id === sel ? ' card--on' : '')}
              onClick={() => setSel(c.id)}
              title={c.title}
            >
              {c.thumb ? <img src={c.thumb} alt={c.title} loading="lazy" /> : <div className="card__noimg" />}
              <span className="card__name">{c.title}</span>
            </button>
          ))}
        </div>

        <form
          className="menu__row"
          onSubmit={(e) => {
            e.preventDefault();
            if (sel) onEnter(name.trim() || 'traveler', sel);
          }}
        >
          <input
            className="name"
            placeholder="your name"
            maxLength={16}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="enter" type="submit" disabled={!sel}>
            Enter world →
          </button>
        </form>
      </div>
    </div>
  );
}
