import { spawn } from "node:child_process";

export type OauthAuthorizationUrlOpener = (url: URL) => Promise<void>;

function browserCommand(): { command: string; args: (url: string) => string[] } {
  switch (process.platform) {
    case "win32":
      return { command: "explorer.exe", args: url => [url] };
    case "darwin":
      return { command: "open", args: url => [url] };
    default:
      return { command: "xdg-open", args: url => [url] };
  }
}

/** 在不经 shell 解释的前提下打开已校验的授权 URL。 */
export const openAuthorizationUrl: OauthAuthorizationUrlOpener = async url => {
  const launcher = browserCommand();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launcher.command, launcher.args(url.toString()), {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
};
