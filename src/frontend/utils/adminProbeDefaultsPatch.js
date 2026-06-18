const API_BASE = window.location.origin

const isAdminPage = () => window.location.pathname.startsWith('/admin')
const isZh = () => (localStorage.getItem('language_preference') || '').toLowerCase().startsWith('zh')
const t = (zh, en) => isZh() ? zh : en

const getAuthHeaders = () => {
  const headers = { 'Content-Type': 'application/json' }
  const token = localStorage.getItem('jwt_token')
  if (token) headers.Authorization = 'Bearer ' + token
  const turnstileToken = localStorage.getItem('turnstile_token')
  if (turnstileToken) headers['X-Turnstile-Token'] = turnstileToken
  return headers
}

const getControls = () => ({
  interval: document.getElementById('probe_default_interval'),
  pingEnabled: document.getElementById('probe_default_ping_enabled'),
  pingMode: document.getElementById('probe_default_ping_mode')
})

const readControls = () => {
  const c = getControls()
  return {
    default_report_interval: c.interval?.value || '180',
    default_ping_enabled: c.pingEnabled?.checked ? 'true' : 'false',
    default_ping_mode: c.pingMode?.value || 'http'
  }
}

const applyControls = (settings = {}) => {
  const c = getControls()
  if (!c.interval || !c.pingEnabled || !c.pingMode) return
  c.interval.value = String(settings.default_report_interval || '180')
  c.pingEnabled.checked = String(settings.default_ping_enabled || 'false') === 'true'
  c.pingMode.value = settings.default_ping_mode || 'http'
  c.pingMode.disabled = !c.pingEnabled.checked
  c.pingMode.style.opacity = c.pingEnabled.checked ? '1' : '0.55'
}

const loadProbeDefaults = async () => {
  if (!localStorage.getItem('jwt_token')) return
  try {
    const res = await fetch(`${API_BASE}/admin/api`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ action: 'get_settings' })
    })
    if (!res.ok) return
    const data = await res.json()
    applyControls(data.settings || {})
  } catch (_) {}
}

const findSettingsGrid = () => {
  const sections = Array.from(document.querySelectorAll('#tab-settings .settings-section'))
  const pingSection = sections.find(section => {
    const title = section.querySelector('.section-title')?.textContent || ''
    return /Ping|测速|节点/i.test(title)
  })
  return pingSection?.parentElement || document.querySelector('#tab-settings .settings-grid')
}

const injectProbeDefaults = () => {
  if (!isAdminPage() || document.getElementById('probe-defaults-section')) return
  const container = findSettingsGrid()
  if (!container) return

  const section = document.createElement('div')
  section.className = 'settings-section'
  section.id = 'probe-defaults-section'
  section.innerHTML = `
    <div class="section-title"><span>▸</span> ${t('探针默认设置', 'Probe Defaults')}</div>
    <div class="form-group">
      <label class="form-label">${t('默认上报间隔', 'Default Report Interval')}</label>
      <select id="probe_default_interval" class="form-select">
        <option value="60">60s</option>
        <option value="180">180s</option>
        <option value="300">300s</option>
        <option value="600">600s</option>
      </select>
      <p class="text-muted text-sm mt-2">${t('建议 20 台机器使用 180 秒，避免 Workers 请求数和 D1 写入压力过高。', 'For about 20 servers, 180s is recommended to reduce Worker requests and D1 writes.')}</p>
    </div>
    <div class="checkbox-item">
      <input type="checkbox" id="probe_default_ping_enabled">
      <label><b>${t('默认启用 Ping 测速', 'Enable Ping probing by default')}</b></label>
    </div>
    <div class="form-group">
      <label class="form-label">${t('默认 Ping 模式', 'Default Ping Mode')}</label>
      <select id="probe_default_ping_mode" class="form-select">
        <option value="http">HTTP</option>
        <option value="tcp">TCP</option>
      </select>
      <p class="text-muted text-sm mt-2">${t('默认关闭更省请求和系统资源。需要延迟监控时再打开。', 'Keep it off by default to save requests and system resources. Enable only when latency monitoring is needed.')}</p>
    </div>
  `

  container.insertBefore(section, container.firstChild)

  const c = getControls()
  c.pingEnabled?.addEventListener('change', () => applyControls(readControls()))
  applyControls({ default_report_interval: '180', default_ping_enabled: 'false', default_ping_mode: 'http' })
  loadProbeDefaults()
}

const patchFetchForProbeDefaults = () => {
  if (window.__probeDefaultsFetchPatched) return
  window.__probeDefaultsFetchPatched = true
  const originalFetch = window.fetch.bind(window)

  window.fetch = (input, init = {}) => {
    try {
      const url = typeof input === 'string' ? input : input?.url || ''
      const isAdminApi = url.includes('/admin/api')
      const isPost = String(init.method || '').toUpperCase() === 'POST'
      if (isAdminApi && isPost && init.body) {
        const body = JSON.parse(init.body)
        if (body?.action === 'save_settings') {
          body.settings = { ...(body.settings || {}), ...readControls() }
          init = { ...init, body: JSON.stringify(body) }
        }
      }
    } catch (_) {}
    return originalFetch(input, init)
  }
}

if (isAdminPage()) {
  patchFetchForProbeDefaults()
  const observer = new MutationObserver(() => injectProbeDefaults())
  observer.observe(document.documentElement, { childList: true, subtree: true })
  document.addEventListener('DOMContentLoaded', injectProbeDefaults)
  setTimeout(injectProbeDefaults, 300)
  setTimeout(injectProbeDefaults, 1000)
}
