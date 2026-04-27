import { useEffect, useRef, useState } from 'react'
import { Stamp, Upload, Save, Loader2, Key, RefreshCw } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { toast } from 'sonner'

/**
 * Letterhead settings — agency identity for exported PDF/DOCX reports.
 * The deploying agency customizes the header logo, name, tagline,
 * default classification, and distribution statement.
 *
 * Changes take effect on the NEXT export — they don't retroactively
 * modify previously exported documents.
 */

interface LetterheadConfig {
  agencyName: string
  agencyTagline: string
  agencyShortName: string
  logoBase64: string
  defaultClassification: string
  distributionStatement: string
  footerText: string
  signaturesEnabled: boolean
}

const DEFAULTS: LetterheadConfig = {
  agencyName: '', agencyTagline: '', agencyShortName: '',
  logoBase64: '',
  defaultClassification: 'UNCLASSIFIED//FOR OFFICIAL USE ONLY',
  distributionStatement: 'Distribution authorized for official use only. Reproduction prohibited without originator approval.',
  footerText: '', signaturesEnabled: true
}

const CLASSIFICATION_PRESETS = [
  'UNCLASSIFIED',
  'UNCLASSIFIED//FOR OFFICIAL USE ONLY',
  'CONFIDENTIAL',
  'CONFIDENTIAL//NOFORN',
  'SECRET',
  'SECRET//NOFORN',
  'TOP SECRET',
  'TOP SECRET//SCI'
]

const MAX_LOGO_BYTES = 500 * 1024  // 500KB

export function LetterheadTab() {
  const [config, setConfig] = useState<LetterheadConfig>(DEFAULTS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [signingKey, setSigningKey] = useState<{ publicKeyB64: string; fingerprint: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    (async () => {
      try {
        const r = await window.heimdall.invoke('settings:get', { key: 'letterhead' }) as LetterheadConfig | null
        if (r) setConfig({ ...DEFAULTS, ...r })
      } catch (err) { console.warn('letterhead load failed:', err) }
      try {
        const k = await window.heimdall.invoke('reports:signing_key_info') as
          { ok: boolean; publicKeyB64?: string; fingerprint?: string }
        if (k.ok && k.publicKeyB64 && k.fingerprint) {
          setSigningKey({ publicKeyB64: k.publicKeyB64, fingerprint: k.fingerprint })
        }
      } catch { /* */ }
      setLoading(false)
    })()
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      await window.heimdall.invoke('settings:set', { key: 'letterhead', value: config })
      toast.success('Letterhead saved — applies to the next export')
    } catch (err) {
      toast.error('Save failed', { description: String(err) })
    } finally {
      setSaving(false)
    }
  }

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > MAX_LOGO_BYTES) {
      toast.error(`Logo too large (${Math.round(file.size / 1024)}KB) — max 500KB`)
      return
    }
    const buf = await file.arrayBuffer()
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)))
    setConfig({ ...config, logoBase64: base64 })
    toast.success(`Logo loaded (${Math.round(file.size / 1024)}KB)`)
  }

  const removeLogo = () => setConfig({ ...config, logoBase64: '' })

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6 max-w-4xl">
      <div className="flex items-center gap-3">
        <Stamp className="w-6 h-6 text-amber-400" />
        <div>
          <h2 className="text-xl font-semibold">Letterhead &amp; Distribution</h2>
          <p className="text-sm text-muted-foreground">
            Customize the header, classification banners, and signature block on exported reports.
            Designed for deploying intelligence agencies to brand their analytic products.
          </p>
        </div>
      </div>

      {/* AGENCY IDENTITY */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agency Identity</CardTitle>
          <CardDescription>Appears in the header of every exported PDF.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="agencyName">Agency name</Label>
              <Input
                id="agencyName"
                value={config.agencyName}
                onChange={(e) => setConfig({ ...config, agencyName: e.target.value })}
                placeholder="e.g. Bureau of Intelligence and Research"
              />
            </div>
            <div>
              <Label htmlFor="agencyShortName">Short name / acronym</Label>
              <Input
                id="agencyShortName"
                value={config.agencyShortName}
                onChange={(e) => setConfig({ ...config, agencyShortName: e.target.value })}
                placeholder="e.g. INR"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="agencyTagline">Tagline</Label>
            <Input
              id="agencyTagline"
              value={config.agencyTagline}
              onChange={(e) => setConfig({ ...config, agencyTagline: e.target.value })}
              placeholder="e.g. Analytic Excellence in the Service of Diplomacy"
            />
          </div>

          <div>
            <Label>Agency logo (PNG/JPEG, &lt;500KB)</Label>
            <div className="flex items-center gap-3 mt-1">
              {config.logoBase64 ? (
                <>
                  <img
                    src={`data:image/png;base64,${config.logoBase64}`}
                    alt="logo preview"
                    className="w-16 h-16 object-contain border border-border rounded bg-white p-1"
                  />
                  <Button size="sm" variant="outline" onClick={removeLogo}>Remove</Button>
                </>
              ) : (
                <div className="w-16 h-16 border-2 border-dashed border-border rounded flex items-center justify-center text-muted-foreground text-xs">
                  no logo
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg"
                onChange={handleLogoUpload}
                className="hidden"
              />
              <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>
                <Upload className="w-3.5 h-3.5 mr-1.5" /> Upload logo
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* CLASSIFICATION + DISTRIBUTION */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Classification &amp; Distribution</CardTitle>
          <CardDescription>
            Banner colors auto-derive from classification: green = UNCLASSIFIED, blue = CONFIDENTIAL,
            red = SECRET, amber = TOP SECRET.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label htmlFor="defaultClassification">Default classification banner</Label>
            <div className="flex gap-2 mt-1">
              <Input
                id="defaultClassification"
                value={config.defaultClassification}
                onChange={(e) => setConfig({ ...config, defaultClassification: e.target.value })}
                placeholder="UNCLASSIFIED//FOR OFFICIAL USE ONLY"
              />
            </div>
            <div className="flex gap-1 flex-wrap mt-2">
              {CLASSIFICATION_PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => setConfig({ ...config, defaultClassification: p })}
                  className="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          <div>
            <Label htmlFor="distributionStatement">Distribution statement (footer)</Label>
            <textarea
              id="distributionStatement"
              value={config.distributionStatement}
              onChange={(e) => setConfig({ ...config, distributionStatement: e.target.value })}
              rows={2}
              className="w-full text-sm bg-card border border-border rounded p-2 mt-1"
            />
          </div>
        </CardContent>
      </Card>

      {/* SIGNATURE */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Key className="w-4 h-4" /> Cryptographic Signature
          </CardTitle>
          <CardDescription>
            Every exported report can be signed with this instance's Ed25519 key.
            Recipients verify integrity using the public-key fingerprint.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Switch
              checked={config.signaturesEnabled}
              onCheckedChange={(v) => setConfig({ ...config, signaturesEnabled: v })}
            />
            <Label className="cursor-pointer" onClick={() => setConfig({ ...config, signaturesEnabled: !config.signaturesEnabled })}>
              Include signature page in exports
            </Label>
          </div>

          {signingKey && (
            <div className="border border-border rounded p-3 space-y-2 bg-card/30">
              <div>
                <div className="text-[10px] text-muted-foreground uppercase mb-1">Public key fingerprint</div>
                <div className="font-mono text-sm text-cyan-300">{signingKey.fingerprint}</div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground uppercase mb-1">Public key (base64) — share with verifiers</div>
                <textarea
                  readOnly
                  value={signingKey.publicKeyB64}
                  rows={3}
                  className="w-full text-[10px] font-mono bg-card border border-border rounded p-2"
                />
              </div>
              <p className="text-[10px] text-muted-foreground">
                The matching private key lives at <code>~/Library/Application Support/heimdall/heimdall-signing.key</code>
                {' '}(mode 0600). It never leaves this host.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center gap-2 sticky bottom-0 bg-background py-2 border-t border-border -mx-6 px-6">
        <Button onClick={save} disabled={saving}>
          {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
          Save letterhead
        </Button>
        <Button variant="ghost" onClick={() => setConfig(DEFAULTS)}>
          <RefreshCw className="w-4 h-4 mr-2" /> Reset to defaults
        </Button>
      </div>
    </div>
  )
}
