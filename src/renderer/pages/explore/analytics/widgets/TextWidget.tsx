import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { WidgetConfig } from '@common/analytics/types'

interface Props {
  config: WidgetConfig
}

export function TextWidget({ config }: Props) {
  const content = config.staticContent || '_Empty text widget — use the editor to add markdown content._'
  return (
    <div className="h-full overflow-auto p-4 prose prose-sm prose-invert max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  )
}
