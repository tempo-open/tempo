/**
 * tempo: every tool on `/mcp` reaches agents with Tempo's name in its description and title
 * (`tempoAgentText`), whether upstream or Tempo wrote it.
 */
import { tempoAgentText } from "@t3tools/shared/tempoBrand";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import { Tool, Toolkit } from "effect/ai";

/**
 * A copy of `tool` that names Tempo. It is copied the way Effect's own `Tool` setters copy a
 * tool, so it keeps its id and still finds the original's handler.
 */
export const tempoTool = <T extends Tool.Any>(tool: T): T => {
  const description = Tool.getDescription(tool);
  const title = Context.getOption(tool.annotations, Tool.Title);
  return Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, {
    description: description === undefined ? undefined : tempoAgentText(description),
    annotations: Option.isSome(title)
      ? Context.add(tool.annotations, Tool.Title, tempoAgentText(title.value))
      : tool.annotations,
  });
};

/** `toolkit` with every tool passed through `tempoTool`: the same tools under the same names. */
export const tempoToolkit = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
): Toolkit.Toolkit<Tools> =>
  Toolkit.make(...Object.values(toolkit.tools).map(tempoTool)) as unknown as Toolkit.Toolkit<Tools>;
