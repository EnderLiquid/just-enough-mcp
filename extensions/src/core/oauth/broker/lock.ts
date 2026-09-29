import { createRequire } from "node:module";
import {
  DEFAULT_OAUTH_BROKER_LOCK_STALE_MS,
  DEFAULT_OAUTH_BROKER_LOCK_UPDATE_MS,
} from "./protocol.ts";
import {
  ensureOAuthBrokerRuntimeDirectories,
  getOAuthBrokerRuntimePaths,
} from "./runtime-files.ts";

interface ProperLockfileModule {
  lock(
    file: string,
    options: Record<string, unknown>,
  ): Promise<() => Promise<void>>;
  check(file: string, options: Record<string, unknown>): Promise<boolean>;
}

const require = createRequire(import.meta.url);
const properLockfile = require("proper-lockfile") as ProperLockfileModule;

export type OAuthBrokerLockErrorCode = "lock-unavailable" | "lock-compromised" | "lock-release-failed";

export class OAuthBrokerLockError extends Error {
  readonly code: OAuthBrokerLockErrorCode;

  constructor(code: OAuthBrokerLockErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OAuthBrokerLockError";
    this.code = code;
  }
}

export interface OAuthBrokerLockOptions {
  readonly staleMs?: number;
  readonly updateMs?: number;
  readonly onCompromised?: (error: OAuthBrokerLockError) => void;
}

export interface OAuthBrokerLockHandle {
  readonly rootDir: string;
  readonly lockPath: string;
  readonly compromised: boolean;
  release(): Promise<void>;
}

export async function acquireOAuthBrokerLock(
  rootDir: string,
  options: OAuthBrokerLockOptions = {},
): Promise<OAuthBrokerLockHandle> {
  await ensureOAuthBrokerRuntimeDirectories(rootDir);
  const paths = getOAuthBrokerRuntimePaths(rootDir);
  const staleMs = requirePositive(options.staleMs ?? DEFAULT_OAUTH_BROKER_LOCK_STALE_MS, "staleMs");
  const updateMs = requirePositive(options.updateMs ?? DEFAULT_OAUTH_BROKER_LOCK_UPDATE_MS, "updateMs");
  let compromised = false;
  let releaseLock: (() => Promise<void>) | undefined;

  try {
    releaseLock = await properLockfile.lock(paths.lockTargetPath, {
      realpath: false,
      lockfilePath: paths.lockPath,
      stale: staleMs,
      update: updateMs,
      retries: 0,
      onCompromised: (error: Error) => {
        compromised = true;
        const wrapped = new OAuthBrokerLockError(
          "lock-compromised",
          "OAuth broker runtime lock was compromised.",
          { cause: error },
        );
        options.onCompromised?.(wrapped);
      },
    });
  } catch (error) {
    throw new OAuthBrokerLockError(
      isErrorWithCode(error) && error.code === "ELOCKED"
        ? "lock-unavailable"
        : "lock-release-failed",
      isErrorWithCode(error) && error.code === "ELOCKED"
        ? "OAuth broker runtime lock is already held."
        : "OAuth broker runtime lock could not be acquired.",
      { cause: error },
    );
  }

  let released = false;
  return {
    rootDir,
    lockPath: paths.lockPath,
    get compromised() {
      return compromised;
    },
    async release(): Promise<void> {
      if (released) {
        return;
      }
      released = true;
      try {
        await releaseLock?.();
      } catch (error) {
        throw new OAuthBrokerLockError(
          "lock-release-failed",
          "OAuth broker runtime lock could not be released.",
          { cause: error },
        );
      }
    },
  };
}

export async function isOAuthBrokerLockHeld(
  rootDir: string,
  options: Pick<OAuthBrokerLockOptions, "staleMs"> = {},
): Promise<boolean> {
  await ensureOAuthBrokerRuntimeDirectories(rootDir);
  const paths = getOAuthBrokerRuntimePaths(rootDir);
  try {
    return await properLockfile.check(paths.lockTargetPath, {
      realpath: false,
      lockfilePath: paths.lockPath,
      stale: options.staleMs ?? DEFAULT_OAUTH_BROKER_LOCK_STALE_MS,
    });
  } catch (error) {
    throw new OAuthBrokerLockError(
      "lock-unavailable",
      "OAuth broker runtime lock status could not be determined.",
      { cause: error },
    );
  }
}

function requirePositive(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${fieldName} must be a positive finite number.`);
  }
  return value;
}

function isErrorWithCode(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}
