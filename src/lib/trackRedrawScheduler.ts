type DrawCallback = () => void;

class TrackRedrawScheduler {
  private readonly callbacks = new Set<DrawCallback>();
  private readonly pending = new Set<DrawCallback>();
  private rafId: number | null = null;

  register(callback: DrawCallback): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
      this.pending.delete(callback);
    };
  }

  request(callback: DrawCallback): void {
    if (!this.callbacks.has(callback)) {
      return;
    }
    this.pending.add(callback);
    this.schedule();
  }

  requestAll(): void {
    for (const callback of this.callbacks) {
      this.pending.add(callback);
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.rafId !== null) {
      return;
    }
    this.rafId = window.requestAnimationFrame(() => {
      this.rafId = null;
      const jobs = Array.from(this.pending);
      this.pending.clear();
      for (const job of jobs) {
        job();
      }
    });
  }
}

export const trackRedrawScheduler = new TrackRedrawScheduler();
