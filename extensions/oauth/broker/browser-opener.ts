import { spawn } from "node:child_process";

export type BrowserOpener = (url: string) => Promise<void>;

/**
 * 平台默认浏览器 opener：detached 启动命令，不等待浏览器退出。
 * 启动失败（命令不存在、平台不支持）时 reject，由 authorize 事务转为 browser-open-failed。
 */
export function createPlatformBrowserOpener(
  platform: NodeJS.Platform = process.platform,
): BrowserOpener {
  return url => new Promise<void>((resolveOpen, rejectOpen) => {
    let command: string;
    let args: string[];
    if (platform === "win32") {
      command = "cmd";
      args = ["/c", "start", "", url];
    } else if (platform === "darwin") {
      command = "open";
      args = [url];
    } else if (platform === "linux") {
      command = "xdg-open";
      args = [url];
    } else {
      rejectOpen(new Error(`Opening a browser is not supported on platform ${platform}.`));
      return;
    }

    let child;
    try {
      child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      rejectOpen(error);
      return;
    }

    child.once("error", rejectOpen);
    child.once("spawn", () => {
      child.unref();
      resolveOpen();
    });
  });
}
