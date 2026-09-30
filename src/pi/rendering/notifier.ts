export type NotifyType = "info" | "warning" | "error";

export interface NotifierSink {
  notify(message: string, type?: NotifyType): void;
}

export interface Notifier {
  notify(message: string, type?: NotifyType): void;
  notifyInfo(message: string): void;
  notifyWarning(message: string): void;
  notifyError(message: string): void;
}

export function createNotifier(notifier?: NotifierSink): Notifier {
  function notify(message: string, type: NotifyType = "info"): void {
    try {
      notifier?.notify(message, type);
    } catch {}
  }

  return {
    notify,
    notifyInfo: message => notify(message, "info"),
    notifyWarning: message => notify(message, "warning"),
    notifyError: message => notify(message, "error"),
  };
}
