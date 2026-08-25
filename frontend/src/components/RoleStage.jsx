/**
 * The stages a hand-written role moves through.
 *
 * One definition, shared by the list, the detail page and the Overview. The
 * order matters — it is the order the picker offers and the order the list
 * sorts by — and three copies of it drift the first time a stage is added.
 * The server holds the same order in manualJobs.STAGES, which is what the
 * database CHECK enforces; this is its label and its weight on screen.
 *
 * Density carries the ranking that colour normally would, densest at the stage
 * that needs the most attention: an open role with nobody on it is louder than
 * one already closed.
 */
export const STAGES = [
  { key: 'open', label: 'Open', fill: 'bg-ink text-paper border-ink', bar: 'bg-ink' },
  { key: 'reviewing', label: 'Reviewing candidates', fill: 'bg-ink/60 text-paper border-ink', bar: 'bg-ink/60' },
  { key: 'placed', label: 'Candidate placed', fill: 'bg-paper text-ink border-ink', bar: 'bg-ink/30' },
  { key: 'closed', label: 'Closed', fill: 'bg-paper text-ink-3 border-rule', bar: 'bg-ink/10' },
];

export function stageLabel(status) {
  const stage = STAGES.find((s) => s.key === status);
  return stage ? stage.label : status;
}

export function StageTag({ status }) {
  const stage = STAGES.find((s) => s.key === status);
  return (
    <span
      className={[
        'inline-flex whitespace-nowrap items-center border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-micro',
        stage ? stage.fill : 'border-rule bg-paper text-ink-3',
      ].join(' ')}
    >
      {stage ? stage.label : status}
    </span>
  );
}
