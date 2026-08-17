import { DurableObject } from "cloudflare:workers";
import { fetchTimeSlots, sendBark } from "./clients";
import { MonitorService } from "./monitor-service";
import { createInitialRecord } from "./schedule";
import type { Env, MonitorRecord } from "./types";

class DurableMonitorStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  async load(): Promise<MonitorRecord> {
    return (await this.storage.get<MonitorRecord>("monitor")) ?? createInitialRecord();
  }

  async save(record: MonitorRecord): Promise<void> {
    await this.storage.put("monitor", record);
  }
}

export class Monitor extends DurableObject<Env> {
  private operationQueue: Promise<void> = Promise.resolve();

  private service(): MonitorService {
    return new MonitorService(new DurableMonitorStore(this.ctx.storage), {
      now: () => Date.now(),
      fetchSlots: () => fetchTimeSlots(fetch),
      push: (intent) => sendBark(fetch, this.env.BARK_DEVICE_KEY, intent)
    });
  }

  tick(nowMs: number, force = false) {
    return this.serialize(() => this.service().tick(nowMs, force));
  }

  getStatus(nowMs: number) {
    return this.serialize(() => this.service().getStatus(nowMs));
  }

  setConfig(codes: string[], nowMs: number) {
    return this.serialize(() => this.service().setConfig(codes, nowMs));
  }

  testNotification() {
    return this.serialize(() => this.service().testNotification());
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
