import { checkAuth, simpleAuthResponse } from '../middleware/auth.js';
import { getLatestMetrics, getLatestMetricsForAllServers, getAllServers } from '../database/schema.js';
import { getServerDetail } from '../utils/cache.js';
import { mergeMetricsIntoServer } from '../utils/metrics.js';
import { createSuccessResponse, createBadRequestResponse, createNotFoundResponse } from '../utils/errors.js';

function getOnlineThresholdMs(server) {
  const interval = parseInt(server?.report_interval || 60, 10);
  const safeInterval = Number.isFinite(interval) && interval > 0 ? interval : 60;
  return Math.max(300000, safeInterval * 2500);
}

export async function handleServerAPI(request, env, sys) {
  const isLoggedIn = await checkAuth(request, env, sys);
  
  if (sys.is_public !== 'true' && !isLoggedIn) {
    return simpleAuthResponse();
  }
  
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  
  if (!id) return createBadRequestResponse('Missing ID');
  
  const server = await getServerDetail(env.DB, id, isLoggedIn);
  if (!server) return createNotFoundResponse('Server not found');
  
  const latestMetrics = await getLatestMetrics(env.DB, id);
  mergeMetricsIntoServer(server, latestMetrics);
  
  return createSuccessResponse(server);
}

export async function handleServersAPI(request, env, sys) {
  const isLoggedIn = await checkAuth(request, env, sys);
  
  if (sys.is_public !== 'true' && !isLoggedIn) {
    return simpleAuthResponse();
  }
  
  const results = await getAllServers(env.DB, isLoggedIn);
  
  const latestMetricsMap = await getLatestMetricsForAllServers(env.DB);
  
  const now = Date.now();
  let globalOnline = 0;
  let globalSpeedIn = 0, globalSpeedOut = 0, globalNetTx = 0, globalNetRx = 0;
  const countryStats = {};
  
  for (const server of results) {
    const latestMetrics = latestMetricsMap.get(server.id);
    
    let isOnline = false;
    
    if (latestMetrics) {
      isOnline = (now - latestMetrics.timestamp) < getOnlineThresholdMs(server);
      mergeMetricsIntoServer(server, latestMetrics);
    }
    
    if (isOnline) {
      globalOnline++;
      globalSpeedIn += parseFloat(server.net_in_speed) || 0;
      globalSpeedOut += parseFloat(server.net_out_speed) || 0;
    }
    
    globalNetRx += parseFloat(server.net_rx || 0);
    globalNetTx += parseFloat(server.net_tx || 0);
    
    const cCode = (server.country || '').toUpperCase();
    if (cCode !== '') {
      countryStats[cCode] = (countryStats[cCode] || 0) + 1;
    }
  }
  
  const globalOffline = results.length - globalOnline;

  const data = {
    servers: results,
    stats: {
      total: results.length,
      online: globalOnline,
      offline: globalOffline,
      globalSpeedIn,
      globalSpeedOut,
      globalNetTx,
      globalNetRx
    },
    countryStats,
    latestMetricsMap: Object.fromEntries(latestMetricsMap),
    sysConfig: {
      show_price: sys.show_price === 'true',
      show_expire: sys.show_expire === 'true',
      show_bw: sys.show_bw === 'true',
      show_tf: sys.show_tf === 'true',
      site_title: sys.site_title || 'Server Monitor'
    }
  };

  return createSuccessResponse(data);
}
