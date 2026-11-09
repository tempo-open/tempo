/** tempo: where the setup script's README explains it, and how to recover an interrupted setup. */
export const REPOS_VOLUME_README_URL =
  "https://github.com/elithrar/dotfiles/blob/0a85522789658cf46810c64cdde1cf5dba62798b/README.md#macos-repos-volume";

/**
 * The command typed into the setup terminal. macOS's own bash runs the script whatever
 * the person's shell is, and the path is single-quoted so no character in it can end
 * the quoting.
 */
export function reposVolumeSetupCommand(scriptPath: string): string {
  return `/bin/bash '${scriptPath.replaceAll("'", `'\\''`)}'`;
}
