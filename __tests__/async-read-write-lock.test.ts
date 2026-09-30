import { describe, expect, it, vi } from "vitest";
import { AsyncReadWriteLock } from "../src/core/concurrency/async-read-write-lock.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("AsyncReadWriteLock", () => {
  it("允许多个读操作并发执行", async () => {
    const lock = new AsyncReadWriteLock();
    const releaseReaders = deferred();
    const entered = vi.fn();

    const first = lock.withRead(async () => {
      entered("first");
      await releaseReaders.promise;
    });
    const second = lock.withRead(async () => {
      entered("second");
      await releaseReaders.promise;
    });

    await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(2));
    releaseReaders.resolve();
    await Promise.all([first, second]);
  });

  it("写操作等待既有读操作结束，并阻止后续读操作插队", async () => {
    const lock = new AsyncReadWriteLock();
    const releaseFirstReader = deferred();
    const releaseWriter = deferred();
    const order: string[] = [];

    const firstReader = lock.withRead(async () => {
      order.push("read-1:start");
      await releaseFirstReader.promise;
      order.push("read-1:end");
    });
    await vi.waitFor(() => expect(order).toEqual(["read-1:start"]));

    const writer = lock.withWrite(async () => {
      order.push("write:start");
      await releaseWriter.promise;
      order.push("write:end");
    });
    const secondReader = lock.withRead(() => {
      order.push("read-2");
    });

    await Promise.resolve();
    expect(order).toEqual(["read-1:start"]);

    releaseFirstReader.resolve();
    await vi.waitFor(() => expect(order).toEqual(["read-1:start", "read-1:end", "write:start"]));
    releaseWriter.resolve();

    await Promise.all([firstReader, writer, secondReader]);
    expect(order).toEqual([
      "read-1:start",
      "read-1:end",
      "write:start",
      "write:end",
      "read-2",
    ]);
  });

  it("操作抛出异常后仍释放锁", async () => {
    const lock = new AsyncReadWriteLock();
    const error = new Error("failed");

    await expect(lock.withWrite(() => {
      throw error;
    })).rejects.toBe(error);

    await expect(lock.withRead(() => "ok")).resolves.toBe("ok");
  });
});
