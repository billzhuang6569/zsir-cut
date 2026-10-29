import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

interface Recent {
  path: string;
  name: string;
  openedAt: string;
}
export class RecentProjects {
  private file: string;
  constructor(
    directory = process.platform === "darwin"
      ? join(homedir(), "Library/Application Support/zsir-cut")
      : join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "zsir-cut"),
  ) {
    this.file = join(directory, "recent.json");
  }
  private async read(): Promise<Recent[]> {
    try {
      const rows: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (!Array.isArray(rows)) throw new Error("最近工程记录无效");
      return rows.filter(
        (row): row is Recent =>
          typeof row?.path === "string" && typeof row?.name === "string" && typeof row?.openedAt === "string",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  private async write(rows: Recent[]) {
    await mkdir(join(this.file, ".."), { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify(rows));
    await rename(`${this.file}.tmp`, this.file);
  }
  async list() {
    return Promise.all(
      (await this.read()).map(async (row) => ({
        ...row,
        exists: await stat(row.path).then(
          (s) => s.isFile(),
          () => false,
        ),
      })),
    );
  }
  async add(path: string, name: string) {
    path = resolve(path);
    await this.write(
      [
        { path, name, openedAt: new Date().toISOString() },
        ...(await this.read()).filter((row) => row.path !== path),
      ].slice(0, 10),
    );
  }
  async remove(path: string) {
    await this.write((await this.read()).filter((row) => row.path !== path));
  }
}
