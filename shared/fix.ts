import type { AnalysisFinding } from './analysis.js'

export interface GenerateFixRequest {
  sourceCode: string
  language: string
  affectedScript: string
  finding: AnalysisFinding
}

export interface GeneratedFix {
  explanation: string
  replacementCode: string
  affectedScript: string
}
