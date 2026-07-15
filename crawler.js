const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

// Configuration paths
const WATCHLIST_PATH = path.join(__dirname, 'watchlist.json');
const DATABASE_PATH = path.join(__dirname, 'database.json');
const FREEBIES_PATH = path.join(__dirname, 'freebies.json');

// Concurrency Settings
const CONCURRENCY_LIMIT = 3; // Reduced to 3 to mimic slower human browsing behavior
const MAX_APPS_PER_RUN = 250; // Stable safe rate limit per 5-minute run

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/605.1.15'
];

// App Store Categories to query top charts
const CATEGORIES = {
  Overall: null,
  Games: 6014,
  PhotoVideo: 6008,
  Productivity: 6007,
  Utilities: 6002,
  Entertainment: 6016,
  Education: 6017,
  SocialNetworking: 6005,
  Music: 6011,
  Lifestyle: 6012,
  HealthFitness: 6013,
  GraphicsDesign: 6025,
  Business: 6000,
  Finance: 6015
};

// Helper to clean price strings and parse them to numbers
function parsePrice(priceStr) {
  if (!priceStr) return null;
  const clean = priceStr.replace(/\s+/g, '');
  if (clean.includes('免費') || clean.toLowerCase().includes('free') || clean === '0' || clean.includes('$0')) {
    return 0;
  }
  // Match digits, periods, and commas (e.g. "NT$ 3,290" -> "3290", "$0.99" -> "0.99")
  const match = clean.match(/[\d,.]+/);
  if (match) {
    const val = parseFloat(match[0].replace(/,/g, ''));
    return isNaN(val) ? null : val;
  }
  return null;
}

// Helper to extract currency
function detectCurrency(priceStr) {
  if (!priceStr) return 'TWD';
  if (priceStr.includes('NT$')) return 'TWD';
  if (priceStr.includes('$')) return 'USD';
  if (priceStr.includes('¥')) return 'JPY';
  return 'TWD';
}

// Concurrency Pool Helper
async function asyncPool(concurrency, array, iteratorFn) {
  const ret = [];
  const executing = new Set();
  for (const item of array) {
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  return Promise.all(ret);
}

// Fetch dynamic App Store Top Charts (Free & Paid) across categories
async function getTopChartIds() {
  const ids = new Set();
  const highPriorityIds = new Set();
  const appRanks = {};
  const feeds = [];

  // Generate RSS Feed URLs for overall and major categories
  for (const [name, genreId] of Object.entries(CATEGORIES)) {
    const genreSuffix = genreId ? `/genre=${genreId}` : '';
    // Stable safe limits for round-robin database coverage (yields ~1,000 unique apps)
    const limit = genreId ? 50 : 100;
    
    feeds.push(`https://itunes.apple.com/tw/rss/topfreeapplications/limit=${limit}${genreSuffix}/json`);
    feeds.push(`https://itunes.apple.com/tw/rss/toppaidapplications/limit=${limit}${genreSuffix}/json`);
  }

  console.log(`[Discovery] Fetching ${feeds.length} App Store RSS charts...`);

  // Fetch charts in parallel with concurrency
  await asyncPool(8, feeds, async (url) => {
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const json = await res.json();
      const entries = json.feed?.entry || [];
      entries.forEach((entry, index) => {
        const id = entry.id?.attributes?.['im:id'];
        if (id) {
          const idStr = id.toString();
          ids.add(idStr);
          const rank = index + 1;
          if (!appRanks[idStr] || rank < appRanks[idStr]) {
            appRanks[idStr] = rank;
          }
          if (index < 5) {
            highPriorityIds.add(idStr);
          }
        }
      });
    } catch (err) {
      // Fail silently to avoid clogging logs
    }
  });

  return {
    allIds: Array.from(ids),
    highPriorityIds: Array.from(highPriorityIds),
    appRanks
  };
}

async function scrapeApp(appId) {
  const url = `https://apps.apple.com/tw/app/id${appId}`;
  
  try {
    const randomUA = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const response = await fetch(url, {
      headers: {
        'User-Agent': randomUA,
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8'
      }
    });

    if (!response.ok) {
      return {
        failed: true,
        appId: appId,
        status: response.status
      };
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Extract App Metadata using OpenGraph tags (highly stable)
    let appName = $('meta[property="og:title"]').attr('content') || '';
    appName = appName
      .replace(/在 App Store/g, '')
      .replace(/App Store 上的/g, '')
      .replace(/[《》‎]/g, '')
      .trim();

    if (!appName) return null;

    const storeUrl = $('meta[property="og:url"]').attr('content') || url;
    const iconUrl = $('meta[property="og:image"]').attr('content') || '';
    
    let developer = $('.app-header__identity a').text().trim() || 
                    $('.provider-link').text().trim() || 
                    'Unknown Developer';
    
    let category = $('.app-header__genre').text().trim() || 
                   $('.information-list__item__definition a').first().text().trim() || 
                   'Utility';

    // Extract IAP (In-App Purchases) List
    let iaps = [];
    let shelfMapping = null;
    
    // Try to find the serialized-server-data script tag (new layout)
    const serverDataTag = $('#serialized-server-data');
    if (serverDataTag.length > 0) {
      try {
        const serverData = JSON.parse(serverDataTag.html());
        shelfMapping = serverData?.data?.[0]?.data?.shelfMapping;
      } catch (e) {
        // Fallback silently
      }
    }
    
    // Try to find the shoebox-media-api-cache-apps script tag (older/fallback layout)
    if (!shelfMapping) {
      const shoeboxTag = $('#shoebox-media-api-cache-apps');
      if (shoeboxTag.length > 0) {
        try {
          const shoebox = JSON.parse(shoeboxTag.html());
          for (const key of Object.keys(shoebox)) {
            const payload = JSON.parse(shoebox[key]);
            const mapping = payload?.data?.[0]?.data?.shelfMapping || payload?.data?.[0]?.attributes?.shelfMapping;
            if (mapping) {
              shelfMapping = mapping;
              break;
            }
          }
        } catch (e) {
          // Fallback silently
        }
      }
    }

    if (shelfMapping) {
      const infoItems = shelfMapping.information?.items || [];
      const iapItem = infoItems.find(item => item.items?.[0]?.textPairs);
      if (iapItem && iapItem.items[0].textPairs) {
        iaps = iapItem.items[0].textPairs.map(pair => ({
          name: pair[0],
          priceText: pair[1]
        }));
      }
    }

    // Fallback: If JSON extraction fails, check specific HTML classes (strict fallback)
    if (iaps.length === 0) {
      const selectors = [
        '.list-with-numbers__item',
        '.we-list-with-numbers__item'
      ];
      let foundItems = $(selectors.join(', '));
      foundItems.each((i, el) => {
        const name = $(el).find('.list-with-numbers__title, .we-list-with-numbers__item__title').text().trim();
        const priceText = $(el).find('.list-with-numbers__price, .we-list-with-numbers__item__price').text().trim();
        if (name && priceText) {
          iaps.push({ name, priceText });
        }
      });
    }

    return {
      app: {
        id: appId,
        name: appName,
        developer,
        icon_url: iconUrl,
        category,
        store_url: storeUrl
      },
      iaps: iaps.map(item => ({
        name: item.name,
        price: parsePrice(item.priceText),
        currency: detectCurrency(item.priceText)
      })).filter(iap => iap.price !== null)
    };

  } catch (error) {
    return {
      failed: true,
      appId: appId,
      status: 500,
      message: error.message
    };
  }
}

async function run() {
  try {
    console.log('[Crawler] Starting iOS App Store Multi-Category Crawler...');
    
    // 1. Load watchlists and existing database
    const customWatchlist = fs.existsSync(WATCHLIST_PATH) ? JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8')) : [];
    
    let database = [];
    if (fs.existsSync(DATABASE_PATH)) {
      try {
        database = JSON.parse(fs.readFileSync(DATABASE_PATH, 'utf8'));
      } catch (e) {
        console.warn('[Crawler] Error parsing database.json, starting fresh.', e.message);
      }
    }

    // 2. Discover App IDs from Top Charts
    const { allIds, highPriorityIds, appRanks } = await getTopChartIds();
    console.log(`[Discovery] Found ${allIds.length} active apps from top charts, including ${highPriorityIds.length} high priority apps.`);

    // Merge newly discovered IDs into our master database list
    const knownAppIdsInDb = new Set(database.map(item => item.app_id));
    const newAppIdsToInitialize = allIds.filter(id => !knownAppIdsInDb.has(id));
    
    // Initialize newly discovered apps with dummy records so they enter the round-robin queue
    newAppIdsToInitialize.forEach(appId => {
      database.push({
        id: `${appId}:init`,
        app_id: appId,
        app_name: "Pending Discovery",
        developer: "",
        icon_url: "",
        category: "",
        store_url: "",
        iap_name: "Initialization",
        current_price: -1, // Placeholder
        original_price: -1,
        currency: "TWD",
        is_free: 0,
        last_updated: 0 // Oldest timestamp to prioritize it in next scrapes
      });
    });

    console.log(`[Database] Total apps registered in database: ${new Set(database.map(item => item.app_id)).size}`);

    // 3. Selection Strategy (Dynamic Priority Score Maximization Algorithm)
    const now = Math.floor(Date.now() / 1000);
    const appScores = [];

    // Group database records by app_id to assess their profiles
    const appRecordsMap = {};
    database.forEach(item => {
      if (!appRecordsMap[item.app_id]) {
        appRecordsMap[item.app_id] = [];
      }
      appRecordsMap[item.app_id].push(item);
    });

    for (const appId of Object.keys(appRecordsMap)) {
      const records = appRecordsMap[appId];
      
      // Get the oldest last_updated timestamp among this app's records
      const lastUpdated = Math.min(...records.map(r => r.last_updated || 0));
      
      // Calculate elapsed hours since last checked
      let elapsedHours = 24;
      if (lastUpdated > 0) {
        elapsedHours = Math.max(0.1, (now - lastUpdated) / 3600);
      } else {
        elapsedHours = 72; // Force brand new apps to be scanned immediately
      }

      // Assign Base Weight based on app profile
      let baseWeight = 500; // Default: App with known IAPs (highly valuable to rotate)

      const isWatchlist = customWatchlist.includes(appId);
      const isTopRank = highPriorityIds.includes(appId);
      const isNew = records.some(r => r.iap_name === 'Initialization');
      const isNoIap = records.some(r => r.iap_name === '無內購項目');
      const isActiveFreebie = records.some(r => r.is_free === 1);
      const isFailed404 = records.some(r => r.iap_name === '爬取失敗 (404-不存在)');
      const isFailedTransient = records.some(r => r.iap_name === '爬取失敗 (暫時性錯誤)');
      const isFailedLegacy = records.some(r => r.iap_name === '爬取失敗' || r.app_name === 'Failed Scrape');

      if (isWatchlist) {
        baseWeight = 10000; // Priority 1: User watchlists (always check hourly)
      } else if (isActiveFreebie) {
        baseWeight = 4000;  // Priority 2: Active deals (must check extremely frequently to verify expiration)
      } else if (isTopRank) {
        baseWeight = 3000;  // Priority 3: Top 5 ranked chart apps
      } else if (isNew) {
        baseWeight = 1000;  // Priority 4: Newly discovered placeholders
      } else if (isFailedTransient) {
        baseWeight = 100;   // Priority 6: Transient errors (retry after minor delay)
      } else if (isNoIap) {
        baseWeight = 10;    // Priority 7: Verified Apps with NO IAPs (check once a week)
      } else if (isFailed404 || isFailedLegacy) {
        baseWeight = 1;     // Priority 8: Dead/Deleted links (check very rarely, once a month)
      }

      // 3. Continuous Rank Factor Boost
      const rank = appRanks[appId] || 999;
      const rankMultiplier = 1.0 + (100.0 / rank); // Rank 1 = 101x multiplier, Rank 50 = 3x, Unranked = 1.1x

      const score = baseWeight * elapsedHours * rankMultiplier;
      appScores.push({ appId, score, baseWeight, elapsedHours, rankMultiplier });
    }

    // Sort descending by score
    appScores.sort((a, b) => b.score - a.score);

    // Take the top MAX_APPS_PER_RUN apps
    const appsList = appScores.slice(0, MAX_APPS_PER_RUN).map(item => item.appId);
    console.log(`[Queue] Maximization Queue selected ${appsList.length} apps to scrape (Limit: ${MAX_APPS_PER_RUN}).`);
    
    // Log the top 10 prioritized items for debug transparency
    console.log('[Queue] Top 10 priority targets:');
    appScores.slice(0, 10).forEach((item, idx) => {
      const records = appRecordsMap[item.appId];
      const name = records[0].app_name;
      console.log(`  ${idx+1}. App ${item.appId} ("${name}"): Score ${item.score.toFixed(1)} (Weight ${item.baseWeight}, Elapsed ${item.elapsedHours.toFixed(1)}h)`);
    });

    // 4. Scrape concurrently
    const scrapedData = [];

    console.log(`[Scraper] Starting parallel scrape with concurrency limit of ${CONCURRENCY_LIMIT}...`);
    await asyncPool(CONCURRENCY_LIMIT, appsList, async (appId) => {
      const data = await scrapeApp(appId);
      if (data && !data.failed) {
        scrapedData.push(data);
        console.log(`[Scraper] Scraped successfully: "${data.app.name}" (${data.iaps.length} IAPs)`);
      } else {
        // If scrape fails, we capture the failure status and update last_updated to cycle it
        scrapedData.push({
          failed: true,
          appId: appId,
          status: data ? data.status : 500
        });
      }
      // Add randomized human-like jitter delay between 1.0s and 2.5s to bypass CDN patterns
      const jitterDelay = Math.floor(Math.random() * 1500) + 1000;
      await new Promise(resolve => setTimeout(resolve, jitterDelay));
    });

    // 5. Update Database with scraped results
    let updatedDatabase = database.filter(item => {
      // Remove placeholder initialization records for apps we just crawled
      const isCrawled = appsList.includes(item.app_id);
      const isPlaceholder = item.iap_name === "Initialization";
      return !(isCrawled && isPlaceholder);
    });

    for (const res of scrapedData) {
      if (res.failed) {
        // Distinguish persistent 404 from transient network/rate limit issues (status 403, 429, 500 etc.)
        const errorIapName = res.status === 404 ? "爬取失敗 (404-不存在)" : "爬取失敗 (暫時性錯誤)";
        
        let found = false;
        updatedDatabase = updatedDatabase.map(item => {
          if (item.app_id === res.appId) {
            found = true;
            // Overwrite status to prevent expired deals showing, but keep timestamps up to date
            return { 
              ...item, 
              last_updated: now,
              iap_name: errorIapName,
              is_free: 0
            };
          }
          return item;
        });
        
        // If no records existed (e.g. only initialization placeholder was present), push a failed placeholder record
        if (!found) {
          updatedDatabase.push({
            id: `${res.appId}:failed`,
            app_id: res.appId,
            app_name: "Failed Scrape",
            developer: "",
            icon_url: "",
            category: "Utility",
            store_url: `https://apps.apple.com/tw/app/id${res.appId}`,
            iap_name: errorIapName,
            current_price: -1,
            original_price: -1,
            currency: "TWD",
            is_free: 0,
            last_updated: now
          });
        }
        continue;
      }

      const { app, iaps } = res;

      // Remove any old records for this app that are not in the new scraped IAP list (dynamic clean up)
      const scrapedIapNames = new Set(iaps.map(i => i.name));
      updatedDatabase = updatedDatabase.filter(item => {
        if (item.app_id === app.id) {
          return scrapedIapNames.has(item.iap_name);
        }
        return true;
      });

      if (iaps.length === 0) {
        // If an app has no IAPs, we keep a record of the app itself to know we checked it
        const iapUniqueId = `${app.id}:No-IAP`;
        const existingIndex = updatedDatabase.findIndex(item => item.id === iapUniqueId);
        const record = {
          id: iapUniqueId,
          app_id: app.id,
          app_name: app.name,
          developer: app.developer,
          icon_url: app.icon_url,
          category: app.category,
          store_url: app.store_url,
          iap_name: "無內購項目",
          current_price: -1,
          original_price: -1,
          currency: "TWD",
          is_free: 0,
          last_updated: now
        };
        if (existingIndex !== -1) {
          updatedDatabase[existingIndex] = record;
        } else {
          updatedDatabase.push(record);
        }
      }

      // Upsert each scraped IAP
      for (const iap of iaps) {
        const iapUniqueId = `${app.id}:${iap.name}`;
        const existingIndex = updatedDatabase.findIndex(item => item.id === iapUniqueId);

        let originalPrice = iap.price;
        if (existingIndex !== -1) {
          const existingItem = updatedDatabase[existingIndex];
          // If current price is higher, or we have an older original price, take max
          originalPrice = Math.max(existingItem.original_price || 0, iap.price);
          
          updatedDatabase[existingIndex] = {
            ...existingItem,
            app_name: app.name,
            developer: app.developer,
            icon_url: app.icon_url,
            category: app.category,
            store_url: app.store_url,
            current_price: iap.price,
            original_price: originalPrice,
            currency: iap.currency,
            is_free: iap.price === 0 ? 1 : 0,
            last_updated: now
          };
        } else {
          updatedDatabase.push({
            id: iapUniqueId,
            app_id: app.id,
            app_name: app.name,
            developer: app.developer,
            icon_url: app.icon_url,
            category: app.category,
            store_url: app.store_url,
            iap_name: iap.name,
            current_price: iap.price,
            original_price: originalPrice,
            currency: iap.currency,
            is_free: iap.price === 0 ? 1 : 0,
            last_updated: now
          });
        }
      }
    }

    // 6. Save database.json
    fs.writeFileSync(DATABASE_PATH, JSON.stringify(updatedDatabase, null, 2), 'utf8');
    console.log(`[Database] Saved ${updatedDatabase.length} entries to database.json`);

    // 7. Dynamically update README.md progress table with latest stats
    updateReadmeStats(updatedDatabase);

    // 8. Write currently active freebies to freebies.json
    const activeFreebies = updatedDatabase.filter(item => item.current_price === 0);
    fs.writeFileSync(FREEBIES_PATH, JSON.stringify(activeFreebies, null, 2), 'utf8');
    console.log(`[Database] Saved ${activeFreebies.length} active freebies to freebies.json`);

    console.log('[Crawler] Finished successfully.');
  } catch (error) {
    console.error('[Fatal Error] Crawler execution failed with exception:', error);
    process.exit(1);
  }
}

// Dynamically compute tracking stats and rewrite progress table in README.md
function updateReadmeStats(database) {
  const README_PATH = path.join(__dirname, 'README.md');
  if (!fs.existsSync(README_PATH)) return;

  const uniqueApps = Array.from(new Set(database.map(item => item.app_id)));
  const dayAgo = Math.floor(Date.now() / 1000) - 86400;
  let noIapCount = 0;
  let hasIapCount = 0;
  let pendingCount = 0;
  let failedCount = 0;

  // Group records by app_id to classify each app's state
  const appRecords = {};
  database.forEach(item => {
    if (!appRecords[item.app_id]) appRecords[item.app_id] = [];
    appRecords[item.app_id].push(item);
  });

  Object.keys(appRecords).forEach(appId => {
    const records = appRecords[appId];
    if (records.some(r => r.iap_name === 'Initialization')) {
      pendingCount++;
    } else if (records.some(r => r.iap_name === '無內購項目')) {
      noIapCount++;
    } else if (records.some(r => r.iap_name && r.iap_name.startsWith('爬取失敗'))) {
      failedCount++;
    } else {
      // It has known IAPs. Check if it was scanned within the last 24 hours
      const lastUpdated = Math.max(...records.map(r => r.last_updated || 0));
      if (lastUpdated >= dayAgo) {
        hasIapCount++;
      } else {
        pendingCount++; // Rotates back to pending discovery if not scanned within 24h
      }
    }
  });

  const tableMarkdown = `<!-- STATS_START -->
| 狀態類別 (Category) | 軟體數量 (Count) | 爬取頻率與策略 (Crawl Strategy) |
| :--- | :--- | :--- |
| 🟢 **追蹤中 (Active Tracking)** | **${hasIapCount}** 款 | 證實有內購且 24 小時內偵測過，高頻輪替檢查 |
| ⏳ **待追蹤 (Pending Discovery)** | **${pendingCount}** 款 | 剛進榜或超過 24 小時未偵測，等待爬取中 |
| 💤 **排除中 (No IAP Excluded)** | **${noIapCount}** 款 | 證實無內購，每 3 天低頻冷卻複檢 |
| ❌ **已失效 (Persistent 404)** | **${failedCount}** 款 | 疑似被伺服器阻擋或地區限制，每 30 天極低頻重試 |
| 📦 **總收錄規模 (Total Database)** | **${uniqueApps.length}** 款 | 當前覆蓋的所有 App Store 行動目錄總量 |
<!-- STATS_END -->`;

  try {
    let readmeContent = fs.readFileSync(README_PATH, 'utf8');
    const regex = /<!-- STATS_START -->[\s\S]*?<!-- STATS_END -->/;
    if (regex.test(readmeContent)) {
      readmeContent = readmeContent.replace(regex, tableMarkdown);
      fs.writeFileSync(README_PATH, readmeContent, 'utf8');
      console.log(`[Database] Dynamically updated README.md with current crawl statistics.`);
    }
  } catch (err) {
    console.warn('[Crawler] Failed to update README.md statistics:', err.message);
  }
}

run();
