import { Cron, type CronOptions } from 'croner'
import log from 'electron-log'

interface ScheduledJob {
  id: string
  cron: Cron
  label: string
  running: boolean
}

export class CronService {
  private jobs = new Map<string, ScheduledJob>()

  schedule(
    id: string,
    expression: string,
    label: string,
    handler: () => Promise<void>
  ): void {
    // Remove existing job with same id
    this.unschedule(id)

    const options: CronOptions = {
      timezone: undefined, // use local timezone
      protect: true // prevent overlapping runs
    }

    const cron = new Cron(expression, options, async () => {
      const job = this.jobs.get(id)
      if (!job || job.running) return

      job.running = true
      log.info(`Cron job starting: ${label} (${id})`)

      try {
        await handler()
        log.info(`Cron job completed: ${label} (${id})`)
      } catch (err) {
        log.error(`Cron job failed: ${label} (${id}):`, err)
      } finally {
        job.running = false
      }
    })

    this.jobs.set(id, { id, cron, label, running: false })
    const next = cron.nextRun()
    log.info(`Cron job scheduled: ${label} (${id}) — expression: ${expression}, next: ${next?.toISOString() ?? 'unknown'}`)
  }

  unschedule(id: string): void {
    const job = this.jobs.get(id)
    if (job) {
      job.cron.stop()
      this.jobs.delete(id)
      log.info(`Cron job unscheduled: ${job.label} (${id})`)
    }
  }

  async runNow(id: string): Promise<void> {
    const job = this.jobs.get(id)
    if (!job) {
      throw new Error(`No job found with id: ${id}`)
    }
    if (job.running) {
      throw new Error(`Job ${id} is already running`)
    }
    job.cron.trigger()
  }

  getJobs(): Array<{ id: string; label: string; running: boolean; nextRun: string | null }> {
    return Array.from(this.jobs.values()).map((job) => ({
      id: job.id,
      label: job.label,
      running: job.running,
      nextRun: job.cron.nextRun()?.toISOString() ?? null
    }))
  }

  isRunning(id: string): boolean {
    return this.jobs.get(id)?.running ?? false
  }

  stopAll(): void {
    for (const job of this.jobs.values()) {
      job.cron.stop()
    }
    this.jobs.clear()
    log.info('All cron jobs stopped')
  }
}

export const cronService = new CronService()
