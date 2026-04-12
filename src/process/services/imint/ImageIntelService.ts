import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
import { llmService } from '../llm/LlmService'
import { getDatabase } from '../database'
import { intelStorageService } from '../intel/IntelStorageService'
import { generateId, timestamp } from '@common/utils/id'
import type { IntelReport } from '@common/types/intel'
import log from 'electron-log'

const VISION_PROMPT = `Analyze this surveillance/camera image for public safety monitoring. Describe:
1. Scene overview (location type, weather, time of day)
2. People count and activity
3. Vehicles visible (type, count)
4. Any unusual activity, incidents, or security concerns
5. Infrastructure condition

If you detect any emergency, threat, or unusual event, start your response with [EVENT DETECTED].
If the scene is normal, start with [NORMAL].
Be concise and factual.`

export class ImageIntelService {
  private imintDir: string

  constructor() {
    this.imintDir = join(app.getPath('home'), '.heimdall', 'imint')
  }

  async analyzeFrame(
    imageUrl: string,
    sourceName: string,
    latitude?: number,
    longitude?: number
  ): Promise<IntelReport | null> {
    try {
      // Fetch the image
      const response = await fetch(imageUrl, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Heimdall/0.1.0 (Public Safety Monitor)' }
      })

      if (!response.ok) {
        log.debug(`IMINT: Failed to fetch frame from ${sourceName}: ${response.status}`)
        return null
      }

      const imageBuffer = Buffer.from(await response.arrayBuffer())
      const contentType = response.headers.get('content-type') || 'image/jpeg'

      // Send to LLM with vision
      const conn = llmService.getConnection()
      if (!conn) {
        log.debug('IMINT: No LLM connection for vision analysis')
        return null
      }

      const base64Image = imageBuffer.toString('base64')
      const analysis = await this.analyzeWithVision(conn, base64Image, contentType)

      if (!analysis) return null

      const isEvent = analysis.startsWith('[EVENT DETECTED]')
      const cleanAnalysis = analysis.replace(/^\[(EVENT DETECTED|NORMAL)\]\s*/i, '')

      // Only store if event detected (saves storage)
      if (!isEvent && !this.shouldAlwaysStore()) {
        log.debug(`IMINT: Normal scene at ${sourceName}, skipping`)
        return null
      }

      // Save frame to disk
      const now = new Date()
      const dateStr = now.toISOString().split('T')[0]
      const timeStr = now.toISOString().replace(/[:.]/g, '-')
      const dir = join(this.imintDir, sourceName.replace(/[^a-zA-Z0-9]/g, '_'), dateStr)
      mkdirSync(dir, { recursive: true })

      const ext = contentType.includes('png') ? 'png' : 'jpg'
      const framePath = join(dir, `${timeStr}.${ext}`)
      writeFileSync(framePath, imageBuffer)

      // Create intel report
      const report: IntelReport = {
        id: generateId(),
        discipline: 'imint',
        title: `IMINT: ${isEvent ? 'Event Detected' : 'Observation'} — ${sourceName}`,
        content: `**Source**: ${sourceName}\n**Analysis**:\n${cleanAnalysis}\n\n**Frame**: ${framePath}`,
        summary: cleanAnalysis.slice(0, 200),
        severity: isEvent ? 'high' : 'info',
        sourceId: this.sourceConfig?.id || 'imint',
        sourceUrl: imageUrl,
        sourceName: `IMINT: ${sourceName}`,
        contentHash: generateId(), // Unique per frame
        latitude: latitude ?? null,
        longitude: longitude ?? null,
        verificationScore: 70,
        reviewed: false,
        createdAt: timestamp(),
        updatedAt: timestamp()
      }

      // Save frame record to DB
      const db = getDatabase()
      db.prepare(
        'INSERT INTO imint_frames (id, report_id, source_name, frame_path, analysis, detected_events, latitude, longitude, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        generateId(), report.id, sourceName, framePath,
        cleanAnalysis, isEvent ? 'true' : 'false',
        latitude ?? null, longitude ?? null, timestamp()
      )

      // Store as intel report
      intelStorageService.store([report])

      log.info(`IMINT: ${isEvent ? 'EVENT' : 'observation'} at ${sourceName}`)
      return report
    } catch (err) {
      log.debug(`IMINT analysis failed for ${sourceName}: ${err}`)
      return null
    }
  }

  private async analyzeWithVision(
    conn: { baseUrl: string; apiKey: string; model: string; customModel: string },
    base64Image: string,
    contentType: string
  ): Promise<string | null> {
    try {
      const model = conn.model || conn.customModel
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (conn.apiKey) headers['Authorization'] = `Bearer ${conn.apiKey}`

      let url = conn.baseUrl.replace(/\/+$/, '') + '/chat/completions'

      let response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: VISION_PROMPT },
              { type: 'image_url', image_url: { url: `data:${contentType};base64,${base64Image}` } }
            ]
          }],
          max_tokens: 500
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(60000)
      })

      // Handle redirect
      if (response.status >= 300 && response.status < 400) {
        const redir = response.headers.get('location')
        if (redir) {
          response = await fetch(redir, {
            method: 'POST', headers,
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: [
                { type: 'text', text: VISION_PROMPT },
                { type: 'image_url', image_url: { url: `data:${contentType};base64,${base64Image}` } }
              ]}],
              max_tokens: 500
            }),
            signal: AbortSignal.timeout(60000)
          })
        }
      }

      if (!response.ok) {
        log.debug(`IMINT vision API ${response.status}`)
        return null
      }

      const data = await response.json() as { choices: Array<{ message: { content: string } }> }
      return data.choices?.[0]?.message?.content || null
    } catch (err) {
      log.debug(`IMINT vision call failed: ${err}`)
      return null
    }
  }

  private shouldAlwaysStore(): boolean {
    // Can be configured to store all frames regardless
    return false
  }

  private sourceConfig: { id: string } | null = null

  setSourceConfig(config: { id: string }): void {
    this.sourceConfig = config
  }
}

export const imageIntelService = new ImageIntelService()
