import { useId } from 'react';
import type { Scenario } from '../../core/model/index.js';
import { AVATAR_ICONS, TOPIC_ICONS } from './scenario-icons.js';

/** Numbers each distinct cited section by first appearance, so a footnote keeps one number. */
function footnoteNumbers(frames: Scenario['frames']): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const frame of frames)
    for (const id of frame.citations)
      if (!numbers.has(id)) numbers.set(id, numbers.size + 1);
  return numbers;
}

/**
 * "What it could mean for someone like you": a made-up example, labelled as such. Captions are
 * plain text (the model never supplies markup), and every footnote opens the citation drawer.
 */
export function ScenarioStrip({
  scenario,
  onOpenSection,
  nested = false,
}: {
  scenario: Scenario;
  onOpenSection: (sectionId: string, trigger: HTMLElement) => void;
  /**
   * Inside a "Section by section" card: one heading level lower, and a unique id so several
   * strips can sit on one page.
   */
  nested?: boolean;
}) {
  const numbers = footnoteNumbers(scenario.frames);
  const uniqueId = useId();
  const titleId = nested ? `scenario-title-${uniqueId}` : 'scenario-title';
  const Heading = nested ? 'h5' : 'h3';
  return (
    <section
      aria-labelledby={titleId}
      className={nested ? 'scenario scenario-nested' : 'scenario'}
    >
      <div className="scenario-head">
        <Heading id={titleId}>
          What it could mean for {scenario.profile.name}
        </Heading>
        <span className="scenario-badge">Example · invented person</span>
      </div>
      <ol className="scenario-frames" data-count={scenario.frames.length}>
        {scenario.frames.map((frame, i) => {
          const Avatar = AVATAR_ICONS[frame.avatar];
          const Topic = TOPIC_ICONS[frame.icon];
          return (
            <li key={i} className="scenario-frame">
              <div className="scenario-art" aria-hidden="true">
                <span className="scenario-avatar">
                  <Avatar size={22} />
                </span>
                <Topic size={30} strokeWidth={1.75} />
              </div>
              <p>
                {frame.caption}
                {frame.citations.map((id) => (
                  <sup key={id}>
                    <button
                      type="button"
                      className="cite"
                      aria-label={`Example source ${String(numbers.get(id))}`}
                      aria-haspopup="dialog"
                      onClick={(e) => {
                        onOpenSection(id, e.currentTarget);
                      }}
                    >
                      {numbers.get(id)}
                    </button>
                  </sup>
                ))}
              </p>
            </li>
          );
        })}
      </ol>
      <p className="muted scenario-note">
        {scenario.profile.name} is made up. What the bill requires comes from
        the sections cited.
      </p>
    </section>
  );
}
