import { spawn } from "node:child_process";

export type BrowserOpener = (url: string) => Promise<void>;

/**
 * 平台默认浏览器 opener：detached 启动命令，不等待浏览器退出。
 * 启动失败（命令不存在、平台不支持）时 reject，由 authorize 事务转为 browser-open-failed。
 *
 * win32 不使用 `cmd /c start`：cmd.exe 会在 start 执行前重新解析 `&`、`|`、`^` 等元字符，
 * 截断 URL 并把残余片段当作命令执行。rundll32 将 URL 作为 argv 原样接收，不经任何 shell 解析。
 */
export function createPlatformBrowserOpener(
  platform: NodeJS.Platform = process.platform,
): BrowserOpener {
  return url => new Promise<void>((resolveOpen, rejectOpen) => {
    let command: string;
    let args: string[];
    if (platform === "win32") {
      command = "rundll32";
      args = ["url.dll,FileProtocolHandler", url];
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
        // 对当前三个平台命令行均无实际作用（xdg-open/open/rundll32 都不弹控制台），
        // 保留它只是防止未来 win32 分支换回控制台子系统命令时重新引入窗口。
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
