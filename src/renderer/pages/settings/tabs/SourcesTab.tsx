import { useState, useEffect } from 'react'
import { Check } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { Label } from '@renderer/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { useSetting } from '@renderer/hooks/useSettings'
import { DISCIPLINE_LABELS, type Discipline } from '@common/types/intel'

interface DisciplineInfo {
  key: Discipline
  description: string
  sources: string[]
}

const DISCIPLINES: DisciplineInfo[] = [
  {
    key: 'osint',
    description: 'News RSS feeds, public records, academic papers',
    sources: ['Reuters', 'AP News', 'GDELT', 'CourtListener', 'arXiv']
  },
  {
    key: 'cybint',
    description: 'CVE databases, threat intelligence feeds, DNS/WHOIS',
    sources: ['NVD/CVE', 'AlienVault OTX', 'abuse.ch', 'RDAP/WHOIS']
  },
  {
    key: 'finint',
    description: 'SEC filings, sanctions lists, PEP databases',
    sources: ['SEC EDGAR', 'OFAC SDN', 'UN Sanctions']
  },
  {
    key: 'socmint',
    description: 'Public social media monitoring via official APIs',
    sources: ['Twitter/X', 'Reddit', 'Telegram channels']
  },
  {
    key: 'geoint',
    description: 'Earthquake, weather, satellite imagery metadata',
    sources: ['USGS', 'NOAA/NWS', 'Copernicus Sentinel']
  },
  {
    key: 'sigint',
    description: 'ADS-B flight tracking, FCC filings, Meshtastic mesh',
    sources: ['OpenSky Network', 'FCC ULS', 'Meshtastic LoRa']
  },
  {
    key: 'rumint',
    description: 'Unverified chatter from forums and public channels',
    sources: ['Forum RSS', '4chan JSON API', 'Telegram monitoring']
  },
  {
    key: 'ci',
    description: 'Breach databases, credential leak monitoring',
    sources: ['HaveIBeenPwned', 'Breach notification RSS']
  },
  {
    key: 'agency',
    description: 'Public alerts from law enforcement and international agencies',
    sources: ['Interpol Notices', 'FBI Most Wanted', 'Europol', 'UN Security Council']
  }
]

export function SourcesTab() {
  const { value: saved, save, saving } = useSetting<string[]>('enabledDisciplines', [])
  const [enabled, setEnabled] = useState<string[]>([])
  const [didSave, setDidSave] = useState(false)

  useEffect(() => {
    if (saved && Array.isArray(saved)) {
      setEnabled(saved)
    }
  }, [saved])

  const toggle = (key: string) => {
    setEnabled((prev) =>
      prev.includes(key) ? prev.filter((d) => d !== key) : [...prev, key]
    )
    setDidSave(false)
  }

  const handleSave = async () => {
    await save(enabled)
    setDidSave(true)
    setTimeout(() => setDidSave(false), 2000)
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Intelligence Disciplines</CardTitle>
          <CardDescription>
            Enable or disable entire intelligence disciplines. Individual sources within each
            discipline can be configured once collectors are active.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {DISCIPLINES.map((d) => (
            <div
              key={d.key}
              className="flex items-start justify-between rounded-md p-3 hover:bg-accent/50 transition-colors"
            >
              <div className="flex-1 min-w-0 mr-4">
                <div className="flex items-center gap-2">
                  <Label className="text-sm font-medium">
                    {DISCIPLINE_LABELS[d.key]}
                  </Label>
                  <Badge variant="outline" className="text-[10px] uppercase font-mono">
                    {d.key}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{d.description}</p>
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {d.sources.map((s) => (
                    <Badge key={s} variant="secondary" className="text-[10px]">
                      {s}
                    </Badge>
                  ))}
                </div>
              </div>
              <Switch
                checked={enabled.includes(d.key)}
                onCheckedChange={() => toggle(d.key)}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving || didSave}>
          {didSave ? <><Check className="h-4 w-4 mr-2" /> Saved</> : 'Save Discipline Settings'}
        </Button>
        <span className="text-sm text-muted-foreground">
          {enabled.length} of {DISCIPLINES.length} disciplines enabled
        </span>
      </div>
    </div>
  )
}
