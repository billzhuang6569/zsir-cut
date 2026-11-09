import { homedir } from "node:os";
import { join } from "node:path";

export function asrPythonPath(directory: string, packaged = process.env.ZCUT_PACKAGED === "1") {
  return packaged ? join(homedir(), ".zsir-cut/asr/.venv/bin/python") : join(directory, ".venv/bin/python");
}
