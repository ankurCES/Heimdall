import { Mic, MicOff, Volume2, VolumeX } from 'lucide-react'
import { Button } from './ui/button'
import { useSpeechSynthesis } from '@renderer/hooks/useSpeechSynthesis'
import { useSpeechRecognition } from '@renderer/hooks/useSpeechRecognition'
import { cn } from '@renderer/lib/utils'

/**
 * Cross-cutting E — Speech controls.
 *
 * Compact floating bar rendered alongside the Chat input. Two buttons:
 *   - Mic: start/stop speech recognition. Transcript populates the
 *     onTranscript callback (parent auto-fills the chat input).
 *   - Speaker: stop currently-speaking synthesis.
 *
 * The parent Chat page calls `speak(text)` when an assistant response
 * arrives (if auto-speak is enabled in analyst prefs).
 */

interface Props {
  onTranscript: (text: string) => void
  autoSend?: boolean
  onAutoSend?: () => void
}

export function SpeechControls({ onTranscript, autoSend, onAutoSend }: Props) {
  const { isListening, transcript, interimTranscript, isSupported, startListening, stopListening } = useSpeechRecognition()
  const { isSpeaking, stop: stopSpeaking } = useSpeechSynthesis()

  // Push final transcript to parent when recognition ends.
  const prevTranscript = { current: '' }
  if (transcript && transcript !== prevTranscript.current) {
    prevTranscript.current = transcript
    onTranscript(transcript)
    if (autoSend && onAutoSend) {
      setTimeout(() => onAutoSend(), 300)
    }
  }

  if (!isSupported) return null

  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        variant={isListening ? 'default' : 'ghost'}
        className={cn('h-8 w-8 p-0', isListening && 'animate-pulse bg-red-500/20 text-red-400')}
        onClick={isListening ? stopListening : startListening}
        title={isListening ? 'Stop listening' : 'Start listening (speech-to-text)'}
      >
        {isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      </Button>

      {isSpeaking && (
        <Button
          size="sm"
          variant="ghost"
          className="h-8 w-8 p-0"
          onClick={stopSpeaking}
          title="Stop speaking"
        >
          <VolumeX className="h-4 w-4" />
        </Button>
      )}

      {(isListening || interimTranscript) && (
        <span className="text-xs text-muted-foreground ml-1 max-w-[200px] truncate italic">
          {interimTranscript || 'Listening…'}
        </span>
      )}
    </div>
  )
}

/** Hook re-export for parent pages that need speak() directly. */
export { useSpeechSynthesis }
