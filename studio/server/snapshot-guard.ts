/** Excludes API input changes while the asynchronous filesystem copy runs. */
export class SnapshotGuard {
  private requests = 0;
  private copying = false;

  async request<T>(operation: () => Promise<T>): Promise<T> {
    if (this.copying) throw new Error("整库快照正在创建，请完成后重试");
    this.requests += 1;
    try { return await operation(); }
    finally { this.requests -= 1; }
  }

  async snapshot<T>(activity: {active: number; queued: number}, operation: () => Promise<T>, ownRequests = 0): Promise<T> {
    if (activity.active || activity.queued) throw new Error("模型任务运行或排队期间不创建整库快照，请等待当前任务结束");
    if (this.copying || this.requests > ownRequests) throw new Error("其他请求或快照仍在处理，请稍后重试整库快照");
    // Set synchronously, before even the first filesystem await.
    this.copying = true;
    try { return await operation(); }
    finally { this.copying = false; }
  }
}
