import { readFileSync } from "node:fs";
import Ajv2020Module, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { parseRational, printRational } from "./rational.ts";

const ajv = new Ajv2020Module.default({ strict: true, allErrors: true });
addFormatsModule.default(ajv);

for (const name of ["timeline", "envelope", "loss-report", "handoff-manifest", "command"]) {
  const schema = JSON.parse(readFileSync(new URL(`../../../schema/${name}.schema.json`, import.meta.url), "utf8"));
  ajv.addSchema(schema);
}

function validate(validator: ValidateFunction, value: unknown): { valid: boolean; errors: ErrorObject[] } {
  const valid = validator(value);
  return { valid, errors: validator.errors ?? [] };
}

const project = ajv.getSchema("https://github.com/billzhuang6569/zsir-cut/schema/timeline.schema.json");
const envelope = ajv.getSchema("https://github.com/billzhuang6569/zsir-cut/schema/envelope.schema.json");
const lossReport = ajv.getSchema("https://github.com/billzhuang6569/zsir-cut/schema/loss-report.schema.json");
const manifest = ajv.getSchema("https://github.com/billzhuang6569/zsir-cut/schema/handoff-manifest.schema.json");
const commandId = "https://github.com/billzhuang6569/zsir-cut/schema/command.schema.json";

interface CommandNode {
  $ref?: string;
  properties?: Record<string, CommandNode>;
  items?: CommandNode;
  allOf?: CommandNode[];
  oneOf?: CommandNode[];
  anyOf?: CommandNode[];
  const?: unknown;
}

export function normalizeCommand(verb: string, input: unknown): unknown {
  const schema = ajv.getSchema(commandId)?.schema as {
    $defs: Record<string, CommandNode> & { requests: Record<string, CommandNode> };
  };
  const visit = (value: unknown, node: CommandNode, key = ""): unknown => {
    if (typeof value === "string" && (node.$ref === "#/$defs/seconds" || key === "edit_rate")) {
      try {
        return printRational(parseRational(value, key !== "edit_rate", false), key !== "edit_rate");
      } catch {
        return value; // Let request validation report malformed values.
      }
    }
    if (node.$ref) return visit(value, schema.$defs[node.$ref.split("/").at(-1) ?? ""] ?? {}, key);
    for (const branch of [...(node.allOf ?? []), ...(node.oneOf ?? []), ...(node.anyOf ?? [])]) {
      const op = branch.properties?.op?.const;
      if (op !== undefined && (!value || typeof value !== "object" || !("op" in value) || value.op !== op)) continue;
      value = visit(value, branch, key);
    }
    if (Array.isArray(value)) return node.items ? value.map((item) => visit(item, node.items ?? {})) : value;
    if (value && typeof value === "object" && node.properties) {
      const properties = node.properties;
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [
          name,
          properties[name] ? visit(item, properties[name], name) : item,
        ]),
      );
    }
    return value;
  };
  return visit(input, schema.$defs.requests[verb] ?? {});
}

if (!project || !envelope || !lossReport || !manifest) {
  throw new Error("Missing zsir-cut schema");
}

export const validateProject = (value: unknown) => validate(project, value);
export const validateEnvelope = (value: unknown) => validate(envelope, value);
export const validateLossReport = (value: unknown) => validate(lossReport, value);
export const validateManifest = (value: unknown) => validate(manifest, value);
export function validateCommand(verb: string, value: unknown): { valid: boolean; errors: ErrorObject[] } {
  const validator = ajv.getSchema(`${commandId}#/$defs/requests/${verb}`);
  if (!validator)
    return {
      valid: false,
      errors: [
        {
          keyword: "verb",
          instancePath: "",
          schemaPath: "",
          params: {},
          message: `未知动词；可选值：${Object.keys(requests()).join(", ")}`,
        },
      ],
    };
  const result = validate(validator, value);
  if (
    result.valid ||
    verb !== "edit" ||
    !value ||
    typeof value !== "object" ||
    !("ops" in value) ||
    !Array.isArray(value.ops)
  )
    return result;
  const errors = result.errors.filter(
    (error) =>
      !/^\/ops\/\d+(?:\/|$)/.test(error.instancePath) &&
      !(error.keyword === "unevaluatedProperties" && error.params.unevaluatedProperty === "ops"),
  );
  const schema = ajv.getSchema(commandId)?.schema as {
    $defs: { edit_op: { oneOf: { properties: { op: { const: string } } }[] } };
  };
  const branches = schema.$defs.edit_op.oneOf;
  for (const [index, op] of value.ops.entries()) {
    const name = op && typeof op === "object" && "op" in op ? op.op : undefined;
    const branch = branches.findIndex((item) => item.properties.op.const === name);
    if (branch < 0) {
      errors.push({
        keyword: "op",
        instancePath: `/ops/${index}/op`,
        schemaPath: "",
        params: {},
        message: `未知操作；可选值：${branches.map((item) => item.properties.op.const).join(", ")}`,
      });
      continue;
    }
    const selected = ajv.getSchema(`${commandId}#/$defs/edit_op/oneOf/${branch}`);
    if (!selected) throw new Error("Missing edit operation schema");
    errors.push(
      ...validate(selected, op).errors.map((error) => ({
        ...error,
        instancePath: `/ops/${index}${error.instancePath}`,
      })),
    );
  }
  return { valid: false, errors };
}

function requests(): Record<string, Record<string, unknown>> {
  return (ajv.getSchema(commandId)?.schema as { $defs: { requests: Record<string, Record<string, unknown>> } }).$defs
    .requests;
}

export function commandSchemaForVerb(verb: string): Record<string, unknown> {
  const schema = ajv.getSchema(commandId)?.schema as {
    $defs: {
      author: unknown;
      read: unknown;
      write: unknown;
      requests: Record<string, Record<string, unknown>>;
      [key: string]: unknown;
    };
  };
  return {
    type: "object",
    ...schema.$defs.requests[verb],
    $defs: Object.fromEntries(Object.entries(schema.$defs).filter(([key]) => key !== "requests")),
  };
}

// MCP clients need field types directly in properties; core validation keeps the original schema.
export function flattenMcpSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const expand = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(expand);
    if (!value || typeof value !== "object") return value;
    const node = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    const merge = (source: Record<string, unknown>) => {
      const properties: Record<string, unknown> = {
        ...(result.properties as object),
        ...(source.properties as object),
      };
      for (const [key, field] of Object.entries((result.properties as object) ?? {}))
        if (properties[key] === true) Object.assign(properties, { [key]: field });
      const required = [
        ...new Set([...((result.required as string[]) ?? []), ...((source.required as string[]) ?? [])]),
      ];
      Object.assign(result, source);
      if (Object.keys(properties).length) result.properties = properties;
      if (required.length) result.required = required;
    };
    if (typeof node.$ref === "string") {
      if (!node.$ref.startsWith("#/")) throw new Error(`Unsupported MCP schema reference: ${node.$ref}`);
      let target: unknown = schema;
      for (const part of node.$ref.slice(2).split("/"))
        target = (target as Record<string, unknown>)[part.replaceAll("~1", "/").replaceAll("~0", "~")];
      merge(expand(target) as Record<string, unknown>);
    }
    for (const branch of (node.allOf as unknown[]) ?? []) merge(expand(branch) as Record<string, unknown>);
    merge(
      Object.fromEntries(
        Object.entries(node)
          .filter(([key]) => !["$defs", "$ref", "allOf", "if", "then", "else"].includes(key))
          .map(([key, field]) => [key, expand(field)]),
      ),
    );
    for (const key of ["anyOf", "oneOf"]) {
      for (const branch of (result[key] as Record<string, unknown>[]) ?? [])
        if (branch.properties)
          result.properties = { ...(branch.properties as object), ...(result.properties as object) };
    }
    return result;
  };
  return expand(schema) as Record<string, unknown>;
}
