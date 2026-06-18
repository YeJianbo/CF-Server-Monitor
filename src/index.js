import { initDatabase, cleanupOldData, getMetricsHistory, rebuildDatabase } from './database/schema.js';
import { checkOfflineNodes } from './services/notification.js';
import { updateDatabase } from './database/updateDatabase.js';
import { handleAdminAPI } from './handlers/admin.js';
import { serveFrontend } from './handlers/frontend.js';
import { handleUpdate, handleWebSocketUpgrade } from './handlers/update.js';
import { handleServerAPI, handleServersAPI } from './handlers/dashboard.js';
import { loadSettings, loadSiteSettings } from './utils/settings.js';
import { checkAuth, simpleAuthResponse } from './middleware/auth.js';
import { getServerDetail, getMetricsHistoryCache, setMetricsHistoryCache } from './utils/cache.js';
import { createSuccessResponse, createUnauthorizedResponse, createBadRequestResponse } from './utils/errors.js';

// Durable Objects: 实时指标广播
// 显式 import + extends，确保 wrangler 静态分析器能在入口文件直接识别此 DO 类
import { MetricsBroadcaster as _MetricsBroadcaster }
  from './durable/MetricsBroadcaster.js';

export class MetricsBroadcaster extends _MetricsBroadcaster {}

function normalizeReportInterval(value) {
  const n = parseInt(value, 10);
  if ([30, 60, 120, 180, 300, 600].includes(n)) return n;
  return 180;
}

function normalizePingMode(value) {
  const v = String(value || '').toLowerCase();
  if (['off', 'http', 'tcp'].includes(v)) return v;
  return 'off';
}

async function handleAgentConfigAPI(request, env, sys) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';
  const secret = url.searchParams.get('secret') || '';

  if (!id || !secret) return createBadRequestResponse('Missing id or secret');
  if (secret !== env.API_SECRET) return createUnauthorizedResponse('Invalid secret');

  const server = await env.DB.prepare(`
    SELECT id, report_interval, ping_mode, reset_day
    FROM servers
    WHERE id = ?
  `).bind(id).first();

  if (!server) {
    return new Response(JSON.stringify({ error: 'Server not found', code: 404 }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const inheritedPingMode = sys?.default_ping_enabled === 'true' ? sys?.default_ping_mode : 'off';

  return createSuccessResponse({
    report_interval: normalizeReportInterval(server.report_interval || sys?.default_report_interval),
    ping_mode: normalizePingMode(server.ping_mode || inheritedPingMode),
    reset_day: parseInt(server.reset_day || 1, 10) || 1,
    custom_ct: sys?.custom_ct || '',
    custom_cu: sys?.custom_cu || '',
    custom_cm: sys?.custom_cm || '',
    custom_bd: sys?.custom_bd || '',
    config_ttl: 300
  }, {
    'Cache-Control': 'no-store'
  });
}

async function getEncryptionKey(env) {
  const secret = env.TURNSTILE_SECRET_KEY || env.API_SECRET || 'default_secret_key_for_turnstile_encryption';
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(hash).slice(0, 32),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
  return keyMaterial;
}

async function encryptCookieData(data, env) {
  const key = await getEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const encodedData = encoder.encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    encodedData
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decryptCookieData(encoded, env) {
  try {
    const key = await getEncryptionKey(env);
    const decoded = new Uint8Array(atob(encoded).split('').map(c => c.charCodeAt(0)));
    const iv = decoded.slice(0, 12);
    const ciphertext = decoded.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      ciphertext
    );
    const encoder = new TextDecoder();
    return JSON.parse(encoder.decode(decrypted));
  } catch (e) {
    console.error('Cookie decryption error:', e);
    return null;
  }
}

async function verifyTurnstileToken(token, secretKey) {
  if (!token || !secretKey) {
    return false;
  }
  
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        secret: secretKey,
        response: token
      })
    });
    
    const data = await response.json();
    return data.success === true;
  } catch (e) {
    console.error('Turnstile verification error:', e);
    return false;
  }
}

async function fetchHistoryData(env, request, id, hours, columns, sys = null) {
  if (!id) return createBadRequestResponse('Missing ID');
  
  if (!sys) {
    sys = await loadSettings(env.DB);
  }
  const isLoggedIn = await checkAuth(request, env, sys);
  
  if (sys.is_public !== 'true' && !isLoggedIn) {
    return simpleAuthResponse();
  }
  
  if (hours > 1 && !isLoggedIn) {
    return createUnauthorizedResponse();
  }
  
  const server = await getServerDetail(env.DB, id, isLoggedIn);
  if (!server) return new Response('Not Found', { status: 404 });
  
  const clampedHours = Math.min(hours, 72);
  
  const cached = getMetricsHistoryCache(id, clampedHours, columns);
  if (cached && Date.now() - cached.timestamp < 60000) {
    return createSuccessResponse(cached.data, { 'X-Cache': 'HIT' });
  }
  
  const data = await getMetricsHistory(env.DB, id, clampedHours, columns);
  
  setMetricsHistoryCache(id, clampedHours, columns, data);
  
  return createSuccessResponse(data, { 'X-Cache': 'MISS' });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    if (!env.API_SECRET || env.API_SECRET.length === 0) {
      return createBadRequestResponse('API_SECRET is required');
    }

    if (env.ASSETS && method === 'GET') {
      try {
        const res = await env.ASSETS.fetch(new Request(`http://static${path}`, request));
        if (res.ok) {
          return res;
        }
      } catch (e) {
      }
    }

    const bypassTurnstilePaths = [
      '/update',
      '/admin/api',
      '/api/config',
      '/api/agent-config',
      '/favicon.ico',
      '/logo.svg',
      '/install.sh',
      '/install-auto.sh',
      '/install-alpine.sh',
      '/install-openwrt.sh'
    ];

    const isApiRequest = path.startsWith('/api/') || path.startsWith('/admin/api');
    if (path === '/api/config' || path === '/api/agent-config' || path === '/rebuild') {
      await initDatabase(env.DB);
    }

    let setTurnstileCookie = false;
    let sys = null;
    
    if (isApiRequest && !bypassTurnstilePaths.includes(path)) {
      sys = await loadSiteSettings(env.DB);
      const turnstileEnabled = sys.turnstile_enabled === 'true';
      const turnstileSecretKey = sys.turnstile_secret_key || '';
      
      if (turnstileEnabled) {
        const cookies = request.headers.get('Cookie') || '';
        const turnstileCookie = cookies.split(';').find(c => c.trim().startsWith('turnstile_verified='));
        
        let hasValidCookie = false;
        if (turnstileCookie) {
          const encryptedData = turnstileCookie.split('=')[1];
          const decrypted = await decryptCookieData(encryptedData, env);
          if (decrypted && decrypted.expires && Date.now() < decrypted.expires * 1000) {
            hasValidCookie = true;
          }
        }
        
        if (!hasValidCookie) {
          const turnstileToken = request.headers.get('X-Turnstile-Token');
          const isVerified = await verifyTurnstileToken(turnstileToken, turnstileSecretKey);
          
          if (!isVerified) {
            return new Response(JSON.stringify({ error: 'Turnstile verification failed', code: 403 }), {
              status: 403,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          
          setTurnstileCookie = true;
        }
      }
    }

    async function ensureSiteSettings() {
      if (!sys) {
        sys = await loadSiteSettings(env.DB);
      }
      return sys;
    }

    async function ensureFullSettings() {
      if (!sys || !sys.site_title) {
        sys = await loadSettings(env.DB);
      }
      return sys;
    }

    const routes = [
      { method: 'POST', path: '/update', handler: () => handleUpdate(request, env, ctx) },
      { method: 'GET', path: '/api/agent-config', handler: async () => {
        await ensureSiteSettings();
        return handleAgentConfigAPI(request, env, sys);
      }},
      { method: 'GET', path: '/__do/health', handler: async () => {
        if (!env.METRICS_BROADCASTER) {
          return createSuccessResponse({ ok: false, reason: 'DO not bound' });
        }
        try {
          const id = env.METRICS_BROADCASTER.idFromName('global');
          const stub = env.METRICS_BROADCASTER.get(id);
          return await stub.fetch('http://internal/health');
        } catch (e) {
          return createSuccessResponse({ ok: false, reason: e.message });
        }
      }},
      { method: 'GET', path: '/api/config', handler: async () => {
        await ensureSiteSettings();
        const turnstileEnabled = sys.turnstile_enabled === 'true';
        let cookieAuth = false;
        
        if (turnstileEnabled) {
          const cookies = request.headers.get('Cookie') || '';
          const turnstileCookie = cookies.split(';').find(c => c.trim().startsWith('turnstile_verified='));
          
          if (turnstileCookie) {
            const encryptedData = turnstileCookie.split('=')[1];
            const decrypted = await decryptCookieData(encryptedData, env);
            if (decrypted && decrypted.expires && Date.now() < decrypted.expires * 1000) {
              cookieAuth = true;
            }
          }
        }
        
        return createSuccessResponse({
          turnstile_enabled: turnstileEnabled,
          turnstile_site_key: sys.turnstile_site_key || '',
          cookie_auth: cookieAuth
        });
      }},
      { method: 'GET', path: '/api/server', handler: async () => {
        await ensureSiteSettings();
        return handleServerAPI(request, env, sys);
      }},
      { method: 'GET', path: '/api/servers', handler: async () => {
        await ensureFullSettings();
        return handleServersAPI(request, env, sys);
      }},
      { method: 'GET', path: '/api/ws', handler: async () => handleWebSocketUpgrade(request, env) },

      { method: 'GET', path: '/api/history/all', handler: async () => {
        await ensureSiteSettings();
        const id = url.searchParams.get('id');
        const hours = parseFloat(url.searchParams.get('hours') || '24');
        const allColumns = 'cpu, ram, disk, processes, net_in_speed, net_out_speed, tcp_conn, udp_conn, ping_ct, ping_cu, ping_cm, ping_bd, swap_total, swap_used, load_avg';
        return fetchHistoryData(env, request, id, hours, allColumns, sys);
      }},
      { method: 'POST', path: '/admin/api', handler: async () => {
        await ensureFullSettings();
        return handleAdminAPI(request, env, sys);
      }},
      { method: 'GET', path: '/updateDatabase', handler: async () => {
        await ensureSiteSettings();
        if (!await checkAuth(request, env, sys)) {
          return simpleAuthResponse();
        }
        const result = await updateDatabase(env.DB);
        return createSuccessResponse(result);
      }},
      { method: 'GET', path: '/rebuild', handler: async () => {
        await ensureSiteSettings();
        if (!await checkAuth(request, env, sys)) {
          return simpleAuthResponse();
        }
        const result = await rebuildDatabase(env.DB);
        return createSuccessResponse(result);
      }}
    ];

    for (const route of routes) {
      if (route.method === method && route.path === path) {
        const response = await route.handler();
        
        if (setTurnstileCookie && response) {
          const expires = Math.floor(Date.now() / 1000) + 3600;
          const cookieData = { expires, verified: true, timestamp: Date.now() };
          const encryptedCookie = await encryptCookieData(cookieData, env);
          
          const newHeaders = new Headers(response.headers);
          newHeaders.set('Set-Cookie', `turnstile_verified=${encryptedCookie}; path=/; max-age=3600; SameSite=Lax; HttpOnly`);
          
          const newResponse = new Response(response.body, {
            status: response.status,
            headers: newHeaders
          });
          return newResponse;
        }
        
        return response;
      }
    }

    await ensureFullSettings();
    return serveFrontend(request, env, sys);
  },

  async scheduled(event, env, ctx) {
    const cron = event.cron;
    console.log(`[Cron] 定时任务触发: ${cron}`);
    
    if (cron === '50 23 * * *') {
      console.log('[Cron] 开始执行每日数据清理任务');
      await cleanupOldData(env.DB);
      console.log('[Cron] 每日数据清理任务完成');
    } else if (cron === '*/1 * * * *') {
      console.log('[Cron] 开始执行离线节点检测');
      await checkOfflineNodes(env.DB);
      console.log('[Cron] 离线节点检测完成');
    }
  }
};
