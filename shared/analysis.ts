export const ANALYSIS_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const
export const ANALYSIS_CATEGORIES = ['performance', 'reliability', 'security', 'maintainability'] as const

export type AnalysisSeverity = (typeof ANALYSIS_SEVERITIES)[number]
export type AnalysisCategory = (typeof ANALYSIS_CATEGORIES)[number]

export interface AnalysisFinding {
  title: string
  severity: AnalysisSeverity
  category: AnalysisCategory
  explanation: string
  impact: string
  evidence: string
  suggestedFix: string
  line: number | null
}

export interface AnalysisResponse {
  summary: string
  findings: AnalysisFinding[]
}

export interface AnalyzeRequest {
  sourceCode: string
  language?: string
  projectContext?: string
}
