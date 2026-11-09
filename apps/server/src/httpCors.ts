import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";
import { TEMPO_DEV_URL_SCHEME, TEMPO_URL_SCHEME } from "@t3tools/shared/tempoBrand";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;

export const DESKTOP_RENDERER_ORIGINS = [
  `${TEMPO_URL_SCHEME}://app`,
  `${TEMPO_DEV_URL_SCHEME}://app`,
] as const;
