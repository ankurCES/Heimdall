// Squawk Code Classifier — maps transponder squawk codes to their meanings
// Reference: ICAO Annex 10, FAA Order 7110.66

export interface SquawkClassification {
  code: string
  category: 'emergency' | 'military' | 'special' | 'vfr' | 'ifr' | 'discrete' | 'unknown'
  meaning: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  description: string
}

// Emergency squawk codes
const EMERGENCY_CODES: Record<string, { meaning: string; description: string }> = {
  '7500': { meaning: 'HIJACK', description: 'Aircraft hijacking or unlawful interference. DO NOT acknowledge on frequency.' },
  '7600': { meaning: 'RADIO FAILURE', description: 'Communications failure (NORDO). Aircraft has lost radio contact.' },
  '7700': { meaning: 'EMERGENCY', description: 'General emergency. Aircraft is declaring an emergency condition.' }
}

// Military squawk codes (US/NATO)
const MILITARY_CODES: Record<string, { meaning: string; description: string }> = {
  '0000': { meaning: 'MILITARY (Discrete)', description: 'Military aircraft, discrete code. Often used for classified missions.' },
  '0100': { meaning: 'MILITARY OPERATIONS', description: 'US military operations area activity.' },
  '0400': { meaning: 'MILITARY (Alert)', description: 'Military alert/scramble operations.' },
  '4400': { meaning: 'MILITARY (Reserved)', description: 'Reserved for military use by FAA/DoD.' },
  '4401': { meaning: 'NORAD/ADIZ', description: 'North American Aerospace Defense Command operations.' },
  '4453': { meaning: 'USAF DRONE', description: 'US Air Force unmanned aerial vehicle operations.' },
  '5100': { meaning: 'DOD/MILITARY', description: 'Department of Defense special operations.' },
  '5400': { meaning: 'DOD/MILITARY', description: 'Department of Defense operations.' },
  '7777': { meaning: 'MILITARY INTERCEPT', description: 'Military interceptor operations. Active air defense.' }
}

// Special purpose codes
const SPECIAL_CODES: Record<string, { meaning: string; description: string }> = {
  '1200': { meaning: 'VFR (US)', description: 'Visual Flight Rules — standard VFR squawk in the US.' },
  '1400': { meaning: 'VFR (Canada)', description: 'Visual Flight Rules — standard VFR squawk in Canada.' },
  '2000': { meaning: 'OCEANIC/Non-Radar', description: 'Oceanic or non-radar environment. Aircraft entering non-radar airspace.' },
  '7000': { meaning: 'VFR (ICAO/Europe)', description: 'Visual Flight Rules — standard VFR squawk in ICAO/European airspace.' },
  '7001': { meaning: 'VFR (Military/UK)', description: 'Military VFR in UK airspace.' },
  '7004': { meaning: 'AEROBATIC', description: 'Aerobatic operations display squawk.' },
  '7010': { meaning: 'VFR (Ireland)', description: 'Standard VFR in Irish airspace.' },
  '1000': { meaning: 'IFR (Mode S)', description: 'Mode S equipped IFR aircraft (no assigned discrete code).' },
  '2100': { meaning: 'SPECIAL OPS', description: 'Special operations / law enforcement.' },
  '4000': { meaning: 'MILITARY FERRY', description: 'Military ferry/positioning flights.' },
  '0033': { meaning: 'PARACHUTE OPS', description: 'Parachute jumping operations in progress.' },
  '1277': { meaning: 'SAR (Search & Rescue)', description: 'Search and rescue operations.' },
  '5000': { meaning: 'FERRY FLIGHT', description: 'Ferry/repositioning flight without passengers.' },
  '6100': { meaning: 'HAZMAT', description: 'Aircraft carrying dangerous goods/hazardous materials.' },
  '6400': { meaning: 'MEDEVAC', description: 'Medical evacuation flight — air ambulance.' },
  '0030': { meaning: 'INTERCEPT', description: 'Aircraft being intercepted.' }
}

// Discrete code ranges
const DISCRETE_RANGES: Array<{ start: number; end: number; meaning: string }> = [
  { start: 0o0100, end: 0o0377, meaning: 'Military discrete block' },
  { start: 0o1201, end: 0o1277, meaning: 'IFR discrete (low altitude)' },
  { start: 0o4401, end: 0o4477, meaning: 'NORAD/DoD reserved block' },
  { start: 0o5001, end: 0o5077, meaning: 'DoD discrete block' },
  { start: 0o5100, end: 0o5377, meaning: 'FAA/DoD shared block' }
]

export class SquawkClassifier {
  classify(squawkCode: string): SquawkClassification {
    if (!squawkCode || squawkCode === 'N/A') {
      return { code: squawkCode || '', category: 'unknown', meaning: 'No squawk', severity: 'info', description: 'Transponder not reporting squawk code.' }
    }

    const code = squawkCode.trim()

    // Emergency codes — highest priority
    if (EMERGENCY_CODES[code]) {
      const e = EMERGENCY_CODES[code]
      return { code, category: 'emergency', meaning: e.meaning, severity: code === '7500' ? 'critical' : 'high', description: e.description }
    }

    // Military codes
    if (MILITARY_CODES[code]) {
      const m = MILITARY_CODES[code]
      return { code, category: 'military', meaning: m.meaning, severity: code === '7777' ? 'critical' : 'high', description: m.description }
    }

    // Special purpose codes
    if (SPECIAL_CODES[code]) {
      const s = SPECIAL_CODES[code]
      const severity = ['1277', '6400', '0030', '6100'].includes(code) ? 'medium' as const : 'info' as const
      return { code, category: 'special', meaning: s.meaning, severity, description: s.description }
    }

    // VFR codes
    if (['1200', '1400', '7000', '7001', '7010'].includes(code)) {
      return { code, category: 'vfr', meaning: 'VFR', severity: 'info', description: 'Standard Visual Flight Rules squawk.' }
    }

    // Check discrete ranges
    const codeOctal = parseInt(code, 8)
    for (const range of DISCRETE_RANGES) {
      if (codeOctal >= range.start && codeOctal <= range.end) {
        return { code, category: 'discrete', meaning: range.meaning, severity: 'low', description: `Discrete assigned code in ${range.meaning} range.` }
      }
    }

    // Standard IFR discrete code
    if (codeOctal >= 0o0100 && codeOctal <= 0o7677) {
      return { code, category: 'ifr', meaning: 'IFR Discrete', severity: 'info', description: 'Standard IFR discrete squawk code assigned by ATC.' }
    }

    return { code, category: 'unknown', meaning: 'Unknown', severity: 'info', description: `Squawk code ${code} — not in known classification database.` }
  }

  // Check if a squawk code is notable (worth flagging)
  isNotable(squawkCode: string): boolean {
    const c = this.classify(squawkCode)
    return c.category === 'emergency' || c.category === 'military' || c.severity === 'critical' || c.severity === 'high' || c.severity === 'medium'
  }
}

export const squawkClassifier = new SquawkClassifier()
