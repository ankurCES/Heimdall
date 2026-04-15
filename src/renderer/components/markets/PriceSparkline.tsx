// Tiny inline SVG sparkline for KPI cards — no Chart.js for performance
interface Props {
  values: number[]
  width?: number
  height?: number
  color?: string
  strokeWidth?: number
}

export function PriceSparkline({ values, width = 80, height = 24, color = '#3b82f6', strokeWidth = 1.5 }: Props) {
  if (!values || values.length < 2) {
    return <svg width={width} height={height} />
  }

  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const stepX = width / (values.length - 1)

  const points = values.map((v, i) => {
    const x = i * stepX
    const y = height - ((v - min) / range) * height
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')

  // Determine color based on trend (first vs last)
  const trendColor = values[values.length - 1] >= values[0] ? '#10b981' : '#ef4444'
  const finalColor = color === 'auto' ? trendColor : color

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <polyline
        fill="none"
        stroke={finalColor}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  )
}
