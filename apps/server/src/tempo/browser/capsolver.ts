/**
 * CapSolver, the captcha solver every profile starts with. It saves the settings it used into the
 * profile, and that copy beats its `assets/config.js`. So each launch first writes that file (all
 * captcha types on, the `tempo capsolver set` key) and, while there is a key, deletes the saved copy.
 * Without a key it finds captchas but solves none; a person can paste one into its popup.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** CapSolver's "Captcha Solver: Auto captcha solving service" on the Chrome Web Store. */
export const CAPSOLVER_ID = "pgojnojmmhpofjgdmaebadhbocahppod";

/** The extension Tempo configures as CapSolver; tests point it at a fixture extension. */
export const CapsolverExtensionId = Context.Reference<string>(
  "t3/tempo/browser/CapsolverExtensionId",
  { defaultValue: () => CAPSOLVER_ID },
);

/** The environment secret holding the CapSolver key. */
export const CAPSOLVER_KEY_SECRET = "tempo-capsolver-key";

/**
 * CapSolver keys are `CAP-` and hex. The extension splits its settings file on
 * commas and colons, so anything else could rewrite the settings around it.
 */
export const isCapsolverKey = (key: string): boolean => /^[A-Za-z0-9-]{8,200}$/.test(key);

/** Every captcha type the extension solves. Its other settings keep the extension's defaults. */
const CAPTCHA_TYPES = [
  "enabledForRecaptcha",
  "enabledForRecaptchaV3",
  "enabledForHCaptcha",
  "enabledForCloudflare",
  "enabledForAwsCaptcha",
  "enabledForGeetestV4",
  "enabledForDataDome",
  "enabledForImageToText",
] as const;

/** `assets/config.js` for a key, or for none; a malformed key counts as none. */
export const capsolverConfig = (key: string | null): string =>
  [
    "export const defaultConfig = {",
    `  apiKey: '${key !== null && isCapsolverKey(key) ? key : ""}',`,
    "  useCapsolver: true,",
    "  manualSolving: false,",
    // Turnstile and the other tasks the extension sends run on CapSolver's own proxies.
    "  useProxy: false,",
    "  enabledForBlacklistControl: false,",
    "  blackUrlList: [],",
    ...CAPTCHA_TYPES.map((name) => `  ${name}: true,`),
    "};",
    "",
  ].join("\n");

/** Writes the settings for a key into an installed copy of CapSolver, unless it already has them. */
export const writeCapsolverConfig = Effect.fn("capsolver.writeConfig")(function* (
  root: string,
  key: string | null,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(root, "assets", "config.js");
  const settings = capsolverConfig(key);
  const current = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => null));
  if (current === settings) return;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(`${file}.tmp`, settings);
  yield* fs.rename(`${file}.tmp`, file);
});

/**
 * Removes the settings CapSolver saved in a profile, before the profile's
 * browser starts, so CapSolver starts again from its settings file.
 */
export const resetCapsolverStorage = Effect.fn("capsolver.resetStorage")(function* (
  userDataDir: string,
  extensionId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Chrome keeps an extension's `chrome.storage.local` here, in the profile's own folder.
  const storage = path.join(userDataDir, "Default", "Local Extension Settings", extensionId);
  yield* fs.remove(storage, { recursive: true, force: true });
});
