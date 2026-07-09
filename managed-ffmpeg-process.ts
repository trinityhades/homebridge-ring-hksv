import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import nodeProcess from 'node:process'

const DEFAULT_STOP_GRACE_MS = 3_000
const activeProcesses = new Set<ManagedFfmpegProcess>()

// Node's `exit` event cannot wait for an asynchronous escalation timer. Kill
// owned children synchronously so an exiting Homebridge child bridge does not
// leave an FFmpeg encoder behind.
nodeProcess.on('exit', () => {
  for (const process of activeProcesses) {
    process.forceStop()
  }
})

export interface ManagedFfmpegProcessOptions {
  ffmpegPath: string
  ffmpegArgs: Array<string | number>
  stdoutCallback?: (data: Buffer) => void
  exitCallback?: (code: number | null, signal: NodeJS.Signals | null) => void
  logLabel: string
  logger: {
    error(message: unknown): void
    info(message: unknown): void
  }
  /** Internal/test override. Production callers use the conservative default. */
  stopGraceMs?: number
}

/**
 * Small, owned FFmpeg wrapper for media ingress.
 *
 * `@homebridge/camera-utils` currently exposes only a one-shot SIGTERM stop.
 * macOS VideoToolbox FFmpeg can remain stuck after that signal, retaining a
 * hardware encoder and RTP ports indefinitely. This wrapper verifies exit and
 * uses SIGKILL only after a brief grace period.
 */
export class ManagedFfmpegProcess {
  readonly exited: Promise<void>

  private readonly child: ChildProcessWithoutNullStreams
  private readonly options: ManagedFfmpegProcessOptions
  private resolveExited: () => void = () => undefined
  private stopTimer?: ReturnType<typeof setTimeout>
  private stopped = false
  private didExit = false

  constructor(options: ManagedFfmpegProcessOptions) {
    this.options = options
    this.exited = new Promise<void>((resolve) => {
      this.resolveExited = resolve
    })
    this.child = spawn(
      options.ffmpegPath,
      options.ffmpegArgs.map((argument) => argument.toString()),
    )
    activeProcesses.add(this)

    const prefix = `${options.logLabel}: `
    if (options.stdoutCallback) {
      this.child.stdout.on('data', options.stdoutCallback)
    }
    this.child.stderr.on('data', (data: Buffer) => {
      options.logger.info(prefix + data)
    })
    this.child.stdin.on('error', (error: Error) => {
      if (!error.message.includes('EPIPE')) {
        options.logger.error(prefix + error.message)
      }
    })
    this.child.once('error', (error) => {
      if (this.didExit) return
      options.logger.error(prefix + error.message)
      this.finish(null, null, false)
    })
    this.child.once('exit', (code, signal) => {
      this.finish(code, signal, true)
    })
  }

  stop() {
    if (this.stopped) return
    this.stopped = true

    if (!this.isRunning()) {
      return
    }

    this.sendSignal('SIGTERM')
    const stopGraceMs = this.options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS
    this.stopTimer = setTimeout(() => {
      if (!this.isRunning()) return
      this.options.logger.info(
        `${this.options.logLabel}: did not stop within ${stopGraceMs}ms; sending SIGKILL`,
      )
      this.sendSignal('SIGKILL')
    }, stopGraceMs)
    this.stopTimer.unref()
  }

  /** Used only during Node's synchronous exit handling. */
  forceStop() {
    this.stopped = true
    if (this.stopTimer) {
      clearTimeout(this.stopTimer)
      this.stopTimer = undefined
    }
    if (this.isRunning()) {
      this.sendSignal('SIGKILL')
    }
  }

  writeStdin(input: string) {
    if (this.stopped || this.didExit) return
    this.child.stdin.write(input)
    this.child.stdin.end()
  }

  private isRunning() {
    return !this.didExit &&
      this.child.exitCode === null &&
      this.child.signalCode === null
  }

  private sendSignal(signal: NodeJS.Signals) {
    try {
      this.child.kill(signal)
    } catch (error) {
      // A child can exit in the small interval between isRunning() and kill().
      // The exit listener owns final accounting, so this is diagnostic only.
      this.options.logger.info(
        `${this.options.logLabel}: unable to send ${signal} (${String(error)})`,
      )
    }
  }

  private finish(
    code: number | null,
    signal: NodeJS.Signals | null,
    logExit: boolean,
  ) {
    if (this.didExit) return
    this.didExit = true
    activeProcesses.delete(this)
    if (this.stopTimer) {
      clearTimeout(this.stopTimer)
      this.stopTimer = undefined
    }

    // Keep stdout/stderr flowing until the child really exits. Pausing stdout
    // before SIGTERM can block a fragmented-MP4 encoder while it flushes.
    this.child.stdout.pause()
    this.child.stderr.pause()
    this.resolveExited()
    this.options.exitCallback?.(code, signal)

    if (!logExit) return
    if (signal === 'SIGKILL') {
      this.options.logger.info(`${this.options.logLabel}: stopped after SIGKILL`)
    } else if (!code || code === 255) {
      this.options.logger.info(`${this.options.logLabel}: stopped gracefully`)
    } else {
      this.options.logger.error(
        `${this.options.logLabel}: exited with code ${code} and signal ${signal}`,
      )
    }
  }
}
