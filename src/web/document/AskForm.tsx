import { useId, useState } from 'react';

// The draft text lives here; only a submitted question goes up to DocumentView, which owns the run.
export function AskForm({
  busy,
  onAsk,
}: {
  busy: boolean;
  onAsk: (question: string) => void;
}) {
  const [question, setQuestion] = useState('');
  const questionId = useId();
  return (
    <form
      className="ask"
      onSubmit={(e) => {
        e.preventDefault();
        const q = question.trim();
        if (q === '' || busy) return;
        onAsk(q);
      }}
    >
      <label htmlFor={questionId}>Or ask your own question</label>
      <div className="row">
        <input
          id={questionId}
          type="text"
          maxLength={500}
          value={question}
          onChange={(e) => {
            setQuestion(e.target.value);
          }}
        />
        <button
          type="submit"
          className="btn primary"
          aria-disabled={busy || question.trim() === ''}
        >
          Ask
        </button>
      </div>
    </form>
  );
}
