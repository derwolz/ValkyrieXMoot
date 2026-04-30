/**
 * lib/ui/pauseMenu.js — Manages the #pause-menu overlay.
 *
 * Reads the static HTML already present in index.html:
 *   #pause-menu          — the full-screen dark overlay (gets class "open" when visible)
 *   #pause-tabs          — tab bar with [data-tab="resume-tab"] [data-tab="bindings-tab"]
 *   #pause-body          — scrollable content area
 *   #resume-tab          — "Resume" pane
 *   #bindings-tab        — keybindings pane
 *   #pause-resume        — "Resume" button inside the resume pane
 *   #kb-tbody            — <tbody> where binding rows are injected
 *   #kb-reset-all        — "Reset all to defaults" button
 *
 * Public API:
 *   PauseMenu.isOpen     — getter, true while the overlay is visible
 *   PauseMenu.open()     — show the menu
 *   PauseMenu.close()    — hide the menu
 *   PauseMenu.toggle()   — open if closed, close if open
 */

import { Bindings, DEFAULT_BINDINGS } from '../input/bindings.js';

const menuEl    = document.getElementById('pause-menu');
const tabBtns   = menuEl.querySelectorAll('.pause-tab');
const tbody     = document.getElementById('kb-tbody');
const resetAllBtn = document.getElementById('kb-reset-all');
const resumeBtn = document.getElementById('pause-resume');

// Track which key-chip is awaiting a keystroke.
let _capturingAction = null;
let _capturingChip   = null;

// ── Tab switching ─────────────────────────────────────────────────────────────

function _activateTab(tabId) {
  for (const btn of tabBtns) {
    const isTarget = btn.dataset.tab === tabId;
    btn.classList.toggle('active', isTarget);
    const pane = document.getElementById(btn.dataset.tab);
    if (pane) pane.style.display = isTarget ? '' : 'none';
  }
  // Rebuild bindings table whenever the keybindings tab is shown.
  if (tabId === 'bindings-tab') _buildTable();
}

for (const btn of tabBtns) {
  btn.addEventListener('click', () => _activateTab(btn.dataset.tab));
}

// ── Keybindings table ─────────────────────────────────────────────────────────

function _buildTable() {
  tbody.innerHTML = '';

  const groups = [
    { id: 'movement', label: 'Movement' },
    { id: 'hotkey',   label: 'Hotkeys'  },
  ];

  for (const group of groups) {
    // Group header row.
    const headerRow = document.createElement('tr');
    headerRow.className = 'kb-row-group';
    const headerCell = document.createElement('td');
    headerCell.colSpan = 2;
    headerCell.textContent = group.label;
    headerRow.appendChild(headerCell);
    tbody.appendChild(headerRow);

    // Action rows for this group.
    for (const action of Bindings.actions) {
      const def = DEFAULT_BINDINGS[action];
      if (def.group !== group.id) continue;

      const tr = document.createElement('tr');

      // Action label cell.
      const labelTd = document.createElement('td');
      labelTd.textContent = def.label;
      tr.appendChild(labelTd);

      // Key chip cell.
      const keyTd = document.createElement('td');
      const chip = document.createElement('span');
      chip.className = 'kb-chip';
      chip.textContent = Bindings.labelFor(action);
      chip.title = 'Click to rebind';
      chip.dataset.action = action;
      chip.addEventListener('click', () => _startCapture(action, chip));
      keyTd.appendChild(chip);
      tr.appendChild(keyTd);

      tbody.appendChild(tr);
    }
  }
}

// ── Key capture ───────────────────────────────────────────────────────────────

function _startCapture(action, chip) {
  // Cancel any previous capture.
  _cancelCapture();

  _capturingAction = action;
  _capturingChip   = chip;
  chip.textContent = '…';
  chip.classList.add('capturing');
}

function _cancelCapture() {
  if (!_capturingAction) return;
  // Restore the chip label.
  if (_capturingChip) {
    _capturingChip.textContent = Bindings.labelFor(_capturingAction);
    _capturingChip.classList.remove('capturing');
  }
  _capturingAction = null;
  _capturingChip   = null;
}

// Listen for keydown in capture mode. Use capture phase to intercept before
// main.js sees Escape or other hotkeys while a rebind is in progress.
window.addEventListener('keydown', (e) => {
  // Escape always closes the menu (whether or not a capture is in progress).
  if (e.code === 'Escape') {
    e.preventDefault();
    if (_capturingAction) {
      // Cancel the capture first; Escape key consumed — don't also close the menu.
      e.stopImmediatePropagation();
      _cancelCapture();
      return;
    }
    if (PauseMenu.isOpen) {
      e.stopImmediatePropagation();
      PauseMenu.close();
      return;
    }
  }

  // If we're capturing a key for rebinding, any non-Escape key becomes the new primary.
  if (_capturingAction) {
    e.preventDefault();
    e.stopImmediatePropagation();

    const action = _capturingAction;
    const chip   = _capturingChip;

    Bindings.rebind(action, e.code);
    chip.textContent = Bindings.labelFor(action);
    chip.classList.remove('capturing');

    _capturingAction = null;
    _capturingChip   = null;
  }
}, true /* capture phase */);

// ── Reset all ─────────────────────────────────────────────────────────────────

resetAllBtn.addEventListener('click', () => {
  _cancelCapture();
  Bindings.resetAll();
  _buildTable();
});

// ── Resume button ─────────────────────────────────────────────────────────────

resumeBtn.addEventListener('click', () => PauseMenu.close());

// ── Public API ────────────────────────────────────────────────────────────────

export const PauseMenu = {
  get isOpen() { return menuEl.classList.contains('open'); },

  open() {
    _cancelCapture();
    // Always start on the Resume tab, rebuild keybindings table for freshness.
    _activateTab('resume-tab');
    menuEl.classList.add('open');
  },

  close() {
    _cancelCapture();
    menuEl.classList.remove('open');
  },

  toggle() {
    if (this.isOpen) this.close(); else this.open();
  },
};
