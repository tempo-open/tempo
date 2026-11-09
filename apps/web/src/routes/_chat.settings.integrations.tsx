import { createFileRoute } from "@tanstack/react-router";

import { TempoIntegrationsSettings } from "../tempo/TempoIntegrationsSettings";

export const Route = createFileRoute("/_chat/settings/integrations")({
  component: TempoIntegrationsSettings,
});
