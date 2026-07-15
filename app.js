// State Management
let freebiesData = [];
let activeCategory = 'all';
let searchQuery = '';

// DOM Elements
const loadingSpinner = document.getElementById('loading-spinner');
const emptyMessage = document.getElementById('empty-message');
const freebiesGrid = document.getElementById('freebies-grid');
const freebieCountBadge = document.getElementById('freebie-count');
const searchInput = document.getElementById('search-input');
const filterButtons = document.querySelectorAll('.filter-btn');
const updateTimeText = document.getElementById('update-time');
const repoLink = document.getElementById('repo-link');

// HTML Sanitization helper (XSS Prevention)
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Format date helper
function formatTime(epochSeconds) {
  if (!epochSeconds) return '未知';
  const date = new Date(epochSeconds * 1000);
  return date.toLocaleString('zh-TW', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

// Dynamically set repository link based on URL
function setupRepoLink() {
  const hostname = window.location.hostname;
  const pathname = window.location.pathname;
  
  if (hostname.includes('github.io')) {
    const user = hostname.split('.')[0];
    const repo = pathname.split('/')[1] || '';
    if (repo) {
      repoLink.href = `https://github.com/${user}/${repo}`;
    } else {
      repoLink.href = `https://github.com/${user}`;
    }
  }
}

// Fetch and load data
async function loadFreebies() {
  try {
    // Read the static JSON file in the same directory
    const response = await fetch('freebies.json');
    if (!response.ok) {
      throw new Error(`Failed to load freebies.json: ${response.statusText}`);
    }
    
    freebiesData = await response.json();
    
    // Sort: newest first
    freebiesData.sort((a, b) => b.last_updated - a.last_updated);
    
    renderData();
    updateHeaderStats();
    
  } catch (error) {
    console.error('Error loading freebie data:', error);
    loadingSpinner.classList.add('hidden');
    emptyMessage.querySelector('p').textContent = '載入資料時出錯，請確認網站是否已正確部署。';
    emptyMessage.classList.remove('hidden');
  }
}

// Update Counts & Last Update Timestamp
function updateHeaderStats() {
  // Count
  freebieCountBadge.textContent = `${freebiesData.length} 個限免中`;
  
  // Last Update Time
  if (freebiesData.length > 0) {
    const latestTimestamp = Math.max(...freebiesData.map(item => item.last_updated || 0));
    updateTimeText.textContent = `最後更新：${formatTime(latestTimestamp)}`;
  } else {
    updateTimeText.textContent = `最後更新：剛剛`;
  }
}

// Render cards
function renderData() {
  // Hide loading
  loadingSpinner.classList.add('hidden');
  
  // Filter items
  const filtered = freebiesData.filter(item => {
    // Defensive coding for null properties
    const appName = item.app_name || '';
    const developer = item.developer || '';
    const iapName = item.iap_name || '';
    const category = item.category || '';

    // Search filter
    const matchesSearch = 
      appName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      developer.toLowerCase().includes(searchQuery.toLowerCase()) ||
      iapName.toLowerCase().includes(searchQuery.toLowerCase());
      
    // Category filter
    const isGame = category.toLowerCase().includes('game') || category.includes('遊戲');
    let matchesCategory = true;
    
    if (activeCategory === 'Game') {
      matchesCategory = isGame;
    } else if (activeCategory === 'App') {
      matchesCategory = !isGame;
    }
    
    return matchesSearch && matchesCategory;
  });

  // Group by app_id to display multiple free IAPs in a single card
  const groupedApps = {};
  filtered.forEach(item => {
    if (!groupedApps[item.app_id]) {
      groupedApps[item.app_id] = {
        app_id: item.app_id,
        app_name: item.app_name,
        developer: item.developer,
        icon_url: item.icon_url,
        category: item.category,
        store_url: item.store_url,
        last_updated: item.last_updated,
        freebies: []
      };
    }
    // Avoid duplicates for identical IAPs
    if (!groupedApps[item.app_id].freebies.some(f => f.iap_name === item.iap_name)) {
      groupedApps[item.app_id].freebies.push({
        iap_name: item.iap_name,
        original_price: item.original_price,
        currency: item.currency
      });
    }
    if (item.last_updated > groupedApps[item.app_id].last_updated) {
      groupedApps[item.app_id].last_updated = item.last_updated;
    }
  });

  const groupedList = Object.values(groupedApps);
  
  // Sort: newest update first
  groupedList.sort((a, b) => b.last_updated - a.last_updated);
  
  // Update badge count with number of unique apps having active IAPs free
  freebieCountBadge.textContent = `${groupedList.length} 款軟體限免中`;

  // Render grid
  if (groupedList.length === 0) {
    freebiesGrid.classList.add('hidden');
    emptyMessage.classList.remove('hidden');
  } else {
    emptyMessage.classList.add('hidden');
    freebiesGrid.innerHTML = '';
    
    groupedList.forEach(app => {
      const card = createCardElement(app);
      freebiesGrid.appendChild(card);
    });
    
    freebiesGrid.classList.remove('hidden');
  }
}

// Create Card Element DOM grouped by App
function createCardElement(app) {
  const card = document.createElement('article');
  card.className = 'glass-card freebie-card';
  
  const iconUrl = app.icon_url || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=128&auto=format&fit=crop&q=60';
  const safeIconUrl = (iconUrl.startsWith('http') || iconUrl.startsWith('https')) ? escapeHtml(iconUrl) : '';
  const safeStoreUrl = (app.store_url && (app.store_url.startsWith('http') || app.store_url.startsWith('https'))) ? escapeHtml(app.store_url) : '#';
  
  const escapedAppName = escapeHtml(app.app_name);
  const escapedDeveloper = escapeHtml(app.developer);
  const escapedCategory = escapeHtml(app.category);

  // Render list of IAPs
  let freebiesHtml = '';
  app.freebies.forEach(f => {
    const hasOriginalPrice = f.original_price && f.original_price > 0;
    const escapedIapName = escapeHtml(f.iap_name);
    const originalPriceText = hasOriginalPrice ? `${escapeHtml(f.currency) === 'TWD' ? 'NT$' : '$'} ${escapeHtml(f.original_price)}` : '';
    
    freebiesHtml += `
      <div class="iap-item-row">
        <div class="iap-item-info">
          <span class="iap-item-bullet">🎁</span>
          <span class="iap-item-name" title="${escapedIapName}">${escapedIapName}</span>
        </div>
        <div class="iap-item-pricing">
          ${hasOriginalPrice ? `<span class="original-price">${originalPriceText}</span>` : ''}
          <span class="free-price">免費</span>
        </div>
      </div>
    `;
  });
  
  card.innerHTML = `
    <div class="card-header">
      ${safeIconUrl ? `<img src="${safeIconUrl}" alt="${escapedAppName} Icon" class="app-icon" loading="lazy">` : `<div class="app-icon-placeholder">🎁</div>`}
      <div class="app-info">
        <h2 class="app-name" title="${escapedAppName}">${escapedAppName}</h2>
        <span class="app-developer">${escapedDeveloper}</span>
        <span class="category-tag">${escapedCategory}</span>
      </div>
    </div>
    <div class="card-body">
      <span class="iap-label">🎁 限免內購項目</span>
      <div class="iap-list-container">
        ${freebiesHtml}
      </div>
      <a href="${safeStoreUrl}" target="_blank" class="get-btn">
        <span>在 App Store 取得</span>
        <span>➔</span>
      </a>
    </div>
  `;
  
  return card;
}

// Search Event Listener
searchInput.addEventListener('input', (e) => {
  searchQuery = e.target.value.trim();
  renderData();
});

// Category Filter Button Event Listeners
filterButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    filterButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeCategory = btn.getAttribute('data-category');
    renderData();
  });
});

// Initialization
document.addEventListener('DOMContentLoaded', () => {
  setupRepoLink();
  loadFreebies();
});
