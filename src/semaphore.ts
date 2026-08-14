/**
 * A minimal counting semaphore with FIFO waiters.
 *
 * `acquire()` resolves once a permit is available and returns the function
 * that releases it. When a permit is released while others are waiting, it
 * is handed directly to the longest-waiting caller instead of being
 * returned to a shared counter for everyone to race over — that keeps
 * arrival order and avoids a thundering-herd wakeup.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.available = limit;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return this.release();
    }

    return new Promise<() => void>((resolve) => {
      // Queued in FIFO order: `release()` hands the permit to `waiters[0]`
      // first, regardless of when other callers arrive later.
      this.waiters.push(() => resolve(this.release()));
    });
  }

  /**
   * Builds a one-shot release closure. `released` makes it idempotent: a
   * second call is a no-op instead of inflating `available` (or, worse,
   * handing out a second permit while the first holder is still using it),
   * which would silently defeat the whole cap.
   */
  private release(): () => void {
    let released = false;

    return () => {
      if (released) return;
      released = true;

      const next = this.waiters.shift();
      if (next) {
        // Direct handoff: the permit moves straight to the next waiter,
        // `available` never sees it.
        next();
      } else {
        this.available++;
      }
    };
  }
}
