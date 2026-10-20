(function () {
  const vscode = acquireVsCodeApi();
  const container = document.getElementById('devices');
  const chips = document.getElementById('chips');
  const toolbarTemplate = document.getElementById('toolbar-template');
  const emptyState = document.getElementById('empty');
  const GAP = 12;
  const DEFAULT_ASPECT = 9 / 20;
  const MAX_DECODE_QUEUE = 20;
  const H264_CODEC = 'avc1.640033';
  const passthroughKeys = new Set(['Meta', 'Control', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']);
  const cells = new Map();
  let order = [];
  let focusedId;
  const heldKeys = new Map();
  let needed = 0;
  let stopOnClose = true;

  document.body.classList.toggle('no-toolbar', !toolbarTemplate.content.firstElementChild);

  const post = (message) => vscode.postMessage(message);

  function toolbarHeight() {
    for (const cell of cells.values()) {
      if (cell.toolbar && !cell.section.hidden && cell.toolbar.offsetHeight) {
        return cell.toolbar.offsetHeight;
      }
    }
    return toolbarTemplate.content.firstElementChild ? 36 : 0;
  }

  function fitToolbar(cell) {
    const toolbar = cell.toolbar;
    if (!toolbar || cell.section.hidden) {
      return;
    }
    const collapsible = [...toolbar.querySelectorAll('[data-collapse]')];
    for (const button of collapsible) {
      button.hidden = false;
    }
    for (let level = 1; level <= 4 && toolbar.scrollWidth > toolbar.clientWidth + 1; level++) {
      for (const button of collapsible) {
        if (Number(button.dataset.collapse) <= level) {
          button.hidden = true;
        }
      }
    }
  }

  function relayout() {
    document.body.classList.toggle('multi', order.length > 1);
    const width = container.clientWidth;
    const cellHeight = Math.max(0, container.clientHeight - toolbarHeight());
    const widths = order.map((id) => Math.floor(cellHeight * cells.get(id).aspect));
    needed = widths.reduce((sum, value) => sum + value, 0) + GAP * Math.max(0, order.length - 1);
    const sideBySide = order.length <= 1 || needed <= width;
    container.classList.toggle('fill', !sideBySide || order.length <= 1);
    order.forEach((id, index) => {
      const cell = cells.get(id);
      cell.section.hidden = !(sideBySide || id === focusedId);
      cell.section.style.width = sideBySide && order.length > 1 ? `${widths[index]}px` : '';
      cell.section.classList.toggle('focused', order.length > 1 && id === focusedId);
    });
    for (const chip of chips.children) {
      chip.classList.toggle('focused', Number(chip.dataset.id) === focusedId);
    }
    cells.forEach(fitToolbar);
  }

  function reportLayout(reason) {
    if (order.length) {
      post({ type: 'layout', reason, width: container.clientWidth, needed });
    }
  }

  function setFocus(id) {
    if (focusedId === id || !cells.has(id)) {
      return;
    }
    focusedId = id;
    relayout();
    post({ type: 'focus', id });
  }

  function layoutCanvas(cell) {
    if (!cell.frameWidth) {
      return;
    }
    const scale = Math.min(cell.viewport.clientWidth / cell.frameWidth, cell.viewport.clientHeight / cell.frameHeight);
    cell.canvas.style.width = `${Math.floor(cell.frameWidth * scale)}px`;
    cell.canvas.style.height = `${Math.floor(cell.frameHeight * scale)}px`;
  }

  function applyFrameSize(cell, width, height) {
    if (cell.canvas.width !== width || cell.canvas.height !== height) {
      cell.canvas.width = width;
      cell.canvas.height = height;
    }
    cell.frameWidth = width;
    cell.frameHeight = height;
    const aspect = width / height;
    const changed = Math.abs(aspect - cell.aspect) > 0.01;
    cell.aspect = aspect;
    layoutCanvas(cell);
    if (changed) {
      relayout();
      reportLayout('aspect');
    }
  }

  function createCell(device) {
    const section = document.createElement('section');
    section.className = 'device';
    const toolbarSource = toolbarTemplate.content.firstElementChild;
    const toolbar = toolbarSource ? toolbarSource.cloneNode(true) : undefined;
    if (toolbar) {
      for (const button of toolbar.querySelectorAll('[data-needs-ui]')) {
        if (!device.hasUi) {
          button.disabled = true;
          button.title = button.dataset.needsUi;
        }
      }
      section.append(toolbar);
    }
    const viewport = document.createElement('div');
    viewport.className = 'viewport';
    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    const status = document.createElement('div');
    status.className = 'status';
    status.textContent = `Connecting to ${device.name}…`;
    viewport.append(canvas, status);
    section.append(viewport);

    const cell = {
      id: device.id,
      name: device.name,
      transport: device.transport,
      aspect: device.aspect || DEFAULT_ASPECT,
      section,
      toolbar,
      viewport,
      canvas,
      context: canvas.getContext('2d'),
      status,
      frameWidth: 0,
      frameHeight: 0,
      pointers: new Set(),
      resizeTimer: undefined,
      observer: undefined,
      decoder: undefined,
      config: undefined,
      waitingKey: true,
    };
    wireCell(cell);
    return cell;
  }

  function wireCell(cell) {
    const { id, canvas, viewport } = cell;
    const position = (event) => {
      const rect = canvas.getBoundingClientRect();
      return { u: (event.clientX - rect.left) / rect.width, v: (event.clientY - rect.top) / rect.height };
    };

    cell.section.addEventListener('pointerdown', () => setFocus(id), true);

    cell.toolbar?.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (button?.dataset.panel) {
        return;
      }
      if (button?.dataset.command && !button.disabled) {
        post({ type: 'command', id, command: button.dataset.command });
      }
      canvas.focus();
    });

    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return;
      }
      canvas.focus();
      canvas.setPointerCapture(event.pointerId);
      cell.pointers.add(event.pointerId);
      post({ type: 'pointer', id, phase: 'down', pointer: event.pointerId, ...position(event) });
    });
    canvas.addEventListener('pointermove', (event) => {
      if (cell.pointers.has(event.pointerId)) {
        post({ type: 'pointer', id, phase: 'move', pointer: event.pointerId, ...position(event) });
      }
    });
    const endPointer = (event) => {
      if (cell.pointers.delete(event.pointerId)) {
        post({ type: 'pointer', id, phase: 'up', pointer: event.pointerId, ...position(event) });
      }
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);

    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const scale = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
        post({ type: 'wheel', id, dx: event.deltaX * scale, dy: event.deltaY * scale, ...position(event) });
      },
      { passive: false },
    );

    canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      post({ type: 'command', id, command: 'emulatorPanel.back' });
    });

    cell.section.addEventListener('dragover', (event) => {
      if (carriesFiles(event)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }
    });
    cell.section.addEventListener('drop', async (event) => {
      if (!carriesFiles(event)) {
        return;
      }
      event.preventDefault();
      const uris = event.dataTransfer
        .getData('text/uri-list')
        .split(/\r?\n/)
        .filter((line) => line.startsWith('file:'));
      if (uris.length) {
        post({ type: 'drop', id, uris });
        return;
      }
      const files = [...event.dataTransfer.files];
      if (files.length) {
        post({
          type: 'dropFiles',
          id,
          files: await Promise.all(files.map(async (file) => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) }))),
        });
      }
    });

    cell.observer = new ResizeObserver(() => {
      layoutCanvas(cell);
      fitToolbar(cell);
      clearTimeout(cell.resizeTimer);
      cell.resizeTimer = setTimeout(
        () =>
          post({
            type: 'resize',
            id,
            width: viewport.clientWidth,
            height: viewport.clientHeight,
            dpr: window.devicePixelRatio || 1,
          }),
        100,
      );
    });
    cell.observer.observe(viewport);
  }

  function renderChips() {
    chips.replaceChildren(
      ...order.map((id) => {
        const cell = cells.get(id);
        const chip = document.createElement('div');
        chip.className = 'chip';
        chip.dataset.id = String(id);
        chip.setAttribute('role', 'tab');
        const dot = document.createElement('span');
        dot.className = 'dot';
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = cell.name;
        const close = document.createElement('button');
        close.className = 'close';
        close.title = cell.transport === 'h264' ? `Stop mirroring ${cell.name}` : stopOnClose ? `Stop ${cell.name}` : `Close ${cell.name} (it keeps running)`;
        close.setAttribute('aria-label', close.title);
        close.textContent = '×';
        close.addEventListener('click', (event) => {
          event.stopPropagation();
          post({ type: 'close', id });
        });
        chip.addEventListener('click', () => {
          setFocus(id);
          cell.canvas.focus();
        });
        chip.append(dot, label, close);
        return chip;
      }),
    );
  }

  function releaseCell(cell) {
    cell.observer.disconnect();
    if (cell.decoder && cell.decoder.state !== 'closed') {
      cell.decoder.close();
    }
    cell.section.remove();
  }

  async function drawFrame(message) {
    const cell = cells.get(message.id);
    if (!cell) {
      return;
    }
    const bitmap = await createImageBitmap(new Blob([message.png], { type: 'image/png' }));
    applyFrameSize(cell, bitmap.width, bitmap.height);
    cell.context.drawImage(bitmap, 0, 0);
    bitmap.close();
    cell.status.hidden = true;
  }

  function resetDecoder(cell) {
    if (cell.decoder && cell.decoder.state !== 'closed') {
      cell.decoder.close();
    }
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (cell.decoder === decoder) {
          applyFrameSize(cell, frame.displayWidth, frame.displayHeight);
          cell.context.drawImage(frame, 0, 0);
          cell.status.hidden = true;
          if (!cell.videoReported) {
            cell.videoReported = true;
            post({ type: 'videoStarted', id: cell.id, width: frame.displayWidth, height: frame.displayHeight });
          }
        }
        frame.close();
      },
      error: () => {
        if (cell.decoder === decoder) {
          cell.decoder = undefined;
          cell.waitingKey = true;
          post({ type: 'videoError', id: cell.id });
        }
      },
    });
    decoder.configure({ codec: H264_CODEC, optimizeForLatency: true });
    cell.decoder = decoder;
    cell.waitingKey = true;
  }

  function handleVideo(message) {
    const cell = cells.get(message.id);
    if (!cell) {
      return;
    }
    if (message.kind === 'session') {
      applyFrameSize(cell, message.width, message.height);
      cell.waitingKey = true;
      return;
    }
    if (message.kind === 'config') {
      cell.config = message.data;
      resetDecoder(cell);
      return;
    }
    const decoder = cell.decoder;
    if (!decoder || decoder.state !== 'configured') {
      return;
    }
    const key = message.kind === 'key';
    if (cell.waitingKey && !key) {
      return;
    }
    if (!key && decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
      cell.waitingKey = true;
      post({ type: 'videoError', id: cell.id });
      return;
    }
    let data = message.data;
    if (key && cell.config) {
      data = new Uint8Array(cell.config.length + message.data.length);
      data.set(cell.config);
      data.set(message.data, cell.config.length);
    }
    cell.waitingKey = false;
    decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: message.pts, data }));
  }

  window.addEventListener('message', async (event) => {
    const message = event.data;
    switch (message.type) {
      case 'devices': {
        const ids = new Set(message.devices.map((device) => device.id));
        for (const [id, cell] of cells) {
          if (!ids.has(id)) {
            releaseCell(cell);
            cells.delete(id);
          }
        }
        let added = false;
        for (const device of message.devices) {
          const existing = cells.get(device.id);
          if (!existing) {
            cells.set(device.id, createCell(device));
            added = true;
          } else if (!existing.frameWidth && device.aspect) {
            existing.aspect = device.aspect;
          }
        }
        stopOnClose = message.stopOnClose !== false;
        document.body.classList.toggle('empty', message.devices.length === 0);
        emptyState.hidden = message.devices.length > 0;
        document.body.classList.toggle('in-window', !!message.separateWindow);
        for (const button of document.querySelectorAll('[data-panel="onTop"]')) {
          button.classList.toggle('pressed', !!message.alwaysOnTop);
          button.setAttribute('aria-pressed', String(!!message.alwaysOnTop));
          button.title = message.alwaysOnTop ? 'Stop keeping window on top' : 'Keep window on top';
        }
        order = message.devices.map((device) => device.id);
        order.forEach((id) => container.append(cells.get(id).section));
        if (message.focused !== undefined && cells.has(message.focused)) {
          focusedId = message.focused;
        }
        if (!cells.has(focusedId)) {
          focusedId = order[0];
        }
        renderChips();
        relayout();
        reportLayout('devices');
        if (added) {
          cells.get(focusedId)?.canvas.focus();
        }
        break;
      }
      case 'frame':
        try {
          await drawFrame(message);
        } finally {
          post({ type: 'drawn', id: message.id });
        }
        break;
      case 'video':
        handleVideo(message);
        break;
      case 'status': {
        const cell = cells.get(message.id);
        if (cell) {
          cell.status.textContent = message.text || '';
          cell.status.hidden = !message.text;
          cell.status.classList.toggle('overlay', cell.frameWidth > 0);
        }
        break;
      }
      case 'requestLayout':
        relayout();
        reportLayout('request');
        break;
    }
  });

  let resizeReport;
  new ResizeObserver(() => {
    relayout();
    clearTimeout(resizeReport);
    resizeReport = setTimeout(() => reportLayout('resize'), 80);
  }).observe(container);

  let windowBounds;
  let windowBoundsTimer;
  const checkWindowBounds = () => {
    if (!document.body.classList.contains('in-window')) {
      windowBounds = undefined;
      return;
    }
    const bounds = { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight };
    const key = Object.values(bounds).join();
    if (key !== windowBounds) {
      windowBounds = key;
      clearTimeout(windowBoundsTimer);
      windowBoundsTimer = setTimeout(() => post({ type: 'windowBounds', ...bounds }), 600);
    }
  };
  setInterval(checkWindowBounds, 1000);
  window.addEventListener('resize', checkWindowBounds);

  const EDIT_ACTIONS = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut' };

  // VS Code takes over a file drag unless its dragenter is cancelled first.
  const carriesFiles = (event) => !!event.dataTransfer?.types.some((type) => type === 'Files' || type === 'text/uri-list');
  document.addEventListener('dragenter', (event) => {
    if (carriesFiles(event)) {
      event.preventDefault();
    }
  });

  const forwardKey = (eventType) => (event) => {
    const held = heldKeys.get(event.code);
    if (eventType === 'keyup' && held) {
      // Sent even with Cmd/Ctrl down now (Shift, then Cmd+P, then letting go
      // of Shift), or the emulator keeps the key pressed.
      event.preventDefault();
      heldKeys.delete(event.code);
      post({ type: 'key', id: held.id, key: held.key, eventType: 'keyup' });
      return;
    }
    const editAction = EDIT_ACTIONS[event.key.toLowerCase()];
    if (eventType === 'keydown' && focusedId !== undefined && editAction && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && !event.repeat) {
      post({ type: 'edit', id: focusedId, action: editAction });
      return;
    }
    if (focusedId === undefined || event.metaKey || event.ctrlKey || event.isComposing || passthroughKeys.has(event.key)) {
      return;
    }
    if (event.target instanceof HTMLButtonElement && (event.key === 'Enter' || event.key === ' ')) {
      return;
    }
    event.preventDefault();
    if (event.key === 'CapsLock') {
      // macOS reports Caps Lock as a keydown when it turns on and a keyup when
      // it turns off, while Android toggles once per press.
      post({ type: 'key', id: focusedId, key: 'CapsLock', eventType: 'keydown' });
      post({ type: 'key', id: focusedId, key: 'CapsLock', eventType: 'keyup' });
      return;
    }
    if (eventType === 'keydown') {
      heldKeys.set(event.code, { id: focusedId, key: event.key });
    } else {
      heldKeys.delete(event.code);
    }
    post({ type: 'key', id: focusedId, key: event.key, eventType });
  };
  window.addEventListener('keydown', forwardKey('keydown'));
  window.addEventListener('keyup', forwardKey('keyup'));

  // A key still down when focus leaves the webview never gets its keyup, and a
  // stuck Alt turns every later letter into a shortcut the text field ignores.
  const releaseHeldKeys = () => {
    for (const { id, key } of heldKeys.values()) {
      post({ type: 'key', id, key, eventType: 'keyup' });
    }
    heldKeys.clear();
  };
  window.addEventListener('blur', releaseHeldKeys);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      releaseHeldKeys();
    }
  });

  document.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-panel]');
    if (button) {
      post({ type: 'panelAction', action: button.dataset.panel });
    }
  });

  post({ type: 'ready' });
})();
