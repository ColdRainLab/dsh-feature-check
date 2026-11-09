/**
 * Client-half unit tests for dsh-feature-check.
 *
 * The bundle is evaluated in a fresh `node:vm` realm whose
 * `window.__ModuleLoader__.load` captures the factory; the factory receives a
 * minimal module table (`react` stub). A miniature hook-capable renderer mounts
 * one component at a time so slot registration, the footer status entry and the
 * self-check panel can be asserted without a browser.
 *
 * Run with:
 *   node plugins/dsh-feature-check/tests/client.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = path.resolve(here, '..', 'lib', 'client.js');
const BUNDLE_SOURCE = readFileSync(BUNDLE_PATH, 'utf8');

const SETTINGS_TAB_SLOT = 'settings.plugins.tab';
const TAB_ENTRY_ID = 'feature-check';
const TAB_ORDER = 20;
const STATUS_PATH = 'api/feature-check/status';
const RUN_PATH = 'api/feature-check/run';

// ==== Tiny React ============================================================
let activeRuntime = null;

function depsChanged(previous, next) {
  if (previous === undefined) return true;
  if (!Array.isArray(previous) || !Array.isArray(next)) return previous !== next;
  if (previous.length !== next.length) return true;
  for (let index = 0; index < previous.length; index += 1) {
    if (!Object.is(previous[index], next[index])) return true;
  }
  return false;
}

class HookRuntime {
  constructor() {
    this.hooks = [];
    this.index = 0;
    this.pendingEffects = [];
    this.tree = null;
    this.rerender = null;
  }

  useState(initial) {
    const index = this.index;
    this.index += 1;
    if (this.hooks[index] === undefined) {
      this.hooks[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial };
    }
    const slot = this.hooks[index];
    const setState = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (Object.is(value, slot.value)) return value;
      slot.value = value;
      if (this.rerender !== null) this.rerender();
      return value;
    };
    return [slot.value, setState];
  }

  useEffect(effect, deps) {
    const index = this.index;
    this.index += 1;
    if (this.hooks[index] === undefined) this.hooks[index] = { kind: 'effect', deps: undefined, cleanup: undefined };
    const slot = this.hooks[index];
    if (depsChanged(slot.deps, deps)) {
      slot.deps = deps;
      this.pendingEffects.push({ slot, effect });
    }
  }

  collectCleanup() {
    for (const slot of this.hooks) {
      if (slot !== undefined && typeof slot.cleanup === 'function') {
        slot.cleanup();
        slot.cleanup = undefined;
      }
    }
  }
}

function createReactStub() {
  return {
    Fragment: Symbol.for('react.fragment'),
    createElement(type, props, ...children) {
      return { type, props: props === null || props === undefined ? {} : props, children };
    },
    useState(initial) { return activeRuntime.useState(initial); },
    useEffect(effect, deps) { activeRuntime.useEffect(effect, deps); },
  };
}

function mount(Component, props) {
  const runtime = new HookRuntime();
  activeRuntime = runtime;
  const renderOnce = () => {
    runtime.index = 0;
    runtime.pendingEffects = [];
    runtime.tree = Component(props);
    const effects = runtime.pendingEffects;
    runtime.pendingEffects = [];
    for (const { slot, effect } of effects) {
      if (typeof slot.cleanup === 'function') slot.cleanup();
      const cleanup = effect();
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    }
    return runtime.tree;
  };
  runtime.rerender = renderOnce;
  renderOnce();
  return {
    runtime,
    get tree() { return runtime.tree; },
    unmount() { runtime.collectCleanup(); },
  };
}

async function flush() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

// ==== Tree helpers ==========================================================
function childrenOf(node) {
  return Array.isArray(node.children) ? node.children : [];
}

function walk(node, visit) {
  if (node === null || node === undefined) return;
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (typeof node !== 'object' || node.type === undefined) return;
  visit(node);
  for (const child of childrenOf(node)) walk(child, visit);
  if (childrenOf(node).length === 0 && node.props !== undefined && node.props.children !== undefined) walk(node.props.children, visit);
}

function findAll(tree, predicate) {
  const found = [];
  walk(tree, (node) => { if (predicate(node)) found.push(node); });
  return found;
}

function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node !== 'object') return '';
  const children = childrenOf(node);
  if (children.length === 0 && node.props !== undefined && node.props.children !== undefined) return textOf(node.props.children);
  return children.map(textOf).join('');
}

function buttons(tree) {
  return findAll(tree, (node) => node.type === 'button');
}

function buttonWithText(tree, text) {
  const match = buttons(tree).find((node) => textOf(node).includes(text));
  assert.ok(match !== undefined, `no button containing ${JSON.stringify(text)}`);
  return match;
}

function click(node, event = {}) {
  const handler = node.props && (node.props.onClick || node.props.onSelect);
  assert.equal(typeof handler, 'function', 'expected a clickable element');
  return handler({ target: node, currentTarget: node, preventDefault() {}, stopPropagation() {}, ...event });
}

/** Render one nested function-component element produced inside a tree. */
function renderFunctionComponent(node) {
  return node.type({ ...node.props, children: node.children });
}

function findFunctionComponent(tree, componentName) {
  return findAll(tree, (node) => typeof node.type === 'function' && node.type.name === componentName)[0];
}

// ==== Bundle loader =========================================================
function createDocument() {
  return {
    baseURI: 'http://127.0.0.1:44661/',
    querySelector() { return null; },
    createElement() { return { setAttribute() {}, textContent: '', parentNode: null }; },
    head: { appendChild() {} },
  };
}

function loadBundle(options = {}) {
  const react = options.react ?? createReactStub();
  let registration = null;
  const sandbox = {
    window: { __ModuleLoader__: { load(captured) { registration = captured; } } },
    console,
    URL,
    JSON,
    Promise,
    Set,
    Map,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    Date,
    Error,
    RegExp,
    Symbol,
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
    navigator: { language: options.language ?? 'zh-CN' },
    location: options.location ?? { protocol: 'http:', href: 'http://127.0.0.1:44661/' },
    fetch: options.fetch ?? (async () => ({ ok: true, status: 200, json: async () => ({ ok: true, report: null, pending: true }) })),
  };
  if (options.document !== undefined) sandbox.document = options.document;
  if (options.transport !== undefined) sandbox.__DSH_TRANSPORT__ = options.transport;
  vm.createContext(sandbox);
  vm.runInContext(BUNDLE_SOURCE, sandbox, { filename: 'dsh-feature-check/client.js' });
  assert.ok(registration !== null, 'bundle must call window.__ModuleLoader__.load');
  assert.equal(registration.id, 'dsh-feature-check');

  const require = (specifier) => {
    if (specifier === 'react') return react;
    throw new Error('unexpected require: ' + specifier);
  };
  const plugin = registration.factory(require);
  return { sandbox, registration, plugin };
}

function createFakeCtx(options = {}) {
  const registrations = [];
  const effects = [];
  const localeRegisters = [];
  const localeService = {
    register(namespace, dictionaries) {
      localeRegisters.push({ namespace, dictionaries });
      return () => {};
    },
    bind() { return (key) => key; },
  };
  const services = options.services ?? { locale: localeService };
  const ctx = {
    slots: {
      inject(slotName, factory) {
        const dispose = factory();
        return typeof dispose === 'function' ? dispose : () => {};
      },
      register(registrationOptions, component) {
        registrations.push({ options: registrationOptions, component });
        return () => {};
      },
    },
    locale: localeService,
    effect(effect) {
      effects.push(effect);
      const dispose = effect();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    get(name) { return services[name]; },
  };
  return { ctx, registrations, effects, localeRegisters };
}

function registrationOf(registrations, id) {
  const match = registrations.find((entry) => entry.options.id === id);
  assert.ok(match !== undefined, `registration ${id} missing`);
  return match;
}

function seed(plugin, patch) {
  plugin.__internal.update(Object.assign({
    report: null,
    open: false,
    busy: false,
    loading: false,
    error: null,
    autoOpened: false,
  }, patch));
}

const OK_REPORT = {
  schemaVersion: 1,
  ok: true,
  pending: false,
  baselineCreated: false,
  checkedAt: '2026-10-24T12:00:00.000Z',
  runtimeVersion: '0.2.1-rc.3',
  baselineRuntimeVersion: '0.2.1-rc.3',
  upgraded: false,
  issues: [],
  warnings: [],
  counts: { entries: 12, clientModules: 14, issues: 0 },
  paths: { report: 'C:/Users/u/.dsh/feature-check/report.json' },
};

const FAIL_REPORT = {
  ...OK_REPORT,
  ok: false,
  upgraded: true,
  baselineRuntimeVersion: '0.2.1-rc.2',
  issues: [
    { kind: 'bundle', name: 'dsh-session-delete', code: 'incompatible-version', detail: 'incompatible with dsh 0.2.1-rc.3', hint: '更新该插件；或临时授权：dsh plugin allow-version dsh-session-delete@0.2.2' },
    { kind: 'client-module', name: 'dsh-gacha-calendar', detail: 'client module is missing', hint: '查看插件页/日志' },
  ],
  counts: { entries: 10, clientModules: 12, issues: 2 },
};

// ==== 1. Plugin shape =======================================================
test('exposes a cordis client plugin and registers one Settings tab', () => {
  const { plugin } = loadBundle();
  assert.equal(plugin.name, 'dsh-feature-check');
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale']);

  const fake = createFakeCtx();
  plugin.apply(fake.ctx);

  assert.deepEqual(fake.registrations.map((entry) => entry.options.name), [SETTINGS_TAB_SLOT]);
  const tab = registrationOf(fake.registrations, TAB_ENTRY_ID);
  assert.equal(tab.options.order, TAB_ORDER);
  assert.equal(tab.options.locale, 'dsh-feature-check');
  assert.equal(typeof tab.options.label, 'function');
  assert.ok(String(tab.options.label()).includes('自检'), 'tab label is localized');

  assert.equal(fake.localeRegisters.length, 1);
  assert.equal(fake.localeRegisters[0].namespace, 'dsh-feature-check');
  assert.equal(fake.localeRegisters[0].dictionaries.zh['tab.label'], '启动自检');
  assert.equal(fake.localeRegisters[0].dictionaries.zh['panel.title'], '启动自检');
  assert.equal(fake.localeRegisters[0].dictionaries.en['tab.label'], 'Self-check');
});

// ==== 2. Settings tab content ==============================================
const TAB_FETCH = (report) => async () => ({ ok: true, status: 200, json: async () => ({ ok: true, report, pending: false }) });

test('settings tab renders missing features with details and a fix hint', () => {
  const { plugin } = loadBundle({ fetch: TAB_FETCH(FAIL_REPORT) });
  const fake = createFakeCtx();
  plugin.apply(fake.ctx);
  const tab = registrationOf(fake.registrations, TAB_ENTRY_ID);
  seed(plugin, { report: FAIL_REPORT, loading: false });
  const view = mount(tab.component, {});
  assert.ok(view.tree !== null);
  const copy = textOf(view.tree);
  assert.ok(copy.includes('启动自检'));
  assert.ok(copy.includes('2 项功能缺失'), 'summary counts the missing features');
  assert.ok(copy.includes('升级'), 'upgrade wording is used');
  assert.ok(copy.includes('不读取会话内容'), 'the tab says what it reads');

  // Each issue row renders through the nested component.
  const rows = findAll(view.tree, (node) => typeof node.type === 'function' && node.type.name === 'IssueRow');
  assert.equal(rows.length, 2);
  const renderedRows = rows.map(renderFunctionComponent);
  const rowText = renderedRows.map(textOf).join('\n');
  assert.ok(rowText.includes('dsh-session-delete'));
  assert.ok(rowText.includes('dsh-gacha-calendar'));
  assert.ok(rowText.includes('allow-version'));
  assert.ok(rowText.includes('插件包'));
  view.unmount();
});

test('settings tab shows the pending copy while the composition settles', () => {
  const pending = { ...OK_REPORT, ok: null, pending: true };
  const { plugin } = loadBundle({ fetch: TAB_FETCH(pending) });
  const fake = createFakeCtx();
  plugin.apply(fake.ctx);
  const tab = registrationOf(fake.registrations, TAB_ENTRY_ID);
  seed(plugin, { report: pending, loading: false });
  const view = mount(tab.component, {});
  const copy = textOf(view.tree);
  assert.ok(copy.includes('等待宿主完成组合') || copy.includes('正在检查'), 'pending copy shown while the composition settles');
  view.unmount();
});

test('settings tab reports a healthy startup with entry/module counts', () => {
  const { plugin } = loadBundle({ fetch: TAB_FETCH(OK_REPORT) });
  const fake = createFakeCtx();
  plugin.apply(fake.ctx);
  const tab = registrationOf(fake.registrations, TAB_ENTRY_ID);
  seed(plugin, { report: OK_REPORT, loading: false });
  const view = mount(tab.component, {});
  const copy = textOf(view.tree);
  assert.ok(copy.includes('自检通过'));
  assert.ok(copy.includes('0.2.1-rc.3'));
  assert.ok(copy.includes('12'));
  assert.ok(copy.includes('没有发现功能缺失'));
  view.unmount();
});

// ==== 4. Requests ===========================================================
test('loadStatus reads the host report into the store', async () => {
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ ok: true, report: FAIL_REPORT, pending: false }) };
  };
  const { plugin } = loadBundle({ fetch: fetchMock });
  seed(plugin, {});
  const report = await plugin.__internal.loadStatus();
  assert.equal(report, FAIL_REPORT);
  assert.equal(calls.length, 1);
  assert.ok(String(calls[0].url).endsWith(STATUS_PATH));
  assert.equal(plugin.__internal.state().report, FAIL_REPORT);
  assert.equal(plugin.__internal.state().error, null);
});

test('a failing status request is stored as an inline error', async () => {
  const { plugin } = loadBundle({ fetch: async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: { message: 'boom' } }) }) });
  seed(plugin, {});
  const report = await plugin.__internal.loadStatus();
  assert.equal(report, null);
  assert.equal(plugin.__internal.state().error, 'boom');
});

test('runCheck posts to the run route and publishes the fresh report', async () => {
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ ok: true, report: OK_REPORT, pending: false }) };
  };
  const { plugin } = loadBundle({ fetch: fetchMock });
  seed(plugin, { report: FAIL_REPORT, open: true, autoOpened: true });
  const report = await plugin.__internal.runCheck();
  assert.equal(report, OK_REPORT);
  const post = calls.find((call) => call.init && call.init.method === 'POST');
  assert.ok(post !== undefined);
  assert.ok(String(post.url).endsWith(RUN_PATH));
  assert.equal(plugin.__internal.state().busy, false);
  assert.equal(plugin.__internal.state().report, OK_REPORT);
});

test('settings tab "check again" triggers the run route', async () => {
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ ok: true, report: FAIL_REPORT, pending: false }) };
  };
  const { plugin } = loadBundle({ fetch: fetchMock });
  const fake = createFakeCtx();
  plugin.apply(fake.ctx);
  const tab = registrationOf(fake.registrations, TAB_ENTRY_ID);
  seed(plugin, { report: FAIL_REPORT, loading: false });
  const view = mount(tab.component, {});
  click(buttonWithText(view.tree, '重新检查'));
  await flush();
  assert.ok(calls.some((call) => call.init && call.init.method === 'POST' && String(call.url).endsWith(RUN_PATH)));
  view.unmount();
});

test('requestJson prefers the carrier transport fetch and keeps its receiver', async () => {
  const calls = [];
  const carrier = {
    streamBaseUrl: 'http://127.0.0.1:44661/',
    fetch(url, init) {
      calls.push({ via: 'carrier', url, init, receiver: this });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, report: null }) });
    },
  };
  const { plugin } = loadBundle({ transport: carrier });
  await plugin.__internal.requestJson(STATUS_PATH, 'GET');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].via, 'carrier');
  assert.equal(calls[0].receiver, carrier, 'transport.fetch must keep its receiver');
  assert.equal(calls[0].url, STATUS_PATH, 'carrier fetch receives the page-relative route');
});

test('global fetch is called with its page global as the receiver', async () => {
  let receiver = null;
  const fetchMock = function (url, init) {
    receiver = this;
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, report: null }) });
  };
  const { plugin } = loadBundle({ fetch: fetchMock });
  await plugin.__internal.requestJson(STATUS_PATH, 'GET');
  assert.ok(receiver !== null, 'fetch must receive a receiver instead of being called detached');
  assert.equal(receiver.fetch, fetchMock, 'the receiver is the page global that owns fetch');
});

test('settings styles ship with the tab content', () => {
  const { plugin } = loadBundle();
  const css = plugin.__internal.CSS;
  assert.ok(css.includes('.dsh-feature-check__settings{'), 'inline settings container style');
  assert.ok(css.includes('.dsh-feature-check__settingsIssues'), 'scrollable issue list');
  assert.ok(css.includes('.dsh-feature-check__row'), 'issue row card');
  assert.equal(css.includes(':has(.dsh-feature-check__footer)'), false, 'the removed footer pairing styles are gone');
});

// ==== 5. Small helpers ======================================================
test('issueCount/toneOf/formatTime behave defensively', () => {
  const { plugin } = loadBundle();
  const internal = plugin.__internal;
  assert.equal(internal.issueCount(FAIL_REPORT), 2);
  assert.equal(internal.issueCount(null), 0);
  assert.equal(internal.issueCount({ counts: { issues: 5 } }), 5);
  assert.equal(internal.toneOf(FAIL_REPORT), 'issues');
  assert.equal(internal.toneOf(OK_REPORT), 'ok');
  assert.equal(internal.toneOf({ ok: null, pending: true }), 'pending');
  assert.equal(internal.toneOf(null), 'unknown');
  assert.equal(internal.formatTime('not-a-date'), 'not-a-date');
  assert.equal(internal.formatTime(''), '');
  assert.notEqual(internal.formatTime('2026-10-24T12:00:00.000Z'), '');
});

