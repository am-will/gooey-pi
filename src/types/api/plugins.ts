export interface SkillRecord {
  id: string
  name: string
  description: string
  kind: 'skill' | 'extension' | 'prompt' | 'package' | 'mcp'
  location: 'bundled' | 'user' | 'project' | 'system'
  path?: string
  enabled: boolean
  icon?: string
  source?: string
  /** MCP server ids this package exists to bridge. Used to collapse duplicate capability rows. */
  associatedMcpServers?: string[]
  associatedPackageSource?: string
  /** Exact bounded map key used only for definition removal; never rendered as display copy. */
  definitionKey?: string
  /** False when an external definition key cannot be represented safely by the app removal API. */
  definitionRemovalAvailable?: boolean
  availability?: {
    available: boolean
    detail: string
    actionUrl?: string
  }
}
export interface PluginWarning {
  scope: 'user' | 'project'
  path: string
  message: string
}
export interface PluginCatalog {
  skills: SkillRecord[]
  warnings: PluginWarning[]
}
export type McpConnectionInput = {
  name: string
  scope: 'user' | 'project'
  projectPath?: string
} & (
  | { type: 'http'; url: string; auth?: 'none' | 'oauth' | 'bearer'; bearerTokenEnvVar?: string }
  | { type: 'stdio'; command: string; args?: string[] }
)
export interface McpStateInput {
  name: string
  scope: 'user' | 'project'
  projectPath?: string
  enabled: boolean
}
export interface CapabilityMutationInput {
  kind: 'package' | 'mcp'
  action: 'enable' | 'disable' | 'remove'
  name: string
  /** Exact bounded MCP map key for definition-only removal. */
  definitionKey?: string
  source?: string
  scope: 'user' | 'project'
  projectPath?: string
}
export interface ExtensionInstallInput {
  source: string
  scope: 'user' | 'project'
  projectPath?: string
}
