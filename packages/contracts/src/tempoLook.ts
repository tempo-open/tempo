/**
 * tempo: the Tempo redesign. `tempoLook` picks the app's whole presentation; the other values shape the
 * home page in the tempo look. apps/web/src/tempo/look/ holds the presentation.
 */
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

export const TempoLook = Schema.Literals(["classic", "tempo"]);
export type TempoLook = typeof TempoLook.Type;

/** The art behind the home page; `auto` is `beam` in dark and `crossing` in light. */
export const TempoHomeBackground = Schema.Literals([
  "auto",
  "beam",
  "crossing",
  "trefoil",
  "plain",
  "picture",
]);
export type TempoHomeBackground = typeof TempoHomeBackground.Type;

const isTempoHomeBackground = Schema.is(TempoHomeBackground);

/** The saved setting: a background this build no longer offers reads as `auto`. */
export const TempoHomeBackgroundSetting = Schema.String.pipe(
  Schema.decodeTo(
    TempoHomeBackground,
    SchemaTransformation.transform({
      decode: (value): TempoHomeBackground => (isTempoHomeBackground(value) ? value : "auto"),
      encode: (value) => value,
    }),
  ),
);

/** How dense the dither dots of the art are. */
export const TempoHomeDots = Schema.Literals(["many", "few", "none", "fine"]);
export type TempoHomeDots = typeof TempoHomeDots.Type;

/** How a picture background meets the page under the typing bar. */
export const TempoHomePictureEffect = Schema.Literals(["fade", "dissolve", "whole"]);
export type TempoHomePictureEffect = typeof TempoHomePictureEffect.Type;

export const TempoHomePictureColors = Schema.Literals(["original", "blue"]);
export type TempoHomePictureColors = typeof TempoHomePictureColors.Type;

export const TempoHomeWidget = Schema.Literals(["limit", "activity", "pullRequests", "month"]);
export type TempoHomeWidget = typeof TempoHomeWidget.Type;

/** The widgets under the typing bar, in order: two or three, each once. */
export const TempoHomeWidgets = Schema.UniqueArray(TempoHomeWidget).check(
  Schema.isMinLength(2),
  Schema.isMaxLength(3),
);
export type TempoHomeWidgets = typeof TempoHomeWidgets.Type;

/** Where the status bar sits on the home page: under the typing bar, or at the page's bottom. */
export const TempoHomePlace = Schema.Literals(["under", "bottom"]);
export type TempoHomePlace = typeof TempoHomePlace.Type;
