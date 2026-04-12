import React, { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import { Bar, Pie, Line, Doughnut } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement, PointElement, LineElement,
  ArcElement, Title, Tooltip, Legend, Filler
} from 'chart.js'

ChartJS.register(
  CategoryScale, LinearScale, BarElement, PointElement, LineElement,
  ArcElement, Title, Tooltip, Legend, Filler
)

interface MarkdownRendererProps {
  content: string
  className?: string
}

// Parse ```chart blocks into Chart.js configs
function extractCharts(content: string): { text: string; charts: Map<string, unknown> } {
  const charts = new Map<string, unknown>()
  let counter = 0
  const text = content.replace(/```chart\s*\n([\s\S]*?)```/g, (_, chartJson) => {
    try {
      const config = JSON.parse(chartJson.trim())
      const id = `chart-${counter++}`
      charts.set(id, config)
      return `\n\n<!--chart:${id}-->\n\n`
    } catch {
      return '```\n' + chartJson + '```'
    }
  })
  return { text, charts }
}

function ChartBlock({ config }: { config: any }) {
  const type = config.type || 'bar'
  const chartData = {
    labels: config.labels || [],
    datasets: (config.datasets || []).map((ds: any, i: number) => ({
      ...ds,
      backgroundColor: ds.backgroundColor || [
        '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
        '#ec4899', '#06b6d4', '#f97316'
      ].slice(0, (config.labels || []).length),
      borderColor: ds.borderColor || ds.backgroundColor || '#3b82f6',
      borderWidth: ds.borderWidth || 1
    }))
  }

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: '#9ca3af', font: { size: 11 } } },
      title: config.title ? { display: true, text: config.title, color: '#e2e8f0', font: { size: 13 } } : undefined
    },
    scales: type === 'pie' || type === 'doughnut' ? undefined : {
      x: { ticks: { color: '#9ca3af' }, grid: { color: '#1f2937' } },
      y: { ticks: { color: '#9ca3af' }, grid: { color: '#1f2937' } }
    },
    ...config.options
  }

  const ChartComponent = {
    bar: Bar, pie: Pie, line: Line, doughnut: Doughnut
  }[type] || Bar

  return (
    <div className="my-4 bg-card/50 border border-border rounded-lg p-4" style={{ height: 280 }}>
      <ChartComponent data={chartData} options={options} />
    </div>
  )
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  const { text, charts } = useMemo(() => extractCharts(content), [content])

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          // Custom rendering for chart placeholders
          p: ({ children, ...props }) => {
            const text = React.Children.toArray(children).join('')
            const chartMatch = text.match(/<!--chart:(chart-\d+)-->/)
            if (chartMatch) {
              const chartConfig = charts.get(chartMatch[1])
              if (chartConfig) return <ChartBlock config={chartConfig} />
            }
            return <p className="mb-3 leading-relaxed" {...props}>{children}</p>
          },
          // Styled markdown elements
          h1: ({ children }) => <h1 className="text-xl font-bold mt-5 mb-3 text-foreground">{children}</h1>,
          h2: ({ children }) => <h2 className="text-lg font-semibold mt-4 mb-2 text-foreground">{children}</h2>,
          h3: ({ children }) => <h3 className="text-base font-semibold mt-3 mb-1.5 text-foreground">{children}</h3>,
          strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
          em: ({ children }) => <em className="italic text-foreground/80">{children}</em>,
          ul: ({ children }) => <ul className="list-disc list-inside mb-3 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal list-inside mb-3 space-y-1">{children}</ol>,
          li: ({ children }) => <li className="text-sm">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-primary/50 pl-3 my-3 text-muted-foreground italic">{children}</blockquote>
          ),
          code: ({ className, children, ...props }) => {
            const isInline = !className
            if (isInline) {
              return <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono text-primary">{children}</code>
            }
            return (
              <code className={`block bg-muted/50 rounded-lg p-3 my-3 text-xs font-mono overflow-x-auto ${className || ''}`} {...props}>
                {children}
              </code>
            )
          },
          pre: ({ children }) => <pre className="bg-muted/50 rounded-lg overflow-x-auto my-3">{children}</pre>,
          table: ({ children }) => (
            <div className="overflow-x-auto my-3">
              <table className="min-w-full text-xs border border-border rounded">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-muted/50">{children}</thead>,
          th: ({ children }) => <th className="px-3 py-1.5 text-left font-semibold border-b border-border">{children}</th>,
          td: ({ children }) => <td className="px-3 py-1.5 border-b border-border/50">{children}</td>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-primary hover:underline">{children}</a>
          ),
          hr: () => <hr className="border-border my-4" />
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
