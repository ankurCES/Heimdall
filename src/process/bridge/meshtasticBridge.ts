import { ipcMain } from 'electron'
import { getDatabase } from '../services/database'
import { settingsService } from '../services/settings/SettingsService'
import { generateId, timestamp } from '@common/utils/id'
import type { MeshtasticConfig } from '@common/types/settings'
import log from 'electron-log'

export function registerMeshtasticBridge(): void {
  ipcMain.handle('meshtastic:getNodes', () => {
    const db = getDatabase()
    return db.prepare('SELECT * FROM meshtastic_nodes ORDER BY last_seen DESC').all()
  })

  ipcMain.handle('meshtastic:getNodeCount', () => {
    const db = getDatabase()
    const result = db.prepare('SELECT COUNT(*) as count FROM meshtastic_nodes').get() as { count: number }
    return result.count
  })

  ipcMain.handle('meshtastic:getMessages', (_event, params?: { limit?: number }) => {
    const db = getDatabase()
    const limit = params?.limit || 100
    return db.prepare(
      "SELECT * FROM intel_reports WHERE discipline = 'sigint' AND source_name LIKE 'Meshtastic%' ORDER BY created_at DESC LIMIT ?"
    ).all(limit)
  })

  ipcMain.handle('meshtastic:getRecommendedMode', () => {
    const db = getDatabase()
    const nodeCount = (db.prepare('SELECT COUNT(*) as count FROM meshtastic_nodes').get() as { count: number }).count
    const recentMessages = (db.prepare(
      "SELECT COUNT(*) as count FROM intel_reports WHERE discipline = 'sigint' AND source_name LIKE 'Meshtastic%' AND created_at > ?"
    ).get(Date.now() - 3600000) as { count: number }).count

    if (recentMessages > 50) return { mode: 'SHORT_FAST', reason: 'High message volume. Short range / fast mode reduces congestion.' }
    if (nodeCount > 10) return { mode: 'LONG_MODERATE', reason: 'Many nodes detected. Long range with moderate speed for coverage.' }
    if (recentMessages > 10) return { mode: 'MEDIUM_SLOW', reason: 'Moderate traffic. Medium range for reliability.' }
    return { mode: 'LONG_FAST', reason: 'Low traffic. Long range / fast mode for maximum SIGINT capture.' }
  })

  // Pull data from connected Meshtastic device via serial
  ipcMain.handle('meshtastic:pullDeviceData', async () => {
    const config = settingsService.get<MeshtasticConfig>('meshtastic')
    if (!config?.serialPath && config?.connectionType === 'serial') {
      return { success: false, message: 'No serial port configured' }
    }

    try {
      const { SerialPort } = await import('serialport')
      const db = getDatabase()
      const now = timestamp()
      const serialPath = config?.serialPath || ''

      return new Promise((resolve) => {
        const sp = new SerialPort({ path: serialPath, baudRate: 115200, autoOpen: false })
        const chunks: Buffer[] = []
        let resolved = false

        sp.open((err) => {
          if (err) {
            resolve({ success: false, message: `Failed to open ${serialPath}: ${err.message}` })
            return
          }

          sp.on('data', (data: Buffer) => {
            chunks.push(data)
          })

          // Wait 5 seconds to collect data from the device
          setTimeout(() => {
            sp.close()
            if (resolved) return
            resolved = true

            const rawData = Buffer.concat(chunks)
            if (rawData.length === 0) {
              resolve({ success: true, message: 'Connected but no data received. Try resetting the device.', nodesFound: 0 })
              return
            }

            // Parse protobuf-like data — Meshtastic uses protobuf over serial
            // For now, log the raw bytes and create a signal report
            log.info(`Meshtastic: received ${rawData.length} bytes from ${serialPath}`)

            // Store as a raw SIGINT capture
            db.prepare(
              'INSERT INTO intel_reports (id, discipline, title, content, severity, source_id, source_name, content_hash, verification_score, reviewed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).run(
              generateId(), 'sigint',
              `Meshtastic Device Dump: ${serialPath}`,
              `**Device**: ${serialPath}\n**Bytes Received**: ${rawData.length}\n**Raw Hex (first 256 bytes)**: \`${rawData.slice(0, 256).toString('hex')}\`\n\nRaw data captured from Meshtastic device. Full protobuf parsing requires @meshtastic/js integration.`,
              'info', 'meshtastic-device', `Meshtastic Device (${serialPath})`,
              generateId(), 60, 0, now, now
            )

            // Log any printable text found in the stream
            const textContent = rawData.toString('utf-8').replace(/[^\x20-\x7E\n]/g, '').trim()
            if (textContent.length > 10) {
              db.prepare(
                'INSERT INTO intel_reports (id, discipline, title, content, severity, source_id, source_name, content_hash, verification_score, reviewed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
              ).run(
                generateId(), 'sigint',
                `Meshtastic Text Data from ${serialPath}`,
                `**Extracted Text**:\n\`\`\`\n${textContent.slice(0, 2000)}\n\`\`\``,
                'low', 'meshtastic-device', `Meshtastic Text`,
                generateId(), 40, 0, now, now
              )
            }

            resolve({
              success: true,
              message: `Received ${rawData.length} bytes from device. Data logged as SIGINT.`,
              bytesReceived: rawData.length
            })
          }, 5000)
        })
      })
    } catch (err) {
      log.error('Meshtastic pull failed:', err)
      return { success: false, message: String(err) }
    }
  })

  log.info('Meshtastic bridge registered')
}
