/**
 * Tempo: what a tool's advertised input leaves out while no relay names another machine:
 * `environmentId`, which targets a linked machine, and the webhook trigger of `schedule_task`,
 * whose public URL comes from the relay. Handlers still accept them, so this only shortens what
 * agents read.
 */
type Json = unknown;
type JsonObject = { [key: string]: Json };

const isObject = (value: Json): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const WEBHOOK_TRIGGER_FIELDS = ["signature", "maxDeliveryAgeMinutes", "dedupe", "filters"];

const withoutFields = (properties: JsonObject, fields: ReadonlyArray<string>): JsonObject =>
  Object.fromEntries(Object.entries(properties).filter(([name]) => !fields.includes(name)));

const withoutWebhookTrigger = (schedule: Json): Json => {
  if (!isObject(schedule) || !isObject(schedule.properties)) return schedule;
  const trigger = schedule.properties.type;
  if (!isObject(trigger) || !Array.isArray(trigger.enum) || !trigger.enum.includes("webhook")) {
    return schedule;
  }
  return {
    ...schedule,
    description: "Trigger: {type:'interval',everyMs} or {type:'fixed_time',timeOfDay,weekdays?}.",
    properties: {
      ...withoutFields(schedule.properties, WEBHOOK_TRIGGER_FIELDS),
      type: { ...trigger, enum: trigger.enum.filter((value) => value !== "webhook") },
    },
  };
};

const visit = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(visit);
  if (!isObject(value)) return value;
  const next = Object.fromEntries(
    Object.entries(value).map(([name, entry]) => [name, visit(entry)]),
  );
  if (!isObject(next.properties)) return next;
  const properties = withoutFields(next.properties, ["environmentId"]);
  return {
    ...next,
    properties:
      properties.schedule === undefined
        ? properties
        : { ...properties, schedule: withoutWebhookTrigger(properties.schedule) },
    ...(Array.isArray(next.required)
      ? { required: next.required.filter((name) => name !== "environmentId") }
      : {}),
  };
};

export const singleMacInputSchema = <Schema extends object>(schema: Schema): Schema =>
  visit(schema) as Schema;
