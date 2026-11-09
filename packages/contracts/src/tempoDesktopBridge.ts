/** tempo: the desktop app's `tempo` bridge. Absent outside Tempo's desktop builds. */
export interface TempoDesktopBridge {
  /**
   * How many agent turns run on the environments this desktop hosts, or null while this
   * window cannot tell. The desktop installs a downloaded update by itself only at zero.
   */
  readonly reportLocalTurns?: (turns: number | null) => Promise<void>;
  /** Where the reading card can open a document: the default browser's name. */
  readonly documentApps?: () => Promise<TempoDocumentApps>;
  /** Opens a rendered page in the default browser; false when it could not. */
  readonly openDocument?: (input: TempoOpenDocumentInput) => Promise<boolean>;
  /** Your own picture for the home, one file in Tempo's userdata folder; null when none is saved. */
  readonly readHomePicture?: () => Promise<Uint8Array<ArrayBuffer> | null>;
  /** Replaces the saved picture; false when it could not be saved. */
  readonly saveHomePicture?: (bytes: Uint8Array) => Promise<boolean>;
  readonly removeHomePicture?: () => Promise<void>;
}

export interface TempoDocumentApps {
  readonly browser: string | null;
}

export type TempoOpenDocumentInput = {
  readonly target: "browser";
  readonly name: string;
  readonly html: string;
};
