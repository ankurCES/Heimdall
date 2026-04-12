import { collectorManager } from './CollectorManager'

// OSINT
import { RssCollector } from './osint/RssCollector'
import { PublicRecordsCollector } from './osint/PublicRecordsCollector'
import { AcademicCollector } from './osint/AcademicCollector'
import { FactbookCollector } from './osint/FactbookCollector'
import { GdeltCollector } from './osint/GdeltCollector'
import { GovernmentDataCollector } from './osint/GovernmentDataCollector'
import { GNewsCollector } from './osint/GNewsCollector'

// CYBINT
import { CveCollector } from './cybint/CveCollector'
import { ThreatFeedCollector } from './cybint/ThreatFeedCollector'
import { DnsWhoisCollector } from './cybint/DnsWhoisCollector'

// FININT
import { EdgarCollector } from './finint/EdgarCollector'
import { SanctionsCollector } from './finint/SanctionsCollector'

// SOCMINT
import { TwitterCollector } from './socmint/TwitterCollector'
import { RedditCollector } from './socmint/RedditCollector'
import { TelegramChannelCollector } from './socmint/TelegramChannelCollector'

// GEOINT
import { UsgsEarthquakeCollector } from './geoint/UsgsEarthquakeCollector'
import { NoaaWeatherCollector } from './geoint/NoaaWeatherCollector'
import { SentinelCollector } from './geoint/SentinelCollector'

// SIGINT
import { AdsbCollector } from './sigint/AdsbCollector'
import { FccCollector } from './sigint/FccCollector'
import { MeshtasticCollector } from './sigint/MeshtasticCollector'

// RUMINT
import { ForumCollector } from './rumint/ForumCollector'

// CI
import { HibpCollector } from './ci/HibpCollector'
import { BreachFeedCollector } from './ci/BreachFeedCollector'

// Agency
import { InterpolCollector } from './agency/InterpolCollector'
import { FbiCollector } from './agency/FbiCollector'
import { EuropolCollector } from './agency/EuropolCollector'
import { UnscCollector } from './agency/UnscCollector'

export function registerAllCollectors(): void {
  // OSINT (7)
  collectorManager.registerFactory('rss', () => new RssCollector())
  collectorManager.registerFactory('public-records', () => new PublicRecordsCollector())
  collectorManager.registerFactory('academic', () => new AcademicCollector())
  collectorManager.registerFactory('factbook', () => new FactbookCollector())
  collectorManager.registerFactory('gdelt', () => new GdeltCollector())
  collectorManager.registerFactory('government-data', () => new GovernmentDataCollector())
  collectorManager.registerFactory('gnews', () => new GNewsCollector())

  // CYBINT (3)
  collectorManager.registerFactory('cve', () => new CveCollector())
  collectorManager.registerFactory('threat-feed', () => new ThreatFeedCollector())
  collectorManager.registerFactory('dns-whois', () => new DnsWhoisCollector())

  // FININT (2)
  collectorManager.registerFactory('edgar', () => new EdgarCollector())
  collectorManager.registerFactory('sanctions', () => new SanctionsCollector())

  // SOCMINT (3)
  collectorManager.registerFactory('twitter', () => new TwitterCollector())
  collectorManager.registerFactory('reddit', () => new RedditCollector())
  collectorManager.registerFactory('telegram-channel', () => new TelegramChannelCollector())

  // GEOINT (3)
  collectorManager.registerFactory('usgs-earthquake', () => new UsgsEarthquakeCollector())
  collectorManager.registerFactory('noaa-weather', () => new NoaaWeatherCollector())
  collectorManager.registerFactory('sentinel', () => new SentinelCollector())

  // SIGINT (3)
  collectorManager.registerFactory('adsb', () => new AdsbCollector())
  collectorManager.registerFactory('fcc', () => new FccCollector())
  collectorManager.registerFactory('meshtastic', () => new MeshtasticCollector())

  // RUMINT (1)
  collectorManager.registerFactory('forum', () => new ForumCollector())

  // CI (2)
  collectorManager.registerFactory('hibp', () => new HibpCollector())
  collectorManager.registerFactory('breach-feed', () => new BreachFeedCollector())

  // Agency (4)
  collectorManager.registerFactory('interpol', () => new InterpolCollector())
  collectorManager.registerFactory('fbi', () => new FbiCollector())
  collectorManager.registerFactory('europol', () => new EuropolCollector())
  collectorManager.registerFactory('unsc', () => new UnscCollector())
}
