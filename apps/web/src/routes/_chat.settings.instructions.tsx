import { createFileRoute } from "@tanstack/react-router";

import { InstructionsSettings } from "../tempo/InstructionsSettings";

export const Route = createFileRoute("/_chat/settings/instructions")({
  component: InstructionsSettings,
});
