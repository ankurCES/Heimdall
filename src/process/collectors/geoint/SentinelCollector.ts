import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import log from 'electron-log'

// Copernicus Data Space — free, registration required but public metadata search is open
// Docs: https://documentation.dataspace.copernicus.eu/APIs/OData.html
const CDSE_ODATA = 'https://catalogue.dataspace.copernicus.eu/odata/v1'

interface SentinelProduct {
  Id: string
  Name: string
  ContentDate: { Start: string; End: string }
  Footprint: string
  Online: boolean
  ContentLength: number
}

export class SentinelCollector extends BaseCollector {
  readonly discipline = 'geoint' as const
  readonly type = 'sentinel'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []
    const aois = this.getAreasOfInterest()

    for (const aoi of aois) {
      try {
        const now = new Date()
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

        const filter = [
          `Collection/Name eq 'SENTINEL-2'`,
          `ContentDate/Start gt ${weekAgo.toISOString()}`,
          `OData.CSC.Intersects(area=geography'SRID=4326;${aoi.polygon}')`,
          `Attributes/OData.CSC.DoubleAttribute/any(att:att/Name eq 'cloudCover' and att/Value lt 30)`
        ].join(' and ')

        const params = new URLSearchParams({
          '$filter': filter,
          '$top': '10',
          '$orderby': 'ContentDate/Start desc'
        })

        const data = await this.fetchJson<{ value: SentinelProduct[] }>(
          `${CDSE_ODATA}/Products?${params.toString()}`
        )

        for (const product of data.value) {
          reports.push(
            this.createReport({
              title: `Sentinel-2: ${product.Name}`,
              content: `**Product**: ${product.Name}\n**Date Range**: ${product.ContentDate.Start} to ${product.ContentDate.End}\n**Size**: ${(product.ContentLength / 1e6).toFixed(1)} MB\n**Online**: ${product.Online}\n**AOI**: ${aoi.name}\n**Footprint**: ${product.Footprint?.slice(0, 200) || 'N/A'}`,
              severity: 'info',
              sourceName: 'Copernicus Sentinel-2',
              verificationScore: 95,
              latitude: aoi.lat,
              longitude: aoi.lon
            })
          )
        }

        log.debug(`Sentinel: ${aoi.name} — ${data.value.length} products`)
      } catch (err) {
        log.warn(`Sentinel fetch failed for ${aoi.name}: ${err}`)
      }
    }

    return reports
  }

  private getAreasOfInterest(): Array<{ name: string; polygon: string; lat: number; lon: number }> {
    const custom = this.sourceConfig?.config?.aois as Array<{
      name: string; polygon: string; lat: number; lon: number
    }> | undefined
    return custom && custom.length > 0 ? custom : []
    // Users configure specific areas of interest via settings
  }
}
