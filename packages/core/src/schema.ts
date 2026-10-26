import { readFileSync } from "node:fs";
import Ajv2020Module, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

const ajv = new Ajv2020Module.default({ strict: true, allErrors: true });
addFormatsModule.default(ajv);

for (const name of ["timeline", "envelope", "loss-report", "handoff-manifest"]) {
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

if (!project || !envelope || !lossReport || !manifest) {
  throw new Error("Missing zsir-cut schema");
}

export const validateProject = (value: unknown) => validate(project, value);
export const validateEnvelope = (value: unknown) => validate(envelope, value);
export const validateLossReport = (value: unknown) => validate(lossReport, value);
export const validateManifest = (value: unknown) => validate(manifest, value);
