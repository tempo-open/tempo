import { ExternalLink } from "lucide-react";

import { Button } from "~/components/ui/button";
import { useDocumentApps } from "~/tempo/documentApps";

/**
 * tempo: the tempo look's way out of a page in the panel, named for the Mac's default browser, with
 * the outward arrow.
 */
export function OpenInBrowserButton(props: { readonly onClick: () => void }) {
  const { browser } = useDocumentApps();
  return (
    <Button
      variant="ghost-muted"
      size="sm"
      onClick={props.onClick}
      type="button"
      data-page-open-in-browser
    >
      <ExternalLink className="size-3.5" />
      {browser ? `Open in ${browser}` : "Open in browser"}
    </Button>
  );
}
