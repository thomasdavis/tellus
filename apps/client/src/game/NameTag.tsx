/** A floating name label, rendered as DOM via drei's <Html>. */
export function NameTag({ name, you = false }: { name: string; you?: boolean }) {
  return (
    <div
      style={{
        transform: 'translateY(-50%)',
        whiteSpace: 'nowrap',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 13,
        fontWeight: 600,
        letterSpacing: 0.2,
        color: you ? '#0b0f1a' : '#eaf2ff',
        background: you ? '#ffd76a' : 'rgba(12,18,32,0.72)',
        border: you ? '1px solid #e7bf4d' : '1px solid rgba(255,255,255,0.18)',
        pointerEvents: 'none',
        userSelect: 'none',
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
      }}
    >
      {name}
    </div>
  );
}
