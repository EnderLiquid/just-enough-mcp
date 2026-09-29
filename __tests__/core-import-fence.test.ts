import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const coreRoots = [
  "extensions/artifacts",
  "extensions/concurrency",
  "extensions/config/overview-bootstrap.ts",
  "extensions/config/overview-bootstrapper.ts",
  "extensions/config/plugin-config.ts",
  "extensions/config/server-overviews.ts",
  "extensions/formatting",
  "extensions/modeling",
  "extensions/oauth",
  "extensions/prompting",
  "extensions/servers",
];

function collectTypeScriptFiles(path: string): string[] {
  if (statSync(path).isFile()) {
    return path.endsWith(".ts") ? [path] : [];
  }

  return readdirSync(path, { withFileTypes: true }).flatMap(entry =>
    collectTypeScriptFiles(join(path, entry.name)),
  );
}

describe("core import fence", () => {
  it("核心 Registry 及其传递依赖不导入 Pi 包", () => {
    const projectRoot = process.cwd();
    const forbiddenImports = /@earendil-works\/pi-(?:coding-agent|ai|tui)/;
    const violations = coreRoots
      .flatMap(root => collectTypeScriptFiles(join(projectRoot, root)))
      .filter(filePath => forbiddenImports.test(readFileSync(filePath, "utf8")))
      .map(filePath => filePath.slice(projectRoot.length + 1).replaceAll("\\", "/"));

    expect(violations).toEqual([]);
  });
});
