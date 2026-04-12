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

  // Pull node database from connected Meshtastic device via serial
  ipcMain.handle('meshtastic:pullDeviceData', async () => {
    const config = settingsService.get<MeshtasticConfig>('meshtastic')
    if (!config?.serialPath && config?.connectionType === 'serial') {
      return { success: false, message: 'No serial port configured' }
    }

    const serialPath = config?.serialPath || ''

    try {
      const { SerialPort } = await import('serialport')
      const db = getDatabase()
      const now = timestamp()

      return new Promise((resolve) => {
        const sp = new SerialPort({ path: serialPath, baudRate: 115200, autoOpen: false })
        const allData: Buffer[] = []
        let nodesFound = 0

        sp.open((err) => {
          if (err) {
            resolve({ success: false, message: `Failed to open ${serialPath}: ${err.message}` })
            return
          }

          log.info(`Meshtastic: connected to ${serialPath}, listening for node data...`)

          sp.on('data', (data: Buffer) => {
            allData.push(data)

            // Try to parse Meshtastic frames from accumulated data
            const combined = Buffer.concat(allData)

            // Look for node info patterns in the raw data
            // Meshtastic protobuf NodeInfo contains: num (uint32), user (UserInfo), position, snr
            // We can extract readable strings (node names, etc.) from the protobuf stream
            const text = combined.toString('utf-8', 0, combined.length)

            // Extract printable strings that look like node names (4+ chars, alphanumeric)
            const nameMatches = text.match(/[\x20-\x7E]{4,30}/g) || []
            const uniqueNames = [...new Set(nameMatches.filter((n) =>
              !n.includes('http') && !n.includes('://') && n.length < 25 && /[a-zA-Z]/.test(n)
            ))]

            // Extract what looks like node IDs (hex patterns)
            const hexMatches = combined.toString('hex').match(/(?:0[0-9a-f]{7}){1}/gi) || []

            nodesFound = Math.max(uniqueNames.length, hexMatches.length / 2)
          })

          // Wait 10 seconds to collect data stream
          setTimeout(() => {
            sp.close()
            const rawData = Buffer.concat(allData)

            log.info(`Meshtastic: received ${rawData.length} bytes, ~${nodesFound} potential nodes`)

            if (rawData.length === 0) {
              resolve({ success: true, message: 'Connected but no data. Try pressing reset on the device.', nodesFound: 0 })
              return
            }

            const hexDump = rawData.toString('hex')

            // Separate protobuf frames (start with 0x94 0xc3) from debug text
            const protoFrames: Buffer[] = []
            const debugLines: string[] = []
            let i = 0
            while (i < rawData.length) {
              if (rawData[i] === 0x94 && i + 1 < rawData.length && rawData[i + 1] === 0xc3) {
                // Protobuf frame: [0x94, 0xc3, len_msb, len_lsb, ...payload]
                if (i + 3 < rawData.length) {
                  const frameLen = (rawData[i + 2] << 8) | rawData[i + 3]
                  if (frameLen > 0 && frameLen < 512 && i + 4 + frameLen <= rawData.length) {
                    protoFrames.push(rawData.slice(i + 4, i + 4 + frameLen))
                    i += 4 + frameLen
                    continue
                  }
                }
              }
              // Debug text — collect until newline
              const nlIdx = rawData.indexOf(0x0a, i)
              if (nlIdx > i) {
                const line = rawData.slice(i, nlIdx).toString('utf-8').replace(/[^\x20-\x7E]/g, '').trim()
                if (line.length > 3) debugLines.push(line)
                i = nlIdx + 1
              } else {
                i++
              }
            }

            // Extract node IDs from debug text (pattern: x[8 hex chars])
            const nodeIdPattern = /x([0-9a-f]{8})/gi
            const discoveredNodeIds = new Set<string>()
            for (const line of debugLines) {
              let match: RegExpExecArray | null
              while ((match = nodeIdPattern.exec(line)) !== null) {
                const nodeId = `!${match[1]}`
                if (nodeId !== '!ffffffff' && nodeId !== '!00000000') {
                  discoveredNodeIds.add(nodeId)
                }
              }
            }

            // Extract node names from protobuf frames
            // In FromRadio NodeInfo, user.long_name is a string field
            const nodeNames: string[] = []
            for (const frame of protoFrames) {
              // Look for printable strings > 3 chars in protobuf payload
              const text = frame.toString('utf-8').replace(/[^\x20-\x7E]/g, '').trim()
              const names = text.match(/[A-Za-z][A-Za-z0-9 _.-]{2,24}/g) || []
              for (const n of names) {
                if (!['DEBUG', 'INFO', 'WARN', 'ERROR', 'Started', 'transport', 'encrypted', 'packets', 'relay', 'queue', 'priority', 'radio'].some((skip) => n.includes(skip))) {
                  nodeNames.push(n.trim())
                }
              }
            }

            // Store discovered nodes
            let stored = 0
            for (const nodeId of discoveredNodeIds) {
              try {
                db.prepare(`
                  INSERT INTO meshtastic_nodes (node_id, first_seen, last_seen, seen_count)
                  VALUES (?, ?, ?, 1)
                  ON CONFLICT(node_id) DO UPDATE SET last_seen = ?, seen_count = seen_count + 1
                `).run(nodeId, now, now, now)
                stored++
              } catch {}
            }

            // Associate names with nodes
            const nodeIdArr = Array.from(discoveredNodeIds)
            for (let ni = 0; ni < Math.min(nodeNames.length, nodeIdArr.length); ni++) {
              try {
                db.prepare('UPDATE meshtastic_nodes SET long_name = ? WHERE node_id = ?').run(nodeNames[ni], nodeIdArr[ni])
              } catch {}
            }

            log.info(`Meshtastic: ${protoFrames.length} protobuf frames, ${debugLines.length} debug lines, ${discoveredNodeIds.size} node IDs, ${nodeNames.length} names`)

            // Store raw dump as intel report
            db.prepare(
              'INSERT INTO intel_reports (id, discipline, title, content, severity, source_id, source_name, content_hash, verification_score, reviewed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).run(
              generateId(), 'sigint',
              `Meshtastic Device Dump: ${rawData.length} bytes, ~${stored} nodes`,
              `**Device**: ${serialPath}\n**Bytes**: ${rawData.length}\n**Protobuf Frames**: ${protoFrames.length}\n**Debug Lines**: ${debugLines.length}\n**Node IDs Found**: ${discoveredNodeIds.size}\n**Node Names**: ${nodeNames.slice(0, 20).join(', ') || 'None extracted'}\n\n**Discovered Node IDs**:\n${Array.from(discoveredNodeIds).slice(0, 50).map((id) => '- `' + id + '`').join('\n')}\n\n**Debug Log (last 20 lines)**:\n\`\`\`\n${debugLines.slice(-20).join('\n')}\n\`\`\``,
              'info', 'meshtastic-device', `Meshtastic Device Dump`,
              generateId(), 60, 0, now, now
            )

            resolve({
              success: true,
              message: `${rawData.length} bytes, ${discoveredNodeIds.size} node IDs, ${protoFrames.length} protobuf frames extracted.`,
              nodesFound: stored,
              bytesReceived: rawData.length
            })
          }, 10000)
        })
      })
    } catch (err) {
      log.error('Meshtastic pull failed:', err)
      return { success: false, message: String(err) }
    }
  })

  log.info('Meshtastic bridge registered')
}
