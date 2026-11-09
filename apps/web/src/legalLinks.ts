import { APP_BASE_NAME } from "./branding";

/**
 * What this build tells users about usage data, in onboarding and Settings. No build bakes in an
 * analytics key, so it states what it does instead of linking T3 Code's privacy policy. A server
 * started with its own `T3CODE_POSTHOG_KEY` is the operator's choice to disclose.
 */
export const USAGE_DATA_NOTICE = `${APP_BASE_NAME} does not collect usage data.`;
