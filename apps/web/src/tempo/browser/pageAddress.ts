/** tempo: an address split the way the tempo look's page bar draws it, host first, no scheme. */
interface PageAddress {
  readonly secure: boolean;
  readonly host: string;
  readonly rest: string;
}

/** Null for an address that is not a web page (a blank tab, a file), which the bar shows whole. */
export function pageAddress(url: string): PageAddress | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const rest = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return {
    secure: parsed.protocol === "https:",
    host: parsed.host,
    rest: rest === "/" ? "" : rest,
  };
}
