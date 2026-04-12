import { useState, useEffect, useCallback } from 'react'
import {
  BookOpen, Search, FolderOpen, FileText, Tag, RefreshCw,
  ChevronRight, ExternalLink, Loader2, AlertCircle, Upload, Download
} from 'lucide-react'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { cn } from '@renderer/lib/utils'

export function VaultPage() {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [tags, setTags] = useState<Record<string, number>>({})
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string>('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Array<{ filename: string; result: { content: string } }>>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'files' | 'search' | 'tags'>('files')
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<string | null>(null)
  const [showImportPrompt, setShowImportPrompt] = useState(false)

  const invoke = useCallback((channel: string, params?: unknown) => {
    return window.heimdall.invoke(channel, params)
  }, [])

  const checkConnection = useCallback(async () => {
    try {
      const result = await invoke('obsidian:testConnection') as { success: boolean; message: string }
      console.log('Obsidian connection result:', result)
      const isConnected = result?.success === true
      setConnected(isConnected)
      if (isConnected) {
        loadFiles()
        loadTags()
        // Check if initial import is needed
        try {
          const needsImport = await invoke('obsidian:needsInitialImport') as boolean
          if (needsImport) setShowImportPrompt(true)
        } catch {
          // Non-critical
        }
      } else {
        setError(result?.message || 'Connection failed')
      }
    } catch (err) {
      console.error('Obsidian connection error:', err)
      setConnected(false)
      setError(String(err))
    }
  }, [invoke])

  const handleBulkImport = async () => {
    setSyncing(true)
    setSyncResult(null)
    setShowImportPrompt(false)
    try {
      const result = await invoke('obsidian:bulkImport') as { imported: number; skipped: number; errors: number }
      setSyncResult(`Imported ${result.imported} files, ${result.skipped} skipped, ${result.errors} errors`)
      loadFiles() // Refresh file list
    } catch (err) {
      setSyncResult(`Import failed: ${err}`)
    } finally {
      setSyncing(false)
    }
  }

  const handleManualSync = async () => {
    setSyncing(true)
    setSyncResult(null)
    try {
      const result = await invoke('obsidian:manualSync') as { synced: number; errors: number }
      setSyncResult(`Synced ${result.synced} new files, ${result.errors} errors`)
      loadFiles()
    } catch (err) {
      setSyncResult(`Sync failed: ${err}`)
    } finally {
      setSyncing(false)
    }
  }

  useEffect(() => {
    checkConnection()
  }, [checkConnection])

  const loadFiles = async (folder?: string) => {
    setLoading(true)
    setError(null)
    try {
      const result = await invoke('obsidian:listFiles', { folder }) as string[]
      setFiles(result || [])
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }

  const loadTags = async () => {
    try {
      const result = await invoke('obsidian:getTags') as Record<string, number>
      setTags(result || {})
    } catch {
      // Tags endpoint may not be available
    }
  }

  const openFile = async (path: string) => {
    setSelectedFile(path)
    setLoading(true)
    try {
      const content = await invoke('obsidian:readFile', { path }) as string
      setFileContent(content || '')
    } catch (err) {
      setFileContent(`Error loading file: ${err}`)
    } finally {
      setLoading(false)
    }
  }

  const handleSearch = async () => {
    if (!searchQuery.trim()) return
    setLoading(true)
    setError(null)
    try {
      const results = await invoke('obsidian:search', { query: searchQuery }) as Array<{
        filename: string
        result: { content: string }
      }>
      setSearchResults(results || [])
      setActiveTab('search')
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }

  const openInObsidian = async (path: string) => {
    try {
      await invoke('obsidian:openInObsidian', { path })
    } catch {
      // Fallback — just select it
    }
  }

  if (connected === null) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!connected) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-4">
        <BookOpen className="h-16 w-16 opacity-30" />
        <h2 className="text-lg font-semibold">Obsidian Vault Not Connected</h2>
        <p className="text-sm max-w-md text-center">
          Install the Local REST API plugin in Obsidian and configure the API key in
          Settings to browse your vault here.
        </p>
        {error && (
          <div className="flex items-center gap-1.5 text-xs text-red-400 max-w-md text-center">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {error}
          </div>
        )}
        <div className="flex gap-2">
          <Button variant="outline" onClick={checkConnection}>
            <RefreshCw className="h-4 w-4 mr-2" /> Retry Connection
          </Button>
        </div>
      </div>
    )
  }

  // Group files by folder
  const fileTree = buildFileTree(files)

  return (
    <div className="flex flex-col h-full">
      {/* Import prompt banner */}
      {showImportPrompt && (
        <div className="bg-primary/10 border-b border-primary/20 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Upload className="h-4 w-4 text-primary" />
            <span className="text-sm">
              <strong>First connection detected.</strong> Import existing Heimdall intelligence files to your Obsidian vault?
            </span>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleBulkImport} disabled={syncing}>
              {syncing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Upload className="h-3.5 w-3.5 mr-1.5" />}
              Import All
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowImportPrompt(false)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {/* Sync status bar */}
      {(syncing || syncResult) && (
        <div className={cn(
          'px-4 py-2 text-xs border-b flex items-center gap-2',
          syncing ? 'bg-yellow-500/10 border-yellow-500/20 text-yellow-400' : 'bg-green-500/10 border-green-500/20 text-green-400'
        )}>
          {syncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
          {syncing ? 'Syncing to Obsidian vault...' : syncResult}
          {!syncing && <button onClick={() => setSyncResult(null)} className="ml-auto text-muted-foreground hover:text-foreground">×</button>}
        </div>
      )}

      <div className="flex flex-1 min-h-0">
      {/* Left panel — file browser / search / tags */}
      <div className="w-72 border-r border-border flex flex-col bg-card/50">
        {/* Search bar */}
        <div className="p-3 border-b border-border">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="Search vault..."
              className="pl-8 h-8 text-sm"
            />
          </div>
        </div>

        {/* Tab buttons */}
        <div className="flex border-b border-border">
          {(['files', 'search', 'tags'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                'flex-1 px-3 py-2 text-xs font-medium transition-colors',
                activeTab === tab ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {tab === 'files' ? 'Files' : tab === 'search' ? `Search${searchResults.length ? ` (${searchResults.length})` : ''}` : 'Tags'}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-2">
          {activeTab === 'files' && (
            <FileTreeView tree={fileTree} onSelect={openFile} selected={selectedFile} />
          )}

          {activeTab === 'search' && (
            <div className="space-y-1">
              {searchResults.length === 0 ? (
                <p className="text-xs text-muted-foreground p-2">
                  {searchQuery ? 'No results found' : 'Enter a search query above'}
                </p>
              ) : (
                searchResults.map((result, i) => (
                  <button
                    key={i}
                    onClick={() => openFile(result.filename)}
                    className={cn(
                      'w-full text-left px-2 py-1.5 rounded text-xs hover:bg-accent transition-colors',
                      selectedFile === result.filename && 'bg-accent'
                    )}
                  >
                    <div className="font-medium truncate">{result.filename}</div>
                    <div className="text-muted-foreground truncate mt-0.5">
                      {result.result?.content?.slice(0, 80)}...
                    </div>
                  </button>
                ))
              )}
            </div>
          )}

          {activeTab === 'tags' && (
            <div className="space-y-1">
              {Object.entries(tags)
                .sort(([, a], [, b]) => b - a)
                .map(([tag, count]) => (
                  <div key={tag} className="flex items-center justify-between px-2 py-1 text-xs">
                    <span className="flex items-center gap-1">
                      <Tag className="h-3 w-3 text-primary" />
                      {tag}
                    </span>
                    <Badge variant="secondary" className="text-[9px] py-0 px-1.5">{count}</Badge>
                  </div>
                ))}
              {Object.keys(tags).length === 0 && (
                <p className="text-xs text-muted-foreground p-2">No tags found</p>
              )}
            </div>
          )}
        </div>

        {/* Footer with sync */}
        <div className="border-t border-border p-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">{files.length} files</span>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={() => loadFiles()}>
              <RefreshCw className="h-3 w-3" />
            </Button>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full h-7 text-xs"
            onClick={handleManualSync}
            disabled={syncing}
          >
            {syncing ? (
              <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
            ) : (
              <Upload className="h-3 w-3 mr-1.5" />
            )}
            Sync to Obsidian
          </Button>
        </div>
      </div>

      {/* Right panel — file content */}
      <div className="flex-1 overflow-auto">
        {selectedFile ? (
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold truncate">{selectedFile.split('/').pop()}</h2>
                <p className="text-xs text-muted-foreground truncate">{selectedFile}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => openInObsidian(selectedFile)}>
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                Open in Obsidian
              </Button>
            </div>
            {loading ? (
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            ) : (
              <div className="prose prose-sm prose-invert max-w-none">
                <pre className="whitespace-pre-wrap text-sm text-foreground/90 leading-relaxed font-sans bg-transparent p-0 border-0">
                  {fileContent}
                </pre>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <BookOpen className="h-12 w-12 mb-3 opacity-30" />
            <p className="text-sm">Select a file to view its contents</p>
            {error && (
              <div className="flex items-center gap-1 mt-2 text-red-400 text-xs">
                <AlertCircle className="h-3 w-3" />
                {error}
              </div>
            )}
          </div>
        )}
      </div>
      </div>
    </div>
  )
}

// ── File Tree helpers ──

interface TreeNode {
  name: string
  path: string
  isFolder: boolean
  children: TreeNode[]
}

function buildFileTree(files: string[]): TreeNode[] {
  const root: TreeNode[] = []

  for (const filePath of files) {
    const parts = filePath.split('/')
    let current = root

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isLast = i === parts.length - 1
      const existingNode = current.find((n) => n.name === part)

      if (existingNode) {
        current = existingNode.children
      } else {
        const node: TreeNode = {
          name: part,
          path: parts.slice(0, i + 1).join('/'),
          isFolder: !isLast,
          children: []
        }
        current.push(node)
        current = node.children
      }
    }
  }

  // Sort: folders first, then alpha
  const sortTree = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const node of nodes) {
      if (node.children.length > 0) sortTree(node.children)
    }
    return nodes
  }

  return sortTree(root)
}

function FileTreeView({
  tree,
  onSelect,
  selected,
  depth = 0
}: {
  tree: TreeNode[]
  onSelect: (path: string) => void
  selected: string | null
  depth?: number
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <>
      {tree.map((node) => (
        <div key={node.path}>
          <button
            onClick={() => {
              if (node.isFolder) toggle(node.path)
              else onSelect(node.path)
            }}
            className={cn(
              'w-full text-left flex items-center gap-1 px-1 py-1 rounded text-xs hover:bg-accent transition-colors',
              selected === node.path && 'bg-accent'
            )}
            style={{ paddingLeft: `${depth * 12 + 4}px` }}
          >
            {node.isFolder ? (
              <>
                <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', expanded.has(node.path) && 'rotate-90')} />
                <FolderOpen className="h-3 w-3 shrink-0 text-yellow-500" />
              </>
            ) : (
              <>
                <span className="w-3" />
                <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
              </>
            )}
            <span className="truncate">{node.name}</span>
          </button>
          {node.isFolder && expanded.has(node.path) && node.children.length > 0 && (
            <FileTreeView tree={node.children} onSelect={onSelect} selected={selected} depth={depth + 1} />
          )}
        </div>
      ))}
    </>
  )
}
