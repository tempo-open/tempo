/**
 * What a viewer's link carries, from the timing on its frame acks, and the screencast scale, JPEG
 * quality and pace that keep its frames fresh: full size on a LAN, smaller frames while the page
 * moves on a slow tunnel, and a sharp still once it settles. A viewer that reports no transfer
 * times keeps the stream it always had.
 */

/**
 * Screencast settings from sharpest to smallest. `bytes` is a frame's size
 * relative to the first, measured on a dense docs page: at full scale JPEG
 * quality barely changes the size, so quality drops first and scale after.
 */
export const STREAM_LEVELS = [
  { scale: 1, quality: 75, bytes: 1 },
  { scale: 1, quality: 55, bytes: 0.78 },
  { scale: 0.75, quality: 55, bytes: 0.48 },
  { scale: 0.5, quality: 50, bytes: 0.27 },
  { scale: 0.5, quality: 35, bytes: 0.22 },
] as const;

/** Stills are full scale at the sharpest level's quality. */
export const STILL_LEVEL = 0;

/** How long a frame may take to arrive, so a pointer move shows within about two of them. */
const TRANSFER_BUDGET_MS = 33;
/** A sharper level must fit the budget with this much room, so the level does not flap. */
const SHARPER_HEADROOM = 0.8;
/** Shorter transfers are within a message event's jitter, so they bound the bandwidth from below. */
const MEASURABLE_TRANSFER_MS = 4;
/**
 * A viewer busy with other work reports a frame late, and a link that delivers
 * in bursts reports one early, so the bandwidth is the median of the last few.
 */
const BANDWIDTH_SAMPLES = 9;
const LEVEL_DWELL_MS = 500;
const RTT_WINDOW_MS = 10_000;
const MAX_FRAMES_IN_FLIGHT = 3;
/** About the display's refresh: Chromium encodes no more often than this. */
const MIN_FRAME_INTERVAL_MS = 16;
/** Without timing from the viewer, about 30 frames a second. */
const UNMEASURED_FRAME_INTERVAL_MS = 33;
const SMOOTHING = 0.3;

export interface FrameDelivery {
  readonly bytes: number;
  /** The level the frame was captured at. */
  readonly level: number;
  readonly sentAt: number;
  readonly ackedAt: number;
  /** How long the viewer took to receive the frame; viewers from before report none. */
  readonly transferMs: number | undefined;
}

const smooth = (previous: number | null, sample: number) =>
  previous === null ? sample : previous + SMOOTHING * (sample - previous);

/** What the stream route needs of a viewer's link. */
export interface ViewerLink {
  /** Frames the link carries at once. */
  readonly window: number;
  record(delivery: FrameDelivery): void;
}

export class StreamLink implements ViewerLink {
  /** Whether the viewer reports transfer times, so frames follow its link. */
  measured = false;
  level = 0;
  /** Bytes per ms of the last frames. */
  private bandwidths: Array<number> = [];
  /** A frame's bytes at the sharpest level, scaled from what the page's frames weigh. */
  private sharpestBytes: number | null = null;
  private rtts: Array<{ readonly at: number; readonly ms: number }> = [];
  private changedAt = Number.NEGATIVE_INFINITY;

  record(delivery: FrameDelivery) {
    if (delivery.transferMs === undefined) return;
    this.measured = true;
    const transferMs = Math.max(delivery.transferMs, 0);
    this.bandwidths.push(delivery.bytes / Math.max(transferMs, MEASURABLE_TRANSFER_MS));
    if (this.bandwidths.length > BANDWIDTH_SAMPLES) this.bandwidths.shift();
    this.sharpestBytes = smooth(
      this.sharpestBytes,
      delivery.bytes / STREAM_LEVELS[delivery.level]!.bytes,
    );
    this.rtts.push({
      at: delivery.ackedAt,
      ms: Math.max(0, delivery.ackedAt - delivery.sentAt - transferMs),
    });
    while (this.rtts[0]!.at < delivery.ackedAt - RTT_WINDOW_MS) this.rtts.shift();
    if (delivery.ackedAt - this.changedAt < LEVEL_DWELL_MS) return;
    const level = this.fittingLevel();
    if (level === this.level) return;
    this.level = level;
    this.changedAt = delivery.ackedAt;
  }

  /** Frames the link carries at once: enough to keep it busy through a round trip. */
  get window() {
    const transferMs = this.transferMs(this.level);
    if (transferMs === null) return 1;
    return Math.min(MAX_FRAMES_IN_FLIGHT, 1 + Math.floor(this.rtt() / Math.max(transferMs, 1)));
  }

  /** The least time between captures: no faster than the link takes frames. */
  get frameIntervalMs() {
    if (!this.measured) return UNMEASURED_FRAME_INTERVAL_MS;
    return Math.max(MIN_FRAME_INTERVAL_MS, this.transferMs(this.level) ?? 0);
  }

  private rtt() {
    return this.rtts.reduce((least, sample) => Math.min(least, sample.ms), Infinity);
  }

  private transferMs(level: number) {
    if (this.bandwidths.length === 0 || this.sharpestBytes === null) return null;
    const sorted = this.bandwidths.toSorted((left, right) => left - right);
    const bandwidth = sorted[Math.floor(sorted.length / 2)]!;
    return (this.sharpestBytes * STREAM_LEVELS[level]!.bytes) / bandwidth;
  }

  private fittingLevel() {
    const fits = (level: number, room: number) =>
      (this.transferMs(level) ?? 0) <= TRANSFER_BUDGET_MS * room;
    if (!fits(this.level, 1)) {
      const smaller = STREAM_LEVELS.findIndex((_, level) => level > this.level && fits(level, 1));
      return smaller === -1 ? STREAM_LEVELS.length - 1 : smaller;
    }
    const sharper = STREAM_LEVELS.findIndex((_, level) => fits(level, SHARPER_HEADROOM));
    return sharper !== -1 && sharper < this.level ? sharper : this.level;
  }
}
