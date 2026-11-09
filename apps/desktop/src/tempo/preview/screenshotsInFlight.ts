/**
 * Agent screenshots in flight, counted per preview tab. A tab keeps rendering for
 * them while it `has` one, and the app window while `any` tab does.
 */
export function makeScreenshotsInFlight() {
  const byTab = new Map<string, number>();
  return {
    begin: (tabId: string): void => {
      byTab.set(tabId, (byTab.get(tabId) ?? 0) + 1);
    },
    /** Ends one `begin`; an end with none in flight changes nothing. */
    end: (tabId: string): void => {
      const count = byTab.get(tabId) ?? 0;
      if (count > 1) byTab.set(tabId, count - 1);
      else byTab.delete(tabId);
    },
    has: (tabId: string): boolean => byTab.has(tabId),
    any: (): boolean => byTab.size > 0,
  };
}
