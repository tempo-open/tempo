/**
 * tempo: a thread's earlier turns load by themselves as the reader nears its top, on web and mobile.
 * Each page is asked for once, keyed by the oldest loaded entry. After a failed page the loader
 * waits for the reader to scroll away and back, so a failing server is never asked in a loop.
 */

/** How far above the viewport, in viewport heights, the next older page starts loading. */
const EARLIER_HISTORY_PREFETCH_VIEWPORTS = 1;

export interface EarlierHistoryAutoLoadState {
  /** The oldest loaded entry when a page was last asked for. */
  readonly requestedFor: string | null;
  /** The reader left the top after a failed page, so coming back asks again. */
  readonly retryOnReturn: boolean;
}

export const INITIAL_EARLIER_HISTORY_AUTO_LOAD: EarlierHistoryAutoLoadState = {
  requestedFor: null,
  retryOnReturn: false,
};

export interface EarlierHistoryAutoLoadInput {
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly failed: boolean;
  /** How far the viewport's top is below the top of the content. */
  readonly distanceFromStart: number;
  readonly viewportLength: number;
  readonly oldestEntryId: string;
}

export function decideEarlierHistoryAutoLoad(
  state: EarlierHistoryAutoLoadState,
  input: EarlierHistoryAutoLoadInput,
): { readonly state: EarlierHistoryAutoLoadState; readonly load: boolean } {
  if (!input.hasMoreHistory || input.loading || input.viewportLength <= 0) {
    return { state, load: false };
  }
  const nearStart =
    input.distanceFromStart <= input.viewportLength * EARLIER_HISTORY_PREFETCH_VIEWPORTS;
  if (!nearStart) {
    return { state: { requestedFor: null, retryOnReturn: input.failed }, load: false };
  }
  if ((input.failed && !state.retryOnReturn) || state.requestedFor === input.oldestEntryId) {
    return { state, load: false };
  }
  return { state: { requestedFor: input.oldestEntryId, retryOnReturn: false }, load: true };
}
