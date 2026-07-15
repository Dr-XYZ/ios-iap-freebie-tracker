// Cloudflare Workers API for iOS App Store IAP Tracker

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;

    // Handle CORS preflight options request
    if (method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Routing
    if (url.pathname === "/api/freebies" && method === "GET") {
      return await handleGetFreebies(env);
    } 
    
    if (url.pathname === "/api/sync" && method === "POST") {
      return await handleSyncData(request, env);
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  }
};

// GET /api/freebies - Returns currently active $0 IAPs
async function handleGetFreebies(env) {
  try {
    const query = `
      SELECT 
        iap.id AS iap_unique_id,
        iap.name AS iap_name,
        iap.current_price,
        iap.original_price,
        iap.currency,
        iap.last_updated AS iap_last_updated,
        app.id AS app_id,
        app.name AS app_name,
        app.developer AS app_developer,
        app.icon_url AS app_icon_url,
        app.category AS app_category,
        app.store_url AS app_store_url
      FROM iap_items iap
      JOIN apps app ON iap.app_id = app.id
      WHERE iap.is_free = 1
      ORDER BY iap.last_updated DESC;
    `;
    
    const { results } = await env.DB.prepare(query).all();
    
    return new Response(JSON.stringify({ success: true, count: results.length, data: results }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  }
}

// POST /api/sync - Sync scraped App & IAP data from Crawler
async function handleSyncData(request, env) {
  try {
    // 1. Authorization Check
    const authHeader = request.headers.get("Authorization");
    const expectedToken = env.API_TOKEN || "freebie-tracker-secure-token";
    
    if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.split(" ")[1] !== expectedToken) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    const payload = await request.json();
    const { app, iaps } = payload;

    if (!app || !app.id || !app.name || !Array.isArray(iaps)) {
      return new Response(JSON.stringify({ success: false, error: "Invalid payload format" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    const now = Math.floor(Date.now() / 1000);

    // 2. Prepare statements to batch DB operations
    const statements = [];

    // Upsert App Metadata
    statements.push(
      env.DB.prepare(`
        INSERT INTO apps (id, name, developer, icon_url, category, store_url, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          developer = excluded.developer,
          icon_url = excluded.icon_url,
          category = excluded.category,
          store_url = excluded.store_url,
          last_updated = excluded.last_updated
      `).bind(app.id, app.name, app.developer || null, app.icon_url || null, app.category || null, app.store_url || null, now)
    );

    // 3. Process IAPs
    for (const iap of iaps) {
      const iapId = `${app.id}:${iap.name}`;
      const isFree = iap.price === 0 ? 1 : 0;
      
      // Fetch existing item (need to do check-then-upsert to manage original_price)
      // Since Cloudflare Worker environment is async, we can run a select first.
      // D1 transactions/batches run sequentially. We can query current original_price first.
      const existing = await env.DB.prepare("SELECT original_price, current_price FROM iap_items WHERE id = ?").bind(iapId).first();
      
      let originalPrice = iap.price;
      let prevPrice = null;

      if (existing) {
        // Keep the highest price we've seen as original_price (so if it goes free, we know original price)
        originalPrice = Math.max(existing.original_price || 0, iap.price);
        prevPrice = existing.current_price;
      }

      // Upsert IAP
      statements.push(
        env.DB.prepare(`
          INSERT INTO iap_items (id, app_id, name, current_price, original_price, currency, is_free, last_updated)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            current_price = excluded.current_price,
            original_price = excluded.original_price,
            currency = excluded.currency,
            is_free = excluded.is_free,
            last_updated = excluded.last_updated
        `).bind(iapId, app.id, iap.name, iap.price, originalPrice, iap.currency || "TWD", isFree, now)
      );

      // If price changed, record historical snapshot
      if (prevPrice === null || prevPrice !== iap.price) {
        statements.push(
          env.DB.prepare(`
            INSERT INTO price_history (iap_id, price, recorded_at)
            VALUES (?, ?, ?)
          `).bind(iapId, iap.price, now)
        );
      }
    }

    // Execute database operations in a single batch
    await env.DB.batch(statements);

    return new Response(JSON.stringify({ success: true, message: `Synced app ${app.name} with ${iaps.length} IAPs.` }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });

  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  }
}
