import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './styles/main.css'
import './styles/light.css'
import { currentLang, translations } from './utils/i18n'

const API_BASE = window.location.origin

const getTranslation = () => {
  const lang = localStorage.getItem('language_preference') || 'en'
  return translations[lang] || translations.en
}

const trans = () => getTranslation()

async function fetchConfig() {
  try {
    const res = await fetch(`${API_BASE}/api/config`)
    if (res.ok) {
      return await res.json()
    }
  } catch (e) {
    console.error('Failed to fetch config:', e)
  }
  return { turnstile_enabled: false, turnstile_site_key: '' }
}

async function loadTurnstileScript() {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
    script.async = true
    script.onload = resolve
    script.onerror = reject
    document.head.appendChild(script)
  })
}

function hasValidTurnstileCookie() {
  const cookies = document.cookie.split(';')
  for (const cookie of cookies) {
    const [name, value] = cookie.trim().split('=')
    if (name === 'turnstile_verified' && value) {
      return true
    }
  }
  return false
}

async function verifyTurnstile(siteKey) {
  return new Promise((resolve) => {
    turnstile.render('#turnstile-container', {
      sitekey: siteKey,
      callback: async (token) => {
        localStorage.setItem('turnstile_token', token)
        try {
          const res = await fetch(`${API_BASE}/api/servers`, {
            headers: { 'X-Turnstile-Token': token }
          })
          if (res.ok) {
            resolve(true)
          } else {
            resolve(false)
          }
        } catch (e) {
          console.error('Failed to verify token:', e)
          resolve(false)
        }
      },
      errorCallback: (error) => {
        console.error('Turnstile error:', error)
        resolve(false)
      },
      expiredCallback: () => {
        localStorage.removeItem('turnstile_token')
        resolve(false)
      }
    })
  })
}

function installAdminPingSwitchPatch() {
  let pingEnabled = false
  let pingMode = 'http'
  let lastModalKey = ''

  const isZh = () => (localStorage.getItem('language_preference') || '').toLowerCase().startsWith('zh')
  const text = (zh, en) => isZh() ? zh : en

  const normalizeInstallScript = (cmd) => {
    return cmd.replace(/\/install(?:-alpine)?\.sh\s*\|\s*(?:bash|sh)\s+-s/g, '/install-auto.sh | sh -s')
  }

  const setPingArg = (cmd, enabled, mode) => {
    const nextMode = enabled ? (mode || 'http') : 'off'
    let next = normalizeInstallScript(cmd)
    if (/\s-ping=[^\s]+/.test(next)) {
      next = next.replace(/\s-ping=[^\s]+/g, ` -ping=${nextMode}`)
    } else {
      next += ` -ping=${nextMode}`
    }
    return next
  }

  const extractPingMode = (cmd) => {
    const m = String(cmd || '').match(/\s-ping=([^\s]+)/)
    return m ? m[1].toLowerCase() : ''
  }

  const copyText = async (value) => {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value)
      return
    }
    const tmp = document.createElement('textarea')
    tmp.value = value
    tmp.style.position = 'fixed'
    tmp.style.left = '-9999px'
    document.body.appendChild(tmp)
    tmp.focus()
    tmp.select()
    document.execCommand('copy')
    tmp.remove()
  }

  const findPingFormGroup = (modal) => {
    const groups = Array.from(modal.querySelectorAll('.form-group'))
    return groups.find(group => {
      const label = group.querySelector('.form-label')
      const labelText = (label?.textContent || '').trim().toLowerCase()
      return labelText.includes('ping') || labelText.includes('测速') || labelText.includes('延迟')
    })
  }

  const ensureSwitch = (modal) => {
    let patch = modal.querySelector('[data-ping-switch-patch]')
    if (patch) return patch

    patch = document.createElement('div')
    patch.className = 'form-group'
    patch.setAttribute('data-ping-switch-patch', '1')
    patch.innerHTML = `
      <div class="checkbox-item no-margin">
        <input type="checkbox" id="copy_ping_enabled">
        <label>
          <b>${text('启用 Ping 测速', 'Enable Ping probing')}</b><br>
          <span class="text-xs text-muted">${text('默认关闭；开启后才会在探针中执行延迟测速。', 'Disabled by default. Enable it only when latency probing is needed.')}</span>
        </label>
      </div>
      <div class="form-row" style="margin-top: 10px;">
        <div class="form-group flex-1 no-margin">
          <label class="form-label">${text('测速模式', 'Probe mode')}</label>
          <select class="form-select" data-ping-mode-select>
            <option value="http">HTTP</option>
            <option value="tcp">TCP</option>
          </select>
        </div>
      </div>
    `

    const pingGroup = findPingFormGroup(modal)
    if (pingGroup) pingGroup.insertAdjacentElement('afterend', patch)
    else modal.querySelector('.modal-footer')?.insertAdjacentElement('beforebegin', patch)

    patch.querySelector('#copy_ping_enabled')?.addEventListener('change', e => {
      pingEnabled = !!e.target.checked
      syncCopyModal()
    })
    patch.querySelector('[data-ping-mode-select]')?.addEventListener('change', e => {
      pingMode = e.target.value || 'http'
      syncCopyModal()
    })

    return patch
  }

  const syncCopyModal = () => {
    const modal = document.getElementById('copyModal')
    if (!modal || !modal.classList.contains('active')) return

    const commandInput = modal.querySelector('.cmd-input-wrapper input.cmd-input')
    if (!commandInput) return

    const rawCmd = String(commandInput.value || '')
    const modalKey = rawCmd.replace(/\s-ping=[^\s]+/g, '').replace(/\/install-auto\.sh\s*\|\s*sh\s+-s/g, '/install.sh | bash -s')

    if (modalKey !== lastModalKey) {
      lastModalKey = modalKey
      const currentPing = extractPingMode(rawCmd)
      if (currentPing && !['off', 'none', 'disabled', '0'].includes(currentPing) && currentPing !== 'http') {
        pingEnabled = true
        pingMode = currentPing
      } else {
        pingEnabled = false
        pingMode = currentPing && !['off', 'none', 'disabled', '0'].includes(currentPing) ? currentPing : 'http'
      }
    }

    const patch = ensureSwitch(modal)
    const checkbox = patch.querySelector('#copy_ping_enabled')
    const modeSelect = patch.querySelector('[data-ping-mode-select]')
    if (checkbox) checkbox.checked = pingEnabled
    if (modeSelect) {
      modeSelect.value = pingMode || 'http'
      modeSelect.disabled = !pingEnabled
      modeSelect.style.opacity = pingEnabled ? '1' : '0.55'
    }

    const pingGroup = findPingFormGroup(modal)
    const pingDisplay = pingGroup?.querySelector('input[readonly]')
    if (pingDisplay) pingDisplay.value = pingEnabled ? String(pingMode || 'http').toUpperCase() : 'OFF'

    commandInput.value = setPingArg(rawCmd, pingEnabled, pingMode)

    const targetSelect = modal.querySelector('select.form-select')
    const linuxOption = targetSelect?.querySelector('option[value="linux"]')
    if (linuxOption) linuxOption.textContent = 'Linux / Alpine (Auto)'
  }

  document.addEventListener('click', async (event) => {
    const copyButton = event.target.closest?.('#copyModal .modal-footer .btn-primary')
    if (!copyButton) return

    const modal = document.getElementById('copyModal')
    const commandInput = modal?.querySelector('.cmd-input-wrapper input.cmd-input')
    if (!commandInput) return

    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()

    syncCopyModal()
    await copyText(commandInput.value)
    const oldText = copyButton.textContent
    copyButton.textContent = `✅ ${text('已复制', 'Copied!')}`
    setTimeout(() => { copyButton.textContent = oldText }, 1500)
  }, true)

  document.addEventListener('change', event => {
    if (event.target.closest?.('#copyModal')) {
      setTimeout(syncCopyModal, 0)
    }
  }, true)

  const observer = new MutationObserver(() => setTimeout(syncCopyModal, 0))
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'value'] })
}

async function initApp() {
  const config = await fetchConfig()
  
  if (config.turnstile_enabled && config.turnstile_site_key && !config.cookie_auth) {
    const loading = document.getElementById('loading')
    if (loading) {
      loading.innerHTML = `
        <div class="loading-content">
          <div class="loading-spinner"></div>
          <div class="loading-text">$ Verifying...</div>
          <div id="turnstile-container" style="margin-top: 20px;"></div>
        </div>
      `
    }
    
    try {
      await loadTurnstileScript()
      const verified = await verifyTurnstile(config.turnstile_site_key)
      
      if (!verified) {
        loading.innerHTML = `
          <div class="loading-content">
            <div style="font-size: 48px; margin-bottom: 16px;">❌</div>
            <div class="loading-text" style="color: #f85149;">${trans().errorInvalidUsername || 'Verification failed'}</div>
            <div style="font-size: 12px; color: #6b7280; margin-top: 8px;">${trans().loginRequired || 'Please refresh the page to try again'}</div>
          </div>
        `
        return
      }
    } catch (e) {
      console.error('Turnstile error:', e)
      loading.innerHTML = `
        <div class="loading-content">
          <div style="font-size: 48px; margin-bottom: 16px;">❌</div>
          <div class="loading-text" style="color: #f85149;">${trans().errorInvalidUsername || 'Verification error'}</div>
          <div style="font-size: 12px; color: #6b7280; margin-top: 8px;">${e.message}</div>
        </div>
      `
      return
    }
  }
  
  const app = createApp(App)
  app.use(router)
  app.mount('#app').$nextTick(() => {
    installAdminPingSwitchPatch()
    const loading = document.getElementById('loading')
    if (loading) {
      setTimeout(() => {
        loading.remove()
      }, 1000)
    }
  })
}

initApp()
