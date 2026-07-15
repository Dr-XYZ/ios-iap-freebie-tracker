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
    // Search filter
    const matchesSearch = 
      item.app_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.developer.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.iap_name.toLowerCase().includes(searchQuery.toLowerCase());
      
    // Category filter
    const isGame = item.category.toLowerCase().includes('game') || item.category.includes('遊戲');
    let matchesCategory = true;
    
    if (activeCategory === 'Game') {
      matchesCategory = isGame;
    } else if (activeCategory === 'App') {
      matchesCategory = !isGame;
    }
    
    return matchesSearch && matchesCategory;
  });
  
  // Render grid
  if (filtered.length === 0) {
    freebiesGrid.classList.add('hidden');
    emptyMessage.classList.remove('hidden');
  } else {
    emptyMessage.classList.add('hidden');
    freebiesGrid.innerHTML = '';
    
    filtered.forEach(item => {
      const card = createCardElement(item);
      freebiesGrid.appendChild(card);
    });
    
    freebiesGrid.classList.remove('hidden');
  }
}

// Create Card Element DOM
function createCardElement(item) {
  const card = document.createElement('article');
  card.className = 'glass-card freebie-card';
  
  // Set placeholder icon if missing
  const iconUrl = item.icon_url || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=128&auto=format&fit=crop&q=60';
  
  // Parse original price display
  const hasOriginalPrice = item.original_price && item.original_price > 0;
  const originalPriceText = hasOriginalPrice ? `${item.currency === 'TWD' ? 'NT$' : '$'} ${item.original_price}` : '';
  
  card.innerHTML = `
    <div class="card-header">
      <img src="${iconUrl}" alt="${item.app_name} Icon" class="app-icon" loading="lazy">
      <div class="app-info">
        <h2 class="app-name" title="${item.app_name}">${item.app_name}</h2>
        <span class="app-developer">${item.developer}</span>
        <span class="category-tag">${item.category}</span>
      </div>
    </div>
    <div class="card-body">
      <div class="iap-details">
        <span class="iap-label">🎁 限免內購項目</span>
        <h3 class="iap-name">${item.iap_name}</h3>
      </div>
      <div class="price-container">
        ${hasOriginalPrice ? `<span class="original-price">${originalPriceText}</span>` : ''}
        <span class="free-price">免費</span>
      </div>
      <a href="${item.store_url}" target="_blank" class="get-btn">
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
