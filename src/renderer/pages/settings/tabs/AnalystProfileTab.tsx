import { useState, useEffect } from 'react'
import { User, Check } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { useSetting } from '@renderer/hooks/useSettings'
import { DISCIPLINE_LABELS } from '@common/types/intel'

/**
 * Cross-cutting G — Analyst profile preferences.
 *
 * Stored as settings key `analyst.profile`. PromptBuilder reads these
 * and injects them into every LLM system prompt so the agent is
 * personalised to the analyst's focus area, preferred disciplines,
 * brevity level, and custom instructions.
 */

interface AnalystProfile {
  name?: string
  focusArea?: string
  preferredDisciplines?: string[]
  brevity?: 'verbose' | 'concise' | 'caveman'
  customInstructions?: string
}

const DEFAULT_PROFILE: AnalystProfile = {
  name: '',
  focusArea: '',
  preferredDisciplines: [],
  brevity: 'concise',
  customInstructions: ''
}

export function AnalystProfileTab() {
  const { value: saved, save, saving } = useSetting<AnalystProfile>('analyst.profile', DEFAULT_PROFILE)
  const [profile, setProfile] = useState<AnalystProfile>(DEFAULT_PROFILE)
  const [didSave, setDidSave] = useState(false)

  useEffect(() => {
    if (saved && typeof saved === 'object') setProfile({ ...DEFAULT_PROFILE, ...saved })
  }, [saved])

  const update = (field: keyof AnalystProfile, value: unknown) => {
    setProfile((prev) => ({ ...prev, [field]: value }))
    setDidSave(false)
  }

  const toggleDiscipline = (disc: string) => {
    const current = profile.preferredDisciplines ?? []
    const next = current.includes(disc) ? current.filter((d) => d !== disc) : [...current, disc]
    update('preferredDisciplines', next)
  }

  const handleSave = async () => {
    await save(profile)
    setDidSave(true)
    setTimeout(() => setDidSave(false), 2000)
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <User className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">Analyst profile</CardTitle>
          </div>
          <CardDescription>
            These preferences are injected into every LLM system prompt via
            PromptBuilder. The agent will prioritise your focus area, weight
            your preferred disciplines higher, and match your brevity level.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Name / alias</Label>
            <Input value={profile.name ?? ''} onChange={(e) => update('name', e.target.value)}
              placeholder='e.g. "Amy Chen" or "Analyst-7"' />
            <p className="text-[10px] text-muted-foreground">The model addresses you by this name. Leave empty for anonymous.</p>
          </div>

          <div className="space-y-2">
            <Label>Area of focus</Label>
            <Input value={profile.focusArea ?? ''} onChange={(e) => update('focusArea', e.target.value)}
              placeholder='e.g. "Iran nuclear programme", "APT groups in Southeast Asia"' />
            <p className="text-[10px] text-muted-foreground">The model will prioritise this domain when interpreting ambiguous queries and selecting which reports to cite first.</p>
          </div>

          <div className="space-y-2">
            <Label>Preferred disciplines (click to toggle)</Label>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(DISCIPLINE_LABELS).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => toggleDiscipline(key)}
                  className={`text-xs px-2 py-1 rounded border font-mono ${
                    (profile.preferredDisciplines ?? []).includes(key)
                      ? 'border-primary bg-primary/15 text-primary'
                      : 'border-border text-muted-foreground hover:bg-accent/30'
                  }`}
                >{label}</button>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground">Selected disciplines get higher weight in analysis. None selected = equal weight.</p>
          </div>

          <div className="space-y-2">
            <Label>Brevity</Label>
            <Select value={profile.brevity ?? 'concise'} onValueChange={(v) => update('brevity', v)}>
              <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="verbose">Verbose — full explanations</SelectItem>
                <SelectItem value="concise">Concise — short and actionable</SelectItem>
                <SelectItem value="caveman">Caveman — ultra-brief, abbreviations</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Custom instructions</Label>
            <textarea
              className="w-full rounded border border-border bg-background p-2 text-sm min-h-[96px]"
              value={profile.customInstructions ?? ''}
              onChange={(e) => update('customInstructions', e.target.value)}
              placeholder="Any additional instructions for the model (e.g. always cite STANAG ratings, always produce ICD 203 language, focus on attribution…)"
            />
            <p className="text-[10px] text-muted-foreground">Appended to every system prompt. Keep concise.</p>
          </div>

          <Button onClick={handleSave} disabled={saving || didSave}>
            {didSave ? <><Check className="h-4 w-4 mr-2" />Saved</> : 'Save profile'}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
