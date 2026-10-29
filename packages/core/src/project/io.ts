import { readFileSync } from "node:fs";
import type { ErrorObject } from "ajv";
import { compare, printRational, type Rational, rational } from "../rational.ts";
import { validateProject } from "../schema.ts";
import type { Project } from "./types.ts";

interface SchemaNode {
  $ref?: string;
  const?: unknown;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  oneOf?: SchemaNode[];
}

const schema = JSON.parse(
  readFileSync(new URL("../../../../schema/timeline.schema.json", import.meta.url), "utf8"),
) as SchemaNode & { $defs: Record<string, SchemaNode> };
const originalKeys = new WeakMap<object, string[]>();

export interface ProjectIssue {
  code: "E_TIME_FORM";
  severity: "error";
  location: string;
}

export type ParseProjectResult =
  | { ok: true; project: Project; issues: ProjectIssue[] }
  | { ok: false; errors: ErrorObject[] };

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Project schema shape mismatch");
  return value;
}

function dereference(node: SchemaNode): SchemaNode {
  if (!node.$ref) return node;
  const name = required(node.$ref.split("/").at(-1));
  return required(schema.$defs[name]);
}

function objectSchema(node: SchemaNode, value: Record<string, unknown>): SchemaNode {
  const resolved = dereference(node);
  if (!resolved.oneOf) return resolved;
  return dereference(required(resolved.oneOf[value.kind === "subtitle" ? 1 : 0]));
}

const pointer = (path: string, key: string | number) =>
  `${path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;

function rememberKeyOrder(text: string, value: unknown): void {
  const orders = new Map<string, string[]>();
  let index = 0;
  const skipSpace = () => {
    while (/\s/.test(text[index] ?? "")) index++;
  };
  const readString = () => {
    const start = index++;
    while (index < text.length) {
      if (text[index] === "\\") index += 2;
      else if (text[index++] === '"') break;
    }
    return JSON.parse(text.slice(start, index)) as string;
  };
  const scan = (path: string): void => {
    skipSpace();
    if (text[index] === "{") {
      index++;
      const keys: string[] = [];
      skipSpace();
      while (text[index] !== "}") {
        const key = readString();
        if (!keys.includes(key)) keys.push(key);
        skipSpace();
        index++;
        scan(pointer(path, key));
        skipSpace();
        if (text[index] === ",") index++;
        skipSpace();
      }
      index++;
      orders.set(path, keys);
    } else if (text[index] === "[") {
      index++;
      skipSpace();
      let item = 0;
      while (text[index] !== "]") {
        scan(pointer(path, item++));
        skipSpace();
        if (text[index] === ",") index++;
        skipSpace();
      }
      index++;
    } else if (text[index] === '"') readString();
    else while (index < text.length && !/[\s,}\]]/.test(text[index] ?? "")) index++;
  };
  scan("");
  const attach = (item: unknown, path: string): void => {
    if (item === null || typeof item !== "object") return;
    if (Array.isArray(item)) {
      item.forEach((entry, offset) => {
        attach(entry, pointer(path, offset));
      });
    } else {
      originalKeys.set(item, orders.get(path) ?? Object.keys(item));
      for (const [key, entry] of Object.entries(item)) attach(entry, pointer(path, key));
    }
  };
  attach(value, "");
}

function convert(value: unknown, node: SchemaNode, path: string, issues: ProjectIssue[]): unknown {
  const reference = node.$ref?.split("/").at(-1);
  if (reference === "ext") return value;
  if (
    reference === "time" ||
    reference === "duration" ||
    reference === "duration_or_zero" ||
    reference === "rate" ||
    path.endsWith("/audio_rate")
  ) {
    const original = value as string;
    const seconds = reference !== "rate" && !path.endsWith("/audio_rate");
    const match = required(/^(\d+)(?:\/(\d+))?s?$/.exec(original));
    const parsed = rational(BigInt(required(match[1])), BigInt(match[2] ?? "1"));
    if (printRational(parsed, seconds) !== original)
      issues.push({ code: "E_TIME_FORM", severity: "error", location: path });
    return parsed;
  }
  if (Array.isArray(value))
    return value.map((item, index) => convert(item, required(dereference(node).items), pointer(path, index), issues));
  if (value !== null && typeof value === "object") {
    const properties = required(objectSchema(node, value as Record<string, unknown>).properties);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        convert(item, required(properties[key]), pointer(path, key), issues),
      ]),
    );
  }
  return value;
}

function parseError(message: string): ErrorObject {
  return { keyword: "parse", instancePath: "", schemaPath: "", params: {}, message };
}

export function parseProject(text: string): ParseProjectResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [parseError(error instanceof Error ? error.message : String(error))] };
  }
  if (
    value &&
    typeof value === "object" &&
    "schema" in value &&
    value.schema === "zsir-cut/timeline" &&
    "schema_version" in value &&
    value.schema_version === "0.1"
  ) {
    value.schema_version = "0.2";
  }
  const validation = validateProject(value);
  if (!validation.valid) {
    return {
      ok: false,
      errors: validation.errors.map((error) =>
        error.instancePath === "/schema_version"
          ? { ...error, message: `Unrecognized zsir-cut project version; upgrade zsir-cut to open this project.` }
          : error,
      ),
    };
  }
  rememberKeyOrder(text, value);
  const issues: ProjectIssue[] = [];
  return { ok: true, project: convert(value, schema, "", issues) as Project, issues };
}

function isRational(value: unknown): value is Rational {
  return value !== null && typeof value === "object" && "numerator" in value && "denominator" in value;
}

function sortArray(values: unknown[], node: SchemaNode): unknown[] {
  const item = dereference(node).items;
  const name = item?.$ref?.split("/").at(-1);
  const field = name === "clip" ? "timeline_start" : name === "token" ? "align" : name === "marker" ? "at" : null;
  if (!field) return values;
  return values.toSorted((left, right) => {
    const a = required((left as Record<string, Rational | { start: Rational }>)[field]);
    const b = required((right as Record<string, Rational | { start: Rational }>)[field]);
    return compare(isRational(a) ? a : a.start, isRational(b) ? b : b.start);
  });
}

function encode(value: unknown, node: SchemaNode, path: string): unknown {
  const reference = node.$ref?.split("/").at(-1);
  if (reference === "ext") return value;
  if (isRational(value)) return printRational(value, reference !== "rate" && !path.endsWith("/audio_rate"));
  if (Array.isArray(value)) {
    const item = required(dereference(node).items);
    return sortArray(value, node).map((entry, index) => encode(entry, item, pointer(path, index)));
  }
  if (value !== null && typeof value === "object") {
    const properties = required(objectSchema(node, value as Record<string, unknown>).properties);
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(properties)
        .filter((key) => source[key] !== undefined)
        .map((key) => [key, encode(source[key], required(properties[key]), pointer(path, key))]),
    );
  }
  return value;
}

export function serializeProject(project: Project): string {
  const stringify = (value: unknown, depth: number): string => {
    if (Array.isArray(value)) {
      if (value.length === 0) return "[]";
      return `[\n${value.map((item) => `${"  ".repeat(depth + 1)}${stringify(item, depth + 1)}`).join(",\n")}\n${"  ".repeat(depth)}]`;
    }
    if (value !== null && typeof value === "object") {
      const source = value as Record<string, unknown>;
      const keys = [...(originalKeys.get(value) ?? []), ...Object.keys(source)].filter(
        (key, index, all) => Object.hasOwn(source, key) && all.indexOf(key) === index,
      );
      if (keys.length === 0) return "{}";
      return `{\n${keys.map((key) => `${"  ".repeat(depth + 1)}${JSON.stringify(key)}: ${stringify(source[key], depth + 1)}`).join(",\n")}\n${"  ".repeat(depth)}}`;
    }
    return JSON.stringify(value) as string;
  };
  return `${stringify(encode(project, schema, ""), 0)}\n`;
}
