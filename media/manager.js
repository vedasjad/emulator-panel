(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const saved = vscode.getState() || {};
  let sort = saved.sort || 'name';
  let direction = saved.direction || 1;
  const collapsed = new Set(saved.collapsed || []);
  let devices = [];
  let sdkProblem;
  let menu;

  const SECTIONS = [
    { platform: 'android', title: 'Android', apiLabel: 'API' },
    { platform: 'ios', title: 'iOS', apiLabel: 'iOS' },
  ];

  const saveState = () => vscode.setState({ sort, direction, collapsed: [...collapsed] });

  const svg = (body, filled) =>
    `<svg viewBox="0 0 24 24" ${
      filled ? 'fill="currentColor" stroke="none"' : 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
    } aria-hidden="true">${body}</svg>`;

  const ICONS = {
    play: svg('<path d="M8 5.5v13l10-6.5z"/>'),
    stop: svg('<rect x="7" y="7" width="10" height="10" rx="1.5"/>', true),
    more: svg('<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>', true),
    showScreen: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
    hideScreen: svg(
      '<path d="M3 3l18 18"/><path d="M10.6 5.1A10.5 10.5 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.8 9.8 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    ),
    virtual: svg('<rect x="4" y="2.5" width="10" height="16" rx="1.8"/><rect x="10" y="11.5" width="10.5" height="8" rx="1.2"/><path d="M13 21.5h4.5"/>'),
    phone: svg('<rect x="6" y="2.5" width="12" height="19" rx="2.6"/><path d="M10.5 18.5h3"/>'),
    ascending: svg('<path d="M7 14l5-5 5 5"/>'),
    descending: svg('<path d="M7 10l5 5 5-5"/>'),
    chevron: svg('<path d="M7 10l5 5 5-5"/>'),
  };

  const STATUS_LABELS = { starting: 'Starting…', stopping: 'Stopping…' };

  const escapeHtml = (text) =>
    String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

  const post = (action, id) => vscode.postMessage({ type: 'action', action, id });
  const find = (id) => devices.find((device) => device.id === id);

  function sortedDevices() {
    const value = (device) =>
      sort === 'api' ? parseFloat(device.api) || 0 : sort === 'type' ? device.type.toLowerCase() : device.displayName.toLowerCase();
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
    const subtitle = device.subtitle.map(escapeHtml).join(' <span class="sep">|</span> ');

    let actions = '';
    if (device.physical) {
      if (device.platform === 'android' && running) {
        actions += device.mirrored
          ? iconButton('hideScreen', 'Hide screen', ICONS.hideScreen)
          : iconButton('open', 'Show screen in Running Devices', ICONS.showScreen);
      }
    } else if (busy) {
      actions += `<span class="spinner" title="${STATUS_LABELS[device.status]}"></span>`;
    } else if (running) {
      actions += iconButton('stop', 'Stop', ICONS.stop);
    } else {
      actions += iconButton('run', 'Run', ICONS.play);
    }
    actions += `<button class="icon-button" data-menu title="More actions" aria-label="More actions for ${escapeHtml(device.displayName)}">${ICONS.more}</button>`;

    const tooltip = [
      busy && STATUS_LABELS[device.status],
      running && !device.physical && (device.external ? 'Running outside Emulator Panel' : 'Running'),
      ...device.details,
    ]
      .filter(Boolean)
      .join('\n');

    return `<div class="row ${device.status}" role="row" data-id="${escapeHtml(device.id)}" title="${escapeHtml(tooltip)}">
  <div class="device-icon ${device.platform}">${device.physical ? ICONS.phone : ICONS.virtual}${running || busy ? `<span class="dot ${device.status}"></span>` : ''}</div>
  <div class="name">
    <div class="title"><span class="label">${escapeHtml(device.displayName)}</span></div>
    <div class="subtitle">${subtitle}</div>
  </div>
  <div class="api">${escapeHtml(device.api)}</div>
  <div class="type">${escapeHtml(device.type)}</div>
  <div class="actions">${actions}</div>
</div>`;
  }

  function render() {
    const notice = sdkProblem
      ? `<div class="notice"><p>${escapeHtml(sdkProblem)}</p><button class="notice-button" data-open-sdk-setting>Set Android SDK Path</button></div>`
      : '';
    if (devices.length === 0) {
      root.innerHTML = `${notice}<div class="empty">No devices were found.<br>Create an Android Virtual Device in Android Studio's Device Manager, or a simulator in Xcode.</div>`;
      return;
    }
    const sorted = sortedDevices();
    root.innerHTML = notice + SECTIONS.map((section) => {
      const list = sorted.filter((device) => device.platform === section.platform);
      if (list.length === 0) {
        return '';
      }
      const isCollapsed = collapsed.has(section.platform);
      const table = isCollapsed
        ? ''
        : `<div class="table" role="table">
  <div class="row head" role="row">
    <div></div>
    ${columnHeader('name', 'Name', 'name')}
    ${columnHeader('api', section.apiLabel, 'api')}
    ${columnHeader('type', 'Type', 'type')}
    <div></div>
  </div>
  ${list.map(rowHtml).join('')}
</div>`;
      return `<section class="section${isCollapsed ? ' collapsed' : ''}">
  <button class="section-header" data-section="${section.platform}" aria-expanded="${!isCollapsed}">${ICONS.chevron}<span>${section.title}</span><span class="count">${list.length}</span></button>
  ${table}
</section>`;
    }).join('');
  }

  function menuItems(device) {
    const items = [];
    const add = (action, label, enabled = true) => items.push({ action, label, enabled });
    const separator = () => {
      if (items.length && items[items.length - 1] !== '-') {
        items.push('-');
      }
    };
    const stopped = device.status === 'stopped';
    const running = device.status === 'running';

    if (device.physical) {
      if (device.platform === 'android') {
        if (running) {
          if (device.mirrored) {
            add('hideScreen', 'Hide Screen');
          } else {
            add('open', 'Show Screen');
          }
          separator();
          add('screenshot', 'Take Screenshot');
          add('openUrl', 'Open URL…');
          add('toggleAppearance', 'Toggle Dark Mode');
          separator();
        }
        add('copySerial', 'Copy ADB Serial');
        if (running) {
          separator();
          add('reboot', 'Reboot…');
        }
      } else {
        add('copyUdid', 'Copy UDID');
      }
      return items;
    }

    if (device.platform === 'ios') {
      if (stopped) {
        add('run', 'Run');
        add('erase', 'Erase Contents and Settings…');
      } else if (running) {
        add('showWindow', 'Show Simulator Window');
        add('stop', 'Stop');
        separator();
        add('setLocation', 'Set Location…');
        add('playRoute', 'Play Route…');
        add('clearLocation', 'Stop Location Simulation');
        separator();
        add('toggleAppearance', 'Toggle Dark Mode');
        add('openUrl', 'Open URL…');
        add('screenshot', 'Take Screenshot');
      }
      separator();
      add('copyUdid', 'Copy UDID');
      add('reveal', 'Reveal Simulator Files');
      if (stopped) {
        separator();
        add('delete', 'Delete…');
      }
      return items;
    }

    if (stopped) {
      add('run', 'Run');
      add('coldBoot', 'Cold Boot');
      add('wipeData', 'Wipe Data and Run…');
    } else if (running) {
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
    if (running && device.details.some((detail) => detail.startsWith('Serial:'))) {
      add('copySerial', 'Copy ADB Serial');
    }
    add('reveal', 'Reveal AVD Files');
    add('editConfig', 'Edit config.ini');
    if (stopped) {
      separator();
      add('delete', 'Delete…');
    }
    return items;
  }

  function closeMenu() {
    menu?.remove();
    menu = undefined;
  }

  function openMenu(id, anchor) {
    closeMenu();
    const device = find(id);
    if (!device) {
      return;
    }
    menu = document.createElement('div');
    menu.className = 'menu';
    menu.dataset.for = id;
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
        post(item.action, id);
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
    if (event.target.closest('[data-open-sdk-setting]')) {
      vscode.postMessage({ type: 'openSdkSetting' });
      return;
    }
    const sectionButton = event.target.closest('[data-section]');
    if (sectionButton) {
      const platform = sectionButton.dataset.section;
      if (collapsed.has(platform)) {
        collapsed.delete(platform);
      } else {
        collapsed.add(platform);
      }
      saveState();
      render();
      return;
    }
    const sortButton = event.target.closest('[data-sort]');
    if (sortButton) {
      const key = sortButton.dataset.sort;
      direction = sort === key ? -direction : 1;
      sort = key;
      saveState();
      render();
      return;
    }
    const row = event.target.closest('.row[data-id]');
    if (!row) {
      return;
    }
    const actionButton = event.target.closest('[data-action]');
    if (actionButton) {
      post(actionButton.dataset.action, row.dataset.id);
      return;
    }
    const menuButton = event.target.closest('[data-menu]');
    if (menuButton) {
      if (menu && menu.dataset.for === row.dataset.id) {
        closeMenu();
        return;
      }
      openMenu(row.dataset.id, menuButton);
    }
  });

  root.addEventListener('dblclick', (event) => {
    const row = event.target.closest('.row[data-id]');
    if (!row || event.target.closest('button')) {
      return;
    }
    const device = find(row.dataset.id);
    if (!device) {
      return;
    }
    if (device.physical) {
      if (device.platform === 'android' && device.status === 'running') {
        post('open', device.id);
      }
      return;
    }
    if (device.status === 'stopped') {
      post('run', device.id);
    } else if (device.status === 'running') {
      if (device.platform === 'ios') {
        post('showWindow', device.id);
      } else if (device.controllable) {
        post('open', device.id);
      }
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
      sdkProblem = event.data.sdkProblem;
      render();
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
