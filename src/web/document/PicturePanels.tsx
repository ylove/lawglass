import {
  ArrowLeftRight,
  ArrowRight,
  Ban,
  Equal,
  type LucideIcon,
} from 'lucide-react';
import type {
  PictureEntry,
  PicturePanel,
  PictureSide,
} from '../../core/model/index.js';
import { GLYPH_ICONS, STAMP_ICONS } from './picture-glyphs.js';

function Side({ side }: { side: PictureSide }) {
  return (
    <div className="pp-side">
      <div className="pp-glyphs" data-count={side.glyphs.length}>
        {side.glyphs.map((glyph, i) => {
          const Icon = GLYPH_ICONS[glyph];
          return <Icon key={i} className="pp-glyph" strokeWidth={1.75} />;
        })}
      </div>
      {/* Labels come from the model: always a text node, never markup. */}
      {side.label && <span className="pp-label">{side.label}</span>}
    </div>
  );
}

const LINK_ICONS: Record<'to' | 'both' | 'equals', LucideIcon> = {
  to: ArrowRight,
  both: ArrowLeftRight,
  equals: Equal,
};

function Link({ panel }: { panel: PicturePanel }) {
  if (panel.link === 'none') return null;
  const Carry = panel.carry ? GLYPH_ICONS[panel.carry] : undefined;
  const Mark = panel.link === 'blocked' ? ArrowRight : LINK_ICONS[panel.link];
  return (
    <div className="pp-link" data-link={panel.link}>
      {Carry && <Carry className="pp-carry" strokeWidth={1.75} />}
      <span className="pp-arrow">
        <Mark className="pp-arrow-icon" strokeWidth={2} />
        {/* Not allowed is a barred circle over a dimmed arrow: the shape says it, not the colour. */}
        {panel.link === 'blocked' && (
          <Ban className="pp-ban" strokeWidth={2.4} />
        )}
      </span>
      {panel.note && <span className="pp-note">{panel.note}</span>}
    </div>
  );
}

/**
 * The small drawing above one summary bullet or section brief (#345): up to three framed panels,
 * each "left side, link, right side" with an optional stamp. Purely illustrative, so everything
 * is hidden from assistive technology; the caption underneath carries the meaning.
 */
export function PicturePanels({ entry }: { entry: PictureEntry }) {
  // Some panels are too wide to pair up on a phone, and the CSS gives them a row each: 2+ glyphs
  // on both sides, or a labelled left side next to a note, whose words would otherwise collide.
  const wide = entry.panels.some(
    (p) =>
      p.right !== undefined &&
      ((p.left.glyphs.length > 1 && p.right.glyphs.length > 1) ||
        (p.left.label !== undefined && p.note !== undefined)),
  );
  return (
    <div
      className="picture-panels"
      data-count={entry.panels.length}
      data-wide={wide || undefined}
      aria-hidden="true"
    >
      {entry.panels.map((panel, i) => {
        const Stamp = panel.stamp ? STAMP_ICONS[panel.stamp.glyph] : undefined;
        return (
          <div key={i} className="pp-panel">
            {panel.stamp && Stamp && (
              <span className="pp-stamp" data-stamp={panel.stamp.glyph}>
                <Stamp className="pp-stamp-icon" strokeWidth={2} />
                {panel.stamp.label && <span>{panel.stamp.label}</span>}
              </span>
            )}
            <div className="pp-scene" data-link={panel.link}>
              <Side side={panel.left} />
              <Link panel={panel} />
              {panel.right && <Side side={panel.right} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}
