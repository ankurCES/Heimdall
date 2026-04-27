import { useEffect } from 'react'
import { toast } from 'sonner'

export function NotificationListener() {
  useEffect(() => {
    // Subscribe to app notifications from main process
    const unsub = window.heimdall.on('app:notification', (data: unknown) => {
      const { title, body, severity } = data as { title: string; body: string; severity: string }
      switch (severity) {
        case 'critical':
        case 'error':
          toast.error(title, { description: body })
          break
        case 'high':
        case 'warning':
          toast.warning(title, { description: body })
          break
        case 'success':
          toast.success(title, { description: body })
          break
        default:
          toast.info(title, { description: body })
      }
    })

    // Subscribe to collector status changes
    const unsubCollector = window.heimdall.on('collector:statusChanged', (data: unknown) => {
      const { sourceId, status, error } = data as { sourceId: string; status: string; error?: string }
      if (status === 'error' && error) {
        toast.error('Collector Error', { description: error.slice(0, 100) })
      }
    })

    // FUNCTIONAL FIX (v1.3.2 — finding E2): subscribe to operational
    // alerts dispatched via the AlertEscalationService 'desktop' channel.
    // Previously this event had no listener and notifications were
    // silently dropped.
    const unsubAlert = window.heimdall.on('alert:incoming', (data: unknown) => {
      const { severity, title, body } = data as { severity: string; title: string; body: string }
      const subject = title || 'Heimdall alert'
      const desc = (body || '').slice(0, 200)
      switch (severity) {
        case 'critical': toast.error(`🔴 ${subject}`, { description: desc, duration: 15_000 }); break
        case 'high':     toast.warning(`🟠 ${subject}`, { description: desc, duration: 10_000 }); break
        case 'medium':   toast.warning(subject, { description: desc }); break
        default:         toast.info(subject, { description: desc })
      }
    })

    return () => { unsub(); unsubCollector(); unsubAlert() }
  }, [])

  return null
}
