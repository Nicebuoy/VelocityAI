import 'dotenv/config'
import express, { type ErrorRequestHandler } from 'express'
import { analyzeSource, generateFix, InvalidAnalysisOutputError, InvalidFixOutputError } from './analyze.js'
import { ANALYSIS_CATEGORIES, ANALYSIS_SEVERITIES, type AnalysisFinding, type AnalyzeRequest } from '../shared/analysis.js'
import type { GenerateFixRequest } from '../shared/fix.js'

const app = express()
const port = Number(process.env.PORT ?? 3001)
const MAX_CODE_LENGTH = 40_000
const MAX_CONTEXT_LENGTH = 3_000

app.disable('x-powered-by')
app.use(express.json({ limit: '200kb' }))

const desktopOrigins = new Set(['http://127.0.0.1:1420', 'http://tauri.localhost', 'https://tauri.localhost'])
app.use((request, response, next) => {
  const origin = request.headers.origin
  if (origin && desktopOrigins.has(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader('Vary', 'Origin')
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (request.method === 'OPTIONS') return response.sendStatus(204)
  }
  next()
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateRequest(body: unknown): { ok: true; value: Required<Pick<AnalyzeRequest, 'sourceCode' | 'language'>> & Pick<AnalyzeRequest, 'projectContext'> } | { ok: false; message: string } {
  if (!isRecord(body)) return { ok: false, message: 'Send a JSON object with sourceCode.' }
  if (typeof body.sourceCode !== 'string' || !body.sourceCode.trim()) {
    return { ok: false, message: 'sourceCode must be a non-empty string.' }
  }
  if (body.sourceCode.length > MAX_CODE_LENGTH) {
    return { ok: false, message: `sourceCode must be ${MAX_CODE_LENGTH.toLocaleString()} characters or fewer.` }
  }
  if (body.language !== undefined && (typeof body.language !== 'string' || body.language.trim().length === 0 || body.language.length > 80)) {
    return { ok: false, message: 'language must be a non-empty string of at most 80 characters.' }
  }
  if (body.projectContext !== undefined && (typeof body.projectContext !== 'string' || body.projectContext.length > MAX_CONTEXT_LENGTH)) {
    return { ok: false, message: `projectContext must be a string of at most ${MAX_CONTEXT_LENGTH.toLocaleString()} characters.` }
  }

  return {
    ok: true,
    value: {
      sourceCode: body.sourceCode,
      language: typeof body.language === 'string' ? body.language.trim() : 'Unknown',
      ...(typeof body.projectContext === 'string' && body.projectContext.trim()
        ? { projectContext: body.projectContext.trim() }
        : {}),
    },
  }
}

function errorResponse(response: express.Response, status: number, code: string, message: string) {
  return response.status(status).json({ error: { code, message } })
}

function validateFixRequest(body: unknown): { ok: true; value: GenerateFixRequest } | { ok: false; message: string } {
  if (!isRecord(body)) return { ok: false, message: 'Send a JSON object with sourceCode, affectedScript, and finding.' }
  if (typeof body.sourceCode !== 'string' || !body.sourceCode.trim() || body.sourceCode.length > MAX_CODE_LENGTH) {
    return { ok: false, message: `sourceCode must be a non-empty string of ${MAX_CODE_LENGTH.toLocaleString()} characters or fewer.` }
  }
  if (typeof body.language !== 'string' || !body.language.trim() || body.language.length > 80) {
    return { ok: false, message: 'language must be a non-empty string of at most 80 characters.' }
  }
  if (typeof body.affectedScript !== 'string' || !body.affectedScript.trim() || body.affectedScript.length > 240) {
    return { ok: false, message: 'affectedScript must be a non-empty string of at most 240 characters.' }
  }
  if (!isRecord(body.finding)) return { ok: false, message: 'finding must contain structured analysis details.' }

  const finding = body.finding
  const findingKeys = ['title', 'severity', 'category', 'explanation', 'impact', 'evidence', 'suggestedFix', 'line']
  if (
    Object.keys(finding).length !== findingKeys.length
    || !findingKeys.every((key) => Object.hasOwn(finding, key))
    || typeof finding.title !== 'string' || !finding.title.trim() || finding.title.length > 180
    || typeof finding.severity !== 'string' || !ANALYSIS_SEVERITIES.includes(finding.severity as AnalysisFinding['severity'])
    || typeof finding.category !== 'string' || !ANALYSIS_CATEGORIES.includes(finding.category as AnalysisFinding['category'])
    || typeof finding.explanation !== 'string' || !finding.explanation.trim() || finding.explanation.length > 1800
    || typeof finding.impact !== 'string' || !finding.impact.trim() || finding.impact.length > 1200
    || typeof finding.evidence !== 'string' || !finding.evidence.trim() || finding.evidence.length > 1200
    || typeof finding.suggestedFix !== 'string' || !finding.suggestedFix.trim() || finding.suggestedFix.length > 1800
    || !(finding.line === null || (typeof finding.line === 'number' && Number.isSafeInteger(finding.line) && finding.line >= 1 && finding.line <= body.sourceCode.split(/\r?\n/).length))
  ) {
    return { ok: false, message: 'finding contains invalid or incomplete analysis details.' }
  }

  return {
    ok: true,
    value: {
      sourceCode: body.sourceCode,
      language: body.language.trim(),
      affectedScript: body.affectedScript.trim(),
      finding: finding as unknown as AnalysisFinding,
    },
  }
}

app.get('/api/health', (_request, response) => response.json({ status: 'ok' }))

app.post('/api/analyze', async (request, response) => {
  const validation = validateRequest(request.body)
  if (!validation.ok) return errorResponse(response, 400, 'INVALID_REQUEST', validation.message)
  if (!process.env.GEMINI_API_KEY?.trim()) {
    return errorResponse(response, 503, 'AI_NOT_CONFIGURED', 'AI analysis is not configured on the server yet.')
  }

  try {
    const result = await analyzeSource(validation.value)
    return response.json(result)
  } catch (error) {
    if (error instanceof InvalidAnalysisOutputError) {
      return errorResponse(response, 502, 'INVALID_AI_RESPONSE', 'The AI returned an invalid analysis. Please try again.')
    }

    const upstreamStatus = isRecord(error) && typeof error.status === 'number' ? error.status : null
    if (upstreamStatus === 429) {
      return errorResponse(response, 429, 'AI_RATE_LIMITED', 'The AI service is busy. Please wait a moment and try again.')
    }
    if (upstreamStatus === 401 || upstreamStatus === 403) {
      return errorResponse(response, 502, 'AI_AUTH_ERROR', 'The AI provider rejected the server credentials. Check the server configuration.')
    }

    console.error('Gemini analysis request failed.', upstreamStatus ?? 'unknown status')
    return errorResponse(response, 502, 'AI_UNAVAILABLE', 'AI analysis is temporarily unavailable. Please try again shortly.')
  }
})

app.post('/api/fix', async (request, response) => {
  const validation = validateFixRequest(request.body)
  if (!validation.ok) return errorResponse(response, 400, 'INVALID_REQUEST', validation.message)
  if (!process.env.GEMINI_API_KEY?.trim()) {
    return errorResponse(response, 503, 'AI_NOT_CONFIGURED', 'AI fix generation is not configured on the server yet.')
  }

  try {
    return response.json(await generateFix(validation.value))
  } catch (error) {
    if (error instanceof InvalidFixOutputError) {
      return errorResponse(response, 502, 'INVALID_AI_RESPONSE', 'The AI returned an invalid fix. Please try again.')
    }
    const upstreamStatus = isRecord(error) && typeof error.status === 'number' ? error.status : null
    if (upstreamStatus === 429) {
      return errorResponse(response, 429, 'AI_RATE_LIMITED', 'The AI service is busy. Please wait a moment and try again.')
    }
    if (upstreamStatus === 401 || upstreamStatus === 403) {
      return errorResponse(response, 502, 'AI_AUTH_ERROR', 'The AI provider rejected the server credentials. Check the server configuration.')
    }
    console.error('Gemini fix request failed.', upstreamStatus ?? 'unknown status')
    return errorResponse(response, 502, 'AI_UNAVAILABLE', 'AI fix generation is temporarily unavailable. Please try again shortly.')
  }
})

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  void _next
  if (isRecord(error) && error.type === 'entity.too.large') {
    return errorResponse(response, 413, 'REQUEST_TOO_LARGE', 'The request is too large to analyze.')
  }
  if (error instanceof SyntaxError) {
    return errorResponse(response, 400, 'INVALID_JSON', 'Request body must be valid JSON.')
  }

  console.error('Unhandled API request error.')
  return errorResponse(response, 500, 'INTERNAL_ERROR', 'The server could not process this request.')
}

app.use(errorHandler)

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be an integer between 1 and 65535.')
}

app.listen(port, '127.0.0.1', () => {
  console.log(`Velocity API listening on http://127.0.0.1:${port}`)
})
