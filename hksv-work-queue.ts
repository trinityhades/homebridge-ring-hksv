class WorkQueue {
  private active = 0
  private waiters: Array<() => void> = []
  private concurrency: number

  constructor(concurrency: number) {
    this.concurrency = concurrency
  }

  setConcurrency(concurrency: number) {
    this.concurrency = Math.max(1, Math.floor(concurrency))
    this.drain()
  }

  async acquire() {
    if (this.active < this.concurrency) {
      this.active++
      return () => this.release()
    }

    await new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })

    this.active++
    return () => this.release()
  }

  private release() {
    this.active = Math.max(0, this.active - 1)
    this.drain()
  }

  private drain() {
    while (this.active < this.concurrency && this.waiters.length) {
      this.waiters.shift()?.()
    }
  }
}

export const hksvRecordingQueue = new WorkQueue(1)
