import { useRef, useState, type PointerEvent } from 'react'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'
import type { AnalysisFinding, AnalysisResponse } from '../shared/analysis'
import type { GeneratedFix } from '../shared/fix'
import './MiniApp.css'

const windowHandle = getCurrentWindow()
const LARGER_WINDOW = new LogicalSize(392, 640)
const ORB_WINDOW = new LogicalSize(76, 76)

function errorMessage(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const error = (payload as { error?: { message?: unknown } }).error
    if (typeof error?.message === 'string') return error.message
  }
  return 'The Velocity API returned an unexpected response.'
}

export default function MiniApp() {
  const [expanded, setExpanded] = useState(false)
  const [code, setCode] = useState('')
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null)
  const [selected, setSelected] = useState<AnalysisFinding | null>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [fix, setFix] = useState<GeneratedFix | null>(null)
  const [snipping, setSnipping] = useState(false)
  const [capture, setCapture] = useState('')
  const [selection, setSelection] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const captureVideo = useRef<HTMLVideoElement>(null)
  const captureStream = useRef<MediaStream | null>(null)

  async function resizeWindow(open: boolean) {
    await windowHandle.setSize(open ? LARGER_WINDOW : ORB_WINDOW)
    setExpanded(open)
  }

  async function analyze() {
    if (!code.trim() || busy) return
    setBusy(true)
    setStatus('Analyzing code…')
    setAnalysis(null)
    setSelected(null)
    setFix(null)
    try {
      const response = await fetch('http://127.0.0.1:3001/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceCode: code, language: 'Luau', projectContext: 'Roblox Luau code. Review for actionable performance, reliability, security, and maintainability issues supported by source.' }),
      })
      const payload: unknown = await response.json()
      if (!response.ok) throw new Error(errorMessage(payload))
      if (!payload || typeof payload !== 'object' || !('findings' in payload) || !Array.isArray(payload.findings)) throw new Error('The analysis response was incomplete.')
      setAnalysis(payload as AnalysisResponse)
      setStatus('')
    } catch (error) {
      setStatus(error instanceof TypeError ? 'Could not reach Velocity API. Start the companion with npm run mini:dev.' : error instanceof Error ? error.message : 'Analysis failed. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function optimize() {
    if (!selected || busy) return
    setBusy(true)
    setStatus('Generating a suggested replacement…')
    setFix(null)
    try {
      const response = await fetch('http://127.0.0.1:3001/api/fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceCode: code, language: 'Luau', affectedScript: 'Pasted code', finding: selected }),
      })
      const payload: unknown = await response.json()
      if (!response.ok) throw new Error(errorMessage(payload))
      if (!payload || typeof payload !== 'object' || !('replacementCode' in payload) || typeof payload.replacementCode !== 'string') throw new Error('The fix response was incomplete.')
      setFix(payload as GeneratedFix)
      setStatus('Suggested code only. It has not been executed or applied.')
    } catch (error) {
      setStatus(error instanceof TypeError ? 'Could not reach Velocity API. Start the companion with npm run mini:dev.' : error instanceof Error ? error.message : 'Optimization failed. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function startSnip() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false })
      captureStream.current = stream
      setSnipping(true)
      setSelection(null)
      requestAnimationFrame(() => {
        if (captureVideo.current) {
          captureVideo.current.srcObject = stream
          void captureVideo.current.play()
        }
      })
    } catch {
      setStatus('Screen capture was cancelled or is unavailable. You can paste code below instead.')
    }
  }

  function finishSnip() {
    const video = captureVideo.current
    if (video && selection && selection.width > 12 && selection.height > 12) {
      const bounds = video.getBoundingClientRect()
      const scaleX = video.videoWidth / bounds.width
      const scaleY = video.videoHeight / bounds.height
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(selection.width * scaleX)
      canvas.height = Math.round(selection.height * scaleY)
      const context = canvas.getContext('2d')
      if (context) {
        context.drawImage(video, Math.round(selection.x * scaleX), Math.round(selection.y * scaleY), canvas.width, canvas.height, 0, 0, canvas.width, canvas.height)
        setCapture(canvas.toDataURL('image/png'))
        setStatus('Capture saved locally. Paste any visible code to analyze it.')
      }
    } else {
      setStatus('Select a rectangle to capture, or paste code below.')
    }
    captureStream.current?.getTracks().forEach((track) => track.stop())
    captureStream.current = null
    setSnipping(false)
  }

  function stopSnip() {
    captureStream.current?.getTracks().forEach((track) => track.stop())
    captureStream.current = null
    setSnipping(false)
    setSelection(null)
  }

  function selectStart(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
    dragStart.current = point
    setSelection({ ...point, width: 0, height: 0 })
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function selectMove(event: PointerEvent<HTMLDivElement>) {
    if (!dragStart.current) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - bounds.left
    const y = event.clientY - bounds.top
    setSelection({ x: Math.min(x, dragStart.current.x), y: Math.min(y, dragStart.current.y), width: Math.abs(x - dragStart.current.x), height: Math.abs(y - dragStart.current.y) })
  }

  return (
    <main className="mini-shell">
      {!expanded ? (
        <button className="mini-orb" data-tauri-drag-region aria-label="Open Velocity Mini" onClick={() => void resizeWindow(true)}><span>V</span></button>
      ) : (
        <section className="mini-panel">
          <header className="mini-header" data-tauri-drag-region>
            <button className="mini-brand" onClick={() => void resizeWindow(false)} aria-label="Minimize to orb" data-tauri-drag-region><span className="mini-mark">V</span><span>VELOCITY <small>MINI</small></span></button>
            <button className="mini-close" aria-label="Minimize to orb" onClick={() => void resizeWindow(false)}>×</button>
          </header>
          <div className="mini-content">
            <div className="mini-intro"><span>LOCAL CODE COMPANION</span><h1>Quick review</h1><p>Snip a code region or paste Luau to inspect it.</p></div>
            <div className="mini-actions"><button onClick={() => void startSnip()} disabled={snipping}>▧ &nbsp;Snip Code</button><span>SCREEN CAPTURE IS MANUAL</span></div>
            {capture && <div className="mini-capture"><img src={capture} alt="Captured screen region" /><button onClick={() => setCapture('')}>Remove capture</button></div>}
            <label className="mini-label" htmlFor="mini-code">PASTE CODE <span>Luau</span></label>
            <textarea id="mini-code" value={code} onChange={(event) => setCode(event.target.value)} placeholder={'-- Paste a Roblox script here\nlocal Players = game:GetService("Players")'} spellCheck={false} />
            <button className="mini-primary" onClick={() => void analyze()} disabled={busy || !code.trim()}>{busy ? 'Working…' : 'Analyze code'}</button>
            {status && <p className="mini-status" role="status">{status}</p>}
            {analysis && <div className="mini-results"><div className="mini-summary">{analysis.summary}</div><h2>Findings <span>{analysis.findings.length}</span></h2>{analysis.findings.length === 0 ? <p className="mini-empty">No actionable findings returned.</p> : analysis.findings.map((finding, index) => <button key={`${finding.title}-${index}`} className={`mini-finding ${selected === finding ? 'selected' : ''}`} onClick={() => { setSelected(finding); setFix(null) }}><span className={`mini-severity ${finding.severity}`}>{finding.severity}</span><strong>{finding.title}</strong><small>{finding.category}{finding.line ? ` · line ${finding.line}` : ''}</small></button>)}
              {selected && <><button className="mini-optimize" onClick={() => void optimize()} disabled={busy}>Optimize selected finding</button>{fix && <div className="mini-fix"><p>{fix.explanation}</p><pre>{fix.replacementCode}</pre></div>}</>}
            </div>}
          </div>
        </section>
      )}
      {snipping && <div className="mini-snip"><video ref={captureVideo} muted playsInline /><div className="mini-snip-cover" onPointerDown={selectStart} onPointerMove={selectMove} onPointerUp={() => { dragStart.current = null }}><div className="mini-snip-tip">Drag to select a code region</div>{selection && <div className="mini-selection" style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }} />}</div><div className="mini-snip-buttons"><button onClick={stopSnip}>Cancel</button><button onClick={finishSnip}>Use capture</button></div></div>}
    </main>
  )
}
