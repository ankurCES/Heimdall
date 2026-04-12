import React from 'react'
import { AlertCircle } from 'lucide-react'

interface Props {
  children: React.ReactNode
  fallback?: React.ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="flex flex-col items-center justify-center h-full p-8 text-muted-foreground">
          <AlertCircle className="h-10 w-10 mb-3 text-red-500" />
          <p className="text-sm font-medium">Something went wrong</p>
          <p className="text-xs mt-1 max-w-md text-center text-red-400">{this.state.error?.message}</p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="mt-4 px-4 py-2 text-xs bg-primary text-primary-foreground rounded-md"
          >
            Try Again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
