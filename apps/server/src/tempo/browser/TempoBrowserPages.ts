/**
 * Opens an extension's popup and options pages as server browser tabs. Preview URLs do not allow
 * `chrome-extension://`, so the server browser opens them itself in the profile's context, and the
 * thread gets them as ordinary server tabs.
 *
 * @module TempoBrowserPages
 */
import {
  TempoBrowserProfileError,
  type TempoBrowserOpenExtensionPageInput,
  type TempoBrowserOpenExtensionPageResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerBrowser from "../../preview/ServerBrowser.ts";
import * as TempoBrowser from "./TempoBrowser.ts";

export class TempoBrowserPages extends Context.Service<
  TempoBrowserPages,
  {
    readonly openExtensionPage: (
      input: TempoBrowserOpenExtensionPageInput,
    ) => Effect.Effect<TempoBrowserOpenExtensionPageResult, TempoBrowserProfileError>;
  }
>()("t3/tempo/browser/TempoBrowserPages") {}

const make = Effect.gen(function* () {
  const browser = yield* TempoBrowser.TempoBrowser;
  const serverBrowser = yield* ServerBrowser.ServerBrowser;

  const openExtensionPage: TempoBrowserPages["Service"]["openExtensionPage"] = (input) =>
    browser.extensionPageUrl(input).pipe(
      Effect.flatMap((url) =>
        serverBrowser
          .openPage({ threadId: input.threadId, profileId: input.profileId, url })
          .pipe(
            Effect.mapError((cause) => new TempoBrowserProfileError({ reason: "launch", cause })),
          ),
      ),
      Effect.withSpan("TempoBrowserPages.openExtensionPage"),
    );

  return TempoBrowserPages.of({ openExtensionPage });
});

export const layer = Layer.effect(TempoBrowserPages, make);
