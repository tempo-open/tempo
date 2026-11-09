/**
 * A thread's logo. The model that titles a thread picks the logo of what it is about
 * (`@t3tools/shared/tempoThreadLogos`), so a product the request only mentions, like a data source or
 * a style to copy, gets none. A thread with no chosen logo shows the one its project folder names.
 */
import { THREAD_ICON_PREFIX, THREAD_LOGO_IDS } from "@t3tools/shared/tempoThreadLogos";

type ThreadLogoRule = {
  /** The file `logos/<logo>.png`, or `tempo` for this app's own icon. */
  readonly logo: string;
  /** Names matched as whole words; hyphens and underscores count as word edges. */
  readonly anyCase?: readonly string[];
  /** Names that are also everyday words, where only this spelling means the name. */
  readonly exactCase?: readonly string[];
};

const PRODUCT_RULES: readonly ThreadLogoRule[] = [{ logo: "tempo", exactCase: ["Tempo"] }];

const TOOL_RULES: readonly ThreadLogoRule[] = [
  { logo: "stripe", anyCase: ["stripe"] },
  { logo: "notion", anyCase: ["notion"] },
  { logo: "figma", anyCase: ["figma"] },
  { logo: "cloudflare", anyCase: ["cloudflare", "wrangler"] },
  { logo: "supabase", anyCase: ["supabase"] },
  { logo: "railway", anyCase: ["railway"] },
  { logo: "posthog", anyCase: ["posthog"] },
  { logo: "linear", exactCase: ["Linear"] },
  { logo: "slack", anyCase: ["slack"] },
  { logo: "github", anyCase: ["github"] },
  { logo: "google", anyCase: ["google"] },
  { logo: "vercel", anyCase: ["vercel"] },
  { logo: "postman", anyCase: ["postman"] },
  { logo: "claude", anyCase: ["claude"] },
  { logo: "anthropic", anyCase: ["anthropic"] },
  { logo: "chatgpt", anyCase: ["chatgpt", "openai", "codex"] },
];

function wholeWords(names: readonly string[], flags: string): RegExp {
  const escaped = names.map((name) =>
    name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"),
  );
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join("|")})(?![\\p{L}\\p{N}])`, flags);
}

const compileRules = (rules: readonly ThreadLogoRule[], tier: number) =>
  rules.flatMap(({ logo, anyCase, exactCase }) => [
    ...(anyCase ? [{ logo, tier, pattern: wholeWords(anyCase, "iu") }] : []),
    ...(exactCase ? [{ logo, tier, pattern: wholeWords(exactCase, "u") }] : []),
  ]);

const COMPILED_FOLDER_RULES = [...compileRules(PRODUCT_RULES, 0), ...compileRules(TOOL_RULES, 1)];

/** Every logo a thread can show, for the check that each one has a file. */
export const THREAD_LOGOS: ReadonlySet<string> = new Set([
  ...THREAD_LOGO_IDS,
  ...COMPILED_FOLDER_RULES.map((rule) => rule.logo),
]);

/**
 * The logo a folder name names, or null. A product beats a tool, an earlier name beats a later one,
 * and a longer name beats a shorter one that starts at the same place.
 */
function resolveNamedLogo(text: string, rules: typeof COMPILED_FOLDER_RULES): string | null {
  let best: { logo: string; tier: number; index: number; length: number } | null = null;
  for (const { logo, tier, pattern } of rules) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const { index } = match;
    const { length } = match[0];
    const wins =
      best === null ||
      tier < best.tier ||
      (tier === best.tier &&
        (index < best.index || (index === best.index && length > best.length)));
    if (wins) best = { logo, tier, index, length };
  }
  return best?.logo ?? null;
}

/**
 * The logo the title model chose for the thread, else the one its project folder names
 * (`stripe-sync` is Stripe), or null. Titles are never read for names: "Read the Notion notes" is
 * not about Notion.
 */
export function resolveThreadLogo(
  chosen: string | null | undefined,
  projectRoot?: string | null,
): string | null {
  if (chosen && !chosen.startsWith(THREAD_ICON_PREFIX)) return chosen;
  const folder = projectRoot?.split(/[\\/]/u).findLast((part) => part !== "");
  return folder === undefined ? null : resolveNamedLogo(folder, COMPILED_FOLDER_RULES);
}

/** The logo an app's name names, such as Slack for `Slack`, or null. */
export function resolveAppLogo(appName: string): string | null {
  return resolveNamedLogo(appName, COMPILED_FOLDER_RULES);
}

/**
 * The icon the title model gave a thread it found no logo for: one emoji. The sidebar shows it only
 * after the folder's logo and the project's favicon.
 */
export function threadFallbackIcon(chosen: string | null | undefined): string | null {
  return chosen?.startsWith(THREAD_ICON_PREFIX) ? chosen.slice(THREAD_ICON_PREFIX.length) : null;
}

/** The first letter or digit a person reads in a title, for the tile of a thread with no logo. */
export function threadLetter(title: string): string {
  const readable = title.replace(/<[^>]*>/gu, " ").replace(/[a-z]+:\/\/(?:www\.)?/giu, " ");
  return /[\p{L}\p{N}]/u.exec(readable)?.[0]?.toLocaleUpperCase() ?? "";
}
