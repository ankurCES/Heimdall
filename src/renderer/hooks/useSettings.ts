import { useState, useEffect, useCallback } from 'react'
import { ipc } from '@renderer/lib/ipc'

export function useSetting<T>(key: string, defaultValue: T) {
  const [value, setValue] = useState<T>(defaultValue)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    ipc.settings.get<T>(key).then((stored) => {
      if (stored !== null && stored !== undefined) {
        setValue(stored as T)
      }
      setLoading(false)
    })
  }, [key])

  const save = useCallback(
    async (newValue: T) => {
      setSaving(true)
      setValue(newValue)
      await ipc.settings.set(key, newValue)
      setSaving(false)
    },
    [key]
  )

  return { value, setValue, save, loading, saving }
}

export function useTestConnection() {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null)

  const test = useCallback(async (channel: string, params?: unknown) => {
    setTesting(true)
    setResult(null)
    try {
      const res = await window.heimdall.invoke(`settings:test${channel}`, params)
      setResult(res as { success: boolean; message: string })
    } catch (err) {
      setResult({ success: false, message: String(err) })
    } finally {
      setTesting(false)
    }
  }, [])

  const clear = useCallback(() => setResult(null), [])

  return { testing, result, test, clear }
}
