import { cn } from '@renderer/lib/utils'

interface Quote {
  ticker: string
  name: string
  category: string
  price: number
  change_pct: number
  currency: string | null
}

interface Props {
  quotes: Quote[]
  onSelect: (ticker: string) => void
  selected?: string
}

// Map % change to color: red (-5%) → gray (0) → green (+5%)
function pctToColor(pct: number): string {
  const clamped = Math.max(-5, Math.min(5, pct))
  const intensity = Math.abs(clamped) / 5  // 0 to 1
  if (clamped >= 0) {
    // Green ramp
    const r = Math.round(31 + (16 - 31) * intensity)
    const g = Math.round(41 + (185 - 41) * intensity)
    const b = Math.round(55 + (129 - 55) * intensity)
    return `rgba(${r}, ${g}, ${b}, ${0.4 + intensity * 0.6})`
  } else {
    // Red ramp
    const r = Math.round(31 + (239 - 31) * intensity)
    const g = Math.round(41 + (68 - 41) * intensity)
    const b = Math.round(55 + (68 - 55) * intensity)
    return `rgba(${r}, ${g}, ${b}, ${0.4 + intensity * 0.6})`
  }
}

const CATEGORY_ORDER = ['Energy', 'Metals', 'Agriculture', 'Currency', 'Volatility']

export function SectorHeatmap({ quotes, onSelect, selected }: Props) {
  // Group by category
  const grouped = new Map<string, Quote[]>()
  for (const q of quotes) {
    if (!grouped.has(q.category)) grouped.set(q.category, [])
    grouped.get(q.category)!.push(q)
  }

  const categories = CATEGORY_ORDER.filter((c) => grouped.has(c))

  return (
    <div className="space-y-3">
      {categories.map((cat) => {
        const items = grouped.get(cat) || []
        return (
          <div key={cat}>
            <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">{cat}</h4>
            <div className={cn(
              'grid gap-1.5',
              items.length === 1 ? 'grid-cols-1' :
              items.length === 2 ? 'grid-cols-2' :
              items.length === 3 ? 'grid-cols-3' :
              'grid-cols-2 sm:grid-cols-4'
            )}>
              {items.map((q) => {
                const isSelected = selected === q.ticker
                const isPositive = q.change_pct >= 0
                return (
                  <button
                    key={q.ticker}
                    onClick={() => onSelect(q.ticker)}
                    style={{ background: pctToColor(q.change_pct) }}
                    className={cn(
                      'rounded-md p-3 text-left transition-all hover:scale-[1.02] hover:ring-2 hover:ring-primary/50',
                      isSelected && 'ring-2 ring-primary'
                    )}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-xs font-semibold truncate">{q.name}</span>
                      <span className="text-[9px] font-mono opacity-70 shrink-0">{q.ticker}</span>
                    </div>
                    <div className="flex items-end justify-between gap-2">
                      <div>
                        <div className="text-base font-bold">${q.price.toFixed(2)}</div>
                        <div className="text-[10px] opacity-70">{q.currency || 'USD'}</div>
                      </div>
                      <div className={cn(
                        'text-sm font-semibold',
                        isPositive ? 'text-green-100' : 'text-red-100'
                      )}>
                        {isPositive ? '+' : ''}{q.change_pct.toFixed(2)}%
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
