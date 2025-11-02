// Cloudflare Worker DoH Proxy
// RFC 8484 compliant DNS-over-HTTPS proxy with intelligent routing

const CACHE_TTL = 300; // 5 minutes
const TIMEOUT = 5000; // 5 seconds
const MAX_RETRIES = 2;

// Performance tracking for intelligent routing
const performanceCache = new Map();
const PERFORMANCE_WINDOW = 100; // Track last 100 requests per upstream

// Default DoH upstreams (will be overridden by DOH_UPSTREAMS env var)
const DEFAULT_UPSTREAMS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/dns-query',
  'https://dns.quad9.net/dns-query',
  'https://doh.opendns.com/dns-query',
];

// Regional DoH servers for geo-routing
const REGIONAL_UPSTREAMS = {
  'NA': [ // North America
    'https://cloudflare-dns.com/dns-query',
    'https://dns.google/dns-query',
  ],
  'EU': [ // Europe
    'https://cloudflare-dns.com/dns-query',
    'https://dns.quad9.net/dns-query',
  ],
  'AS': [ // Asia
    'https://dns.google/dns-query',
    'https://cloudflare-dns.com/dns-query',
    'https://doh.dns.sb/dns-query',
  ],
  'OC': [ // Oceania
    'https://cloudflare-dns.com/dns-query',
    'https://dns.google/dns-query',
  ],
  'SA': [ // South America
    'https://cloudflare-dns.com/dns-query',
    'https://dns.google/dns-query',
  ],
  'AF': [ // Africa
    'https://cloudflare-dns.com/dns-query',
    'https://dns.quad9.net/dns-query',
  ],
};

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // Handle CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400',
          }
        });
      }

      // Only handle /dns-query path
      if (url.pathname !== '/dns-query') {
        return new Response('DoH Proxy - Use /dns-query endpoint', {
          status: 404,
          headers: { 'Content-Type': 'text/plain' }
        });
      }

      // Get upstreams from environment variable or use defaults
      const upstreamsStr = env?.DOH_UPSTREAMS;
      let upstreams = DEFAULT_UPSTREAMS;

      if (upstreamsStr) {
        try {
          upstreams = upstreamsStr.split(',').map(u => u.trim()).filter(u => u);
        } catch (e) {
          console.error('Failed to parse DOH_UPSTREAMS:', e);
        }
      }

      // Get client region for geo-routing
      const clientRegion = getClientRegion(request);
      const regionalUpstreams = REGIONAL_UPSTREAMS[clientRegion] || [];

      // Combine regional and general upstreams
      const allUpstreams = [...new Set([...regionalUpstreams, ...upstreams])];

      let dnsQuery;
      let isGetRequest = request.method === 'GET';

      // Handle GET request (base64url encoded dns parameter)
      if (isGetRequest) {
        const dnsParam = url.searchParams.get('dns');
        if (!dnsParam) {
          return new Response('Missing dns parameter', {
            status: 400,
            headers: { 'Content-Type': 'text/plain' }
          });
        }

        try {
          dnsQuery = base64urlDecode(dnsParam);
        } catch (e) {
          return new Response('Invalid dns parameter encoding', {
            status: 400,
            headers: { 'Content-Type': 'text/plain' }
          });
        }
      }
      // Handle POST request (binary DNS message in body)
      else if (request.method === 'POST') {
        const contentType = request.headers.get('content-type') || '';
        if (!contentType.includes('application/dns-message')) {
          return new Response('Invalid Content-Type. Must be application/dns-message', {
            status: 400,
            headers: { 'Content-Type': 'text/plain' }
          });
        }

        dnsQuery = await request.arrayBuffer();
        if (dnsQuery.byteLength === 0 || dnsQuery.byteLength > 512) {
          return new Response('Invalid DNS message size', {
            status: 400,
            headers: { 'Content-Type': 'text/plain' }
          });
        }
      } else {
        return new Response('Method not allowed. Use GET or POST', {
          status: 405,
          headers: {
            'Content-Type': 'text/plain',
            'Allow': 'GET, POST'
          }
        });
      }

      // Try cache first
      const cacheKey = new Request(request.url, { method: 'GET' });
      const cache = caches.default;
      let response = await cache.match(cacheKey);

      if (response) {
        response = new Response(response.body, response);
        response.headers.set('X-Cache', 'HIT');
        return response;
      }

      // Race multiple upstreams with intelligent selection
      const selectedUpstreams = selectBestUpstreams(allUpstreams, 3);

      try {
        response = await raceDoHRequests(selectedUpstreams, dnsQuery, isGetRequest);
      } catch (e) {
        // Fallback to all upstreams if racing fails
        response = await raceDoHRequests(allUpstreams, dnsQuery, isGetRequest);
      }

      if (!response || !response.ok) {
        return new Response('All upstream DoH servers failed', {
          status: 502,
          headers: { 'Content-Type': 'text/plain' }
        });
      }

      // Build proper DoH response
      const dohResponse = new Response(response.body, {
        status: 200,
        headers: {
          'Content-Type': 'application/dns-message',
          'Cache-Control': `public, max-age=${CACHE_TTL}`,
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'X-Cache': 'MISS',
          'X-Upstream': response.headers.get('X-Upstream') || 'unknown',
        }
      });

      // Cache the response
      ctx.waitUntil(cache.put(cacheKey, dohResponse.clone()));

      return dohResponse;

    } catch (error) {
      console.error('DoH Proxy Error:', error);
      return new Response(`Internal Server Error: ${error.message}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  }
};

// Race multiple DoH requests and return the fastest
async function raceDoHRequests(upstreams, dnsQuery, isGetRequest) {
  if (upstreams.length === 0) {
    throw new Error('No upstreams available');
  }

  return new Promise((resolve, reject) => {
    let resolved = false;
    let failedCount = 0;
    const startTime = Date.now();

    upstreams.forEach(async (upstream) => {
      try {
        const upstreamStart = Date.now();
        const response = await fetchWithTimeout(
          upstream,
          dnsQuery,
          isGetRequest,
          TIMEOUT
        );

        if (!resolved && response.ok) {
          resolved = true;
          const latency = Date.now() - upstreamStart;

          // Track performance
          updatePerformanceMetrics(upstream, latency, true);

          // Add upstream header
          response.headers.set('X-Upstream', upstream);
          response.headers.set('X-Latency', `${latency}ms`);

          resolve(response);
        } else if (!response.ok) {
          updatePerformanceMetrics(upstream, Date.now() - upstreamStart, false);
          failedCount++;
        }
      } catch (error) {
        updatePerformanceMetrics(upstream, TIMEOUT, false);
        failedCount++;

        if (!resolved && failedCount === upstreams.length) {
          reject(new Error('All upstreams failed'));
        }
      }
    });

    // Timeout fallback
    setTimeout(() => {
      if (!resolved) {
        reject(new Error('All requests timed out'));
      }
    }, TIMEOUT + 1000);
  });
}

// Fetch with timeout
async function fetchWithTimeout(upstream, dnsQuery, isGetRequest, timeout) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    let fetchOptions;
    let fetchUrl = upstream;

    if (isGetRequest) {
      const encodedQuery = base64urlEncode(new Uint8Array(dnsQuery));
      fetchUrl = `${upstream}?dns=${encodedQuery}`;
      fetchOptions = {
        method: 'GET',
        headers: {
          'Accept': 'application/dns-message',
          'User-Agent': 'DoH-Proxy/1.0',
        },
        signal: controller.signal,
      };
    } else {
      fetchOptions = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/dns-message',
          'Accept': 'application/dns-message',
          'User-Agent': 'DoH-Proxy/1.0',
        },
        body: dnsQuery,
        signal: controller.signal,
      };
    }

    const response = await fetch(fetchUrl, fetchOptions);
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// Base64url encoding (RFC 4648)
function base64urlEncode(buffer) {
  const base64 = btoa(String.fromCharCode(...buffer));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Base64url decoding
function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) {
    str += '=';
  }
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// Get client region from Cloudflare headers
function getClientRegion(request) {
  const country = request.cf?.country || 'US';

  // Map countries to regions
  const regionMap = {
    'US': 'NA', 'CA': 'NA', 'MX': 'NA',
    'GB': 'EU', 'DE': 'EU', 'FR': 'EU', 'IT': 'EU', 'ES': 'EU', 'NL': 'EU', 'SE': 'EU', 'NO': 'EU', 'DK': 'EU', 'FI': 'EU', 'PL': 'EU', 'CH': 'EU', 'AT': 'EU', 'BE': 'EU', 'IE': 'EU', 'PT': 'EU', 'CZ': 'EU', 'GR': 'EU', 'RO': 'EU', 'HU': 'EU',
    'CN': 'AS', 'JP': 'AS', 'KR': 'AS', 'IN': 'AS', 'SG': 'AS', 'TH': 'AS', 'VN': 'AS', 'ID': 'AS', 'MY': 'AS', 'PH': 'AS', 'TW': 'AS', 'HK': 'AS',
    'AU': 'OC', 'NZ': 'OC',
    'BR': 'SA', 'AR': 'SA', 'CL': 'SA', 'CO': 'SA', 'PE': 'SA',
    'ZA': 'AF', 'EG': 'AF', 'NG': 'AF', 'KE': 'AF',
  };

  return regionMap[country] || 'NA';
}

// Track performance metrics for each upstream
function updatePerformanceMetrics(upstream, latency, success) {
  if (!performanceCache.has(upstream)) {
    performanceCache.set(upstream, {
      latencies: [],
      successRate: 1,
      totalRequests: 0,
    });
  }

  const metrics = performanceCache.get(upstream);
  metrics.totalRequests++;

  if (success) {
    metrics.latencies.push(latency);
    if (metrics.latencies.length > PERFORMANCE_WINDOW) {
      metrics.latencies.shift();
    }
  }

  metrics.successRate = success
    ? Math.min(metrics.successRate + 0.1, 1)
    : Math.max(metrics.successRate - 0.2, 0);
}

// Select best upstreams based on performance history
function selectBestUpstreams(upstreams, count) {
  const scored = upstreams.map(upstream => {
    const metrics = performanceCache.get(upstream);

    if (!metrics || metrics.latencies.length === 0) {
      return { upstream, score: 1000 }; // Give new upstreams a chance
    }

    const avgLatency = metrics.latencies.reduce((a, b) => a + b, 0) / metrics.latencies.length;
    const score = avgLatency / metrics.successRate;

    return { upstream, score };
  });

  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, count).map(s => s.upstream);
}
