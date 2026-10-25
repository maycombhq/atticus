import type { ReactNode } from "react";

export interface Quote { text: string; source: string }

interface QuoteListProps { quotes: Quote[]; empty?: ReactNode }

export function QuoteList({ quotes, empty }: QuoteListProps) {
  if (!quotes.length) return <>{empty}</>;
  return (
    <ol className="quotes">
      {quotes.map((q, i) => (
        <li key={i}>
          {q.text} <cite>{q.source}</cite>
        </li>
      ))}
    </ol>
  );
}
