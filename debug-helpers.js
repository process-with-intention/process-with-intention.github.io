/**
 * Debug helpers injected into the page during connected-mode debugging.
 * Injected once via: chrome-devtools evaluate_script "() => { ... }"
 *
 * Provides:
 * 1. Element marking — Ctrl+Shift+M marks the element under the cursor
 *    so the agent can find it via [data-agent-inspect].
 * 2. Session recorder — captures clicks, keyboard input, navigation,
 *    scrolls, and form fills into window.__agentRecorder.events[].
 *    The agent reads this to build a reproduction prompt.
 */

// Guard against double-injection
if (!window.__agentDebugHelpers) {
  window.__agentDebugHelpers = true;

  // ── 1. Element Marker ──────────────────────────────────────────────
  // Ctrl+Shift+M: marks the element under the cursor with [data-agent-inspect]
  // Visual feedback: brief green outline flash

  let lastMarked = null;

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'M') {
      e.preventDefault();

      // Get element under cursor via the most recent mousemove target
      const target = window.__agentLastHovered || document.activeElement;
      if (!target || target === document.body) return;

      // Clear previous mark
      if (lastMarked) {
        delete lastMarked.dataset.agentInspect;
        lastMarked.style.outline = lastMarked.__agentPrevOutline || '';
      }

      // Mark new element
      target.dataset.agentInspect = Date.now();
      lastMarked = target;

      // Visual feedback
      target.__agentPrevOutline = target.style.outline;
      target.style.outline = '3px solid #00e676';
      setTimeout(() => {
        target.style.outline = target.__agentPrevOutline || '';
      }, 1500);
    }
  });

  // Track the element under cursor for the marker
  document.addEventListener('mousemove', (e) => {
    window.__agentLastHovered = e.target;
  }, { passive: true });


  // ── 2. Session Recorder ────────────────────────────────────────────
  // Records user interactions into window.__agentRecorder.events[]
  // Agent reads via: chrome-devtools evaluate_script "() => window.__agentRecorder"

  const recorder = {
    recording: false,
    events: [],
    startTime: null,
    start() {
      this.events = [];
      this.startTime = Date.now();
      this.recording = true;
      this.viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        userAgent: navigator.userAgent,
      };
    },
    stop() {
      this.recording = false;
      return {
        viewport: this.viewport,
        duration: Date.now() - this.startTime,
        eventCount: this.events.length,
        events: this.events,
      };
    },
    // Walk up from a target to find the nearest interactive ancestor
    // (a, button, input, select, textarea, [role=button], [role=link], [role=menuitem])
    _interactiveAncestor(el) {
      const interactive = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="radio"]';
      let node = el;
      while (node && node !== document.body) {
        if (node.matches && node.matches(interactive)) return node;
        node = node.parentElement;
      }
      return el; // fallback to original target
    },
    // Extract semantic attributes that disambiguate an element
    _identity(el) {
      const info = {};
      if (el.getAttribute('aria-label')) info.ariaLabel = el.getAttribute('aria-label');
      if (el.href) info.href = el.getAttribute('href');
      if (el.getAttribute('role')) info.role = el.getAttribute('role');
      if (el.tagName) info.tag = el.tagName.toLowerCase();
      if (el.type) info.type = el.type;
      if (el.name) info.name = el.name;
      if (el.id) info.id = el.id;
      // Nearest landmark or named section ancestor for positional context
      const section = el.closest('[id]:not([id^="__"])');
      if (section && section !== el) info.nearestId = section.id;
      return info;
    },
    _selector(el) {
      if (!el || el === document || el === document.body) return 'body';
      // Prefer aria-label selector if available (most specific for this codebase)
      const label = el.getAttribute('aria-label');
      if (label) return el.tagName.toLowerCase() + '[aria-label="' + label + '"]';
      // Prefer href for links
      if (el.tagName === 'A' && el.getAttribute('href')) return 'a[href="' + el.getAttribute('href') + '"]';
      if (el.id) return '#' + el.id;
      // Fallback: build a path selector
      const parts = [];
      let node = el;
      while (node && node !== document.body && parts.length < 4) {
        let seg = node.tagName.toLowerCase();
        if (node.id) { parts.unshift('#' + node.id); break; }
        const label = node.getAttribute('aria-label');
        if (label) { parts.unshift(seg + '[aria-label="' + label + '"]'); break; }
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
          if (siblings.length > 1) seg += ':nth-child(' + (Array.from(parent.children).indexOf(node) + 1) + ')';
        }
        parts.unshift(seg);
        node = node.parentElement;
      }
      return parts.join(' > ');
    },
    _push(type, detail) {
      if (!this.recording) return;
      this.events.push({
        type,
        time: Date.now() - this.startTime,
        url: location.pathname + location.hash,
        ...detail,
      });
    },
  };

  // Click — resolve to nearest interactive ancestor before recording
  document.addEventListener('click', (e) => {
    const interactive = recorder._interactiveAncestor(e.target);
    recorder._push('click', {
      selector: recorder._selector(interactive),
      identity: recorder._identity(interactive),
      text: interactive.textContent?.substring(0, 80).trim(),
      x: e.clientX,
      y: e.clientY,
    });
  }, { capture: true, passive: true });

  // Keyboard (Enter, Escape, Tab — not character keys for privacy)
  document.addEventListener('keydown', (e) => {
    if (['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete'].includes(e.key) || e.ctrlKey || e.metaKey) {
      const interactive = recorder._interactiveAncestor(e.target);
      recorder._push('keydown', {
        key: e.key,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        meta: e.metaKey,
        selector: recorder._selector(interactive),
        identity: recorder._identity(interactive),
      });
    }
  }, { capture: true, passive: true });

  // Input/change (captures form fills)
  document.addEventListener('input', (e) => {
    recorder._push('input', {
      selector: recorder._selector(e.target),
      identity: recorder._identity(e.target),
      value: e.target.value?.substring(0, 100),
      inputType: e.inputType,
    });
  }, { capture: true, passive: true });

  // Scroll (debounced)
  let scrollTimer;
  document.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      recorder._push('scroll', {
        scrollY: Math.round(window.scrollY),
        scrollX: Math.round(window.scrollX),
      });
    }, 300);
  }, { capture: true, passive: true });

  // Navigation (SPA route changes via popstate + pushState/replaceState)
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function() {
    origPush.apply(this, arguments);
    recorder._push('navigate', { to: location.pathname + location.hash });
  };
  history.replaceState = function() {
    origReplace.apply(this, arguments);
    recorder._push('navigate', { to: location.pathname + location.hash });
  };
  window.addEventListener('popstate', () => {
    recorder._push('navigate', { to: location.pathname + location.hash });
  });

  window.__agentRecorder = recorder;

  console.log(
    '%c[Agent Debug Helpers loaded]%c\n' +
    '• Ctrl+Shift+M → mark element under cursor for agent\n' +
    '• __agentRecorder.start() → begin recording interactions\n' +
    '• __agentRecorder.stop() → stop recording',
    'color: #00e676; font-weight: bold', 'color: inherit'
  );
}
