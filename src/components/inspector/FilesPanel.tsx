import {
  ChevronDown,
  ChevronRight,
  Code2,
  FileJson2,
  FileText,
  Folder,
  FolderOpen,
  RefreshCw,
  Search,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { basename } from '@/lib/data'
import { errorMessage } from '@/lib/errors'
import {
  type GitStatus,
  PROJECT_FILE_LISTING_LIMIT,
  type ProjectFileEntry,
  type ProjectRecord,
} from '@/types/api'
import { EmptyState, IconButton } from '../ui'

export interface FileTreeNode {
  id: string
  name: string
  path: string
  fullPath: string
  root: string
  type: 'directory' | 'file'
  children: FileTreeNode[]
  depth: number
}

export function getFileIcon(filename: string) {
  if (filename.endsWith('.json')) {
    return <FileJson2 size={13} />
  }
  if (
    /\.(tsx?|jsx?|vue|svelte|html|css|scss|py|rs|go|c|cpp|h|java|php|rb|sh|bash|zsh|sql|ya?ml|toml)$/i.test(
      filename,
    )
  ) {
    return <Code2 size={13} />
  }
  return <FileText size={13} />
}

// One shared collator: localeCompare with options resolves a new collator on
// every call, which dominates tree building for folders with thousands of files.
const compareNames = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }).compare

export function buildTreeFromEntries(
  entries: ProjectFileEntry[],
  root: string,
  baseDepth = 0,
): FileTreeNode[] {
  const rootNodes: FileTreeNode[] = []
  const nodeMap = new Map<string, FileTreeNode>()

  const getOrCreateDir = (dirPath: string): FileTreeNode => {
    const normalized = dirPath.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/')
    let node = nodeMap.get(normalized)
    if (node) return node

    const lastSlash = normalized.lastIndexOf('/')
    const parentPath = lastSlash === -1 ? '' : normalized.slice(0, lastSlash)
    const name = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1)
    const depth = baseDepth + (normalized ? normalized.split('/').length - 1 : 0)

    node = {
      id: `${root}\0${normalized}`,
      name,
      path: normalized,
      fullPath: `${root}/${normalized}`,
      root,
      type: 'directory',
      children: [],
      depth,
    }
    nodeMap.set(normalized, node)

    if (parentPath) {
      getOrCreateDir(parentPath).children.push(node)
    } else {
      rootNodes.push(node)
    }
    return node
  }

  for (const entry of entries) {
    if (!entry.path) continue
    const normalized = entry.path.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/')
    if (!normalized) continue
    const lastSlash = normalized.lastIndexOf('/')
    const parentPath = lastSlash === -1 ? '' : normalized.slice(0, lastSlash)
    const name = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1)
    const depth = baseDepth + (lastSlash === -1 ? 0 : normalized.split('/').length - 1)

    let node = nodeMap.get(normalized)
    if (node) {
      node.type = entry.type
    } else {
      node = {
        id: `${root}\0${normalized}`,
        name,
        path: normalized,
        fullPath: `${root}/${normalized}`,
        root,
        type: entry.type,
        children: [],
        depth,
      }
      nodeMap.set(normalized, node)

      if (parentPath) {
        getOrCreateDir(parentPath).children.push(node)
      } else {
        rootNodes.push(node)
      }
    }
  }

  const sortNodes = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return compareNames(a.name, b.name)
    })
    for (const node of nodes) {
      if (node.children.length > 0) {
        sortNodes(node.children)
      }
    }
  }

  sortNodes(rootNodes)
  return rootNodes
}

export function buildProjectTree(
  groups: Array<{ root: string; listing: { entries: ProjectFileEntry[]; skipped: number } }>,
  _primaryFolder: string,
): FileTreeNode[] {
  if (groups.length === 0) return []
  if (groups.length === 1) {
    return buildTreeFromEntries(groups[0].listing.entries, groups[0].root, 0)
  }

  return groups.map(({ root, listing }) => ({
    id: root,
    name: basename(root),
    path: '',
    fullPath: root,
    root,
    type: 'directory' as const,
    children: buildTreeFromEntries(listing.entries, root, 1),
    depth: 0,
  }))
}

export function filterFileTree(nodes: FileTreeNode[], query: string): FileTreeNode[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return nodes

  const filterNode = (node: FileTreeNode): FileTreeNode | null => {
    const isMatch =
      node.name.toLowerCase().includes(normalized) || node.path.toLowerCase().includes(normalized)
    if (node.type === 'file') {
      return isMatch ? node : null
    }

    const filteredChildren = node.children
      .map(filterNode)
      .filter((child): child is FileTreeNode => child !== null)

    if (isMatch || filteredChildren.length > 0) {
      return {
        ...node,
        children: filteredChildren,
      }
    }
    return null
  }

  return nodes.map(filterNode).filter((node): node is FileTreeNode => node !== null)
}

export function flattenVisibleTree(
  nodes: FileTreeNode[],
  expandedIds: ReadonlySet<string>,
  isSearching: boolean,
): FileTreeNode[] {
  const result: FileTreeNode[] = []
  const traverse = (list: FileTreeNode[]) => {
    for (const node of list) {
      result.push(node)
      if (node.type === 'directory' && node.children.length > 0) {
        const isExpanded = isSearching || expandedIds.has(node.id)
        if (isExpanded) {
          traverse(node.children)
        }
      }
    }
  }
  traverse(nodes)
  return result
}

export function collectDirectoryIds(nodes: FileTreeNode[]): Set<string> {
  const ids = new Set<string>()
  const collect = (list: FileTreeNode[]) => {
    for (const node of list) {
      if (node.type === 'directory') {
        ids.add(node.id)
        collect(node.children)
      }
    }
  }
  collect(nodes)
  return ids
}

export function FilesPanel({
  project,
  git,
  onReveal,
}: {
  project?: ProjectRecord
  git: GitStatus
  onReveal(path: string): void
}) {
  const [query, setQuery] = useState('')
  const [treeRoots, setTreeRoots] = useState<FileTreeNode[]>([])
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [skipped, setSkipped] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [visibleLimit, setVisibleLimit] = useState(1_000)
  const loadToken = useRef(0)
  const loadedDirectories = useRef(new Set<string>())
  const loadingDirectories = useRef(new Set<string>())
  const recursiveListing = useRef(false)
  const isSearching = Boolean(query.trim())

  const load = async (recursive = isSearching, expand = false) => {
    const token = ++loadToken.current
    setTreeRoots([])
    setExpandedIds(new Set())
    loadedDirectories.current.clear()
    loadingDirectories.current.clear()
    recursiveListing.current = recursive
    setError('')
    setSkipped(0)
    setTruncated(false)
    setVisibleLimit(1_000)
    if (!project || !window.prime) return
    setLoading(true)
    try {
      const roots = project.folders.length ? project.folders : [project.primaryFolder]
      const groups = await Promise.all(
        roots.map(async (root) => ({
          root,
          listing: await window.prime.projects.listFiles(root, project.harness, recursive ? undefined : 'children'),
        })),
      )
      if (loadToken.current !== token) return
      setSkipped(groups.reduce((sum, group) => sum + group.listing.skipped, 0))
      setTruncated(groups.some((group) => group.listing.truncated))
      const builtTree = buildProjectTree(groups, project.primaryFolder)
      setTreeRoots(builtTree)
      if (expand) setExpandedIds(collectDirectoryIds(builtTree))
      for (const root of roots) loadedDirectories.current.add(root)
    } catch (reason) {
      if (loadToken.current === token) setError(errorMessage(reason))
    } finally {
      if (loadToken.current === token) setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    return () => {
      loadToken.current += 1
    }
  }, [project?.id, project?.primaryFolder, project?.folders.join('\0'), project?.harness, isSearching])

  const changed = useMemo(
    () => new Map(git.files.map((file) => [file.path, file.status])),
    [git.files],
  )

  const filteredTree = useMemo(() => filterFileTree(treeRoots, query), [treeRoots, query])
  const visibleNodes = useMemo(
    () => flattenVisibleTree(filteredTree, expandedIds, isSearching),
    [filteredTree, expandedIds, isSearching],
  )
  const displayedNodes = visibleNodes.slice(0, visibleLimit)

  const allDirIds = useMemo(() => collectDirectoryIds(treeRoots), [treeRoots])

  const toggleExpand = async (node: FileTreeNode) => {
    const id = node.id
    const opening = !expandedIds.has(id)
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (opening) next.add(id)
      else next.delete(id)
      return next
    })
    if (!opening || node.children.length > 0 || recursiveListing.current || loadedDirectories.current.has(id) || loadingDirectories.current.has(id) || !window.prime || !project) return
    const token = loadToken.current
    loadingDirectories.current.add(id)
    try {
      const listing = await window.prime.projects.listFiles(node.fullPath, project.harness, 'children')
      if (loadToken.current !== token) return
      const prefix = node.path ? `${node.path}/` : ''
      const entries = listing.entries.map((entry) => ({ ...entry, path: `${prefix}${entry.path}` }))
      const children = buildTreeFromEntries(entries, node.root, node.depth + 1 - (node.path ? node.path.split('/').length : 0))
      // Entries are relative to the project; the builder supplies their ancestor path.
      let descendants = children
      if (node.path) {
        for (const segment of node.path.split('/')) descendants = descendants.find((child) => child.name === segment)?.children ?? []
      }
      const replace = (nodes: FileTreeNode[]): FileTreeNode[] => nodes.map((item) => item.id === id ? { ...item, children: descendants } : { ...item, children: replace(item.children) })
      setTreeRoots(replace)
      setSkipped((count) => count + listing.skipped)
      setTruncated((value) => value || listing.truncated === true)
      loadedDirectories.current.add(id)
    } catch (reason) {
      if (loadToken.current === token) setError(errorMessage(reason))
    } finally {
      if (loadToken.current === token) loadingDirectories.current.delete(id)
    }
  }

  const collapseAll = () => {
    setExpandedIds(new Set())
  }

  const expandAll = () => {
    if (recursiveListing.current) setExpandedIds(new Set(allDirIds))
    else void load(true, true)
  }

  if (!project) {
    return (
      <EmptyState icon={<Folder size={24} />} title="No project files">
        Choose a local project to inspect files.
      </EmptyState>
    )
  }

  return (
    <div className="files-panel">
      <div className="files-search">
        <Search size={13} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter project paths"
        />
        {!isSearching && allDirIds.size > 0 ? (
          expandedIds.size > 0 ? (
            <IconButton size="small" label="Collapse all folders" onClick={collapseAll}>
              <Folder size={13} />
            </IconButton>
          ) : (
            <IconButton size="small" label="Expand all folders" onClick={expandAll}>
              <FolderOpen size={13} />
            </IconButton>
          )
        ) : null}
        <IconButton size="small" label="Refresh project files" onClick={() => void load()}>
          <RefreshCw className={loading ? 'spin' : ''} size={13} />
        </IconButton>
      </div>

      <div className="file-tree scroll-area">
        <button
          type="button"
          className="tree-root"
          onClick={() => onReveal(project.primaryFolder)}
          title={project.primaryFolder}
        >
          <Folder size={14} />
          <strong>
            {project.folders.length > 1
              ? `${project.folders.length} project folders`
              : basename(project.primaryFolder)}
          </strong>
        </button>

        {loading ? <p>Loading project files…</p> : null}
        {error ? <p>Unable to list project files: {error}</p> : null}
        {!loading && !error && skipped > 0 ? (
          <p className="file-tree__skipped">
            {skipped} {skipped === 1 ? 'folder' : 'folders'} could not be read and{' '}
            {skipped === 1 ? 'was' : 'were'} skipped.
          </p>
        ) : null}
        {!loading && !error && truncated ? (
          <p className="file-tree__skipped">
            Large project: the file list stops after{' '}
            {PROJECT_FILE_LISTING_LIMIT.toLocaleString('en-US')} entries
            {project.folders.length > 1 ? ' per project folder' : ''}, so some deeper paths are not
            shown or searchable.
          </p>
        ) : null}

        {!loading && !error
          ? displayedNodes.map((node) => {
              const isDirectory = node.type === 'directory'
              const isExpanded = isSearching || expandedIds.has(node.id)
              const status =
                node.root === project.primaryFolder ? changed.get(node.path) : undefined

              if (isDirectory) {
                return (
                  <button
                    type="button"
                    key={node.id}
                    className="file-tree__item is-directory"
                    style={{ paddingLeft: `${8 + node.depth * 14}px` }}
                    title={node.path || node.name}
                    aria-expanded={isExpanded}
                    onClick={isSearching ? undefined : () => void toggleExpand(node)}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      onReveal(node.fullPath)
                    }}
                  >
                    <span className="file-tree__chevron">
                      {(!recursiveListing.current && !loadedDirectories.current.has(node.id)) || node.children.length > 0 ? (
                        isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />
                      ) : (
                        <span className="file-tree__expander-placeholder" />
                      )}
                    </span>
                    <span className="file-tree__icon">
                      {isExpanded ? <FolderOpen size={13} /> : <Folder size={13} />}
                    </span>
                    <span className="file-tree__name">{node.name}</span>
                    {status ? (
                      <small
                        className={`file-tree__status ${
                          status === 'M'
                            ? 'file-tree__status--modified'
                            : status === 'A'
                              ? 'file-tree__status--added'
                              : status === 'D'
                                ? 'file-tree__status--deleted'
                                : ''
                        }`}
                      >
                        {status}
                      </small>
                    ) : null}
                  </button>
                )
              }

              return (
                <button
                  type="button"
                  key={node.id}
                  className="file-tree__item is-file"
                  style={{ paddingLeft: `${8 + node.depth * 14}px` }}
                  title={node.path}
                  onClick={() => onReveal(node.fullPath)}
                >
                  <span className="file-tree__expander-placeholder" />
                  <span className="file-tree__icon">{getFileIcon(node.name)}</span>
                  <span className="file-tree__name">{node.name}</span>
                  {status ? (
                    <small
                      className={`file-tree__status ${
                        status === 'M'
                          ? 'file-tree__status--modified'
                          : status === 'A'
                            ? 'file-tree__status--added'
                            : status === 'D'
                              ? 'file-tree__status--deleted'
                              : ''
                      }`}
                    >
                      {status}
                    </small>
                  ) : null}
                </button>
              )
            })
          : null}

        {!loading && !error && visibleNodes.length > displayedNodes.length ? (
          <button
            type="button"
            className="file-tree__show-more"
            onClick={() =>
              setVisibleLimit((limit) => Math.min(visibleNodes.length, limit + 1_000))
            }
          >
            Show {Math.min(1_000, visibleNodes.length - displayedNodes.length)} more paths
          </button>
        ) : null}

        {!loading && !error && treeRoots.length > 0 && visibleNodes.length === 0 ? (
          <p>{query.trim() ? `No files match “${query}”.` : 'No project files found.'}</p>
        ) : null}

        {!loading && !error && treeRoots.length === 0 ? <p>No project files found.</p> : null}
      </div>
    </div>
  )
}
