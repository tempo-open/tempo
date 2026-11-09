/**
 * The tempo server browser services for the server's layer graph: TempoBrowser over
 * BrowserExtensions, BrowserPasskeys, BrowserPasswords, and the full Chrome
 * build. Needs an HttpClient, ServerConfig, and the platform services.
 *
 * @module TempoBrowserServices
 */
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as BrowserExtensions from "./BrowserExtensions.ts";
import * as BrowserPasskeys from "./BrowserPasskeys.ts";
import * as BrowserPasswords from "./BrowserPasswords.ts";
import * as TempoBrowser from "./TempoBrowser.ts";
import * as ExtensionBrowser from "./ExtensionBrowser.ts";

export const layer = TempoBrowser.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      BrowserExtensions.layer,
      BrowserPasskeys.layer,
      BrowserPasswords.layer,
      ExtensionBrowser.layer,
    ),
  ),
  Layer.provide(ServerSecretStore.layer),
);
