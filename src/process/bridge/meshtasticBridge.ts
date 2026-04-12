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

            // Extract any readable node-like data and persist
            const hexDump = rawData.toString('hex')

            // Look for Meshtastic node number patterns (4-byte little-endian uint32)
            // Node numbers are typically in range 0x00000001 - 0xFFFFFFFF
            const nodeNumbers = new Set<string>()
            for (let i = 0; i < rawData.length - 4; i++) {
              // Look for protobuf field tag for 'num' (field 1, wire type 0 = varint)
              if (rawData[i] === 0x08 && rawData[i + 1] > 0 && rawData[i + 1] < 0x80) {
                // Simple varint (single byte)
                const nodeNum = rawData[i + 1]
                if (nodeNum > 0) nodeNumbers.add(`0x${nodeNum.toString(16)}`)
              }
            }

            // Extract readable strings as potential node names
            const textContent = rawData.toString('utf-8').replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim()
            const potentialNames = textContent.match(/[A-Za-z][A-Za-z0-9 _-]{2,20}/g) || []
            const filteredNames = [...new Set(potentialNames.filter((n) =>
              n.trim().length >= 3 && !/^(GET|POST|HTTP|Content|Accept|Host|User)/.test(n)
            ))]

            // Store discovered nodes
            let stored = 0
            for (const name of filteredNames.slice(0, 50)) {
              try {
                db.prepare(`
                  INSERT INTO meshtastic_nodes (node_id, long_name, first_seen, last_seen, seen_count)
                  VALUES (?, ?, ?, ?, 1)
                  ON CONFLICT(node_id) DO UPDATE SET long_name = ?, last_seen = ?, seen_count = seen_count + 1
                `).run(`serial_${stored}`, name.trim(), now, now, name.trim(), now)
                stored++
              } catch {}
            }

            // Store raw dump as intel report
            db.prepare(
              'INSERT INTO intel_reports (id, discipline, title, content, severity, source_id, source_name, content_hash, verification_score, reviewed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).run(
              generateId(), 'sigint',
              `Meshtastic Device Dump: ${rawData.length} bytes, ~${stored} nodes`,
              `**Device**: ${serialPath}\n**Bytes**: ${rawData.length}\n**Nodes Extracted**: ${stored}\n**Names Found**: ${filteredNames.slice(0, 20).join(', ')}\n\n**Raw Hex (first 512 bytes)**:\n\`\`\`\n${hexDump.slice(0, 1024)}\n\`\`\``,
              'info', 'meshtastic-device', `Meshtastic Device Dump`,
              generateId(), 60, 0, now, now
            )

            resolve({
              success: true,
              message: `${rawData.length} bytes received, ${stored} nodes extracted from device.`,
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
