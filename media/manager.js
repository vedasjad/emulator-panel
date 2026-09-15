(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const saved = vscode.getState() || {};
  let sort = saved.sort || 'name';
  let direction = saved.direction || 1;
  let devices = [];
  let menu;

  const svg = (body, filled) =>
    `<svg viewBox="0 0 24 24" ${
      filled ? 'fill="currentColor" stroke="none"' : 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
    } aria-hidden="true">${body}</svg>`;

  const ICONS = {
    play: svg('<path d="M8 5.5v13l10-6.5z"/>'),
    stop: svg('<rect x="7" y="7" width="10" height="10" rx="1.5"/>', true),
    more: svg('<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>', true),
    device: svg('<rect x="4" y="2.5" width="10" height="16" rx="1.8"/><rect x="10" y="11.5" width="10.5" height="8" rx="1.2"/><path d="M13 21.5h4.5"/>'),
    ascending: svg('<path d="M7 14l5-5 5 5"/>'),
    descending: svg('<path d="M7 10l5 5 5-5"/>'),
  };

  const STATUS_LABELS = { starting: 'Starting…', stopping: 'Stopping…' };

  const escapeHtml = (text) =>
    String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

  const post = (action, name) => vscode.postMessage({ type: 'action', action, avd: name });
  const find = (name) => devices.find((device) => device.name === name);

  function sortedDevices() {
    const value = (device) =>
      sort === 'api' ? parseFloat(device.api) || 0 : sort === 'type' ? 'virtual' : device.displayName.toLowerCase();
    return [...devices].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      const primary = x < y ? -1 : x > y ? 1 : 0;
      return (primary || a.displayName.localeCompare(b.displayName)) * direction;
    });
  }

  function columnHeader(key, label, className) {
    const active = sort === key;
    const indicator = active ? (direction > 0 ? ICONS.ascending : ICONS.descending) : '';
    return `<button class="col-header ${className}${active ? ' active' : ''}" data-sort="${key}" title="Sort by ${label}">${indicator}<span>${label}</span></button>`;
  }

  const iconButton = (action, title, icon) =>
    `<button class="icon-button ${action}" data-action="${action}" title="${title}" aria-label="${title}">${icon}</button>`;

  function rowHtml(device) {
    const busy = device.status === 'starting' || device.status === 'stopping';
    const running = device.status === 'running';
    const subtitle = [device.androidVersion, device.abi].filter(Boolean).map(escapeHtml).join(' <span class="sep">|</span> ');

    let actions = '';
    if (busy) {
      actions += `<span class="spinner" title="${STATUS_LABELS[device.status]}"></span>`;
    } else if (running) {
      actions += iconButton('stop', 'Stop', ICONS.stop);
    } else {
      actions += iconButton('run', 'Run', ICONS.play);
    }
    actions += `<button class="icon-button" data-menu title="More actions" aria-label="More actions for ${escapeHtml(device.displayName)}">${ICONS.more}</button>`;

    const tooltip = [
      busy && STATUS_LABELS[device.status],
      running && (device.external ? 'Running outside Emulator Panel' : 'Running'),
      device.device && `Device: ${device.device}`,
      device.image && `Image: ${device.image}`,
      device.resolution && `Screen: ${device.resolution}`,
      device.serial && `Serial: ${device.serial}`,
    ]
      .filter(Boolean)
      .join('\n');

    return `<div class="row ${device.status}" role="row" data-name="${escapeHtml(device.name)}" title="${escapeHtml(tooltip)}">
  <div class="device-icon">${ICONS.device}${running || busy ? `<span class="dot ${device.status}"></span>` : ''}</div>
  <div class="name">
    <div class="title"><span class="label">${escapeHtml(device.displayName)}</span></div>
    <div class="subtitle">${subtitle}</div>
  </div>
  <div class="api">${escapeHtml(device.api)}</div>
  <div class="type">Virtual</div>
  <div class="actions">${actions}</div>
</div>`;
  }

  function render() {
    if (devices.length === 0) {
      root.innerHTML = `<div class="empty">No Android Virtual Devices were found.<br>Create one in Android Studio's Device Manager.</div>`;
      return;
    }
    root.innerHTML = `<div class="table" role="table">
  <div class="row head" role="row">
    <div></div>
    ${columnHeader('name', 'Name', 'name')}
    ${columnHeader('api', 'API', 'api')}
    ${columnHeader('type', 'Type', 'type')}
    <div></div>
  </div>
  ${sortedDevices().map(rowHtml).join('')}
</div>`;
  }

  function menuItems(device) {
    const items = [];
    const add = (action, label, enabled = true) => items.push({ action, label, enabled });
    const separator = () => {
      if (items.length && items[items.length - 1] !== '-') {
        items.push('-');
      }
    };
    if (device.status === 'stopped') {
      add('run', 'Run');
      add('coldBoot', 'Cold Boot');
      add('wipeData', 'Wipe Data and Run…');
    } else if (device.status === 'running') {
      if (device.controllable) {
        add('open', 'Open in Running Devices');
      }
      add('stop', 'Stop');
      if (device.controllable) {
        separator();
        add('location', 'Location', device.hasUi);
        add('extendedControls', 'Extended Controls', device.hasUi);
        add('screenshot', 'Take Screenshot');
      }
    }
    separator();
    if (device.serial) {
      add('copySerial', 'Copy ADB Serial');
    }
    add('reveal', 'Reveal AVD Files');
    add('editConfig', 'Edit config.ini');
    if (device.status === 'stopped') {
      separator();
      add('delete', 'Delete…');
    }
    return items;
  }

  function closeMenu() {
    menu?.remove();
    menu = undefined;
  }

  function openMenu(name, anchor) {
    closeMenu();
    const device = find(name);
    if (!device) {
      return;
    }
    menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'menu');
    for (const item of menuItems(device)) {
      if (item === '-') {
        const separator = document.createElement('div');
        separator.className = 'menu-separator';
        menu.append(separator);
        continue;
      }
      const button = document.createElement('button');
      button.className = `menu-item${item.action === 'delete' ? ' danger' : ''}`;
      button.setAttribute('role', 'menuitem');
      button.textContent = item.label;
      button.disabled = !item.enabled;
      button.addEventListener('click', () => {
        closeMenu();
        post(item.action, name);
      });
      menu.append(button);
    }
    document.body.append(menu);
    const rect = anchor.getBoundingClientRect();
    const left = Math.max(4, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 4));
    const below = rect.bottom + 2;
    const top = below + menu.offsetHeight > window.innerHeight - 4 ? Math.max(4, rect.top - menu.offsetHeight - 2) : below;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.querySelector('.menu-item:not(:disabled)')?.focus();
  }

  root.addEventListener('click', (event) => {
    const sortButton = event.target.closest('[data-sort]');
    if (sortButton) {
      const key = sortButton.dataset.sort;
      direction = sort === key ? -direction : 1;
      sort = key;
      vscode.setState({ sort, direction });
      render();
      return;
    }
    const row = event.target.closest('.row[data-name]');
    if (!row) {
      return;
    }
    const actionButton = event.target.closest('[data-action]');
    if (actionButton) {
      post(actionButton.dataset.action, row.dataset.name);
      return;
    }
    const menuButton = event.target.closest('[data-menu]');
    if (menuButton) {
      if (menu && menu.dataset.for === row.dataset.name) {
        closeMenu();
        return;
      }
      openMenu(row.dataset.name, menuButton);
      if (menu) {
        menu.dataset.for = row.dataset.name;
      }
    }
  });

  root.addEventListener('dblclick', (event) => {
    const row = event.target.closest('.row[data-name]');
    if (!row || event.target.closest('button')) {
      return;
    }
    const device = find(row.dataset.name);
    if (device?.status === 'stopped') {
      post('run', device.name);
    } else if (device?.controllable) {
      post('open', device.name);
    }
  });

  document.addEventListener(
    'pointerdown',
    (event) => {
      if (menu && !menu.contains(event.target) && !event.target.closest('[data-menu]')) {
        closeMenu();
      }
    },
    true,
  );
  document.addEventListener('keydown', (event) => {
    if (!menu) {
      return;
    }
    if (event.key === 'Escape') {
      closeMenu();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const items = [...menu.querySelectorAll('.menu-item:not(:disabled)')];
      const index = items.indexOf(document.activeElement);
      const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
      items[next]?.focus();
    }
  });
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);

  window.addEventListener('message', (event) => {
    if (event.data.type === 'devices') {
      devices = event.data.devices;
      render();
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
