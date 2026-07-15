const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

// Configuration paths
const WATCHLIST_PATH = path.join(__dirname, 'watchlist.json');
const DATABASE_PATH = path.join(__dirname, 'database.json');
const FREEBIES_PATH = path.join(__dirname, 'freebies.json');

// Concurrency Settings
const CONCURRENCY_LIMIT = 5;
const MAX_APPS_PER_RUN = 250; // Stable safe rate limit for GitHub Actions (concurrency 5, delay 500ms)

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
    return parseFloat(match[0].replace(/,/g, ''));
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
          // If in top 5 of the chart, mark as high priority
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
    highPriorityIds: Array.from(highPriorityIds)
  };
}

async function scrapeApp(appId) {
  const url = `https://apps.apple.com/tw/app/id${appId}`;
  
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP status ${response.status}`);
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
    // console.error(`Error scraping ${appId}:`, error.message);
    return null;
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
    const { allIds, highPriorityIds } = await getTopChartIds();
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

    // 3. Selection Strategy (Priority Queue & Round-Robin)
    // - Priority 1: User's custom watchlist (always checked)
    // - Priority 2: High priority top-ranked apps (Top 5 of each chart, always checked)
    // - Priority 3: Oldest updated apps in the database (Round-Robin)
    
    const appsToScrape = new Set([...customWatchlist, ...highPriorityIds]);
    console.log(`[Queue] High-priority scraping target count: ${appsToScrape.size} apps (watchlist + top 5 charts).`);
    
    // Get all unique app IDs in the database, sorted by their oldest check time
    const appLastUpdatedMap = {};
    database.forEach(item => {
      if (!appLastUpdatedMap[item.app_id] || item.last_updated < appLastUpdatedMap[item.app_id]) {
        appLastUpdatedMap[item.app_id] = item.last_updated;
      }
    });

    const sortedAppIds = Object.keys(appLastUpdatedMap).sort((a, b) => appLastUpdatedMap[a] - appLastUpdatedMap[b]);
    
    // Fill remaining slots up to MAX_APPS_PER_RUN
    for (const appId of sortedAppIds) {
      if (appsToScrape.size >= MAX_APPS_PER_RUN) break;
      appsToScrape.add(appId);
    }

    const appsList = Array.from(appsToScrape);
    console.log(`[Queue] Selected ${appsList.length} apps to scrape in this run (including ${customWatchlist.length} from watchlist).`);

    // 4. Scrape concurrently
    const now = Math.floor(Date.now() / 1000);
    const scrapedData = [];

    console.log(`[Scraper] Starting parallel scrape with concurrency limit of ${CONCURRENCY_LIMIT}...`);
    await asyncPool(CONCURRENCY_LIMIT, appsList, async (appId) => {
      const data = await scrapeApp(appId);
      if (data) {
        scrapedData.push(data);
        console.log(`[Scraper] Scraped successfully: "${data.app.name}" (${data.iaps.length} IAPs)`);
      } else {
        // If scrape fails, we still update the timestamp in database so it rotates to the back of the queue
        scrapedData.push({
          failed: true,
          appId: appId
        });
      }
      // Artificial small delay between batches
      await new Promise(resolve => setTimeout(resolve, 500));
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
        // For failed scrapes, update the last_updated time of existing records so they cycle in round-robin
        let found = false;
        updatedDatabase = updatedDatabase.map(item => {
          if (item.app_id === res.appId) {
            found = true;
            return { ...item, last_updated: now };
          }
          return item;
        });
        
        // If no records existed (e.g. only placeholder existed, but it was filtered out), put a failed placeholder back
        if (!found) {
          updatedDatabase.push({
            id: `${res.appId}:failed`,
            app_id: res.appId,
            app_name: "Failed Scrape",
            developer: "",
            icon_url: "",
            category: "Utility",
            store_url: `https://apps.apple.com/tw/app/id${res.appId}`,
            iap_name: "爬取失敗",
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

    // 7. Write currently active freebies to freebies.json
    const activeFreebies = updatedDatabase.filter(item => item.current_price === 0);
    fs.writeFileSync(FREEBIES_PATH, JSON.stringify(activeFreebies, null, 2), 'utf8');
    console.log(`[Database] Saved ${activeFreebies.length} active freebies to freebies.json`);

    console.log('[Crawler] Finished successfully.');
  } catch (error) {
    console.error('[Fatal Error] Crawler execution failed with exception:', error);
    process.exit(1);
  }
}

run();
