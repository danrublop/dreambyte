'use client'

import { useState, useCallback } from 'react'
import { Plug, Cpu, Sparkles, Bot, Plus, Search, ChevronDown, ChevronRight, FileText as FileIcon } from 'lucide-react'
import ModelsAndApiPanel from './settings/ModelsAndApiPanel'
import AgentsSettingsTab from './settings/AgentsSettingsTab'

type Section = 'apps' | 'models' | 'skills' | 'agents'

const SECTIONS: { id: Section; label: string; icon: typeof Plug }[] = [
  { id: 'apps', label: 'Apps & Integrations', icon: Plug },
  { id: 'models', label: 'Models', icon: Cpu },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'agents', label: 'Agents', icon: Bot },
]

function AppsSection() {
  const [expandedApp, setExpandedApp] = useState<string | null>(null)

  const INTEGRATIONS = [
    {
      id: 'claude-code',
      name: 'Claude Code CLI',
      description: 'Use Claude Code as an AI coding agent inside Dreambyte',
      connected: false,
      setupSteps: [
        'Install Claude Code: npm install -g @anthropic-ai/claude-code',
        'Authenticate: claude login',
        'In Dreambyte, the agent connects via the MCP server at scripts/mcp/mcp-server.ts',
        'Start the MCP server: npm run mcp-server',
        'Claude Code can now generate scenes, verify output, and call all agent tools',
      ],
      docs: 'https://docs.anthropic.com/en/docs/claude-code',
    },
    {
      id: 'codex',
      name: 'OpenAI Codex CLI',
      description: 'Use OpenAI Codex as an alternative coding agent',
      connected: false,
      setupSteps: [
        'Install Codex CLI: npm install -g @openai/codex',
        'Set your OpenAI API key: export OPENAI_API_KEY=sk-...',
        'Run Codex in the project directory: codex',
        'Point it at the MCP server for tool access: npm run mcp-server',
      ],
      docs: 'https://github.com/openai/codex',
    },
    {
      id: 'github',
      name: 'GitHub',
      description: 'Push projects to repos, sync scenes, version control',
      connected: false,
      setupSteps: [
        'Go to Settings > Developer Settings > Personal Access Tokens on GitHub',
        'Generate a token with repo scope',
        'Link your project via the GitHub panel in the editor sidebar',
      ],
    },
    {
      id: 'slack',
      name: 'Slack',
      description: 'Send notifications and share renders to channels',
      connected: false,
      setupSteps: [
        'Create a Slack app at api.slack.com/apps',
        'Add the Incoming Webhooks feature',
        'Copy the webhook URL and paste it in the field below',
      ],
    },
    {
      id: 'figma',
      name: 'Figma',
      description: 'Import designs and assets from Figma files',
      connected: false,
      setupSteps: [
        'Generate a personal access token in Figma > Settings > Account',
        'Paste the token below to enable asset imports',
      ],
    },
    {
      id: 'google-drive',
      name: 'Google Drive',
      description: 'Save exports and assets to Drive',
      connected: false,
      setupSteps: ['Sign in with your Google account', 'Grant Dreambyte access to a specific Drive folder'],
    },
    {
      id: 'notion',
      name: 'Notion',
      description: 'Sync scripts and scene outlines from Notion',
      connected: false,
      setupSteps: [
        'Create an integration at notion.so/my-integrations',
        'Share the relevant Notion pages with your integration',
        'Paste the integration token below',
      ],
    },
  ]

  return (
    <div>
      <h2 className="text-lg font-semibold text-[var(--color-text-primary)] mb-1">Apps & Integrations</h2>
      <p className="text-[13px] text-[var(--color-text-muted)] mb-6">
        Connect external apps and services to your workflow.
      </p>

      <div className="space-y-3">
        {INTEGRATIONS.map((app) => (
          <div
            key={app.id}
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] overflow-hidden"
          >
            <div
              className="p-4 flex items-center gap-4 cursor-pointer"
              onClick={() => setExpandedApp(expandedApp === app.id ? null : app.id)}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[13px] font-medium text-[var(--color-text-primary)]">{app.name}</span>
                  {app.connected && (
                    <span className="text-[10px] text-green-400 bg-green-400/10 border border-green-400/30 rounded px-1.5 py-0.5 uppercase font-bold tracking-tight">
                      Connected
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-[var(--color-text-muted)]">{app.description}</p>
              </div>
              <ChevronDown
                size={14}
                className={`text-[var(--color-text-muted)] transition-transform shrink-0 ${expandedApp === app.id ? 'rotate-180' : ''}`}
              />
            </div>

            {expandedApp === app.id && (
              <div className="px-4 pb-4 pt-0 border-t border-[var(--color-border)]">
                <div className="mt-3">
                  <h4 className="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)] font-bold mb-2">
                    Setup
                  </h4>
                  <ol className="space-y-1.5 list-decimal list-inside">
                    {app.setupSteps.map((step, i) => (
                      <li key={i} className="text-[12px] text-[var(--color-text-secondary)] leading-relaxed">
                        {step}
                      </li>
                    ))}
                  </ol>
                </div>
                {app.docs && (
                  <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
                    <span className="text-[11px] text-[var(--color-text-muted)]">
                      Docs: <span className="text-[var(--color-accent)] font-mono">{app.docs}</span>
                    </span>
                  </div>
                )}
                <div className="mt-3">
                  <span className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] cursor-pointer transition-colors border border-[var(--color-border)] rounded-md px-3 py-1.5">
                    {app.connected ? 'Manage' : 'Connect'}
                  </span>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function ModelsSection() {
  return (
    <div>
      <h2 className="text-lg font-semibold text-[var(--color-text-primary)] mb-1">Models</h2>
      <p className="text-[13px] text-[var(--color-text-muted)] mb-6">
        Manage AI model providers, API keys, and custom endpoints.
      </p>
      <ModelsAndApiPanel />
    </div>
  )
}

interface SkillDef {
  id: string
  name: string
  description: string
  trigger?: string
  source: 'dreambyte' | 'library'
  files: string[]
}

const DREAMBYTE_SKILLS: SkillDef[] = [
  {
    id: 'dreambyte',
    name: 'dreambyte',
    description: 'Generate animated video scenes for Dreambyte',
    trigger: '/dreambyte',
    source: 'dreambyte',
    files: ['SKILL.md', 'rules/three.md', 'rules/audio.md', 'rules/research.md', 'rules/generation.md'],
  },
  {
    id: 'svg-animation',
    name: 'svg-animation',
    description: 'SVG draw-on animation techniques and path morphing',
    source: 'library',
    files: ['svg-animation.md'],
  },
  {
    id: 'canvas2d-animation',
    name: 'canvas2d-animation',
    description: 'Canvas2D hand-drawn strokes, particles, and procedural art',
    source: 'library',
    files: ['canvas2d-animation.md'],
  },
  {
    id: 'd3-data-visualization',
    name: 'd3-data-visualization',
    description: 'D3.js charts, graphs, and data storytelling',
    source: 'library',
    files: ['d3-data-visualization.md'],
  },
  {
    id: 'threejs-3d-scene',
    name: 'threejs-3d-scene',
    description: 'Three.js 3D geometry, PBR materials, and lighting',
    source: 'library',
    files: ['threejs-3d-scene.md'],
  },
  {
    id: 'motion-css-animation',
    name: 'motion-css-animation',
    description: 'HTML/CSS animation with Anime.js and motion design',
    source: 'library',
    files: ['motion-css-animation.md'],
  },
  {
    id: 'lottie-animation',
    name: 'lottie-animation',
    description: 'Lottie micro-animations and icon animations',
    source: 'library',
    files: ['lottie-animation.md'],
  },
]

const PERSONAL_SKILLS: SkillDef[] = []

function SkillsSection() {
  const [selectedSkill, setSelectedSkill] = useState<SkillDef | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [loadingFile, setLoadingFile] = useState(false)
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set())
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['dreambyte', 'personal']))

  const toggleSkillExpanded = (id: string) => {
    setExpandedSkills((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSection = (id: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const loadFile = useCallback(async (skill: SkillDef, file: string) => {
    setSelectedSkill(skill)
    setSelectedFile(file)
    setLoadingFile(true)
    setFileContent(null)
    try {
      const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.skills : undefined
      if (ipc) {
        const data = await ipc.readFile({ source: skill.source, file })
        setFileContent(data.content)
      } else {
        setFileContent('Failed to load file.')
      }
    } catch {
      setFileContent('Failed to load file.')
    } finally {
      setLoadingFile(false)
    }
  }, [])

  const handleSelectSkill = (skill: SkillDef) => {
    setSelectedSkill(skill)
    // Auto-open first file
    loadFile(skill, skill.files[0])
    // Auto-expand
    setExpandedSkills((prev) => new Set(prev).add(skill.id))
  }

  const handleSelectFile = (skill: SkillDef, file: string) => {
    loadFile(skill, file)
  }

  return (
    <>
      {/* Skills sidebar */}
      <div className="w-[180px] shrink-0 border-r border-[var(--color-border)] overflow-y-auto">
        <div className="p-3">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[12px] font-semibold text-[var(--color-text-primary)]">Skills</span>
            <div className="flex items-center gap-1">
              <span
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] cursor-pointer transition-colors"
                title="Search skills"
              >
                <Search size={13} />
              </span>
              <span
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] cursor-pointer transition-colors"
                title="New skill"
              >
                <Plus size={13} />
              </span>
            </div>
          </div>

          {/* Personal skills */}
          <div className="mb-2">
            <div
              className="flex items-center gap-1 px-1 py-1 text-[11px] text-[var(--color-text-muted)] cursor-pointer select-none hover:text-[var(--color-text-primary)]"
              onClick={() => toggleSection('personal')}
            >
              {expandedSections.has('personal') ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              <span>Personal skills</span>
            </div>
            {expandedSections.has('personal') && (
              <div className="ml-2">
                {PERSONAL_SKILLS.length === 0 ? (
                  <div className="px-2 py-2 text-[11px] text-[var(--color-text-muted)] italic">
                    No personal skills yet
                  </div>
                ) : (
                  PERSONAL_SKILLS.map((skill) => (
                    <SkillTreeItem
                      key={skill.id}
                      skill={skill}
                      selectedFile={selectedSkill?.id === skill.id ? selectedFile : null}
                      isExpanded={expandedSkills.has(skill.id)}
                      onSelect={() => handleSelectSkill(skill)}
                      onToggle={() => toggleSkillExpanded(skill.id)}
                      onFileSelect={(f) => handleSelectFile(skill, f)}
                    />
                  ))
                )}
              </div>
            )}
          </div>

          {/* Dreambyte skills */}
          <div>
            <div
              className="flex items-center gap-1 px-1 py-1 text-[11px] text-[var(--color-text-muted)] cursor-pointer select-none hover:text-[var(--color-text-primary)]"
              onClick={() => toggleSection('dreambyte')}
            >
              {expandedSections.has('dreambyte') ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              <span>Dreambyte skills</span>
            </div>
            {expandedSections.has('dreambyte') && (
              <div className="ml-2">
                {DREAMBYTE_SKILLS.map((skill) => (
                  <SkillTreeItem
                    key={skill.id}
                    skill={skill}
                    selectedFile={selectedSkill?.id === skill.id ? selectedFile : null}
                    isExpanded={expandedSkills.has(skill.id)}
                    onSelect={() => handleSelectSkill(skill)}
                    onToggle={() => toggleSkillExpanded(skill.id)}
                    onFileSelect={(f) => handleSelectFile(skill, f)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* File content */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {selectedFile && selectedSkill ? (
          <div>
            <div className="flex items-center justify-between mb-6">
              <span className="text-[13px] font-mono text-[var(--color-text-secondary)]">{selectedFile}</span>
              {selectedSkill.trigger && (
                <span className="text-[10px] text-[var(--color-text-muted)] bg-white/5 border border-[var(--color-border)] rounded px-2 py-1 uppercase tracking-tight font-bold">
                  Trigger: {selectedSkill.trigger}
                </span>
              )}
            </div>

            {loadingFile ? (
              <div className="text-[13px] text-[var(--color-text-muted)] py-8 text-center">Loading...</div>
            ) : fileContent ? (
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-6">
                <pre className="text-[13px] text-[var(--color-text-secondary)] leading-relaxed whitespace-pre-wrap font-[inherit] overflow-x-auto">
                  {fileContent}
                </pre>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <Sparkles size={32} className="text-[var(--color-text-muted)] opacity-20 mb-4" />
            <p className="text-[13px] text-[var(--color-text-muted)]">Select a skill or file to view its contents</p>
          </div>
        )}
      </div>
    </>
  )
}

function SkillTreeItem({
  skill,
  selectedFile,
  isExpanded,
  onSelect,
  onToggle,
  onFileSelect,
}: {
  skill: SkillDef
  selectedFile: string | null
  isExpanded: boolean
  onSelect: () => void
  onToggle: () => void
  onFileSelect: (file: string) => void
}) {
  return (
    <div>
      <div
        className={`flex items-center gap-1 px-2 py-1 rounded-md cursor-pointer transition-colors text-[12px] ${
          selectedFile !== null
            ? 'text-[var(--color-text-primary)]'
            : 'text-[var(--color-text-secondary)] hover:bg-white/5'
        }`}
      >
        <span
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
          className="shrink-0 text-[var(--color-text-muted)]"
        >
          {isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </span>
        <span className="truncate" onClick={onSelect}>
          {skill.name}
        </span>
      </div>
      {isExpanded && (
        <div className="ml-5 space-y-0.5 mt-0.5">
          {skill.files.map((f) => (
            <div
              key={f}
              className={`flex items-center gap-1.5 px-2 py-0.5 text-[11px] cursor-pointer rounded transition-colors ${
                selectedFile === f
                  ? 'bg-white/8 text-[var(--color-text-primary)]'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] hover:bg-white/5'
              }`}
              onClick={() => onFileSelect(f)}
            >
              <FileIcon size={10} className="shrink-0" />
              <span className="truncate">{f}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function AgentsSection() {
  return (
    <div>
      <h2 className="text-lg font-semibold text-[var(--color-text-primary)] mb-1">Agents</h2>
      <p className="text-[13px] text-[var(--color-text-muted)] mb-6">
        Configure and manage AI agents, their tools, and permissions.
      </p>
      <AgentsSettingsTab />
    </div>
  )
}

export default function CustomizeView({ onClose }: { onClose: () => void }) {
  const [activeSection, setActiveSection] = useState<Section>('apps')

  return (
    <div className="flex-1 flex min-h-0">
      {/* Left sidebar */}
      <div className="w-[200px] shrink-0 border-r border-[var(--color-border)] bg-[var(--color-input-bg)] overflow-y-auto">
        <div className="p-3">
          <div className="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)] px-2 mb-2">Customize</div>
          <div className="space-y-0.5">
            {SECTIONS.map((section) => {
              const Icon = section.icon
              const isActive = activeSection === section.id
              return (
                <div
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors ${
                    isActive
                      ? 'bg-white/8 text-[var(--color-text-primary)]'
                      : 'text-[var(--color-text-secondary)] hover:bg-white/5 hover:text-[var(--color-text-primary)]'
                  }`}
                >
                  <Icon
                    size={14}
                    className={isActive ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)]'}
                  />
                  <span className="text-[12px] font-medium truncate">{section.label}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Main content */}
      {activeSection === 'skills' ? (
        <div className="flex-1 flex min-h-0 bg-[var(--color-input-bg)]">
          <SkillsSection />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto bg-[var(--color-input-bg)]">
          <div className="max-w-[640px] mx-auto px-8 py-8">
            {activeSection === 'apps' && <AppsSection />}
            {activeSection === 'models' && <ModelsSection />}
            {activeSection === 'agents' && <AgentsSection />}
          </div>
        </div>
      )}
    </div>
  )
}
