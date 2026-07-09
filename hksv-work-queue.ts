/* eslint-disable no-use-before-define */
/**
 * Global, bounded scheduler for the expensive parts of HKSV recording.
 *
 * A slot is reserved before a queued caller is woken.  This is important: the
 * old queue woke every waiter while `active` was still unchanged, allowing a
 * burst of recordings to exceed the configured concurrency.
 */
export interface ResourceGovernorOptions {
  recordingConcurrency: number
  /** Maximum time a recording may wait for a slot. `0` disables the timeout. */
  queueTimeoutMs?: number
}

export interface RecordingResourceRequest {
  signal?: AbortSignal
  /** Identifies a camera so it cannot run two recording encoders at once. */
  cameraId?: string
  /** Overrides the governor default for this request. `0` disables it. */
  timeoutMs?: number
  /** Bytes already buffered for this request, for diagnostics only. */
  queuedBytes?: number
}

export interface ResourceGovernorMetrics {
  recordingConcurrency: number
  activeRecordings: number
  queuedRecordings: number
  queuedBytes: number
  activeFfmpegProcesses: number
  activeRingCalls: number
  activeByCamera: Readonly<Record<string, number>>
  rejectedByTimeout: number
  rejectedByAbort: number
}

export interface RecordingResourceLease {
  readonly cameraId: string
  release(): void
  /** Updates diagnostic accounting while this recording owns a slot. */
  setQueuedBytes(bytes: number): void
}

interface Waiter {
  cameraId: string
  queuedBytes: number
  resolve: (lease: RecordingResourceLease) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort: () => void
  timeout?: ReturnType<typeof setTimeout>
}

const DEFAULT_CAMERA_ID = '__legacy_recording__'

export class ResourceGovernor {
  private active = 0
  private readonly activeByCamera = new Map<string, number>()
  private readonly recordingQueuedBytes = new Map<string, number>()
  private readonly waiters: Waiter[] = []
  private recordingConcurrency: number
  private queueTimeoutMs: number
  private activeFfmpegProcesses = 0
  private activeRingCalls = 0
  private rejectedByTimeout = 0
  private rejectedByAbort = 0

  constructor(options: ResourceGovernorOptions) {
    this.recordingConcurrency = normalizeConcurrency(options.recordingConcurrency)
    this.queueTimeoutMs = normalizeTimeout(options.queueTimeoutMs)
  }

  /** Configure this shared governor during platform startup. */
  configure(options: ResourceGovernorOptions) {
    this.recordingConcurrency = normalizeConcurrency(options.recordingConcurrency)
    this.queueTimeoutMs = normalizeTimeout(options.queueTimeoutMs)
    this.drain()
  }

  /**
   * Compatibility entry point for v14 callers. New platform code should call
   * configure() once at startup instead.
   */
  setConcurrency(concurrency: number) {
    this.configure({ recordingConcurrency: concurrency })
  }

  /** Compatibility API returning only an idempotent release function. */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    const lease = await this.acquireLease({ signal })
    return () => lease.release()
  }

  acquireLease(
    request: RecordingResourceRequest = {},
  ): Promise<RecordingResourceLease> {
    const signal = request.signal
    if (signal?.aborted) {
      this.rejectedByAbort++
      return Promise.reject(getAbortError())
    }

    const cameraId = request.cameraId || DEFAULT_CAMERA_ID
    if (this.canAcquire(cameraId) && this.waiters.length === 0) {
      return Promise.resolve(this.reserve(cameraId, request.queuedBytes ?? 0))
    }

    return new Promise<RecordingResourceLease>((resolve, reject) => {
      const waiter: Waiter = {
        cameraId,
        queuedBytes: normalizeQueuedBytes(request.queuedBytes),
        resolve,
        reject,
        signal,
        onAbort: () => this.rejectWaiter(waiter, getAbortError(), 'abort'),
      }

      const timeoutMs = normalizeTimeout(request.timeoutMs ?? this.queueTimeoutMs)
      if (timeoutMs > 0) {
        waiter.timeout = setTimeout(() => {
          this.rejectWaiter(waiter, getTimeoutError(), 'timeout')
        }, timeoutMs)
      }

      signal?.addEventListener('abort', waiter.onAbort, { once: true })
      this.waiters.push(waiter)
      // An earlier release/configure may have made capacity available between
      // the check above and queue insertion.
      this.drain()
    })
  }

  getMetrics(): ResourceGovernorMetrics {
    return {
      recordingConcurrency: this.recordingConcurrency,
      activeRecordings: this.active,
      queuedRecordings: this.waiters.length,
      queuedBytes:
        this.waiters.reduce((total, waiter) => total + waiter.queuedBytes, 0) +
        [...this.recordingQueuedBytes.values()].reduce((total, bytes) => total + bytes, 0),
      activeFfmpegProcesses: this.activeFfmpegProcesses,
      activeRingCalls: this.activeRingCalls,
      activeByCamera: Object.fromEntries(this.activeByCamera),
      rejectedByTimeout: this.rejectedByTimeout,
      rejectedByAbort: this.rejectedByAbort,
    }
  }

  /** Resource counters for platform diagnostics; each returned release is idempotent. */
  trackFfmpegProcess(): () => void {
    this.activeFfmpegProcesses++
    return this.getCounterRelease('activeFfmpegProcesses')
  }

  trackRingCall(): () => void {
    this.activeRingCalls++
    return this.getCounterRelease('activeRingCalls')
  }

  private canAcquire(cameraId: string) {
    return this.active < this.recordingConcurrency && !this.activeByCamera.has(cameraId)
  }

  private reserve(cameraId: string, queuedBytes: number): RecordingResourceLease {
    // Reserve before resolving a waiter: this is the handoff invariant.
    this.active++
    this.activeByCamera.set(cameraId, (this.activeByCamera.get(cameraId) ?? 0) + 1)
    let released = false
    let currentQueuedBytes = normalizeQueuedBytes(queuedBytes)
    this.recordingQueuedBytes.set(cameraId, currentQueuedBytes)

    return {
      cameraId,
      release: () => {
        if (released) return
        released = true
        this.active = Math.max(0, this.active - 1)
        const cameraActive = (this.activeByCamera.get(cameraId) ?? 1) - 1
        if (cameraActive > 0) this.activeByCamera.set(cameraId, cameraActive)
        else this.activeByCamera.delete(cameraId)
        this.recordingQueuedBytes.delete(cameraId)
        this.drain()
      },
      setQueuedBytes: (bytes) => {
        if (released) return
        currentQueuedBytes = normalizeQueuedBytes(bytes)
        this.recordingQueuedBytes.set(cameraId, currentQueuedBytes)
      },
    }
  }

  private drain() {
    // Preserve FIFO among eligible requests, but do not leave global capacity
    // idle when the oldest waiter is blocked only by its own active camera.
    while (this.active < this.recordingConcurrency) {
      const index = this.waiters.findIndex((waiter) => this.canAcquire(waiter.cameraId))
      if (index === -1) return

      const [waiter] = this.waiters.splice(index, 1)
      this.cleanupWaiter(waiter)
      const lease = this.reserve(waiter.cameraId, waiter.queuedBytes)
      waiter.resolve(lease)
    }
  }

  private rejectWaiter(waiter: Waiter, error: Error, reason: 'abort' | 'timeout') {
    const index = this.waiters.indexOf(waiter)
    if (index === -1) return
    this.waiters.splice(index, 1)
    this.cleanupWaiter(waiter)
    if (reason === 'abort') this.rejectedByAbort++
    else this.rejectedByTimeout++
    waiter.reject(error)
    this.drain()
  }

  private cleanupWaiter(waiter: Waiter) {
    if (waiter.timeout) clearTimeout(waiter.timeout)
    waiter.signal?.removeEventListener('abort', waiter.onAbort)
  }

  private getCounterRelease(counter: 'activeFfmpegProcesses' | 'activeRingCalls') {
    let released = false
    return () => {
      if (released) return
      released = true
      this[counter] = Math.max(0, this[counter] - 1)
    }
  }
}

function normalizeConcurrency(value: number) {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.floor(value))
}

function normalizeTimeout(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

function normalizeQueuedBytes(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

function getAbortError() {
  const error = new Error('HKSV recording request closed before it started')
  error.name = 'AbortError'
  return error
}

function getTimeoutError() {
  const error = new Error('HKSV recording request timed out waiting for a resource slot')
  error.name = 'TimeoutError'
  return error
}

/** Platform-owned singleton. Configure once from RingPlatform during startup. */
export const hksvRecordingQueue = new ResourceGovernor({ recordingConcurrency: 1 })

export function configureHksvResourceGovernor(options: ResourceGovernorOptions) {
  hksvRecordingQueue.configure(options)
  return hksvRecordingQueue
}
