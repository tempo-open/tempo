/**
 * tempo: a finished reply's deliverables as cards under it, in the tempo look: each page it shared as
 * its preview, opening where a link in the reply opens, unless the page already draws in place of
 * its link, and each markdown file it linked, opening in Quick Look. Cards show once the thread's
 * pages are read, so they never move after they appear.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { FileIcon } from "lucide-react";

import { useProjectFileQuery } from "../../components/files/projectFilesQueryState";
import { cn } from "../../lib/utils";
import { openFileForReading } from "../quickLook/quickLookState";
import { PagePreview } from "./PagePreview";
import {
  documentPreview,
  replyDeliverables,
  replyMarkdownFiles,
  replyPageUrls,
  type ReplyFile,
  type ReplyPages,
} from "./replyDeliverables.logic";

const CARD_CLASS =
  "flex min-w-0 flex-col overflow-hidden rounded-xl bg-card text-start ring-1 ring-border outline-none hover:ring-tempo-hair-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

function CardMeta(props: { title: string; detail: string }) {
  return (
    <div className="px-3 pt-2.5 pb-2.75">
      <div className="flex items-start gap-1.75 font-medium text-foreground text-tempo-label leading-4.5">
        <FileIcon aria-hidden data-reply-deliverable-mark />
        <span className="min-w-0 break-words">{props.title}</span>
      </div>
      <div className="mt-0.75 ps-5.5 text-secondary-label text-tempo-caption leading-3.75">
        {props.detail}
      </div>
    </div>
  );
}

/**
 * The document's title and its first line, on top of its card; empty until the file is read, and
 * the title its path gives when it cannot be read.
 */
function FilePreview(props: { file: ReplyFile; threadRef: ScopedThreadRef; cwd: string }) {
  const { file, threadRef, cwd } = props;
  const query = useProjectFileQuery(threadRef.environmentId, cwd, file.path);
  const markdown = query.data?.contents ?? (query.error === null ? undefined : "");
  const preview = markdown === undefined ? null : documentPreview(markdown, file.path);
  return (
    <div className="flex h-21 flex-col justify-end gap-1 border-border border-b bg-muted px-3.5 pt-3 pb-2.75">
      {preview === null ? null : (
        <>
          <div className="font-semibold text-foreground text-tempo-title" data-reply-preview-line>
            {preview.title}
          </div>
          {preview.lead === null ? null : (
            <div className="font-semibold text-muted-foreground text-xs" data-reply-preview-line>
              {preview.lead}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FileCard(props: {
  file: ReplyFile;
  files: ReadonlyArray<ReplyFile>;
  threadRef: ScopedThreadRef;
  cwd: string | undefined;
}) {
  const { file, files, threadRef, cwd } = props;
  return (
    <button
      type="button"
      onClick={(event) =>
        openFileForReading(threadRef, file.path, {
          from: event.currentTarget,
          siblings: files.map(({ path }) => ({ path })),
        })
      }
      className={CARD_CLASS}
      data-reply-deliverable="file"
    >
      {cwd === undefined ? null : <FilePreview file={file} threadRef={threadRef} cwd={cwd} />}
      <CardMeta title={file.name} detail="Opens in Quick Look" />
    </button>
  );
}

/** `pages` is null until the thread's pages are read (useReplyPages). */
export function ReplyDeliverables(props: {
  text: string;
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  pages: ReplyPages | null;
}) {
  const { text, cwd, threadRef, pages } = props;
  if (pages === null) return null;
  const files = replyMarkdownFiles(text, cwd);
  const deliverables = replyDeliverables(replyPageUrls(text), pages, files);
  if (deliverables.length === 0) return null;
  return (
    <div
      className={cn("mt-4 grid gap-2.5", deliverables.length >= 3 ? "grid-cols-3" : "grid-cols-2")}
      data-reply-deliverables
    >
      {deliverables.map((deliverable) =>
        deliverable.kind === "page" ? (
          <PagePreview key={deliverable.page.url} page={deliverable.page} threadRef={threadRef} />
        ) : (
          <FileCard
            key={deliverable.file.path}
            file={deliverable.file}
            files={files}
            threadRef={threadRef}
            cwd={cwd}
          />
        ),
      )}
    </div>
  );
}
