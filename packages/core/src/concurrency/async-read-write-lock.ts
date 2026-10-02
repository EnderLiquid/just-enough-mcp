type LockMode = "read" | "write";

type ReleaseLock = () => void;

interface PendingLockRequest {
  mode: LockMode;
  resolve: (release: ReleaseLock) => void;
}

export class AsyncReadWriteLock {
  private activeReaders = 0;
  private writerActive = false;
  private readonly pending: PendingLockRequest[] = [];

  async withRead<T>(operation: () => T | Promise<T>): Promise<T> {
    const release = await this.acquire("read");
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async withWrite<T>(operation: () => T | Promise<T>): Promise<T> {
    const release = await this.acquire("write");
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private acquire(mode: LockMode): Promise<ReleaseLock> {
    if (this.canAcquireImmediately(mode)) {
      return Promise.resolve(this.grant(mode));
    }

    return new Promise(resolve => {
      this.pending.push({ mode, resolve });
    });
  }

  private canAcquireImmediately(mode: LockMode): boolean {
    if (this.writerActive || this.pending.length > 0) {
      return false;
    }

    return mode === "read" || this.activeReaders === 0;
  }

  private grant(mode: LockMode): ReleaseLock {
    if (mode === "read") {
      this.activeReaders += 1;
    } else {
      this.writerActive = true;
    }

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;

      if (mode === "read") {
        this.activeReaders -= 1;
      } else {
        this.writerActive = false;
      }
      this.advanceQueue();
    };
  }

  private advanceQueue(): void {
    if (this.writerActive || this.activeReaders > 0) {
      return;
    }

    const first = this.pending.shift();
    if (!first) {
      return;
    }

    if (first.mode === "write") {
      first.resolve(this.grant("write"));
      return;
    }

    first.resolve(this.grant("read"));
    while (this.pending[0]?.mode === "read") {
      this.pending.shift()!.resolve(this.grant("read"));
    }
  }
}
