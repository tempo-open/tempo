import "./quickLookCard.css";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { isHostPath } from "@t3tools/shared/path";
import * as Schema from "effect/Schema";
import {
  Suspense,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { canUseMarkdownFileShellActions } from "~/components/chat/MarkdownFileLink.logic";
import {
  filePreviewReadErrorMessage,
  isMarkdownPreviewFile,
} from "~/components/files/filePreviewMode";
import {
  getProjectFileQueryAtom,
  useProjectFileQuery,
} from "~/components/files/projectFilesQueryState";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "~/components/preview/fileExplorerLabel";
import { Spinner } from "~/components/ui/spinner";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { isContextMenuOpen } from "~/contextMenuFallback";
import { openInEditorMenuLabel } from "~/editorLabels";
import { useOpenInPreferredEditor, usePreferredEditor } from "~/editorPreferences";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useRemoteOpenResolution } from "~/remoteOpen";
import { useRightPanelStore } from "~/rightPanelStore";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import { revisionedQuery } from "~/state/revisionedQuery";

import { useDocumentApps } from "../documentApps";
import {
  classifyDocumentHref,
  documentDirectory,
  QuickLookDocument,
  type DocumentLinkTarget,
} from "./QuickLookDocument";
import { blockIndexForLine, documentFileName } from "./quickLookDocument.logic";
import { documentPageHtml } from "./quickLookExport";
import { closeQuickLook, type QuickLookFile, type QuickLookRequest } from "./quickLookState";

const OpenTarget = Schema.Literals(["browser", "side", "editor"]);
type OpenTarget = typeof OpenTarget.Type;

const CLOSE = "M4 4l8 8M12 4l-8 8";
const EXPAND = "M9.5 2.75h3.75V6.5M13 3L9 7M6.5 13.25H2.75V9.5M3 13l4-4";
const COLLAPSE = "M13 6.5H9.5V3M9.5 6.5L13.25 2.75M3 9.5h3.5V13M6.5 9.5L2.75 13.25";
const PREVIOUS = "M10 3.5L5.5 8l4.5 4.5";
const NEXT = "M6 3.5L10.5 8 6 12.5";
const MORE = "M3.5 6l4.5 4.5L12.5 6";

function Glyph({ d }: { readonly d: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d={d}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BarButton(props: {
  readonly label: string;
  readonly glyph: string;
  readonly onClick: () => void;
  readonly pressed?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-ql-icon=""
            aria-label={props.label}
            aria-pressed={props.pressed}
            onClick={props.onClick}
          />
        }
      >
        <Glyph d={props.glyph} />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function reportOpenFailure(title: string) {
  toastManager.add(stackedThreadToast({ type: "error", title }));
}

export function QuickLookCard(props: {
  readonly request: QuickLookRequest;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}) {
  const { request, environmentId, cwd } = props;
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  // Keyed by file, so stepping to another file starts without the fade.
  const [scrolledFile, setScrolledFile] = useState<string | null>(null);
  const [index, setIndex] = useState(request.index);
  const [trail, setTrail] = useState<ReadonlyArray<QuickLookFile>>([]);
  const current = trail.at(-1) ?? request.files[index] ?? request.files[0];
  const path = current?.path ?? "";
  const revealLine = current?.line;
  const scrolled = scrolledFile === path;
  const scrollRef = useRef<HTMLDivElement>(null);
  // State, not a ref: Base UI mounts the popup's contents a render after the dialog, so
  // effects that need the document wait for this element to exist.
  const [article, setArticle] = useState<HTMLElement | null>(null);
  const afterClose = useRef<(() => void) | null>(null);
  const backdropPress = useRef(false);

  const file = useProjectFileQuery(environmentId, cwd, path, path.length > 0);
  // Each card reads under its own revision, so a file an agent changed since an earlier read is read again.
  useAtomMount(
    revisionedQuery(getProjectFileQueryAtom(environmentId, cwd, path), `quick-look:${request.id}`),
  );
  const markdown = file.data?.contents ?? null;
  const loaded = markdown !== null;
  const absolutePath = isHostPath(path) ? path : resolvePathLinkTarget(path, cwd);
  const fileName = documentFileName(path);
  const readError = file.readError ? filePreviewReadErrorMessage(file.readError) : file.error;

  const openLink = useOpenLink(request.threadRef);
  const apps = useDocumentApps();
  const openDocument = window.desktopBridge?.tempo?.openDocument;
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const availableEditors = serverConfig?.availableEditors ?? [];
  const [preferredEditor] = usePreferredEditor(availableEditors);
  const openInPreferredEditor = useOpenInPreferredEditor(environmentId, availableEditors);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const canOperateHost = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const remoteOpen = useRemoteOpenResolution(environmentId);
  const canUseShell =
    canOperateHost &&
    canUseMarkdownFileShellActions(environmentId, remoteOpen.state.mode, remoteOpen.isResolved);
  const revealLabel =
    canUseShell &&
    serverConfig?.shellRevealInFileManager === true &&
    serverConfig.availableEditors.includes("file-manager")
      ? serverConfig.shellRevealInFileManagerKind === undefined
        ? revealInFileExplorerLabelForOs(serverConfig.environment.platform.os)
        : revealInFileExplorerLabelForKind(serverConfig.shellRevealInFileManagerKind)
      : null;
  const editorLabel =
    canUseShell && preferredEditor !== null && preferredEditor !== "file-manager"
      ? openInEditorMenuLabel(preferredEditor)
      : null;

  const targets: ReadonlyArray<{ readonly id: OpenTarget; readonly label: string }> = [
    ...(openDocument && apps.browser
      ? [{ id: "browser" as const, label: `Open in ${apps.browser}` }]
      : []),
    { id: "side", label: "Open on the side" },
    ...(editorLabel ? [{ id: "editor" as const, label: editorLabel }] : []),
  ];
  const [preferredTarget, setPreferredTarget] = useLocalStorage(
    "tempo.quickLook.openIn",
    "browser",
    OpenTarget,
  );
  const primary = targets.find((target) => target.id === preferredTarget) ?? targets[0];

  // Runs as the card attaches, before its first frame, so the zoom grows out of the clicked link.
  const aimZoom = (popup: HTMLDivElement | null) => {
    if (!popup || !request.origin) return;
    popup.style.transformOrigin = `${request.origin.x - popup.offsetLeft}px ${request.origin.y - popup.offsetTop}px`;
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the rendered document to the linked line once its blocks exist
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || !article || !loaded || path.length === 0) return;
    if (revealLine === undefined) {
      scroll.scrollTop = 0;
      return;
    }
    const blocks = [...article.querySelectorAll<HTMLElement>("[data-line]")];
    let block =
      blocks[
        blockIndexForLine(
          blocks.map((element) => Number(element.dataset.line)),
          revealLine,
        )
      ];
    // Inside a code block, land on the line itself; the fence takes the block's first line.
    if (block?.hasAttribute("data-doc-code")) {
      const codeLines = block.querySelectorAll<HTMLElement>(".line");
      block = codeLines[revealLine - Number(block.dataset.line) - 1] ?? block;
    }
    if (!block) return;
    // The card may still be zooming in, so screen distances are divided by its current scale.
    const frame = scroll.getBoundingClientRect();
    const scale = frame.height / scroll.offsetHeight || 1;
    const top = (block.getBoundingClientRect().top - frame.top) / scale + scroll.scrollTop;
    scroll.scrollTop = Math.max(0, top - scroll.clientHeight / 3);
    block.setAttribute("data-revealed", "");
    const revealed = block;
    const clear = window.setTimeout(() => revealed.removeAttribute("data-revealed"), 2600);
    return () => window.clearTimeout(clear);
  }, [article, loaded, path, revealLine]);

  const close = (then?: () => void) => {
    afterClose.current = then ?? null;
    setOpen(false);
  };

  const openOnSide = (target: QuickLookFile) =>
    close(() =>
      useRightPanelStore.getState().openFile(request.threadRef, target.path, target.line),
    );

  const openIn = (target: OpenTarget) => {
    if (target === "side") {
      if (current) openOnSide(current);
      return;
    }
    if (target === "editor") {
      void openInPreferredEditor(absolutePath).then((result) =>
        result._tag === "Success" ? close() : reportOpenFailure("Unable to open the file"),
      );
      return;
    }
    if (!openDocument) return;
    if (!article) return;
    const title = article.querySelector("[data-doc-title]")?.textContent?.trim() || fileName;
    const dir = documentDirectory(path, cwd);
    const html = documentPageHtml(article, title, (href) => {
      const link = classifyDocumentHref(href, dir);
      return link?.kind === "file" ? link.path : null;
    });
    void openDocument({ target: "browser", name: fileName, html }).then((opened) =>
      opened
        ? close()
        : reportOpenFailure(`${apps.browser ?? "The browser"} could not open the page`),
    );
  };

  const reveal = () => {
    void openInEditor({
      environmentId,
      input: { cwd: absolutePath, editor: "file-manager", reveal: true },
    }).then((result) =>
      result._tag === "Success" ? close() : reportOpenFailure("Unable to show the file"),
    );
  };

  const step = (direction: -1 | 1) => {
    if (request.files.length < 2) return;
    setTrail([]);
    setIndex((at) => (at + direction + request.files.length) % request.files.length);
  };

  const followLink = (target: DocumentLinkTarget) => {
    if (target.kind === "web") {
      void openLink(target.url);
      return;
    }
    if (target.kind === "anchor") {
      article
        ?.querySelector<HTMLElement>(`[id="${CSS.escape(target.id)}"]`)
        ?.scrollIntoView({ block: "start" });
      return;
    }
    if (isMarkdownPreviewFile(target.path)) {
      setTrail((previous) => [...previous, { path: target.path, line: target.line }]);
      return;
    }
    openOnSide(target);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || isContextMenuOpen()) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true'], [role='menuitem']")) {
      return;
    }
    // Quick Look's keys: Space closes, the arrows step through the files beside this one.
    if (event.key === " ") {
      event.preventDefault();
      close();
      return;
    }
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && request.files.length > 1) {
      event.preventDefault();
      step(event.key === "ArrowLeft" ? -1 : 1);
    }
  };

  const loading = (
    <div data-ql-state="" data-loading="">
      <Spinner />
    </div>
  );
  let body: ReactElement;
  if (markdown !== null) {
    body = (
      <Suspense fallback={loading}>
        <QuickLookDocument
          markdown={markdown}
          path={path}
          cwd={cwd}
          environmentId={environmentId}
          threadRef={request.threadRef}
          onLink={followLink}
          onArticle={setArticle}
          footer={
            file.data?.truncated ? (
              <p data-ql-note="">
                This shows the first 1 MB of the file. Open it on the side to read the rest.
              </p>
            ) : null
          }
        />
      </Suspense>
    );
  } else if (readError) {
    body = (
      <div data-ql-state="" role="alert">
        <div>
          <p data-ql-state-title="">This file could not be opened.</p>
          <p>{readError}</p>
        </div>
      </div>
    );
  } else {
    body = loading;
  }

  return (
    <DialogPrimitive.Root
      open={open}
      disablePointerDismissal
      onOpenChange={(nextOpen, details) => {
        if (nextOpen) return;
        if (details.reason === "escape-key" && isContextMenuOpen()) {
          details.cancel();
          return;
        }
        close();
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (nextOpen) return;
        const then = afterClose.current;
        afterClose.current = null;
        closeQuickLook();
        then?.();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop forceRender data-ql-backdrop="" />
        <DialogPrimitive.Viewport
          data-ql-viewport=""
          onPointerDown={(event) => {
            backdropPress.current = event.target === event.currentTarget;
          }}
          onClick={(event) => {
            if (backdropPress.current && event.target === event.currentTarget) close();
            backdropPress.current = false;
          }}
        >
          <DialogPrimitive.Popup
            ref={aimZoom}
            initialFocus={scrollRef}
            aria-label={fileName}
            // The slot marks an open dialog, so type to focus the composer leaves its keys alone.
            data-slot="dialog-popup"
            data-ql-card=""
            data-zoom={request.origin ? "" : undefined}
            data-expanded={expanded ? "" : undefined}
            data-scrolled={scrolled ? "" : undefined}
            onKeyDown={onKeyDown}
          >
            <header
              data-ql-bar=""
              onDoubleClick={(event) => {
                if ((event.target as HTMLElement).closest("button")) return;
                setExpanded((value) => !value);
              }}
            >
              <div data-ql-tools="">
                <BarButton label="Close" glyph={CLOSE} onClick={() => close()} />
                <BarButton
                  label={expanded ? "Restore size" : "Fill the window"}
                  glyph={expanded ? COLLAPSE : EXPAND}
                  pressed={expanded}
                  onClick={() => setExpanded((value) => !value)}
                />
                {trail.length > 0 ? (
                  <BarButton
                    label="Back"
                    glyph={PREVIOUS}
                    onClick={() => setTrail((previous) => previous.slice(0, -1))}
                  />
                ) : request.files.length > 1 ? (
                  <>
                    <BarButton label="Previous file" glyph={PREVIOUS} onClick={() => step(-1)} />
                    <BarButton label="Next file" glyph={NEXT} onClick={() => step(1)} />
                  </>
                ) : null}
              </div>
              <DialogPrimitive.Title data-ql-title="">
                <span data-ql-title-name="">{fileName}</span>
                {trail.length === 0 && request.files.length > 1 ? (
                  <span data-ql-title-count="">
                    {index + 1} of {request.files.length}
                  </span>
                ) : null}
              </DialogPrimitive.Title>
              {primary ? (
                <div data-ql-open="">
                  <button type="button" data-ql-open-main="" onClick={() => openIn(primary.id)}>
                    {primary.label}
                  </button>
                  {targets.length > 1 || revealLabel ? (
                    // The card is light paper in either theme, so its menu is too.
                    <MenuPrimitive.Root>
                      <MenuPrimitive.Trigger
                        render={
                          <button
                            type="button"
                            data-ql-open-more=""
                            aria-label="More ways to open"
                          />
                        }
                      >
                        <Glyph d={MORE} />
                      </MenuPrimitive.Trigger>
                      <MenuPrimitive.Portal>
                        <MenuPrimitive.Positioner
                          data-ql-menu-positioner=""
                          side="bottom"
                          align="end"
                          sideOffset={6}
                        >
                          <MenuPrimitive.Popup data-ql-menu="">
                            {targets
                              .filter((target) => target.id !== primary.id)
                              .map((target) => (
                                <MenuPrimitive.Item
                                  key={target.id}
                                  data-ql-menu-item=""
                                  onClick={() => {
                                    setPreferredTarget(target.id);
                                    openIn(target.id);
                                  }}
                                >
                                  {target.label}
                                </MenuPrimitive.Item>
                              ))}
                            {revealLabel ? (
                              <>
                                {targets.length > 1 ? (
                                  <MenuPrimitive.Separator data-ql-menu-separator="" />
                                ) : null}
                                <MenuPrimitive.Item data-ql-menu-item="" onClick={reveal}>
                                  {revealLabel}
                                </MenuPrimitive.Item>
                              </>
                            ) : null}
                          </MenuPrimitive.Popup>
                        </MenuPrimitive.Positioner>
                      </MenuPrimitive.Portal>
                    </MenuPrimitive.Root>
                  ) : null}
                </div>
              ) : null}
            </header>
            <div
              ref={scrollRef}
              data-ql-scroll=""
              tabIndex={-1}
              onScroll={(event) => {
                const next = event.currentTarget.scrollTop > 4;
                if (next !== scrolled) setScrolledFile(next ? path : null);
              }}
            >
              {body}
            </div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
