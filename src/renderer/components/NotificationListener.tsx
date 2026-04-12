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

    return () => { unsub(); unsubCollector() }
  }, [])

  return null
}
