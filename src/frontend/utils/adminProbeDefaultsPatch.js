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
  document.querySelectorAll('#copyModal [data-ping-switch-patch]').forEach(el => el.remove())
  if (!isAdminPage() || document.getElementById('probe-defaults-section')) return
  const container = findSettingsGrid()
  if (!container) return

  const section = document.createElement('div')
  section.className = 'settings-section'
  section.id = 'probe-defaults-section'
  section.innerHTML = `
    <div class="section-title"><span>▸</span> ${t('探针默认设置', 'Probe Defaults')}</div>
    <div class="form-row">
      <div class="form-group flex-1">
        <label class="form-label">${t('默认上报间隔', 'Default Report Interval')}</label>
        <select id="probe_default_interval" class="form-select">
          <option value="60">60s</option>
          <option value="180">180s</option>
          <option value="300">300s</option>
          <option value="600">600s</option>
        </select>
      </div>
      <div class="form-group flex-1">
        <label class="form-label">${t('默认 Ping 模式', 'Default Ping Mode')}</label>
        <div class="flex items-center gap-2" style="gap:10px; align-items:center;">
          <label class="checkbox-item no-margin" style="display:flex; align-items:center; gap:6px; margin:0; white-space:nowrap;">
            <input type="checkbox" id="probe_default_ping_enabled">
            <span>${t('开启', 'On')}</span>
          </label>
          <select id="probe_default_ping_mode" class="form-select" style="min-width:110px;">
            <option value="http">HTTP</option>
            <option value="tcp">TCP</option>
          </select>
        </div>
      </div>
    </div>
  `

  container.insertBefore(section, container.firstChild)

  const c = getControls()
  c.pingEnabled?.addEventListener('change', () => applyControls(readControls()))
  applyControls({ default_report_interval: '180', default_ping_enabled: 'false', default_ping_mode: 'http' })
  loadProbeDefaults()
}

const normalizePingValue = (value) => {
  const v = String(value || '').toLowerCase()
  return ['off', 'http', 'tcp'].includes(v) ? v : 'off'
}

const normalizeInstallCommand = (cmd) => {
  return String(cmd || '').replace(/\/install(?:-alpine|-openwrt)?\.sh\s*\|\s*(?:bash|sh)\s+-s/g, '/install-auto.sh | sh -s')
}

const setCommandPing = (cmd, ping) => {
  const next = normalizePingValue(ping)
  const text = normalizeInstallCommand(cmd)
  if (/\s-ping=[^\s]+/.test(text)) return text.replace(/\s-ping=[^\s]+/g, ` -ping=${next}`)
  return `${text} -ping=${next}`
}

const findFormGroupByLabel = (root, pattern) => {
  return Array.from(root.querySelectorAll('.form-group')).find(group => {
    const label = group.querySelector('.form-label')?.textContent || ''
    return pattern.test(label)
  })
}

const ensureCopyModalPingOff = () => {
  const modal = document.getElementById('copyModal')
  if (!modal || !modal.classList.contains('active')) return

  const pingGroup = findFormGroupByLabel(modal, /ping|测速|延迟/i)
  const commandInput = modal.querySelector('.cmd-input-wrapper input.cmd-input')
  if (!pingGroup || !commandInput) return

  let select = pingGroup.querySelector('select[data-copy-ping-mode]')
  if (!select) {
    const current = normalizePingValue(
      commandInput.value.match(/\s-ping=([^\s]+)/)?.[1] ||
      pingGroup.querySelector('input')?.value ||
      'off'
    )
    const holder = pingGroup.querySelector('.flex') || pingGroup
    holder.innerHTML = `
      <select class="form-select" data-copy-ping-mode style="width:125px; min-width:125px;">
        <option value="off">OFF</option>
        <option value="http">HTTP</option>
        <option value="tcp">TCP</option>
      </select>
    `
    select = pingGroup.querySelector('select[data-copy-ping-mode]')
    select.value = current
    select.addEventListener('change', () => {
      commandInput.value = setCommandPing(commandInput.value, select.value)
    })
  }

  commandInput.value = setCommandPing(commandInput.value, select.value || 'off')
}

const ensureEditModalPingOff = () => {
  const modal = document.getElementById('editModal')
  if (!modal || !modal.classList.contains('active')) return
  const pingGroup = findFormGroupByLabel(modal, /ping|测速|延迟/i)
  const select = pingGroup?.querySelector('select')
  if (!select || select.querySelector('option[value="off"]')) return
  const option = document.createElement('option')
  option.value = 'off'
  option.textContent = 'OFF'
  select.insertBefore(option, select.firstChild)
}

const syncPingOffControls = () => {
  ensureCopyModalPingOff()
  ensureEditModalPingOff()
}

const patchCopyButtonForPingOff = () => {
  if (window.__copyPingOffPatched) return
  window.__copyPingOffPatched = true
  document.addEventListener('click', async event => {
    const button = event.target.closest?.('#copyModal .modal-footer .btn-primary')
    if (!button) return
    const modal = document.getElementById('copyModal')
    const commandInput = modal?.querySelector('.cmd-input-wrapper input.cmd-input')
    const select = modal?.querySelector('select[data-copy-ping-mode]')
    if (!commandInput || !select) return

    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()

    const cmd = setCommandPing(commandInput.value, select.value)
    commandInput.value = cmd
    try {
      await navigator.clipboard.writeText(cmd)
    } catch (_) {
      commandInput.focus()
      commandInput.select()
      document.execCommand('copy')
    }

    const old = button.textContent
    button.textContent = `✅ ${t('已复制', 'Copied!')}`
    setTimeout(() => { button.textContent = old }, 1500)
  }, true)
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
  patchCopyButtonForPingOff()
  const observer = new MutationObserver(() => {
    injectProbeDefaults()
    syncPingOffControls()
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
  document.addEventListener('DOMContentLoaded', () => {
    injectProbeDefaults()
    syncPingOffControls()
  })
  setTimeout(() => { injectProbeDefaults(); syncPingOffControls() }, 300)
  setTimeout(() => { injectProbeDefaults(); syncPingOffControls() }, 1000)
}
