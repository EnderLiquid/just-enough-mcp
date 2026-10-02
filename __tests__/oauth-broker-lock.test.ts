import { describe, expect, it } from "vitest";
import {
  acquireOAuthBrokerLock,
  isOAuthBrokerLockHeld,
} from "../packages/core/src/oauth/broker/lock.js";
import { createTempDirFixture } from "./support/temp-dir.js";

const tempDirs = createTempDirFixture("just-enough-mcp-oauth-broker-lock");

describe("OAuth broker runtime 锁", () => {
  it("互斥，且 release 幂等", async () => {
    const rootDir = tempDirs.create();
    const first = await acquireOAuthBrokerLock(rootDir, {
      staleMs: 2_000,
      updateMs: 1_000,
    });

    expect(await isOAuthBrokerLockHeld(rootDir, { staleMs: 2_000 })).toBe(true);
    await expect(acquireOAuthBrokerLock(rootDir, {
      staleMs: 2_000,
      updateMs: 1_000,
    })).rejects.toMatchObject({ code: "lock-unavailable" });

    await first.release();
    await first.release();
    expect(await isOAuthBrokerLockHeld(rootDir, { staleMs: 2_000 })).toBe(false);
  });
});
