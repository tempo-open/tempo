import { AuthProvidersManageScope, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { PlugIcon } from "lucide-react";

import { EnvironmentMachineIcon } from "../components/EnvironmentMachineIcon";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import type { EnvironmentPresentation } from "../state/environments";
import { useEnvironmentScope } from "../state/session";
import { McpServersSection } from "./McpServersSettings";
import { ServiceConnectionsSection } from "./ServiceConnectionsSettings";

/**
 * Settings → Integrations: the MCP servers and service connections agents get. Each environment
 * keeps its own, so the page shows them for every environment in the selection.
 */
export function TempoIntegrationsSettings() {
  const { scope, environments } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {scope.kind === "unavailable" ? (
        <SettingsSection title="Unavailable selection">
          <SettingsRow title={scope.message} />
        </SettingsSection>
      ) : environments.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PlugIcon />
            </EmptyMedia>
            <EmptyTitle>No environments available</EmptyTitle>
            <EmptyDescription>Connect an environment to set up its integrations.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        environments.map((environment, index) => (
          <EnvironmentIntegrations
            key={environment.environmentId}
            environment={environment}
            showEnvironmentLabel={environments.length > 1}
            // Search anchors must be unique, so only the first environment carries them.
            anchored={index === 0}
          />
        ))
      )}
    </SettingsPageContainer>
  );
}

function EnvironmentIntegrations({
  environment,
  showEnvironmentLabel,
  anchored,
}: {
  readonly environment: EnvironmentPresentation;
  readonly showEnvironmentLabel: boolean;
  readonly anchored: boolean;
}) {
  const { environmentId } = environment;
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const suffix = showEnvironmentLabel ? ` · ${environment.label}` : "";
  const icon = showEnvironmentLabel ? (
    <EnvironmentMachineIcon
      kind={resolveEnvironmentMachineKind(environment.serverConfig)}
      className="size-3.5"
    />
  ) : undefined;

  return (
    <>
      {connected ? (
        <McpServersSection
          environmentId={environmentId}
          titleSuffix={suffix}
          icon={icon}
          canManage={canManage}
          anchored={anchored}
        />
      ) : null}
      <ServiceConnectionsSection
        environmentId={environmentId}
        connected={connected}
        title={`Service connections${suffix}`}
        icon={icon}
        anchored={anchored}
      />
    </>
  );
}
