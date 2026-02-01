type GetWaiter<T> = {
  resolve: (item: T) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

type PutWaiter<T> = {
  item: T;
  resolve: () => void;
  reject: (err: Error) => void;
};

export class AsyncQueue<T> {
  private readonly capacity: number;
  private readonly items: T[] = [];
  private readonly getWaiters: GetWaiter<T>[] = [];
  private readonly putWaiters: PutWaiter<T>[] = [];

  constructor(capacity: number = Infinity) {
    if (!Number.isFinite(capacity) && capacity !== Infinity) {
      throw new Error("capacity must be a number or Infinity");
    }
    if (capacity <= 0) {
      throw new Error("capacity must be > 0");
    }
    this.capacity = capacity;
  }

  get size(): number {
    return this.items.length;
  }

  shift(): T | undefined {
    if (this.items.length === 0) {
      return undefined;
    }
    const item = this.items.shift();
    this.drainPutWaiter();
    return item;
  }

  async put(item: T): Promise<void> {
    if (this.getWaiters.length > 0) {
      const waiter = this.getWaiters.shift()!;
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(item);
      return;
    }

    if (this.items.length < this.capacity) {
      this.items.push(item);
      return;
    }

    return new Promise((resolve, reject) => {
      this.putWaiters.push({ item, resolve, reject });
    });
  }

  tryPut(item: T): boolean {
    if (this.getWaiters.length > 0) {
      const waiter = this.getWaiters.shift()!;
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(item);
      return true;
    }

    if (this.items.length < this.capacity) {
      this.items.push(item);
      return true;
    }

    return false;
  }

  async get(signal?: AbortSignal): Promise<T> {
    if (this.items.length > 0) {
      const item = this.items.shift()!;
      this.drainPutWaiter();
      return item;
    }

    if (signal?.aborted) {
      throw abortError();
    }

    return new Promise((resolve, reject) => {
      const waiter: GetWaiter<T> = {
        resolve,
        reject,
        signal
      };

      if (signal) {
        const onAbort = () => {
          this.removeGetWaiter(waiter);
          reject(abortError());
        };
        waiter.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.getWaiters.push(waiter);
    });
  }

  private removeGetWaiter(waiter: GetWaiter<T>): void {
    const idx = this.getWaiters.indexOf(waiter);
    if (idx >= 0) {
      this.getWaiters.splice(idx, 1);
    }
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }

  private drainPutWaiter(): void {
    if (this.items.length >= this.capacity) {
      return;
    }
    if (this.putWaiters.length === 0) {
      return;
    }

    const waiter = this.putWaiters.shift()!;
    this.items.push(waiter.item);
    waiter.resolve();
  }
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
