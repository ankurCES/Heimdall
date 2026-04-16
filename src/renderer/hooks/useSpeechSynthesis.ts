import { useState, useEffect, useCallback, useRef } from 'react'

/**
 * Cross-cutting E — Speech synthesis via the Web Speech API.
 *
 * Wraps window.speechSynthesis (available in Electron's Chromium)
 * with React state management. Voice + rate preferences persisted
 * to localStorage.
 */
export function useSpeechSynthesis() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [selectedVoiceName, setSelectedVoiceName] = useState<string>(() =>
    localStorage.getItem('speech.voiceName') || ''
  )
  const [rate, setRate] = useState<number>(() =>
    parseFloat(localStorage.getItem('speech.rate') || '1')
  )
  const utterRef = useRef<SpeechSynthesisUtterance | null>(null)

  useEffect(() => {
    const loadVoices = () => {
      const v = window.speechSynthesis.getVoices()
      setVoices(v)
      if (!selectedVoiceName && v.length > 0) {
        const enVoice = v.find((x) => x.lang.startsWith('en'))
        if (enVoice) setSelectedVoiceName(enVoice.name)
      }
    }
    loadVoices()
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', loadVoices)
  }, [])

  useEffect(() => {
    localStorage.setItem('speech.voiceName', selectedVoiceName)
  }, [selectedVoiceName])

  useEffect(() => {
    localStorage.setItem('speech.rate', String(rate))
  }, [rate])

  const speak = useCallback((text: string) => {
    window.speechSynthesis.cancel()
    const utter = new SpeechSynthesisUtterance(text)
    const voice = voices.find((v) => v.name === selectedVoiceName)
    if (voice) utter.voice = voice
    utter.rate = rate
    utter.onend = () => setIsSpeaking(false)
    utter.onerror = () => setIsSpeaking(false)
    utterRef.current = utter
    setIsSpeaking(true)
    window.speechSynthesis.speak(utter)
  }, [voices, selectedVoiceName, rate])

  const stop = useCallback(() => {
    window.speechSynthesis.cancel()
    setIsSpeaking(false)
  }, [])

  return { voices, isSpeaking, speak, stop, selectedVoiceName, setSelectedVoiceName, rate, setRate }
}
