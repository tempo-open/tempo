import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ThreadMoveService from "./ThreadMoveService.ts";
import { THREAD_MOVE_DOWNLOAD_PREFIX, THREAD_MOVE_UPLOAD_PREFIX } from "./ThreadMoveTokens.ts";

/**
 * Archive bytes for a thread move travel over these signed URLs, never the
 * WebSocket. The URL is the credential: it names one move and expires.
 */
const tokenAfter = Effect.fn("ThreadMoveHttp.tokenAfter")(function* (prefix: string) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return null;
  const token = url.value.pathname.slice(`${prefix}/`.length);
  return token.length === 0 ? null : token;
});

const layerDownloadRoute = HttpRouter.add(
  "GET",
  `${THREAD_MOVE_DOWNLOAD_PREFIX}/*`,
  Effect.gen(function* () {
    const moves = yield* ThreadMoveService.ThreadMoveService;
    const token = yield* tokenAfter(THREAD_MOVE_DOWNLOAD_PREFIX);
    const archivePath = token === null ? null : yield* moves.resolveDownload(token);
    if (archivePath === null) return HttpServerResponse.text("Not Found", { status: 404 });
    return yield* HttpServerResponse.file(archivePath, {
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    }).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }),
);

const layerUploadRoute = HttpRouter.add(
  "POST",
  `${THREAD_MOVE_UPLOAD_PREFIX}/*`,
  Effect.gen(function* () {
    const moves = yield* ThreadMoveService.ThreadMoveService;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const token = yield* tokenAfter(THREAD_MOVE_UPLOAD_PREFIX);
    if (token === null) return HttpServerResponse.text("Not Found", { status: 404 });
    const header = request.headers["content-length"];
    const contentLength = header === undefined ? null : Number(header);
    if (contentLength !== null && !Number.isInteger(contentLength)) {
      return HttpServerResponse.text("Content-Length must match the upload size.", { status: 400 });
    }
    // Keep the request stream in the route scope until the response is sent.
    const bodyPull = yield* Stream.toPull(request.stream);
    const stored = yield* moves.receiveUpload(
      token,
      Stream.fromPull(Effect.succeed(bodyPull)),
      contentLength,
    );
    return stored.ok
      ? HttpServerResponse.empty({ status: 204 })
      : HttpServerResponse.text(stored.detail, { status: stored.status });
  }),
);

export const layer = Layer.mergeAll(layerDownloadRoute, layerUploadRoute);
