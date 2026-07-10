import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempDirFixture {
  create(): string;
  cleanup(): void;
}

export function createTempDirFixture(prefix: string): TempDirFixture {
  const directories = new Set<string>();

  return {
    create() {
      const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
      directories.add(directory);
      return directory;
    },
    cleanup() {
      for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
      }
      directories.clear();
    },
  };
}
