import type { TempoThreadPage } from "@t3tools/contracts";
import { faviconUrlForOrigin } from "@t3tools/shared/favicon";
import { GlobeIcon } from "lucide-react";
import { useState } from "react";

import { failedFaviconHosts } from "../../components/chat/MarkdownExternalLink";
import { threadLogoSource } from "../threadLogos/ThreadLogo";
import { isPageLink, pageEmoji, siteLogo } from "./replyLinks.logic";

/**
 * The 17 px logo takes 34 px on a Retina screen. The favicon service answers a request for 34 px
 * with a 16 px icon, and a request for 64 px with a 64 px icon when the site has one.
 */
const FAVICON_SIZE = 64;

/**
 * The mark before a link's name in the tempo look: a page's emoji for a page an agent made (`page`
 * once the thread's pages hold it), the site's logo from the thread logos, else the site's own icon,
 * else a globe. Never on a tile.
 */
export function ReplyLinkLogo(props: {
  readonly href: string;
  readonly host: string;
  readonly page: TempoThreadPage | undefined;
}) {
  const { href, host, page } = props;
  const [failedHost, setFailedHost] = useState<string | null>(null);
  if (isPageLink(href)) {
    return (
      <span aria-hidden data-thread-find-ignore data-reply-link-emoji>
        {pageEmoji(page)}
      </span>
    );
  }
  const logo = siteLogo(host);
  const logoSrc = logo === null ? undefined : threadLogoSource(logo);
  if (logoSrc !== undefined) {
    return <img src={logoSrc} alt="" aria-hidden draggable={false} data-reply-link-logo />;
  }
  const faviconSrc = faviconUrlForOrigin(`https://${host}`, FAVICON_SIZE);
  if (faviconSrc === null || failedHost === host || failedFaviconHosts.has(host)) {
    return <GlobeIcon aria-hidden data-reply-link-mark />;
  }
  return (
    <img
      src={faviconSrc}
      alt=""
      aria-hidden
      loading="lazy"
      draggable={false}
      data-reply-link-logo
      onError={() => {
        failedFaviconHosts.add(host);
        setFailedHost(host);
      }}
    />
  );
}
