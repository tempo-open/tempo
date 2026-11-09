/**
 * tempo: the logos a thread can show. The model that titles a thread also picks the one logo of what
 * the thread is about, from these ids (`textGenerationPrompts.ts`); the sidebar draws
 * `apps/web/src/tempo/threadLogos/logos/<id>.png`, or this app's own icon for `tempo`.
 */

export interface ThreadLogo {
  readonly id: string;
  /** What the logo stands for, as the model reads it. */
  readonly about: string;
}

/** Widely used developer platforms, plus this app. */
const THREAD_LOGOS: readonly ThreadLogo[] = [
  { id: "tempo", about: "Tempo, this coding app" },
  { id: "github", about: "GitHub" },
  { id: "vercel", about: "Vercel" },
  { id: "cloudflare", about: "Cloudflare and Wrangler" },
  { id: "supabase", about: "Supabase" },
  { id: "railway", about: "Railway" },
  { id: "stripe", about: "Stripe" },
  { id: "posthog", about: "PostHog" },
  { id: "postman", about: "Postman" },
  { id: "figma", about: "Figma" },
  { id: "notion", about: "Notion" },
  { id: "linear", about: "Linear" },
  { id: "slack", about: "Slack" },
  { id: "google", about: "Google" },
  { id: "claude", about: "Claude and Claude Code" },
  { id: "anthropic", about: "Anthropic" },
  { id: "chatgpt", about: "ChatGPT, OpenAI and Codex" },
];

export const THREAD_LOGO_IDS: ReadonlySet<string> = new Set(THREAD_LOGOS.map((logo) => logo.id));

const SITE_DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/u;

/**
 * The model's answer: a logo id from the list, a company's website domain ("example.com"), or null
 * for "none", a blank, or anything else.
 */
export function threadLogoFromModel(answer: string | null | undefined): string | null {
  const logo =
    answer
      ?.trim()
      .toLowerCase()
      .replace(/^https?:\/\//u, "")
      .replace(/^www\./u, "")
      .replace(/\/.*$/u, "") ?? "";
  return THREAD_LOGO_IDS.has(logo) || SITE_DOMAIN.test(logo) ? logo : null;
}

/**
 * A thread's `tempoLogo` starts with this when it holds the fallback icon, not a logo: the sidebar
 * shows it only when no logo turns up (not even the project folder's or its favicon).
 */
export const THREAD_ICON_PREFIX = "icon:";

/** One emoji, including skin tones, flags and joined ones like 👨‍💻 (no Intl.Segmenter on Hermes). */
const PART = String.raw`(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})(?:\uFE0F|\p{Emoji_Modifier})?`;
const ONE_EMOJI = new RegExp(`^${PART}(?:\u200D${PART})*$`, "u");

/** The model's icon answer as a `tempoLogo` value: `icon:<one emoji>`, or null. */
export function threadIconFromModel(answer: string | null | undefined): string | null {
  const icon = answer?.trim() ?? "";
  return ONE_EMOJI.test(icon) ? `${THREAD_ICON_PREFIX}${icon}` : null;
}

/**
 * A logo or icon someone picks by hand: a logo id from the list, one emoji, or "none" (null).
 * Undefined for anything else. A site domain is left out: its logo is fetched only for the model.
 */
export function threadLogoFromChoice(choice: string): string | null | undefined {
  const answer = choice.trim();
  if (answer.toLowerCase() === "none") return null;
  if (THREAD_LOGO_IDS.has(answer.toLowerCase())) return answer.toLowerCase();
  return threadIconFromModel(answer) ?? undefined;
}

/** How the model picks the fallback icon, in the same call as the title and logo. */
export const THREAD_ICON_INSTRUCTIONS = `Icon: also return icon. It is shown only when the thread gets no logo, so always return exactly one emoji that shows the subject being made or worked on, so the user can spot the thread in a list: 🍕 for a pizza ordering app, 🌦️ for a weather dashboard, 🎮 for a game, 📚 for a reading tracker, 🏋️ for a fitness app.
Choose the subject, not the activity. Avoid generic work emoji such as 💻 🛠️ 📝 ✅ 🚀 📊 unless that thing is the subject.`;

const listLogos = (logos: readonly ThreadLogo[]) =>
  logos.map((logo) => `${logo.id}: ${logo.about}`).join("\n");

/**
 * How the model picks the logo. A logo says what the thread is about, so a product named only on
 * the way (a data source, a tool, a style to copy) gets none: a missing logo costs little, a wrong
 * one misleads.
 */
export const THREAD_LOGO_INSTRUCTIONS = `Logo: choose the one product, service, or company this thread is about. Return its id from the list below as logo; for a real company or product that is not in the list, return its website's domain instead, such as "example.com"; otherwise return "none".
A thread is about a product only when the user wants that product itself built, changed, fixed, set up, studied, or worked in, or deals with the company behind it (a meeting, a deal, a reply, a contract). Return "none" when products are only named along the way:
- a source of input, such as notes from a meeting app or data from Stripe
- a tool the agent should use to do the work
- a style, design, or example to follow, such as "in Apple's design style"
- something to compare against or imitate
A new product, idea, or project that does not exist yet gets "none", even when it is built with or from products in the list.
Return a domain only for a company the thread names and is about: its real domain if you know it, else the likeliest one, such as "name.com". The app checks the site before it shows a logo.
A question about how a listed product itself works counts: "Why does my Vercel deploy fail" is vercel.
When unsure, return "none". A missing logo costs little; a wrong one misleads.

Products and services (id: what it is):
${listLogos(THREAD_LOGOS)}`;
