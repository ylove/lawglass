// Page-level notice (e.g. why this document was opened). It is the page's status message,
// so it keeps role="status".
export function NoticeBar({ notice }: { notice?: string | null | undefined }) {
  if (!notice) return null;
  return (
    <p className="note" role="status">
      {notice}
    </p>
  );
}
