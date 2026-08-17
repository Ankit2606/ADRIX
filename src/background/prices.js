const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let priceCache = {};
let lastFetch = 0;

// Hardcoded mock prices for demonstration
const MOCK_PRICES = {
  'ETH': 3000.50,
  'WETH': 3000.50,
  'USDC': 1.00,
  'USDT': 1.00,
  'DAI': 1.00,
  'WBTC': 60000.00,
  'LINK': 15.20,
  'MATIC': 0.85,
  'POL': 0.85,
  'BNB': 400.00,
  'ARB': 1.10,
  'OP': 2.50
};

export async function fetchPrices() {
  const now = Date.now();
  if (now - lastFetch < CACHE_TTL && Object.keys(priceCache).length > 0) {
    return priceCache;
  }
  
  // In a real app, we would fetch from CoinGecko or another oracle:
  // const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin,matic-network&vs_currencies=usd');
  // const data = await response.json();
  
  // Using mocks for this demo
  priceCache = { ...MOCK_PRICES };
  lastFetch = now;
  return priceCache;
}

export async function calculateFiatValue(symbol, balanceFormatted) {
  const prices = await fetchPrices();
  const price = prices[symbol.toUpperCase()] || 0;
  return parseFloat(balanceFormatted) * price;
}
