import type { SVGProps } from "react";

/** The "T" brand mark for Tempo. Keeps the upstream name so merges stay small. */
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 56 56" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 4H52V15H34V52H22V15H4V4Z" fill="currentColor" />
    </svg>
  );
}
