import { useState, useRef, useCallback, useEffect } from 'react'

/**
 * Cross-cutting E — Speech recognition via the Web Speech API.
 *
 * Note: Chromium's SpeechRecognition sends audio to Google servers for
 * processing. This means it requires an internet connection and is NOT
 * air-gap-safe. The UI should surface this limitation clearly.
 *
 * Falls back to a no-op when the API isn't available (e.g. older
 * Electron builds or air-gapped deployments).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SpeechRecognitionCtor: typeof SpeechRecognition | undefined = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition

export function useSpeechRecognition() {
  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [interimTranscript, setInterimTranscript] = useState('')
  const [isSupported] = useState(() => !!SpeechRecognitionCtor)
  const recognitionRef = useRef<SpeechRecognition | null>(null)

  const startListening = useCallback(() => {
    if (!SpeechRecognitionCtor) return
    if (recognitionRef.current) { recognitionRef.current.abort(); recognitionRef.current = null }

    const recognition = new SpeechRecognitionCtor()
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = 'en-US'

    recognition.onresult = (event) => {
      let interim = ''
      let final = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) {
          final += result[0].transcript
        } else {
          interim += result[0].transcript
        }
      }
      if (final) setTranscript((prev) => (prev + ' ' + final).trim())
      setInterimTranscript(interim)
    }

    recognition.onend = () => {
      setIsListening(false)
      setInterimTranscript('')
    }
    recognition.onerror = () => {
      setIsListening(false)
      setInterimTranscript('')
    }

    recognitionRef.current = recognition
    setTranscript('')
    setInterimTranscript('')
    setIsListening(true)
    recognition.start()
  }, [])

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop()
    setIsListening(false)
  }, [])

  useEffect(() => {
    return () => { recognitionRef.current?.abort() }
  }, [])

  return { isListening, transcript, interimTranscript, isSupported, startListening, stopListening }
}
