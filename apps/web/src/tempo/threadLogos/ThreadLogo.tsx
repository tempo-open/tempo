import { useAtomValue } from "@effect/atom-react";
import { isProjectFaviconFallbackUrl } from "@t3tools/shared/projectFavicon";
import type { ReactNode } from "react";

import tempoIconUrl from "../../../../../assets/prod/t3-black-web-apple-touch-180.png";
import { ProjectFavicon, type ProjectFaviconProject } from "../../components/ProjectFavicon";
import { cn } from "../../lib/utils";
import { projectFaviconUrlAtom } from "../../state/assets";
import {
  resolveAppLogo,
  resolveThreadLogo,
  threadFallbackIcon,
  threadLetter,
} from "./threadLogo.logic";

// no-inline keeps the logos out of the JS bundle, so a row only loads the logo it shows.
const LOGO_FILES = import.meta.glob<string>("./logos/*.png", {
  eager: true,
  query: "?no-inline",
  import: "default",
});

/** A logo from the list, or a company's own site icon that the server kept as a data URI. */
export const threadLogoSource = (logo: string): string | undefined =>
  logo.startsWith("data:image/png;base64,")
    ? logo
    : logo === "tempo"
      ? tempoIconUrl
      : LOGO_FILES[`./logos/${logo}.png`];

function ThreadLogo(props: { readonly src: string; readonly className?: string | undefined }) {
  return (
    <img
      src={props.src}
      alt=""
      draggable={false}
      className={cn(
        "size-4 shrink-0 rounded-[25%] object-cover outline -outline-offset-1 outline-black/8 dark:outline-white/10",
        props.className,
      )}
    />
  );
}

/** The first letter of a title on a plain tile, the size of a logo so the list stays aligned. */
function ThreadLetterTile(props: {
  readonly title: string;
  readonly className?: string | undefined;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[25%] bg-black/6 text-3xs leading-none font-medium text-secondary-label outline -outline-offset-1 outline-black/8 select-none dark:bg-white/10 dark:outline-white/10",
        // The tempo look draws the letter bare: no tile behind a letter.
        "tempo:bg-transparent tempo:text-tempo-note tempo:font-semibold tempo:outline-0",
        props.className,
      )}
    >
      {threadLetter(props.title)}
    </span>
  );
}

/** The title model's icon for a thread with no logo: one emoji drawn the size of a logo. */
function FallbackIcon(props: { readonly icon: string; readonly className?: string | undefined }) {
  const { icon, className } = props;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center overflow-hidden text-sm leading-none select-none",
        className,
      )}
    >
      {icon}
    </span>
  );
}

function IconOrLetter(props: {
  readonly title: string;
  readonly icon: string | null;
  readonly className?: string | undefined;
}) {
  return props.icon === null ? (
    <ThreadLetterTile title={props.title} className={props.className} />
  ) : (
    <FallbackIcon icon={props.icon} className={props.className} />
  );
}

function ProjectIconOrLetter(props: {
  readonly title: string;
  readonly icon: string | null;
  readonly project: ProjectFaviconProject;
  readonly className?: string | undefined;
}) {
  const { project } = props;
  const src = useAtomValue(
    projectFaviconUrlAtom({
      environmentId: project.environmentId,
      cwd: project.workspaceRoot,
      faviconPath: project.faviconPath,
    }),
  );
  const hasOwnIcon = project.projectIcon != null || (src && !isProjectFaviconFallbackUrl(src));
  return hasOwnIcon ? (
    <ProjectFavicon project={project} className={cn("size-4 shrink-0", props.className)} />
  ) : (
    <IconOrLetter title={props.title} icon={props.icon} className={props.className} />
  );
}

/**
 * A sidebar row's icon: the logo of what the thread is about, else the one its project folder
 * names, else the project's favicon or chosen icon, else the title model's fallback emoji, else
 * the title's first letter.
 */
export function ThreadIcon(props: {
  readonly title: string;
  /** The thread's `tempoLogo`: the title model's pick, null for none, absent until it picks. */
  readonly logo?: string | null | undefined;
  readonly project?: ProjectFaviconProject | null | undefined;
  readonly className?: string | undefined;
}) {
  const { title, project, className } = props;
  const logo = resolveThreadLogo(props.logo, project?.workspaceRoot);
  // A logo this build has no file for (a newer server's list) falls back like none.
  const src = logo === null ? undefined : threadLogoSource(logo);
  if (src !== undefined) return <ThreadLogo src={src} className={className} />;
  const icon = threadFallbackIcon(props.logo);
  return project ? (
    <ProjectIconOrLetter title={title} icon={icon} project={project} className={className} />
  ) : (
    <IconOrLetter title={title} icon={icon} className={className} />
  );
}

/** An app's logo by its name, or the fallback when the name names none. */
export function AppLogo(props: {
  readonly name: string;
  readonly fallback: ReactNode;
  readonly className?: string | undefined;
}) {
  const logo = resolveAppLogo(props.name);
  const src = logo === null ? undefined : threadLogoSource(logo);
  return src === undefined ? props.fallback : <ThreadLogo src={src} className={props.className} />;
}
