/**
 * One-time Chart.js registration for analytics widgets.
 * Imported by every widget that uses react-chartjs-2.
 */
import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, PointElement,
  LineElement, ArcElement, Title, Tooltip, Legend, Filler, TimeScale
} from 'chart.js'

let registered = false
export function ensureChartRegistered(): void {
  if (registered) return
  ChartJS.register(
    CategoryScale, LinearScale, BarElement, PointElement, LineElement,
    ArcElement, Title, Tooltip, Legend, Filler, TimeScale
  )
  registered = true
}

// Shared palettes
export const COLORS = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#6366f1', '#14b8a6',
  '#e11d48', '#84cc16', '#a855f7', '#0ea5e9', '#d946ef'
]

export const SEVERITY_COLORS: Record<string, string> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#3b82f6',
  info: '#6b7280'
}

export const DISCIPLINE_COLORS: Record<string, string> = {
  osint: '#3b82f6',
  cybint: '#8b5cf6',
  finint: '#10b981',
  socmint: '#ec4899',
  geoint: '#f59e0b',
  sigint: '#06b6d4',
  rumint: '#6366f1',
  ci: '#ef4444',
  agency: '#14b8a6',
  imint: '#a855f7'
}

export function colorFor(label: string, scheme: string = 'default', index: number = 0): string {
  if (scheme === 'severity') return SEVERITY_COLORS[label.toLowerCase()] || '#6b7280'
  if (scheme === 'discipline') return DISCIPLINE_COLORS[label.toLowerCase()] || COLORS[index % COLORS.length]
  return COLORS[index % COLORS.length]
}

export const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { labels: { color: '#9ca3af', font: { size: 10 } } },
    tooltip: { backgroundColor: '#0f172a', titleColor: '#e2e8f0', bodyColor: '#94a3b8', borderColor: '#1e293b', borderWidth: 1 }
  },
  animation: { duration: 300 }
} as const
