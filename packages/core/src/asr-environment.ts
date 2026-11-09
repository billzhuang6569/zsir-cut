import { join } from "node:path";

export function asrPythonPath(directory: string, packaged = process.env.ZCUT_PACKAGED === "1") {
  return packaged ? join(directory, "../../python/bin/python3") : join(directory, ".venv/bin/python");
}
