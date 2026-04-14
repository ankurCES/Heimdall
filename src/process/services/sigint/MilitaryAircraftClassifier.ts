import log from 'electron-log'

// Military Aircraft ICAO Hex Range Classifier
// Maps hex code ranges to country/military operator
// Based on ICAO address block allocations + known military ranges
// Ref: World Monitor seed-military-flights.mjs (28 countries)

interface MilitaryRange {
  start: number  // Hex range start
  end: number    // Hex range end
  country: string
  operator: string
}

// Major military ICAO hex ranges (sorted by start address)
const MILITARY_RANGES: MilitaryRange[] = [
  // United States (largest military fleet)
  { start: 0xADF7C7, end: 0xAFFFFF, country: 'US', operator: 'US Military' },
  { start: 0xA00001, end: 0xA00FFF, country: 'US', operator: 'USAF' },

  // United Kingdom
  { start: 0x43C000, end: 0x43CFFF, country: 'UK', operator: 'Royal Air Force' },

  // France
  { start: 0x3B0000, end: 0x3B0FFF, country: 'FR', operator: 'French Air Force' },
  { start: 0x3A0000, end: 0x3AFFFF, country: 'FR', operator: 'French Military' },

  // Germany
  { start: 0x3F0000, end: 0x3FFFFF, country: 'DE', operator: 'Luftwaffe' },

  // Russia
  { start: 0x155000, end: 0x155FFF, country: 'RU', operator: 'Russian Air Force' },

  // China
  { start: 0x780000, end: 0x78FFFF, country: 'CN', operator: 'PLA Air Force' },

  // Israel
  { start: 0x738000, end: 0x738FFF, country: 'IL', operator: 'Israeli Air Force' },

  // India
  { start: 0x800000, end: 0x80FFFF, country: 'IN', operator: 'Indian Air Force' },

  // Australia
  { start: 0x7C0000, end: 0x7C0FFF, country: 'AU', operator: 'RAAF' },

  // Canada
  { start: 0xC00000, end: 0xC00FFF, country: 'CA', operator: 'RCAF' },

  // Turkey
  { start: 0x4B8000, end: 0x4B8FFF, country: 'TR', operator: 'Turkish Air Force' },

  // Saudi Arabia
  { start: 0x710000, end: 0x710FFF, country: 'SA', operator: 'Royal Saudi Air Force' },

  // UAE
  { start: 0x896000, end: 0x896FFF, country: 'AE', operator: 'UAE Air Force' },

  // Japan
  { start: 0x840000, end: 0x840FFF, country: 'JP', operator: 'JASDF' },

  // South Korea
  { start: 0x718000, end: 0x718FFF, country: 'KR', operator: 'ROKAF' },

  // Italy
  { start: 0x300000, end: 0x300FFF, country: 'IT', operator: 'Italian Air Force' },

  // NATO (special assignments)
  { start: 0x480000, end: 0x480FFF, country: 'NATO', operator: 'NATO AWACS/SIGINT' },

  // Poland
  { start: 0x489000, end: 0x489FFF, country: 'PL', operator: 'Polish Air Force' },

  // Norway
  { start: 0x478000, end: 0x478FFF, country: 'NO', operator: 'Royal Norwegian Air Force' },

  // Greece
  { start: 0x468000, end: 0x468FFF, country: 'GR', operator: 'Hellenic Air Force' },

  // Egypt
  { start: 0x010000, end: 0x010FFF, country: 'EG', operator: 'Egyptian Air Force' },

  // Pakistan
  { start: 0x760000, end: 0x760FFF, country: 'PK', operator: 'Pakistan Air Force' },

  // Brazil
  { start: 0xE40000, end: 0xE40FFF, country: 'BR', operator: 'Brazilian Air Force' },

  // Qatar
  { start: 0x060000, end: 0x060FFF, country: 'QA', operator: 'Qatar Emiri Air Force' },

  // Kuwait
  { start: 0x050000, end: 0x050FFF, country: 'KW', operator: 'Kuwait Air Force' },

  // Belgium
  { start: 0x448000, end: 0x448FFF, country: 'BE', operator: 'Belgian Air Component' },

  // Switzerland
  { start: 0x4B0000, end: 0x4B0FFF, country: 'CH', operator: 'Swiss Air Force' }
]

// Known military callsign prefixes
const MILITARY_CALLSIGNS = [
  'RCH', 'REACH', 'EVAC', 'EVIL', 'DARK', 'JAKE', 'TOPCAT', 'DOOM',
  'VIPER', 'HAWK', 'EAGLE', 'RAZOR', 'NITE', 'NIGHT', 'STEEL',
  'KING', 'DUKE', 'BARON', 'SENTRY', 'MAGIC', 'ATLAS', 'GIANT',
  'RAMBO', 'TORCH', 'STUD', 'FURY', 'GHOST', 'REAPER',
  'NATO', 'AWACS', 'JSTAR', 'RIVET', 'COBRA', 'HUSKER',
  'SAM', 'EXEC', 'AF1', 'AF2', 'VENUS', 'MAGMA'
]

export interface MilitaryClassification {
  isMilitary: boolean
  country: string
  operator: string
  confidence: number
  method: 'hex_range' | 'callsign' | 'none'
}

class MilitaryAircraftClassifierImpl {
  classify(hex: string, callsign?: string): MilitaryClassification {
    const hexNum = parseInt(hex, 16)

    // 1. Check hex ranges (highest confidence)
    for (const range of MILITARY_RANGES) {
      if (hexNum >= range.start && hexNum <= range.end) {
        return {
          isMilitary: true,
          country: range.country,
          operator: range.operator,
          confidence: 0.9,
          method: 'hex_range'
        }
      }
    }

    // 2. Check callsign prefixes
    if (callsign) {
      const cs = callsign.trim().toUpperCase()
      for (const prefix of MILITARY_CALLSIGNS) {
        if (cs.startsWith(prefix)) {
          return {
            isMilitary: true,
            country: 'Unknown',
            operator: `Military (callsign: ${prefix})`,
            confidence: 0.7,
            method: 'callsign'
          }
        }
      }
    }

    return { isMilitary: false, country: '', operator: '', confidence: 0, method: 'none' }
  }

  // Batch classify for efficiency
  classifyBatch(aircraft: Array<{ hex: string; callsign?: string }>): Map<string, MilitaryClassification> {
    const results = new Map<string, MilitaryClassification>()
    for (const ac of aircraft) {
      results.set(ac.hex, this.classify(ac.hex, ac.callsign))
    }
    return results
  }
}

export const militaryAircraftClassifier = new MilitaryAircraftClassifierImpl()
