/** In-process request metrics exposed on the platform health endpoint. */
class Metrics {
  readonly startedAt = new Date();
  private requests = 0;
  private errors = 0;
  private byStatus = new Map<number, number>();
  private latencies: number[] = [];
  private slow = new Map<string, { count: number; totalMs: number }>();

  record(route: string, status: number, ms: number): void {
    this.requests++;
    this.byStatus.set(status, (this.byStatus.get(status) ?? 0) + 1);
    this.latencies.push(ms);
    if (this.latencies.length > 2000) this.latencies.splice(0, 1000);
    const s = this.slow.get(route) ?? { count: 0, totalMs: 0 };
    s.count++;
    s.totalMs += ms;
    this.slow.set(route, s);
  }

  recordError(): void {
    this.errors++;
  }

  snapshot() {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const pct = (p: number) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]! * 10) / 10 : 0);
    return {
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds: Math.round((Date.now() - this.startedAt.getTime()) / 1000),
      requests: this.requests,
      unhandledErrors: this.errors,
      statusCounts: Object.fromEntries(this.byStatus),
      latencyMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) },
      slowestRoutes: [...this.slow.entries()]
        .map(([route, v]) => ({ route, count: v.count, avgMs: Math.round((v.totalMs / v.count) * 10) / 10 }))
        .sort((a, b) => b.avgMs - a.avgMs)
        .slice(0, 10),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    };
  }
}

export const metrics = new Metrics();
