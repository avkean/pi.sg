import { createEncoder } from './client.mjs';
import { prepareInput, friendlyError } from './input.mjs';
import { enhance } from './enhance.mjs';
import { withConfirmation } from './surface.mjs';

const form = document.querySelector('#compress-form');
const input = document.querySelector('#input');
const output = document.querySelector('#output');
const outputLabel = document.querySelector('#output-label');
const copy = document.querySelector('#copy');
const clear = document.querySelector('#clear');
const open = document.querySelector('#open');
const stats = document.querySelector('#stats');
const error = document.querySelector('#input-error');
const copyStatus = document.querySelector('#copy-status');
const plain = document.querySelector('#plain');
const unicode = document.querySelector('#unicode');
const extra = document.querySelector('#extra');
const confirmation = document.querySelector('#confirmation');
const encoder = createEncoder({
  workerUrl: new URL('./worker.js', import.meta.url),
  timeoutMs: 300,
  maxPending: 2
});
let revision = 0,
  debounce,
  retry,
  copiedTimer,
  result = null,
  enhancementController;

encoder.preload();

function resetOutput() {
  result = null;
  output.value = '';
  copy.disabled = true;
  copy.textContent = 'Copy link';
  copyStatus.textContent = '';
  open.hidden = true;
  open.removeAttribute('href');
  outputLabel.textContent = 'Compressed link';
  clearTimeout(copiedTimer);
}

function showResult(current, source, version) {
  if (version !== revision) return;
  if (result?.source === source && result.url.length < current.url.length)
    return;
  result = { ...current, source };
  displayResult();
}

function displayResult() {
  if (!result) return;
  let url;
  try {
    url = withConfirmation(result.url, confirmation.checked);
  } catch {
    output.value = '';
    copy.disabled = true;
    copy.textContent = 'Copy link';
    copyStatus.textContent = '';
    clearTimeout(copiedTimer);
    open.hidden = true;
    open.removeAttribute('href');
    error.textContent =
      'This link is at the size limit. Turn off “Show destination first” to share it.';
    error.hidden = false;
    stats.textContent = 'The confirmation screen needs one extra character.';
    return;
  }
  if (output.value !== url) {
    clearTimeout(copiedTimer);
    copy.textContent = 'Copy link';
    copyStatus.textContent = '';
  }
  error.hidden = true;
  error.textContent = '';
  output.value = url;
  copy.disabled = false;
  open.href = url;
  open.hidden = false;
  stats.textContent =
    sizeChange(result.source, url) +
    (result.limited ? ' Quick compression.' : '');
}

function sizeChange(source, encoded) {
  const before = [...source].length;
  const difference = [...encoded].length - before;
  if (!difference) return 'Same length (0% change).';
  const amount = Math.abs(difference);
  const percent = (amount / before) * 100;
  const rounded =
    percent < 0.1
      ? '<0.1'
      : percent.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return `${amount.toLocaleString()} ${amount === 1 ? 'character' : 'characters'} ${difference > 0 ? 'longer' : 'shorter'} (${rounded}%).`;
}

async function compress(version, attempt = 0) {
  if (version !== revision) return;
  if (attempt && result?.enhanced) return;
  let source;
  try {
    source = prepareInput(input.value);
    if (!source) {
      stats.textContent = 'Paste a link to get started.';
      return;
    }
    if (!attempt) stats.textContent = 'Compressing…';
    const options = {
      origin: location.origin,
      format: plain.checked ? 'ascii' : 'compact'
    };
    let extraPending = null;
    if (!attempt && extra.checked) {
      enhancementController?.abort();
      enhancementController = new AbortController();
      extraPending = enhance(source, {
        ...options,
        signal: enhancementController.signal
      });
    }
    let current;
    try {
      current = await encoder.encode(source, options);
    } catch (failure) {
      // A stronger pass can rescue an input whose browser result exceeded
      // the sharing limit. Otherwise retain the original actionable error.
      current = await extraPending;
      if (!current) throw failure;
    }
    if (version !== revision) return;
    showResult(current, source, version);
    extraPending?.then((smaller) => {
      if (
        smaller &&
        version === revision &&
        (!result || smaller.url.length < result.url.length)
      )
        showResult(smaller, source, version);
    });
    if (current.limited && attempt < 2) {
      retry = setTimeout(
        () => compress(version, attempt + 1),
        750 * (attempt + 1)
      );
    } else if (current.limited && result?.url === current.url && output.value) {
      stats.textContent =
        sizeChange(source, output.value) +
        ' Quick compression; reload to retry.';
    }
  } catch (failure) {
    if (version !== revision) return;
    resetOutput();
    error.textContent = friendlyError(failure);
    error.hidden = false;
    input.setAttribute('aria-invalid', 'true');
    stats.textContent = 'Check the address above.';
  }
}

function changed(immediate = false) {
  const version = ++revision;
  clearTimeout(debounce);
  clearTimeout(retry);
  enhancementController?.abort();
  resetOutput();
  error.hidden = true;
  error.textContent = '';
  input.removeAttribute('aria-invalid');
  clear.disabled = input.value.length === 0;
  if (!input.value.trim()) {
    stats.textContent = 'Paste a link to get started.';
    return;
  }
  stats.textContent = 'Compressing…';
  if (immediate) compress(version);
  else debounce = setTimeout(() => compress(version), 160);
}

input.addEventListener('input', () => changed());
plain.addEventListener('change', () => changed(true));
unicode.addEventListener('change', () => changed(true));
extra.addEventListener('change', () => changed(true));
confirmation.addEventListener('change', displayResult);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    changed(true);
  }
});
form.addEventListener('submit', (event) => {
  event.preventDefault();
  changed(true);
});
clear.addEventListener('click', () => {
  input.value = '';
  changed(true);
  input.focus();
});
output.addEventListener('click', () => {
  if (output.value) output.select();
});
copy.addEventListener('click', async () => {
  if (!result || !output.value) return;
  const version = revision,
    value = output.value;
  try {
    if (!navigator.clipboard?.writeText) throw Error('Clipboard unavailable');
    await navigator.clipboard.writeText(value);
    if (version !== revision || output.value !== value) return;
    copy.textContent = 'Copied!';
    copyStatus.textContent = 'Link copied.';
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copy.textContent = 'Copy link';
    }, 1600);
  } catch {
    if (version !== revision || output.value !== value) return;
    output.focus();
    output.select();
    stats.textContent =
      sizeChange(result.source, value) +
      ' Link selected. Use your device’s Copy command.';
    copyStatus.textContent =
      'Copy wasn’t available. The link is selected for you.';
  }
});
window.addEventListener('pagehide', () => {
  revision++;
  clearTimeout(debounce);
  clearTimeout(retry);
  clearTimeout(copiedTimer);
  enhancementController?.abort();
  encoder.close();
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload();
});
