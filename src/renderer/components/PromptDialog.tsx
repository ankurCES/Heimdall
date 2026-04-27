// PromptDialog — v1.8.1 stand-in for window.prompt(), which Electron's
// renderer blocks by default. Wraps the existing radix Dialog with a
// single-input form + Cancel/OK buttons + Enter-to-submit. Used
// anywhere the codebase used to call prompt() — saved searches,
// entity merge target, briefing recipients, graph canvas creation.
//
// API mirrors a Promise-returning prompt() so the migration from
// `const x = prompt(label, init)` to `const x = await promptDialog({label, init})`
// is a one-line change at the call site.

import { useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'

export interface PromptOptions {
  label: string
  description?: string
  initialValue?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Render a textarea instead of a single-line input. */
  multiline?: boolean
  /** Validation hook — return an error string to keep the dialog
   *  open and show the message; return null to allow submit. */
  validate?: (value: string) => string | null
}

interface InternalProps extends PromptOptions {
  onResolve: (value: string | null) => void
}

function PromptDialogImpl(props: InternalProps) {
  const [open, setOpen] = useState(true)
  const [value, setValue] = useState(props.initialValue ?? '')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)

  useEffect(() => {
    // Auto-focus + select-all so Enter just works.
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      if (inputRef.current && 'select' in inputRef.current) inputRef.current.select()
    })
  }, [])

  const submit = () => {
    const v = value
    const validationError = props.validate ? props.validate(v) : null
    if (validationError) { setError(validationError); return }
    setOpen(false)
    props.onResolve(v)
  }
  const cancel = () => {
    setOpen(false)
    props.onResolve(null)
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (!props.multiline || (e.metaKey || e.ctrlKey))) {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) cancel() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{props.label}</DialogTitle>
          {props.description && (
            <DialogDescription className="text-xs whitespace-pre-line">
              {props.description}
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="py-2">
          {props.multiline ? (
            <textarea
              ref={inputRef as React.MutableRefObject<HTMLTextAreaElement | null>}
              value={value}
              onChange={(e) => { setValue(e.target.value); setError(null) }}
              onKeyDown={handleKey}
              placeholder={props.placeholder}
              rows={5}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-y font-mono"
            />
          ) : (
            <Input
              ref={inputRef as React.MutableRefObject<HTMLInputElement | null>}
              value={value}
              onChange={(e) => { setValue(e.target.value); setError(null) }}
              onKeyDown={handleKey}
              placeholder={props.placeholder}
              className="font-mono"
            />
          )}
          {error && <div className="text-xs text-red-600 dark:text-red-400 mt-1">{error}</div>}
          {props.multiline && (
            <div className="text-[11px] text-muted-foreground mt-1">
              ⌘/Ctrl + Enter to submit, Esc to cancel.
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={cancel}>
            {props.cancelLabel ?? 'Cancel'}
          </Button>
          <Button onClick={submit}>
            {props.confirmLabel ?? 'OK'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Imperative async API mirroring window.prompt():
 *   const name = await promptDialog({ label: 'Name?' })
 *   if (name === null) return  // user cancelled
 *
 * Mounts the dialog into a transient detached div, resolves the
 * promise when the user submits or cancels, then unmounts. Multiple
 * concurrent calls each get their own root.
 */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    let root: Root | null = createRoot(host)
    const cleanup = () => {
      // Defer the unmount one tick so the closing animation can run
      // without React complaining about state updates during teardown.
      setTimeout(() => {
        try { root?.unmount() } catch { /* */ }
        try { host.remove() } catch { /* */ }
        root = null
      }, 200)
    }
    root.render(
      <PromptDialogImpl
        {...opts}
        onResolve={(v) => { cleanup(); resolve(v) }}
      />
    )
  })
}
