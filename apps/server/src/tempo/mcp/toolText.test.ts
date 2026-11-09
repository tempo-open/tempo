import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { tempoTool, tempoToolkit } from "./toolText.ts";

const UpstreamTool = Tool.make("t3_thread_read", {
  description: "Read a T3 thread. Needs an agent running inside T3 Code.",
  parameters: Schema.Struct({ threadId: Schema.String }),
  success: Schema.String,
})
  .annotate(Tool.Title, "Read a T3 thread")
  .annotate(Tool.Readonly, true);

it("names Tempo in a tool's description and title and keeps everything else", () => {
  const tool = tempoTool(UpstreamTool);

  expect(Tool.getDescription(tool)).toBe(
    "Read a Tempo thread. Needs an agent running inside Tempo.",
  );
  expect(Context.getOption(tool.annotations, Tool.Title)).toEqual(
    Option.some("Read a Tempo thread"),
  );
  expect(Context.get(tool.annotations, Tool.Readonly)).toBe(true);
  expect(tool.name).toBe("t3_thread_read");
  expect(tool.id).toBe(UpstreamTool.id);
  expect(Tool.getJsonSchema(tool)).toEqual(Tool.getJsonSchema(UpstreamTool));
  expect(Tool.getDescription(UpstreamTool)).toBe(
    "Read a T3 thread. Needs an agent running inside T3 Code.",
  );
});

it("renames a toolkit's tools under their own names", () => {
  const toolkit = tempoToolkit(Toolkit.make(UpstreamTool));

  expect(Object.keys(toolkit.tools)).toEqual(["t3_thread_read"]);
  expect(Tool.getDescription(toolkit.tools.t3_thread_read)).toBe(
    "Read a Tempo thread. Needs an agent running inside Tempo.",
  );
});
