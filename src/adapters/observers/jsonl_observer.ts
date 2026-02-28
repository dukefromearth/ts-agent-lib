import { appendFile } from "node:fs/promises";
import { BufferedObserver, OverflowPolicy, type OverflowPolicy as OverflowPolicyType } from "../../observers";
import type { ExecutionEventType } from "../../types";

export interface JsonlObserverOptions {
  maxQueueSize?: number;
  overflowPolicy?: OverflowPolicyType;
  serialize?: (event: ExecutionEventType) => string;
}

export class JsonlEventObserver extends BufferedObserver {
  private readonly outputPath: string;
  private readonly serializeEvent: (event: ExecutionEventType) => string;

  constructor(outputPath: string, options: JsonlObserverOptions = {}) {
    super({
      maxQueueSize: options.maxQueueSize ?? 5000,
      overflowPolicy: options.overflowPolicy ?? OverflowPolicy.DROP_OLDEST
    });
    this.outputPath = outputPath;
    this.serializeEvent = options.serialize ?? ((event) => JSON.stringify(event));
  }

  protected async process(event: ExecutionEventType): Promise<void> {
    await appendFile(this.outputPath, `${this.serializeEvent(event)}\n`, "utf8");
  }
}
