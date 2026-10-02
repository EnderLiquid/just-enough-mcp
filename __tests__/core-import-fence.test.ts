import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const coreRoot = "packages/core/src";

function collectTypeScriptFiles(path: string): string[] {
  if (statSync(path).isFile()) {
    return path.endsWith(".ts") ? [path] : [];
  }

  return readdirSync(path, { withFileTypes: true }).flatMap(entry =>
    collectTypeScriptFiles(join(path, entry.name)),
  );
}

function resolveLocalTypeScriptImport(filePath: string, specifier: string): string | undefined {
  const withoutJavaScriptExtension = specifier.endsWith(".js")
    ? specifier.slice(0, -3)
    : specifier;
  const basePath = resolve(dirname(filePath), withoutJavaScriptExtension);
  const candidates = [
    `${basePath}.ts`,
    `${basePath}.tsx`,
    join(basePath, "index.ts"),
  ];

  return candidates.find(candidate => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !path.startsWith(`..${"/"}`) && !path.startsWith(`..${"\\"}`));
}

describe("core import fence", () => {
  it("核心及其本地传递依赖不导入 Pi 包或 Pi adapter", () => {
    const projectRoot = process.cwd();
    const absoluteCoreRoot = resolve(projectRoot, coreRoot);
    const coreFiles = collectTypeScriptFiles(absoluteCoreRoot);
    const forbiddenImports = /@earendil-works\/pi-(?:coding-agent|ai|tui)/;
    const localImportPattern = /(?:from\s+|import\s*\(\s*|export\s+[^;]*?from\s+)\["'](\.[^"']+)["']/g;
    const violations: string[] = [];

    for (const filePath of coreFiles) {
      const source = readFileSync(filePath, "utf8");
      const displayPath = filePath.slice(projectRoot.length + 1).replaceAll("\\", "/");
      if (forbiddenImports.test(source)) {
        violations.push(displayPath);
      }

      for (const match of source.matchAll(localImportPattern)) {
        const target = resolveLocalTypeScriptImport(filePath, match[1]!);
        if (target && !isInside(absoluteCoreRoot, target)) {
          violations.push(`${displayPath} -> ${target.slice(projectRoot.length + 1).replaceAll("\\", "/")}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
