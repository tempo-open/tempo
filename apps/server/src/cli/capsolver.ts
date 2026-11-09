/**
 * `tempo capsolver`: the CapSolver key this environment's server browser solves
 * captchas with. `set` saves it in the environment's secret store, `clear`
 * removes it, and `status` says whether one is saved without showing it. The
 * running server hands it to CapSolver at each profile's next launch.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import { TEMPO_CLI_NAME } from "@t3tools/shared/tempoBrand";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import { Command, GlobalFlag, Prompt } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { CAPSOLVER_KEY_SECRET, isCapsolverKey } from "../tempo/browser/capsolver.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

/** Scripts pass the key in this variable; a person types it at a hidden prompt. */
const KEY_VARIABLE = "TEMPO_CAPSOLVER_KEY";

class CapsolverKeyError extends CliError.UserError {}

const readKey = Effect.gen(function* () {
  const fromEnvironment = (yield* HostProcess.Environment)[KEY_VARIABLE]?.trim();
  if (fromEnvironment) return fromEnvironment;
  const typed = yield* Prompt.run(Prompt.Password({ message: "CapSolver API key" }));
  return Redacted.value(typed).trim();
});

const runSet = Effect.gen(function* () {
  const key = yield* readKey;
  if (!isCapsolverKey(key)) {
    return yield* new CapsolverKeyError({
      cause:
        "That is not a CapSolver API key. It starts with CAP- and has only letters, digits and dashes.",
    });
  }
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  yield* secrets.set(CAPSOLVER_KEY_SECRET, new TextEncoder().encode(key));
  yield* Console.log("✓ Saved. Server browser tabs solve captchas with it from their next start.");
});

const runStatus = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const saved = yield* secrets.get(CAPSOLVER_KEY_SECRET);
  yield* Console.log(
    Option.isSome(saved)
      ? "A CapSolver key is saved."
      : `No CapSolver key is saved. Save one with \`${TEMPO_CLI_NAME} capsolver set\`.`,
  );
});

const runClear = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  yield* secrets.remove(CAPSOLVER_KEY_SECRET);
  yield* Console.log("✓ Removed. Profiles that already read it keep it until it is cleared there.");
});

const capsolverLayer = (config: ServerConfig.ServerConfig["Service"]) =>
  ServerSecretStore.layer.pipe(
    Layer.provideMerge(ServerConfig.layer(config)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
  );

const subcommand = <E, R>(
  name: string,
  description: string,
  run: Effect.Effect<void, E, R | ServerSecretStore.ServerSecretStore>,
) =>
  Command.make(name, { ...projectLocationFlags }).pipe(
    Command.withDescription(description),
    Command.withHandler((flags) =>
      Effect.gen(function* () {
        const logLevel = yield* GlobalFlag.LogLevel;
        const config = yield* resolveCliAuthConfig(flags, logLevel);
        return yield* run.pipe(Effect.provide(capsolverLayer(config)));
      }),
    ),
  );

export const capsolverCommand = Command.make("capsolver").pipe(
  Command.withDescription("The CapSolver key this machine's server browser solves captchas with."),
  Command.withSubcommands([
    subcommand(
      "set",
      `Save the CapSolver API key: typed at a prompt, or read from ${KEY_VARIABLE}.`,
      runSet,
    ),
    subcommand("status", "Say whether a CapSolver key is saved, without showing it.", runStatus),
    subcommand("clear", "Remove the saved CapSolver key.", runClear),
  ]),
);
