import type { ClientConfig } from '../../core/model/index.js';

type Chip = ClientConfig['chips'][number];

export function ChipRow({
  chips,
  busy,
  activeLabel,
  onPick,
}: {
  chips: Chip[];
  busy: boolean;
  /** Label of the question being shown, so its chip can look selected. */
  activeLabel?: string | null;
  onPick: (chipId: Chip['id'], label: string) => void;
}) {
  return (
    <section aria-labelledby="chips-title">
      <h3 id="chips-title">What would you like to know?</h3>
      <div role="group" aria-labelledby="chips-title" className="chips">
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className="chip"
            // "current", not "pressed": clicking again re-asks rather than toggling off.
            aria-current={chip.label === activeLabel ? 'true' : undefined}
            aria-disabled={busy}
            onClick={() => {
              // aria-disabled (not disabled) keeps keyboard focus on the chip.
              if (busy) return;
              onPick(chip.id, chip.label);
            }}
          >
            {chip.label}
          </button>
        ))}
      </div>
    </section>
  );
}
