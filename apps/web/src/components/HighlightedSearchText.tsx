import { highlightSearchText } from "../app/search-utils";

export default function HighlightedSearchText({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
  return (
    <>
      {highlightSearchText(text, query).map((part, index) =>
        part.matched
          ? <mark className="search-highlight" key={`${index}-${part.text}`}>{part.text}</mark>
          : <span key={`${index}-${part.text}`}>{part.text}</span>,
      )}
    </>
  );
}
