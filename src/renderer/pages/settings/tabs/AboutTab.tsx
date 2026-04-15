import { Github, Linkedin, Star, ExternalLink } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import heimdallLogo from '@renderer/assets/heimdall-logo.png'

export function AboutTab() {
  const openExternal = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="max-w-lg mx-auto py-8">
      {/* Logo + App Info */}
      <div className="flex flex-col items-center text-center mb-8">
        <img
          src={heimdallLogo}
          alt="Heimdall"
          className="w-32 h-32 rounded-2xl shadow-lg shadow-primary/20 mb-6"
        />
        <h1 className="text-3xl font-bold tracking-tight mb-1">Heimdall</h1>
        <p className="text-lg text-muted-foreground italic mb-3">Always vigilant</p>
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20">
          <span className="text-xs font-mono text-primary">v0.5.0</span>
        </div>
      </div>

      {/* Description */}
      <div className="text-center mb-8">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Intelligence monitoring platform for public safety. Aggregates open-source intelligence
          across 10+ disciplines with AI-powered analysis, geospatial mapping, and real-time alerting.
        </p>
      </div>

      {/* Separator */}
      <div className="border-t border-border my-6" />

      {/* Developer */}
      <div className="text-center mb-6">
        <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-4">Developer</h3>
        <p className="text-sm font-medium mb-4">Ankur Nair</p>
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="outline"
            size="sm"
            className="gap-2 text-xs"
            onClick={() => openExternal('https://github.com/ankurCES')}
          >
            <Github className="h-3.5 w-3.5" />
            GitHub
            <ExternalLink className="h-3 w-3 text-muted-foreground" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-2 text-xs"
            onClick={() => openExternal('https://www.linkedin.com/in/ankur-nair-10baab350/')}
          >
            <Linkedin className="h-3.5 w-3.5" />
            LinkedIn
            <ExternalLink className="h-3 w-3 text-muted-foreground" />
          </Button>
        </div>
      </div>

      {/* Separator */}
      <div className="border-t border-border my-6" />

      {/* Star the repo */}
      <div className="text-center">
        <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-3">Open Source</h3>
        <Button
          variant="default"
          size="sm"
          className="gap-2"
          onClick={() => openExternal('https://github.com/ankurCES/Heimdall')}
        >
          <Star className="h-4 w-4" />
          Star on GitHub
          <ExternalLink className="h-3 w-3" />
        </Button>
        <p className="text-xs text-muted-foreground mt-3">
          MIT License
        </p>
      </div>

      {/* Footer */}
      <div className="border-t border-border mt-8 pt-4 text-center">
        <p className="text-[10px] text-muted-foreground/60">
          Built with Electron + React + TypeScript + SQLite + Vectra
        </p>
      </div>
    </div>
  )
}
