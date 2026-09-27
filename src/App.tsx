import { useRef, useState, type ReactNode } from 'react'
import { ANALYSIS_CATEGORIES, ANALYSIS_SEVERITIES, type AnalysisFinding, type AnalysisResponse } from '../shared/analysis'
import type { GeneratedFix as ApiGeneratedFix } from '../shared/fix'
import { DEMO_PROJECT_SCRIPTS } from './projectDemo'
import { summarizePerformanceCategories } from './performanceDashboard'
import './App.css'

type ProjectFinding = AnalysisFinding & { scriptName?: string }
type Finding = ProjectFinding & { id: string }
type DisplayAnalysisResponse = Omit<AnalysisResponse, 'findings'> & { findings: ProjectFinding[] }
type GeneratedFix = ApiGeneratedFix & { beforeCode: string; finding: Finding }
type AnalysisState = 'idle' | 'loading' | 'success' | 'error'
type FixState = 'idle' | 'generating' | 'ready' | 'error'
type VerifyState = 'idle' | 'running' | 'clear' | 'detected' | 'error'
type AnalysisMode = 'code' | 'performance'
type ProjectScanProgress = { completed: number; total: number; currentScript: string }
type ProjectScanMeta = { projectName: string; scriptsAnalyzed: number }
const LANGUAGE_OPTIONS = ['Luau', 'JavaScript', 'TypeScript', 'Python', 'Other'] as const
type Language = (typeof LANGUAGE_OPTIONS)[number]
type IconName = 'bolt' | 'chevron' | 'code' | 'check' | 'clock' | 'spark' | 'undo' | 'arrow' | 'shield' | 'refresh' | 'scan'
type WorkflowState = 'complete' | 'active' | 'pending'
type DiffLine = { kind: 'added' | 'removed' | 'context'; text: string }

const FILE_EXTENSIONS: Record<Language, string> = {
  Luau: 'client.lua',
  JavaScript: 'js',
  TypeScript: 'ts',
  Python: 'py',
  Other: 'txt',
}

const PERFORMANCE_DEMO_CODE = `local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")
local localPlayer = Players.LocalPlayer
local targetUpdate = ReplicatedStorage:WaitForChild("TargetUpdate")
local raycastParams = RaycastParams.new()

local function startTracking()
  RunService.Heartbeat:Connect(function()
    local character = localPlayer.Character
    local root = character and character:FindFirstChild("HumanoidRootPart")
    if not root then return end

    local visibleTargets = {}
    for _, targetPlayer in Players:GetPlayers() do
      if targetPlayer ~= localPlayer then
        local targetCharacter = targetPlayer.Character
        local targetRoot = targetCharacter and targetCharacter:FindFirstChild("HumanoidRootPart")
        if targetRoot then
          local direction = targetRoot.Position - root.Position
          local hit = Workspace:Raycast(root.Position, direction, raycastParams)
          if not hit then
            table.insert(visibleTargets, targetPlayer.UserId)
            targetUpdate:FireServer(targetPlayer.UserId, direction.Unit)
          end
        end
      end
    end

    for _, item in Workspace:GetDescendants() do
      if item:IsA("ParticleEmitter") then
        item.Enabled = #visibleTargets > 0
      end
    end
  end)
end

localPlayer.CharacterAdded:Connect(startTracking)
if localPlayer.Character then
  startTracking()
end`

const FIXED_CODE = `local Players = game:GetService("Players")
local CollectionService = game:GetService("CollectionService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")
local localPlayer = Players.LocalPlayer
local targetUpdate = ReplicatedStorage:WaitForChild("TargetUpdate")
local raycastParams = RaycastParams.new()
local scanInterval = 0.2
local elapsed = 0
local heartbeatConnection
local visibleTargets = {}

local function scanTargets()
  local character = localPlayer.Character
  local root = character and character:FindFirstChild("HumanoidRootPart")
  if not root then return end

  table.clear(visibleTargets)
  for _, targetPlayer in Players:GetPlayers() do
    if targetPlayer ~= localPlayer then
      local targetCharacter = targetPlayer.Character
      local targetRoot = targetCharacter and targetCharacter:FindFirstChild("HumanoidRootPart")
      if targetRoot then
        local direction = targetRoot.Position - root.Position
        if direction.Magnitude <= 300 and not Workspace:Raycast(root.Position, direction, raycastParams) then
          table.insert(visibleTargets, { userId = targetPlayer.UserId, direction = direction.Unit })
        end
      end
    end
  end

  local showTargets = #visibleTargets > 0
  for _, item in CollectionService:GetTagged("TargetEffect") do
    if item:IsA("ParticleEmitter") and item.Enabled ~= showTargets then
      item.Enabled = showTargets
    end
  end
  if showTargets then targetUpdate:FireServer(visibleTargets) end
end

local function startTracking()
  if heartbeatConnection then heartbeatConnection:Disconnect() end
  elapsed = 0
  heartbeatConnection = RunService.Heartbeat:Connect(function(deltaTime)
    elapsed += deltaTime
    if elapsed < scanInterval then return end
    elapsed %= scanInterval
    scanTargets()
  end)
end

localPlayer.CharacterAdded:Connect(startTracking)
if localPlayer.Character then
  startTracking()
end`

const DEMO_RESULT: AnalysisResponse = {
  summary: 'This sample repeats target scans, raycasts, workspace traversal, and remote calls inside Heartbeat. It also leaves prior Heartbeat connections active after character respawns.',
  findings: [
    {
      title: 'Target scans and raycasts run on every Heartbeat',
      severity: 'medium',
      category: 'performance',
      explanation: 'The Heartbeat callback enumerates players, resolves character parts, and raycasts once for each target every frame.',
      impact: 'Per-frame work grows with the number of players and repeats even when the target list does not need an immediate refresh.',
      evidence: 'RunService.Heartbeat:Connect on line 10 contains Players:GetPlayers() and Workspace:Raycast() on line 22.',
      suggestedFix: 'Run the scan on a configurable interval, cull distant targets before raycasting, and reuse the target buffer.',
      line: 10,
    },
    {
      title: 'Entire workspace is traversed every frame',
      severity: 'high',
      category: 'performance',
      explanation: 'Workspace:GetDescendants() walks every descendant just to find ParticleEmitters during each Heartbeat callback.',
      impact: 'The traversal cost scales with the place instance tree and repeats even when the set of effects is unchanged.',
      evidence: 'for _, item in Workspace:GetDescendants() do on line 31.',
      suggestedFix: 'Track relevant effects with CollectionService tags or maintain a cached emitter list from instance-added and removed signals.',
      line: 31,
    },
    {
      title: 'RemoteEvent fires once per visible player per frame',
      severity: 'high',
      category: 'performance',
      explanation: 'FireServer is called inside the target loop, so each visible player produces a separate network message on every Heartbeat.',
      impact: 'This creates avoidable client-to-server traffic that increases with both frame frequency and visible target count.',
      evidence: 'targetUpdate:FireServer(targetPlayer.UserId, direction.Unit) on line 25.',
      suggestedFix: 'Collect targets during the scan and send one validated batch at a deliberate update interval.',
      line: 25,
    },
    {
      title: 'Heartbeat connection is never disconnected',
      severity: 'medium',
      category: 'reliability',
      explanation: 'startTracking creates a new Heartbeat connection whenever CharacterAdded fires but never stores or disconnects earlier connections.',
      impact: 'After respawns, multiple callbacks can continue doing the same scans and retain their captured state.',
      evidence: 'RunService.Heartbeat:Connect on line 10 is called from startTracking, which is connected to CharacterAdded on line 39.',
      suggestedFix: 'Store the RBXScriptConnection and disconnect it before starting a new tracker or when the script is cleaned up.',
      line: 10,
    },
    {
      title: 'Particle effects are looked up and rewritten repeatedly',
      severity: 'medium',
      category: 'performance',
      explanation: 'Each scan revisits every Workspace descendant and assigns Enabled to every ParticleEmitter even when the value has not changed.',
      impact: 'Repeated discovery and redundant property writes add work unrelated to changes in target visibility.',
      evidence: 'Workspace:GetDescendants() on line 31 and item.Enabled assignment on line 33.',
      suggestedFix: 'Limit updates to tagged or cached emitters and assign Enabled only when the desired state differs.',
      line: 33,
    },
  ],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAnalysisFinding(value: unknown): value is AnalysisFinding {
  return isRecord(value)
    && typeof value.title === 'string'
    && ANALYSIS_SEVERITIES.includes(value.severity as AnalysisFinding['severity'])
    && ANALYSIS_CATEGORIES.includes(value.category as AnalysisFinding['category'])
    && typeof value.explanation === 'string'
    && typeof value.impact === 'string'
    && typeof value.evidence === 'string'
    && typeof value.suggestedFix === 'string'
    && (value.line === null || (typeof value.line === 'number' && Number.isSafeInteger(value.line) && value.line > 0))
}

function isAnalysisResponse(value: unknown): value is AnalysisResponse {
  return isRecord(value)
    && typeof value.summary === 'string'
    && Array.isArray(value.findings)
    && value.findings.every(isAnalysisFinding)
}

function isGeneratedFix(value: unknown): value is ApiGeneratedFix {
  return isRecord(value)
    && typeof value.explanation === 'string'
    && value.explanation.trim().length > 0
    && typeof value.replacementCode === 'string'
    && value.replacementCode.trim().length > 0
    && typeof value.affectedScript === 'string'
    && value.affectedScript.trim().length > 0
}

function createReplacementDiff(before: string, after: string, kind: 'removed' | 'added'): DiffLine[] {
  const beforeLines = before.split(/\r?\n/)
  const afterLines = after.split(/\r?\n/)
  let prefix = 0
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1
  let suffix = 0
  while (suffix < beforeLines.length - prefix && suffix < afterLines.length - prefix && beforeLines[beforeLines.length - suffix - 1] === afterLines[afterLines.length - suffix - 1]) suffix += 1

  const changedLines = kind === 'removed' ? beforeLines : afterLines
  const end = changedLines.length - suffix
  const contextStart = Math.max(0, prefix - 2)
  const contextEnd = Math.min(changedLines.length, end + 2)
  return [
    ...changedLines.slice(contextStart, prefix).map((text) => ({ kind: 'context' as const, text })),
    ...changedLines.slice(prefix, end).map((text) => ({ kind, text })),
    ...changedLines.slice(end, contextEnd).map((text) => ({ kind: 'context' as const, text })),
  ]
}

function findingStillPresent(original: AnalysisFinding, findings: AnalysisFinding[]): boolean {
  const stopWords = new Set(['about', 'after', 'again', 'also', 'being', 'could', 'inside', 'issue', 'likely', 'might', 'should', 'source', 'still', 'that', 'their', 'there', 'these', 'this', 'through', 'using', 'when', 'where', 'which', 'while', 'with', 'would'])
  const terms = (text: string) => new Set(text.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g)?.filter((word) => !stopWords.has(word)) ?? [])
  const originalTerms = terms(`${original.title} ${original.explanation} ${original.evidence}`)
  return findings.some((candidate) => {
    if (candidate.category !== original.category) return false
    const candidateTerms = terms(`${candidate.title} ${candidate.explanation} ${candidate.evidence}`)
    const overlap = [...originalTerms].filter((word) => candidateTerms.has(word)).length
    return candidate.title.trim().toLowerCase() === original.title.trim().toLowerCase()
      || (originalTerms.size > 0 && overlap / originalTerms.size >= 0.28)
  })
}

function getApiErrorMessage(value: unknown): string {
  if (isRecord(value) && isRecord(value.error) && typeof value.error.message === 'string') {
    return value.error.message
  }
  return 'The analysis service returned an unexpected response.'
}

const BEFORE_LINES: DiffLine[] = [
  { kind: 'removed', text: 'RunService.Heartbeat:Connect(function()' },
  { kind: 'context', text: '  for _, targetPlayer in Players:GetPlayers() do' },
  { kind: 'context', text: '    local hit = Workspace:Raycast(root.Position, direction, raycastParams)' },
  { kind: 'removed', text: '    targetUpdate:FireServer(targetPlayer.UserId, direction.Unit)' },
  { kind: 'removed', text: '  for _, item in Workspace:GetDescendants() do' },
  { kind: 'context', text: '    item.Enabled = #visibleTargets > 0' },
  { kind: 'context', text: 'localPlayer.CharacterAdded:Connect(startTracking)' },
]

const AFTER_LINES: DiffLine[] = [
  { kind: 'added', text: 'local scanInterval = 0.2' },
  { kind: 'added', text: 'local heartbeatConnection' },
  { kind: 'added', text: 'if heartbeatConnection then heartbeatConnection:Disconnect() end' },
  { kind: 'added', text: 'heartbeatConnection = RunService.Heartbeat:Connect(function(deltaTime)' },
  { kind: 'added', text: '  if elapsed < scanInterval then return end' },
  { kind: 'context', text: '  for _, targetPlayer in Players:GetPlayers() do' },
  { kind: 'added', text: '  targetUpdate:FireServer(visibleTargets)' },
  { kind: 'added', text: '  for _, item in CollectionService:GetTagged("TargetEffect") do' },
  { kind: 'added', text: '    if item.Enabled ~= showTargets then item.Enabled = showTargets end' },
]

function createDemoProjectSources(): Record<string, string> {
  return Object.fromEntries(DEMO_PROJECT_SCRIPTS.map((script) => [script.name, script.sourceCode]))
}

const iconShapes: Record<IconName, ReactNode> = {
  bolt: <path d="M13 2 4 13h6l-1 9 9-12h-6l1-8Z" />,
  chevron: <path d="m9 18 6-6-6-6" />,
  code: <><path d="m8 8-4 4 4 4" /><path d="m16 8 4 4-4 4" /><path d="m14 4-4 16" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  spark: <><path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z" /><path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z" /></>,
  undo: <><path d="M3 7v6h6" /><path d="M5 13a8 8 0 1 0 2-5L3 11" /></>,
  arrow: <><path d="M7 17 17 7" /><path d="M7 7h10v10" /></>,
  shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-4" /></>,
  refresh: <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M5.6 9a7 7 0 0 1 11.7-2L20 12M4 12l2.7 5a7 7 0 0 0 11.7-2" /></>,
  scan: <><path d="M4 7V5a1 1 0 0 1 1-1h2" /><path d="M17 4h2a1 1 0 0 1 1 1v2" /><path d="M20 17v2a1 1 0 0 1-1 1h-2" /><path d="M7 20H5a1 1 0 0 1-1-1v-2" /><path d="M4 12h16" /></>,
}

function Icon({ name, size = 16, className = '' }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {iconShapes[name]}
    </svg>
  )
}

function BrandMark() {
  return <div className="brand-mark"><Icon name="bolt" size={19} /></div>
}

function TopBar() {
  return (
    <header className="topbar">
      <div className="brand-lockup" aria-label="Velocity AI">
        <BrandMark />
        <span className="brand-name">velocity<span>.ai</span></span>
      </div>
      <div className="topbar-divider" />
      <div className="workspace-picker" aria-label="Current workspace: Gameplay Systems">
        <span className="workspace-kicker">WORKSPACE</span>
        <span className="workspace-name">Gameplay Systems</span>
        <Icon name="chevron" size={14} className="workspace-chevron" />
      </div>
      <div className="topbar-spacer" />
      <span className="demo-pill"><span className="demo-dot" />LOCAL DEMO</span>
      <div className="user-avatar" aria-label="User profile">M</div>
    </header>
  )
}

function EngineStatus() {
  return (
    <div className="engine-status" aria-label="Velocity demo engine ready">
      <div className="engine-orb" aria-hidden="true">
        <span className="orb-ring orb-ring-one" />
        <span className="orb-ring orb-ring-two" />
        <span className="orb-core"><Icon name="bolt" size={18} /></span>
        <span className="orb-satellite" />
      </div>
      <div className="engine-copy">
        <span className="engine-label">VELOCITY ENGINE</span>
        <strong>Demo mode <span className="engine-ready-dot" /></strong>
        <span className="engine-subtitle">Local analysis preview</span>
      </div>
      <span className="engine-chip">READY</span>
    </div>
  )
}

function WorkflowRail({ applied, restored, verifyState }: { applied: boolean; restored: boolean; verifyState: VerifyState }) {
  const steps: { label: string; state: WorkflowState }[] = [
    { label: 'Analyze', state: 'complete' },
    { label: 'Finding', state: 'complete' },
    { label: 'Fix', state: applied ? 'complete' : 'active' },
    { label: 'Verify', state: verifyState === 'running' ? 'active' : verifyState === 'clear' || verifyState === 'detected' ? 'complete' : 'pending' },
    { label: 'Apply', state: applied ? 'complete' : 'pending' },
    { label: 'Restore', state: restored ? 'complete' : 'pending' },
  ]

  return (
    <section className="workflow" aria-label="Optimization workflow">
      <div className="workflow-heading"><span>WORKFLOW</span><span className="workflow-note">Patch lifecycle</span></div>
      <ol className="workflow-steps">
        {steps.map((step, index) => (
          <li className={`workflow-step is-${step.state}`} key={step.label}>
            <span className="step-marker">{step.state === 'complete' ? <Icon name="check" size={13} /> : String(index + 1).padStart(2, '0')}</span>
            <span className="step-name">{step.label}</span>
            {index < steps.length - 1 && <span className="step-connector" aria-hidden="true" />}
          </li>
        ))}
      </ol>
    </section>
  )
}

function CodeEditor({
  code,
  onChange,
  onAnalyze,
  onProjectScan,
  onLoadDemo,
  isAnalyzing,
  mode,
  onModeChange,
  language,
  onLanguageChange,
  applied,
  projectScriptCount,
  workflowLocked,
}: {
  code: string
  onChange: (value: string) => void
  onAnalyze: () => void
  onProjectScan: () => void
  onLoadDemo: () => void
  isAnalyzing: boolean
  mode: AnalysisMode
  onModeChange: (value: AnalysisMode) => void
  language: Language
  onLanguageChange: (value: Language) => void
  applied: boolean
  projectScriptCount: number
  workflowLocked: boolean
}) {
  const editorRef = useRef<HTMLTextAreaElement | null>(null)
  const gutterRef = useRef<HTMLDivElement | null>(null)
  const lineCount = code.split('\n').length
  const fileName = language === 'Luau'
    ? 'StarterPlayer / StarterPlayerScripts / TargetTracker.client.lua'
    : `${language} / source.${FILE_EXTENSIONS[language]}`

  function syncGutter() {
    if (editorRef.current && gutterRef.current) {
      gutterRef.current.scrollTop = editorRef.current.scrollTop
    }
  }

  return (
    <section className="panel editor-panel" aria-labelledby="source-title">
      <div className="panel-heading editor-heading">
        <div className="panel-title-wrap">
          <span className="panel-icon"><Icon name="code" size={16} /></span>
          <div><h2 id="source-title">Source code</h2><p>Inspect and tune a project snippet</p></div>
        </div>
        <div className="editor-heading-right">
          <div className="analysis-mode-switch" role="group" aria-label="Analysis mode">
            <button type="button" className={mode === 'code' ? 'is-selected' : ''} aria-pressed={mode === 'code'} onClick={() => onModeChange('code')} disabled={isAnalyzing || workflowLocked}>Code</button>
            <button type="button" className={mode === 'performance' ? 'is-selected' : ''} aria-pressed={mode === 'performance'} onClick={() => onModeChange('performance')} disabled={isAnalyzing || workflowLocked}>Performance</button>
          </div>
          <label className="language-pill">
            <select className="language-select" value={language} onChange={(event) => onLanguageChange(event.target.value as Language)} disabled={isAnalyzing || workflowLocked} aria-label="Code language">
              {LANGUAGE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
            <span className="language-caret">v</span>
          </label>
        </div>
      </div>
      <div className="file-strip">
        <span className="file-dot" />
        <span className="file-path">{fileName}</span>
        {applied && <span className="applied-label"><Icon name="check" size={12} /> PATCH APPLIED</span>}
        <span className="file-strip-end">{language}</span>
      </div>
      <div className="editor-surface">
        <div className="line-gutter" ref={gutterRef} aria-hidden="true">
          {Array.from({ length: lineCount }, (_, index) => <span key={index}>{String(index + 1).padStart(2, '0')}</span>)}
        </div>
        <textarea
          ref={editorRef}
          className="code-input"
          aria-label="Source code editor"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          value={code}
          onChange={(event) => onChange(event.target.value)}
          onScroll={syncGutter}
        />
      </div>
      <div className="editor-footer">
        <div className="editor-meta"><span><span className="meta-dot" />{lineCount} lines</span><span>UTF-8</span><span>Modified locally</span></div>
        <div className="editor-actions">
          <button type="button" className="editor-demo-button" onClick={onLoadDemo} disabled={isAnalyzing || workflowLocked} title="Load the built-in Roblox Luau performance example">
            <Icon name="refresh" size={14} />Load demo
          </button>
          <button type="button" className="project-scan-button" onClick={onProjectScan} disabled={isAnalyzing || workflowLocked} title="Scan the built-in Roblox demo project">
            {isAnalyzing ? <span className="button-spinner" /> : <Icon name="scan" size={14} />}
            Project Scan <span className="project-script-count">{projectScriptCount}</span>
          </button>
          <button type="button" className="analyze-button" onClick={onAnalyze} disabled={isAnalyzing || workflowLocked}>
            {isAnalyzing ? <span className="button-spinner" /> : <Icon name="spark" size={16} />}
            {isAnalyzing ? 'Analyzing code...' : 'Analyze Code'}
          </button>
        </div>
      </div>
      <span className="sr-only" aria-live="polite">{isAnalyzing ? 'Sending code for analysis' : 'Analysis control ready'}</span>
    </section>
  )
}

function FindingCard({ finding, onViewFix, onOptimize, isOptimizing, optimizeDisabled }: { finding: Finding; onViewFix: () => void; onOptimize: () => void; isOptimizing: boolean; optimizeDisabled: boolean }) {
  return (
    <article className="finding-card">
      <div className="finding-topline">
        <span className={`severity-badge severity-${finding.severity}`}><span />{finding.severity} priority</span>
        <span className="finding-id">{finding.id}</span>
      </div>
      <div className="finding-category"><span className="category-rule" />{finding.category.toUpperCase()}<span className="category-divider">/</span>{finding.line === null ? 'SOURCE REVIEW' : `LINE ${String(finding.line).padStart(2, '0')}`}</div>
      {finding.scriptName && <div className="finding-source-script"><Icon name="code" size={12} /><code>{finding.scriptName}</code></div>}
      <h3>{finding.title}</h3>
      <p className="finding-summary">{finding.explanation}</p>
      <div className="finding-details">
        <div className="finding-detail-row">
          <span className="detail-icon impact-icon"><Icon name="arrow" size={14} /></span>
          <div><span className="detail-label">POTENTIAL IMPACT</span><p>{finding.impact}</p></div>
        </div>
        <div className="finding-detail-row">
          <span className="detail-icon evidence-icon"><Icon name="code" size={14} /></span>
          <div><span className="detail-label">EVIDENCE</span><p className="evidence-text">{finding.evidence}</p></div>
        </div>
        <div className="finding-detail-row">
          <span className="detail-icon fix-icon"><Icon name="spark" size={14} /></span>
          <div><span className="detail-label">SUGGESTED FIX</span><p>{finding.suggestedFix}</p></div>
        </div>
      </div>
      <div className="finding-footer">
        <span className="line-reference"><span className="line-reference-dot" />{finding.line === null ? 'SOURCE EVIDENCE' : `LINE ${String(finding.line).padStart(2, '0')}`}</span>
        <div className="finding-card-actions">
          {finding.scriptName && <button type="button" className="optimize-action" onClick={onOptimize} disabled={optimizeDisabled}>
            {isOptimizing ? <span className="button-spinner" /> : <Icon name="spark" size={13} />}{isOptimizing ? 'Optimizing' : 'Optimize'}
          </button>}
          <button type="button" className="text-action" onClick={onViewFix}>View fix <Icon name="arrow" size={14} /></button>
        </div>
      </div>
    </article>
  )
}

function ProjectPerformanceDashboard({ visible, result, status, progress, meta }: {
  visible: boolean
  result: DisplayAnalysisResponse | null
  status: AnalysisState
  progress: ProjectScanProgress | null
  meta: ProjectScanMeta | null
}) {
  if (!visible) return null
  const ready = status === 'success' && result !== null && meta !== null
  const categories = ready ? summarizePerformanceCategories(result.findings) : []
  const findingCount = result?.findings.length ?? 0

  return (
    <section className="game-performance-dashboard" aria-labelledby="game-performance-title">
      <div className="game-performance-heading">
        <div className="game-performance-title-wrap">
          <span className="game-performance-mark"><Icon name="bolt" size={16} /></span>
          <div>
            <span className="game-performance-eyebrow">PROJECT PERFORMANCE SCAN</span>
            <h2 id="game-performance-title">Roblox Game Performance</h2>
            <p>{meta ? `${meta.projectName} · ${meta.scriptsAnalyzed} ${meta.scriptsAnalyzed === 1 ? 'script' : 'scripts'} analyzed` : status === 'loading' ? 'Scanning the built-in Roblox Luau project' : 'Project scan did not complete'}</p>
          </div>
        </div>
        {ready && <div className="game-performance-total"><strong>{findingCount}</strong><span>{findingCount === 1 ? 'finding' : 'findings'}</span></div>}
      </div>
      {ready
        ? <div className="game-performance-categories">
            {categories.map((category) => (
              <article className="game-performance-category" key={category.id}>
                <div className="game-performance-category-top">
                  <h3>{category.title}</h3>
                  {category.highestSeverity
                    ? <span className={`dashboard-severity severity-${category.highestSeverity}`}>{category.highestSeverity} priority</span>
                    : <span className="dashboard-no-issues">No detected issues</span>}
                </div>
                <p className="game-performance-description">{category.description}</p>
                <div className="game-performance-category-count">{category.findings.length} {category.findings.length === 1 ? 'finding' : 'findings'}</div>
              </article>
            ))}
          </div>
        : status === 'loading' && progress
          ? <div className="game-performance-scan-state" role="status">{progress.completed} of {progress.total} scripts complete · current: <code>{progress.currentScript}</code></div>
          : <div className="game-performance-scan-state" role={status === 'error' ? 'alert' : undefined}>{status === 'error' ? 'No project summary is available because the scan did not finish.' : 'Project category summary will appear after the scan completes.'}</div>}
      {ready && <div className="game-performance-footnote"><Icon name="shield" size={13} />Findings can appear in multiple relevant categories. Qualitative source analysis only; no runtime benchmarks or performance measurements are available.</div>}
    </section>
  )
}

function FindingsPanel({
  result,
  resultIsDemo,
  resultIsProject,
  status,
  error,
  projectProgress,
  onOptimize,
  optimizingFindingId,
  optimizeDisabled,
  language,
  mode,
  onViewFix,
}: {
  result: DisplayAnalysisResponse | null
  resultIsDemo: boolean
  resultIsProject: boolean
  status: AnalysisState
  error: string | null
  projectProgress: ProjectScanProgress | null
  onOptimize: (finding: Finding) => void
  optimizingFindingId: string | null
  optimizeDisabled: boolean
  language: Language
  mode: AnalysisMode
  onViewFix: () => void
}) {
  const findingCount = result?.findings.length ?? 0
  const languageLabel = language === 'Luau' ? 'ROBLOX / LUAU' : language.toUpperCase()
  const findings = result?.findings.map((finding, index) => ({ ...finding, id: `VEL-${String(index + 1).padStart(3, '0')}` })) ?? []
  const findingGroups = [
    { key: 'code', title: 'Code-level findings', findings: findings.filter((finding) => finding.category !== 'performance') },
    { key: 'performance', title: 'Performance optimizations', findings: findings.filter((finding) => finding.category === 'performance') },
  ].filter((group) => group.findings.length > 0)

  return (
    <section className="panel findings-panel" aria-labelledby="findings-title">
      <div className="panel-heading findings-heading">
        <div className="panel-title-wrap">
          <span className="panel-icon findings-panel-icon"><Icon name="spark" size={16} /></span>
          <div><h2 id="findings-title">Analysis results</h2><p>{mode === 'performance' ? 'Roblox / Luau performance review' : 'Actionable engineering findings'}</p></div>
        </div>
        <span className="finding-count"><span />{findingCount} {findingCount === 1 ? 'finding' : 'findings'}</span>
      </div>
      <div className="results-origin"><Icon name={resultIsDemo ? 'clock' : resultIsProject ? 'scan' : 'spark'} size={13} />{status === 'loading' ? resultIsProject ? 'PROJECT SCAN' : 'ANALYZING' : status === 'error' ? 'REQUEST FAILED' : resultIsDemo ? 'SAMPLE RESULT' : resultIsProject ? 'PROJECT SCAN' : result ? 'GEMINI ANALYSIS' : 'READY TO ANALYZE'}<span>/</span>{languageLabel}<span>/</span>{mode.toUpperCase()}</div>
      {result && <p className="analysis-summary">{result.summary}</p>}
      {status === 'loading' && projectProgress
        ? <div className="project-scan-progress" role="status" aria-live="polite">
            <div className="project-scan-progress-heading"><span><span className="button-spinner" />Scanning project</span><strong>{projectProgress.completed}/{projectProgress.total}</strong></div>
            <progress max={projectProgress.total} value={projectProgress.completed} aria-label="Project scan progress" />
            <code>{projectProgress.currentScript}</code>
          </div>
        : status === 'loading' && <div className="analysis-loading" role="status"><span className="button-spinner" />Analyzing submitted code...</div>}
      {status === 'error' && error && <div className="analysis-error" role="alert"><strong>Analysis could not complete</strong><p>{error}</p><span>Check the API server and retry.</span></div>}
      {findingGroups.map((group) => (
        <section className={`finding-group finding-group-${group.key}`} key={group.key} aria-label={group.title}>
          <div className="finding-group-heading"><h3>{group.title}</h3><span>{group.findings.length}</span></div>
          {group.findings.map((finding) => <FindingCard key={finding.id} finding={finding} onViewFix={onViewFix} onOptimize={() => onOptimize(finding)} isOptimizing={optimizingFindingId === finding.id} optimizeDisabled={optimizeDisabled || (optimizingFindingId !== null && optimizingFindingId !== finding.id)} />)}
        </section>
      ))}
      {result && findingCount === 0 && <div className="empty-analysis">No actionable findings were returned for this snippet.</div>}
      {status === 'idle' && !result && <div className="empty-analysis">Choose a language, add source code, and analyze it to see findings.</div>}
      <div className="findings-footnote"><Icon name="shield" size={13} /> Findings are qualitative; runtime performance was not measured.</div>
    </section>
  )
}

function DiffPane({ title, state, lines, fileLabel = 'TargetTracker.client.lua' }: { title: string; state: 'before' | 'after'; lines: DiffLine[]; fileLabel?: string }) {
  return (
    <div className={`diff-pane diff-${state}`}>
      <div className="diff-pane-heading"><span className="diff-state-dot" />{title}<span className="diff-file-label">{fileLabel}</span></div>
      <div className="diff-code">
        {lines.map((line, index) => (
          <div className={`diff-line diff-${line.kind}`} key={`${line.text}-${index}`}>
            <span className="diff-sign">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}</span>
            <code>{line.text}</code>
          </div>
        ))}
      </div>
    </div>
  )
}

function DiffViewer({ applied, onApply, onRestore, onVerify, showDemoPatch, generatedFix, fixState, fixError, verifyState, verifyMessage }: {
  applied: boolean
  onApply: () => void
  onRestore: () => void
  onVerify: () => void
  showDemoPatch: boolean
  generatedFix: GeneratedFix | null
  fixState: FixState
  fixError: string | null
  verifyState: VerifyState
  verifyMessage: string | null
}) {
  const hasGeneratedFix = generatedFix !== null
  const beforeDiff = generatedFix ? createReplacementDiff(generatedFix.beforeCode, generatedFix.replacementCode, 'removed') : []
  const afterDiff = generatedFix ? createReplacementDiff(generatedFix.beforeCode, generatedFix.replacementCode, 'added') : []
  return (
    <section className="panel diff-panel" aria-labelledby="diff-title">
      <div className="panel-heading diff-heading">
        <div className="panel-title-wrap">
          <span className="panel-icon diff-panel-icon"><Icon name="code" size={16} /></span>
          <div><h2 id="diff-title">Proposed fix</h2><p>{hasGeneratedFix ? `AI-generated replacement · ${generatedFix.affectedScript}` : showDemoPatch ? 'Review the targeted change before applying' : 'A generated diff is not available for this analysis'}</p></div>
        </div>
        {hasGeneratedFix ? <span className="diff-stat">AI GENERATED</span> : showDemoPatch ? <span className="diff-stat"><span>+8</span> <span>-3</span> lines</span> : <span className="diff-stat">NOT GENERATED</span>}
      </div>
      <div className="diff-panes">
        {hasGeneratedFix ? <>
          <DiffPane title="BEFORE · REMOVED" state="before" lines={beforeDiff} fileLabel={generatedFix.affectedScript} />
          <DiffPane title="AFTER · ADDED" state="after" lines={afterDiff} fileLabel={generatedFix.affectedScript} />
        </> : showDemoPatch ? <>
          <DiffPane title="BEFORE" state="before" lines={BEFORE_LINES} />
          <DiffPane title="AFTER" state="after" lines={AFTER_LINES} />
        </> : <div className="fix-not-connected"><span className="verification-icon pending"><Icon name={fixState === 'generating' ? 'refresh' : 'clock'} size={15} /></span><div><strong>{fixState === 'generating' ? 'Generating a targeted fix' : fixState === 'error' ? 'Fix generation could not complete' : 'Choose a project finding to optimize'}</strong><p>{fixState === 'generating' ? 'Gemini is preparing a full replacement for the affected script.' : fixState === 'error' ? fixError : 'Select Optimize on a Project Scan finding to review its proposed code change here.'}</p></div></div>}
      </div>
      {hasGeneratedFix && <>
        <div className="diff-explanation"><span className="explanation-mark"><Icon name="spark" size={13} /></span>{generatedFix.explanation} Proposed source is not executed; runtime impact is not measured.</div>
        {verifyMessage && <div className={`fix-verification-message is-${verifyState}`} role={verifyState === 'error' ? 'alert' : 'status'}>{verifyMessage}</div>}
        <div className="diff-actions">
          <div className="patch-status"><span className={applied ? 'status-check is-applied' : 'status-check'}>{applied ? <Icon name="check" size={12} /> : <Icon name="clock" size={12} />}</span>{applied ? 'Applied to in-memory demo project' : 'Review before applying'}</div>
          <div className="patch-buttons">
            <button type="button" className="restore-button" onClick={onRestore} disabled={!applied || verifyState === 'running'}>
              <Icon name="undo" size={15} />Restore
            </button>
            <button type="button" className="verify-button" onClick={onVerify} disabled={!applied || verifyState === 'running'}>
              {verifyState === 'running' ? <span className="button-spinner" /> : <Icon name="shield" size={14} />}{verifyState === 'running' ? 'Verifying' : 'Verify'}
            </button>
            <button type="button" className="apply-button" onClick={onApply} disabled={applied}>
              <Icon name={applied ? 'check' : 'bolt'} size={15} />{applied ? 'Applied' : 'Apply fix'}
            </button>
          </div>
        </div>
      </>}
      {showDemoPatch && <>
        <div className="diff-explanation"><span className="explanation-mark"><Icon name="spark" size={13} /></span>Throttles target scans, batches remote updates, narrows effect lookup, and disconnects the previous tracker. Runtime impact is not measured.</div>
        <div className="diff-actions">
          <div className="patch-status"><span className={applied ? 'status-check is-applied' : 'status-check'}>{applied ? <Icon name="check" size={12} /> : <Icon name="clock" size={12} />}</span>{applied ? 'Patch applied to editor' : 'Patch preview ready'}</div>
          <div className="patch-buttons">
            <button type="button" className="restore-button" onClick={onRestore} disabled={!applied}>
              <Icon name="undo" size={15} />Restore
            </button>
            <button type="button" className="apply-button" onClick={onApply} disabled={applied}>
              <Icon name={applied ? 'check' : 'bolt'} size={15} />{applied ? 'Applied' : 'Apply fix'}
            </button>
          </div>
        </div>
      </>}
      {!showDemoPatch && !hasGeneratedFix && <div className="diff-actions"><div className="patch-status"><span className="status-check"><Icon name="clock" size={12} /></span>{fixState === 'error' ? 'No patch was applied' : 'Analysis only - no patch applied'}</div></div>}
    </section>
  )
}

function VerificationPanel({ applied, verifyState, verifyMessage }: { applied: boolean; verifyState: VerifyState; verifyMessage: string | null }) {
  return (
    <section className="panel verification-panel" aria-labelledby="verification-title">
      <div className="panel-heading verification-heading">
        <div className="panel-title-wrap">
          <span className="panel-icon verify-panel-icon"><Icon name="shield" size={16} /></span>
          <div><h2 id="verification-title">Verification</h2><p>Checks available for this patch</p></div>
        </div>
        <span className={`not-run-pill verify-pill-${verifyState}`}><span />{verifyState === 'running' ? 'RUNNING' : verifyState === 'clear' ? 'CLEAR' : verifyState === 'detected' ? 'DETECTED' : verifyState === 'error' ? 'ERROR' : 'NOT RUN'}</span>
      </div>
      <div className="verification-list">
        <div className="verification-row"><span className="verification-icon ready"><Icon name="check" size={13} /></span><span>Patch preview</span><strong>READY</strong></div>
        {verifyState !== 'idle' && <div className="verification-row"><span className={`verification-icon ${verifyState === 'clear' ? 'ready' : 'pending'}`}><Icon name={verifyState === 'clear' ? 'check' : verifyState === 'running' ? 'refresh' : 'clock'} size={13} /></span><span>Original finding</span><strong>{verifyState === 'running' ? 'CHECKING' : verifyState === 'clear' ? 'NOT DETECTED' : verifyState === 'detected' ? 'STILL DETECTED' : 'ERROR'}</strong></div>}
        <div className="verification-row"><span className="verification-icon pending"><Icon name="clock" size={13} /></span><span>Project checks</span><strong>NOT CONNECTED</strong></div>
        <div className="verification-row"><span className="verification-icon pending"><Icon name="clock" size={13} /></span><span>Runtime behavior</span><strong>NOT RUN</strong></div>
      </div>
      <div className="verification-note">
        <span className="verification-note-marker" />
        <p>{verifyMessage ?? (applied ? 'The patch is held in demo memory. Run Verify to re-analyze the modified source.' : 'Preview only. This demo does not execute code or run project checks.')}</p>
      </div>
    </section>
  )
}

function App() {
  const [code, setCode] = useState(PERFORMANCE_DEMO_CODE)
  const [language, setLanguage] = useState<Language>('Luau')
  const [mode, setMode] = useState<AnalysisMode>('performance')
  const [applied, setApplied] = useState(false)
  const [restored, setRestored] = useState(false)
  const [result, setResult] = useState<DisplayAnalysisResponse | null>(DEMO_RESULT)
  const [resultIsDemo, setResultIsDemo] = useState(true)
  const [resultIsProject, setResultIsProject] = useState(false)
  const [analysisState, setAnalysisState] = useState<AnalysisState>('idle')
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  const [projectProgress, setProjectProgress] = useState<ProjectScanProgress | null>(null)
  const [projectScanMeta, setProjectScanMeta] = useState<ProjectScanMeta | null>(null)
  const [projectSources, setProjectSources] = useState<Record<string, string>>(createDemoProjectSources)
  const [generatedFix, setGeneratedFix] = useState<GeneratedFix | null>(null)
  const [fixState, setFixState] = useState<FixState>('idle')
  const [fixError, setFixError] = useState<string | null>(null)
  const [verificationState, setVerificationState] = useState<VerifyState>('idle')
  const [verificationMessage, setVerificationMessage] = useState<string | null>(null)
  const [optimizingFindingId, setOptimizingFindingId] = useState<string | null>(null)
  const preApplyCodeRef = useRef(PERFORMANCE_DEMO_CODE)

  function handleLanguageChange(nextLanguage: Language) {
    setLanguage(nextLanguage)
    setResult(null)
    setResultIsDemo(false)
    setResultIsProject(false)
    setProjectScanMeta(null)
    setAnalysisState('idle')
    setAnalysisError(null)
    setApplied(false)
    setRestored(false)
    setGeneratedFix(null)
    setFixState('idle')
    setVerificationState('idle')
    setVerificationMessage(null)
  }

  function handleModeChange(nextMode: AnalysisMode) {
    setMode(nextMode)
    setResult(null)
    setResultIsDemo(false)
    setResultIsProject(false)
    setProjectScanMeta(null)
    setAnalysisState('idle')
    setAnalysisError(null)
    setApplied(false)
    setRestored(false)
    setGeneratedFix(null)
    setFixState('idle')
    setVerificationState('idle')
    setVerificationMessage(null)
  }

  function handleLoadDemo() {
    setCode(PERFORMANCE_DEMO_CODE)
    setLanguage('Luau')
    setMode('performance')
    setResult(DEMO_RESULT)
    setResultIsDemo(true)
    setResultIsProject(false)
    setProjectScanMeta(null)
    setAnalysisState('idle')
    setAnalysisError(null)
    setProjectProgress(null)
    setApplied(false)
    setRestored(false)
    setProjectSources(createDemoProjectSources())
    setGeneratedFix(null)
    setFixState('idle')
    setFixError(null)
    setVerificationState('idle')
    setVerificationMessage(null)
    preApplyCodeRef.current = PERFORMANCE_DEMO_CODE
  }

  async function handleAnalyze() {
    if (applied || optimizingFindingId !== null) return
    setProjectProgress(null)
    setAnalysisState('loading')
    setAnalysisError(null)
    setResult(null)
    setResultIsDemo(false)
    setResultIsProject(false)
    setProjectScanMeta(null)
    setApplied(false)
    setRestored(false)
    setGeneratedFix(null)
    setFixState('idle')
    setFixError(null)
    setVerificationState('idle')
    setVerificationMessage(null)

    try {
      const payload = await requestAnalysis({
        sourceCode: code,
        language,
        projectContext: getProjectContext(language, mode),
      })

      setResult(payload)
      setAnalysisState('success')
    } catch (error) {
      setAnalysisError(error instanceof TypeError
        ? 'Could not reach the API server. Start the app with npm run dev and retry.'
        : error instanceof Error ? error.message : 'Analysis failed. Please try again.')
      setAnalysisState('error')
    }
  }

  async function handleProjectScan() {
    if (applied || optimizingFindingId !== null) return
    setLanguage('Luau')
    setMode('performance')
    setResult(null)
    setResultIsDemo(false)
    setResultIsProject(true)
    setProjectScanMeta(null)
    setAnalysisState('loading')
    setAnalysisError(null)
    setApplied(false)
    setRestored(false)
    const scanSources = createDemoProjectSources()
    setProjectSources(scanSources)
    setGeneratedFix(null)
    setFixState('idle')
    setFixError(null)
    setVerificationState('idle')
    setVerificationMessage(null)
    setProjectProgress({ completed: 0, total: DEMO_PROJECT_SCRIPTS.length, currentScript: DEMO_PROJECT_SCRIPTS[0].name })
    const findings: ProjectFinding[] = []
    const summaries: string[] = []
    let currentScript = ''

    try {
      for (let index = 0; index < DEMO_PROJECT_SCRIPTS.length; index += 1) {
        const script = DEMO_PROJECT_SCRIPTS[index]
        currentScript = script.name
        setProjectProgress({ completed: index, total: DEMO_PROJECT_SCRIPTS.length, currentScript: script.name })
        const response = await requestAnalysis({
          sourceCode: scanSources[script.name] ?? script.sourceCode,
          language: 'Luau',
          projectContext: `Roblox Luau game project. Script path: ${script.name}. ${getProjectContext('Luau', 'performance')} Give only findings supported by this script. Do not claim measured improvements.`,
        })
        summaries.push(`${script.name}: ${response.summary}`)
        findings.push(...response.findings.map((finding) => ({ ...finding, scriptName: script.name })))
        setProjectProgress({ completed: index + 1, total: DEMO_PROJECT_SCRIPTS.length, currentScript: script.name })
      }

      setResult({
        summary: `Scanned ${DEMO_PROJECT_SCRIPTS.length} Luau scripts. ${summaries.join(' ')}`,
        findings,
      })
      setProjectScanMeta({ projectName: 'Gameplay Systems', scriptsAnalyzed: DEMO_PROJECT_SCRIPTS.length })
      setProjectProgress(null)
      setAnalysisState('success')
    } catch (error) {
      const message = error instanceof TypeError
        ? 'Could not reach the API server. Start the app with npm run dev and retry.'
        : error instanceof Error ? error.message : 'Project scan failed. Please try again.'
      setAnalysisError(currentScript ? `${currentScript}: ${message}` : message)
      setProjectScanMeta(null)
      setProjectProgress(null)
      setAnalysisState('error')
    }
  }

  async function requestAnalysis(request: { sourceCode: string; language: string; projectContext: string }): Promise<AnalysisResponse> {
    const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      })

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new Error(response.ok
        ? 'The analysis server returned invalid JSON.'
        : 'Could not reach the API server. Start the app with npm run dev and retry.')
    }

    if (!response.ok) throw new Error(getApiErrorMessage(payload))
    if (!isAnalysisResponse(payload)) throw new Error('The analysis server returned malformed analysis data.')
    return payload
  }

  async function handleOptimize(finding: Finding) {
    if (!finding.scriptName || applied) return
    const sourceCode = projectSources[finding.scriptName]
    if (typeof sourceCode !== 'string') {
      setFixState('error')
      setFixError('The affected script is not present in the in-memory demo project.')
      return
    }

    setOptimizingFindingId(finding.id)
    setFixState('generating')
    setFixError(null)
    setGeneratedFix(null)
    setVerificationState('idle')
    setVerificationMessage(null)

    try {
      const response = await fetch('/api/fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceCode,
          language: 'Luau',
          affectedScript: finding.scriptName,
          finding: {
            title: finding.title,
            severity: finding.severity,
            category: finding.category,
            explanation: finding.explanation,
            impact: finding.impact,
            evidence: finding.evidence,
            suggestedFix: finding.suggestedFix,
            line: finding.line,
          },
        }),
      })

      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        throw new Error(response.ok ? 'The fix service returned invalid JSON.' : 'Could not reach the API server. Start the app with npm run dev and retry.')
      }
      if (!response.ok) throw new Error(getApiErrorMessage(payload))
      if (!isGeneratedFix(payload) || payload.affectedScript !== finding.scriptName) {
        throw new Error('The fix service returned malformed fix data.')
      }

      setGeneratedFix({ ...payload, beforeCode: sourceCode, finding })
      setFixState('ready')
      setTimeout(() => document.getElementById('diff-title')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0)
    } catch (error) {
      setFixError(error instanceof TypeError
        ? 'Could not reach the API server. Start the app with npm run dev and retry.'
        : error instanceof Error ? error.message : 'Fix generation failed. Please try again.')
      setFixState('error')
    } finally {
      setOptimizingFindingId(null)
    }
  }

  async function handleVerify() {
    if (!generatedFix || !applied || verificationState === 'running') return
    setVerificationState('running')
    setVerificationMessage('Re-analyzing the modified demo script. This checks source findings only; it does not run Roblox code.')

    try {
      const response = await requestAnalysis({
        sourceCode: projectSources[generatedFix.affectedScript] ?? generatedFix.replacementCode,
        language: 'Luau',
        projectContext: `Roblox Luau performance review. Script path: ${generatedFix.affectedScript}. Re-analyze this modified source and check whether the following original finding remains: ${generatedFix.finding.title}. ${generatedFix.finding.explanation} Do not claim measured improvements.`,
      })
      const remains = findingStillPresent(generatedFix.finding, response.findings)
      setVerificationState(remains ? 'detected' : 'clear')
      setVerificationMessage(remains
        ? `The original finding may still be present: ${generatedFix.finding.title}. Gemini returned a related finding in the modified source.`
        : `The original finding was not detected in the re-analysis of ${generatedFix.affectedScript}. This is a source review, not runtime verification.`)
    } catch (error) {
      setVerificationState('error')
      setVerificationMessage(error instanceof TypeError
        ? 'Could not reach the API server to verify the modified script.'
        : error instanceof Error ? error.message : 'Verification failed. Please try again.')
    }
  }

  function getProjectContext(sourceLanguage: string, analysisMode: AnalysisMode) {
    return [
      sourceLanguage === 'Luau' ? 'Roblox Luau game code.' : `${sourceLanguage} source code.`,
      `Velocity AI analysis mode: ${analysisMode === 'performance' ? 'Performance optimization' : 'Code review'}.`,
      analysisMode === 'performance'
        ? 'Focus on actionable performance bottlenecks and resource cleanup inferable from source. For Roblox Luau, inspect RunService loops, raycasts, instance and table work, remote traffic, physics, and rendering. Do not claim measured improvements.'
        : 'Review for concrete reliability, security, maintainability, and performance issues supported by source evidence.',
    ].join(' ')
  }

  function handleApply() {
    if (generatedFix) {
      if (applied || verificationState === 'running') return
      setProjectSources((sources) => ({ ...sources, [generatedFix.affectedScript]: generatedFix.replacementCode }))
      setApplied(true)
      setRestored(false)
      setVerificationState('idle')
      setVerificationMessage(null)
      return
    }
    preApplyCodeRef.current = code
    setCode(FIXED_CODE)
    setApplied(true)
    setRestored(false)
  }

  function handleRestore() {
    if (generatedFix) {
      if (!applied || verificationState === 'running') return
      const restoredScript = generatedFix.affectedScript
      setProjectSources((sources) => ({ ...sources, [generatedFix.affectedScript]: generatedFix.beforeCode }))
      setApplied(false)
      setRestored(true)
      setVerificationState('idle')
      setGeneratedFix(null)
      setFixState('idle')
      setFixError(null)
      setVerificationMessage(`Restored ${restoredScript} to its original in-memory demo source.`)
      return
    }
    setCode(preApplyCodeRef.current)
    setApplied(false)
    setRestored(true)
  }

  function handleViewFix() {
    document.getElementById('diff-title')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  return (
    <div className="app-frame">
      <TopBar />
      <main className="workspace-main">
        <div className="page-intro">
          <div className="page-title-group">
            <div className="eyebrow"><span className="eyebrow-line" />ENGINEERING OPTIMIZATION</div>
            <h1>Optimization workspace</h1>
            <p>Find the friction in your code. Review a focused fix.</p>
          </div>
          <EngineStatus />
        </div>

        <ProjectPerformanceDashboard visible={resultIsProject} result={result} status={analysisState} progress={projectProgress} meta={projectScanMeta} />

        <WorkflowRail applied={applied} restored={restored} verifyState={verificationState} />

        <div className="workspace-grid">
          <CodeEditor code={code} onChange={setCode} onAnalyze={handleAnalyze} onProjectScan={handleProjectScan} onLoadDemo={handleLoadDemo} isAnalyzing={analysisState === 'loading'} workflowLocked={optimizingFindingId !== null || (Boolean(generatedFix) && applied)} mode={mode} onModeChange={handleModeChange} language={language} onLanguageChange={handleLanguageChange} applied={applied} projectScriptCount={DEMO_PROJECT_SCRIPTS.length} />
          <FindingsPanel result={result} resultIsDemo={resultIsDemo} resultIsProject={resultIsProject} status={analysisState} error={analysisError} projectProgress={projectProgress} language={language} mode={mode} onViewFix={handleViewFix} onOptimize={handleOptimize} optimizingFindingId={optimizingFindingId} optimizeDisabled={applied} />
          <DiffViewer applied={applied} onApply={handleApply} onRestore={handleRestore} onVerify={handleVerify} showDemoPatch={resultIsDemo && !generatedFix} generatedFix={generatedFix} fixState={fixState} fixError={fixError} verifyState={verificationState} verifyMessage={verificationMessage} />
          <VerificationPanel applied={applied} verifyState={verificationState} verifyMessage={verificationMessage} />
        </div>
        <footer className="workspace-footer">
          <span><BrandMark />VELOCITY AI <span className="footer-separator">/</span> ENGINEERING COMPANION</span>
          <span className="footer-right"><span className="footer-status-dot" />DEMO WORKSPACE <span className="footer-separator">/</span> ALL CHANGES LOCAL</span>
        </footer>
      </main>
    </div>
  )
}

export default App
