import type { ProjectIconColor } from "@t3tools/contracts";

/**
 * tempo: the tempo look draws a project's monogram in white on a solid tile of its color, the 700
 * shade in both themes, never as letters on a tint.
 */
export const PROJECT_MONOGRAM_TILE_CLASS: Record<ProjectIconColor, string> = {
  gray: "tempo:text-gray-700",
  red: "tempo:text-red-700",
  orange: "tempo:text-orange-700",
  amber: "tempo:text-amber-700",
  yellow: "tempo:text-yellow-700",
  lime: "tempo:text-lime-700",
  green: "tempo:text-green-700",
  emerald: "tempo:text-emerald-700",
  teal: "tempo:text-teal-700",
  cyan: "tempo:text-cyan-700",
  sky: "tempo:text-sky-700",
  blue: "tempo:text-blue-700",
  indigo: "tempo:text-indigo-700",
  violet: "tempo:text-violet-700",
  purple: "tempo:text-purple-700",
  fuchsia: "tempo:text-fuchsia-700",
  pink: "tempo:text-pink-700",
  rose: "tempo:text-rose-700",
};
