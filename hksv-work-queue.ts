class WorkQueue {
  private active = 0
  private waiters: Array<{
    resolve: () => void
    reject: (error: Error) => void
    abort: () => void
  }> = []
  private concurrency: number

  constructor(concurrency: number) {
    this.concurrency = concurrency
  }

  setConcurrency(concurrency: number) {
    this.concurrency = Math.max(1, Math.floor(concurrency))
    this.drain()
  }

  async acquire(signal?: AbortSignal) {
    if (signal?.aborted) {
      throw this.getAbortError()
    }

    if (this.active < this.concurrency) {
      this.active++
      return this.getRelease()
    }

    let waiter:
      | {
          resolve: () => void
          reject: (error: Error) => void
          abort: () => void
        }
      | undefined

    await new Promise<void>((resolve, reject) => {
      waiter = {
        resolve,
        reject,
        abort: () => {
          this.waiters = this.waiters.filter((item) => item !== waiter)
          reject(this.getAbortError())
        },
      }

      signal?.addEventListener('abort', waiter.abort, { once: true })
      this.waiters.push(waiter)
    }).finally(() => {
      if (waiter) {
        signal?.removeEventListener('abort', waiter.abort)
      }
      signal?.throwIfAborted()
    })

    this.active++
    return this.getRelease()
  }

  private release() {
    this.active = Math.max(0, this.active - 1)
    this.drain()
  }

  private drain() {
    while (this.active < this.concurrency && this.waiters.length) {
      this.waiters.shift()?.resolve()
    }
  }

  private getRelease() {
    let released = false

    return () => {
      if (released) {
        return
      }

      released = true
      this.release()
    }
  }

  private getAbortError() {
    const error = new Error('HKSV recording request closed before it started')
    error.name = 'AbortError'
    return error
  }
}

export const hksvRecordingQueue = new WorkQueue(1)
