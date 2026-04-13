import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import { imageIntelService } from '../../services/imint/ImageIntelService'
import log from 'electron-log'

// Public traffic camera snapshot feeds — JPEG images from DOT sources
// These are publicly accessible government traffic cameras

const DEFAULT_CAMERAS = [
  // Virginia DOT (verified working)
  { name: 'VA I-64 Hampton Roads', url: 'https://cdn.511virginia.org/cameras/CAM-MP-085.jpg', lat: 36.9785, lon: -76.4283 },
  { name: 'VA I-95 Fredericksburg', url: 'https://cdn.511virginia.org/cameras/CAM-MP-034.jpg', lat: 38.3032, lon: -77.4605 },
  { name: 'VA I-81 Roanoke', url: 'https://cdn.511virginia.org/cameras/CAM-MP-001.jpg', lat: 37.2710, lon: -79.9414 },
  // Minnesota DOT (verified working)
  { name: 'MN I-94 Minneapolis', url: 'https://511mn.org/camera?id=1', lat: 44.9778, lon: -93.2650 },
  { name: 'MN I-35W Minneapolis', url: 'https://511mn.org/camera?id=5', lat: 44.9537, lon: -93.2474 },
  { name: 'MN I-494 Bloomington', url: 'https://511mn.org/camera?id=10', lat: 44.8547, lon: -93.3088 },
  // Colorado DOT (verified working)
  { name: 'CO I-70 Floyd Hill', url: 'https://www.cotrip.org/dimages/camera?imageURL=remote/COACDOT-cam-I-70-Floyd-Hill-EB-202.561-static.jpg', lat: 39.7162, lon: -105.4019 },
  // Wisconsin DOT
  { name: 'WI I-94 Milwaukee', url: 'https://511wi.gov/map/Cctv/GetCameraImage?cameraId=1001', lat: 43.0389, lon: -87.9065 },
  // Illinois DOT
  { name: 'IL I-90 Chicago', url: 'https://www.travelmidwest.com/lmiga/cameraThumbnail.do?id=IDOT-cam-IL-90-at-River-Rd', lat: 41.9772, lon: -87.8246 }
]

export class TrafficCameraCollector extends BaseCollector {
  readonly discipline = 'imint' as const
  readonly type = 'traffic-camera'

  async collect(): Promise<IntelReport[]> {
    const cameras = this.getCameras()
    const reports: IntelReport[] = []

    for (const cam of cameras) {
      try {
        // Just capture and log the frame — ImageIntelService handles LLM analysis
        const report = await imageIntelService.analyzeFrame(cam.url, cam.name, cam.lat, cam.lon)
        if (report) reports.push(report)
      } catch (err) {
        log.debug(`TrafficCamera: ${cam.name} failed: ${err}`)
      }

      // Rate limit between cameras
      await new Promise((r) => setTimeout(r, 3000))
    }

    log.info(`TrafficCamera: processed ${cameras.length} cameras, ${reports.length} events detected`)
    return reports
  }

  private getCameras(): Array<{ name: string; url: string; lat: number; lon: number }> {
    const custom = this.sourceConfig?.config?.cameras as Array<{ name: string; url: string; lat: number; lon: number }> | undefined
    return custom && custom.length > 0 ? custom : DEFAULT_CAMERAS
  }
}
