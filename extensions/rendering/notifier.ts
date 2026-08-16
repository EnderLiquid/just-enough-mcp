export type NotifyType = "info" | "warning" | "error";

export interface NotifierSink {
  notify(message: string, type?: NotifyType): void;
}

let currentNotifier: NotifierSink | undefined;

export function installNotifierSink(notifier?: NotifierSink): () => void {
  currentNotifier = notifier;

  return () => {
    if (currentNotifier === notifier) {
      currentNotifier = undefined;
    }
  };
}

export function notify(message: string, type: NotifyType = "info"): void {
  try {
    currentNotifier?.notify(message, type);
  } catch {}
}

export function notifyInfo(message: string): void {
  notify(message, "info");
}

export function notifyWarning(message: string): void {
  notify(message, "warning");
}

export function notifyError(message: string): void {
  notify(message, "error");
}
