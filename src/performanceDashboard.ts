import type { AnalysisFinding, AnalysisSeverity } from '../shared/analysis'

export interface PerformanceCategorySummary {
  id: string
  title: string
  description: string
  findings: AnalysisFinding[]
  highestSeverity: AnalysisSeverity | null
}

const CATEGORY_DEFINITIONS = [
  {
    id: 'scripts',
    title: 'Script Performance',
    description: 'Per-frame loops, repeated queries, and avoidable work in script paths.',
    pattern: /heartbeat|stepped|per.frame|loop|repeated|query|calculation|scan|travers|descendants/i,
  },
  {
    id: 'networking',
    title: 'Networking / Replication',
    description: 'RemoteEvent or RemoteFunction frequency, payload flow, and replicated state.',
    pattern: /remote|fireserver|onserverevent|replication|network|bandwidth|traffic/i,
  },
  {
    id: 'physics',
    title: 'Physics',
    description: 'Raycasts, collision work, physics queries, and repeated solver-related operations.',
    pattern: /raycast|physics|collision|solver|spatial query|hitscan/i,
  },
  {
    id: 'instances',
    title: 'Rendering / Instances',
    description: 'Instance traversal, object updates, rendering-related work, and visual effects.',
    pattern: /workspace|getdescendants|instance traversal|instance creation|instance churn|instance updates|instance operations|render(?:ing)?|particle|effect|visual|cframe|descendant/i,
  },
  {
    id: 'cleanup',
    title: 'Memory / Cleanup',
    description: 'Connection lifetimes, resource release, repeated allocations, and cleanup paths.',
    pattern: /cleanup|disconnect|respawn|leak|allocat|memory(?: usage| pressure| leak| allocation)?/i,
  },
] as const

const SEVERITY_RANK: Record<AnalysisSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
}

export function summarizePerformanceCategories(findings: AnalysisFinding[]): PerformanceCategorySummary[] {
  return CATEGORY_DEFINITIONS.map((category) => {
    const matchedFindings = findings.filter((finding) => category.pattern.test([
      finding.title,
      finding.explanation,
      finding.evidence,
      finding.suggestedFix,
    ].join(' ')))

    const highestSeverity = matchedFindings.reduce<AnalysisSeverity | null>((highest, finding) => (
      highest === null || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[highest] ? finding.severity : highest
    ), null)

    return {
      id: category.id,
      title: category.title,
      description: category.description,
      findings: matchedFindings,
      highestSeverity,
    }
  })
}
