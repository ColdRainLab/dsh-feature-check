window.__ModuleLoader__.load({
	id: 'dsh-feature-check',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		// ==== Module table externals ==========================================
		var React = require('react');

		// ==== Identity / slot contract ========================================
		var PLUGIN_ID = 'dsh-feature-check';
		var NS = 'dsh-feature-check';
		// Placement: Settings → 内置插件 → 启动自检 tab. The sidebar-footer entry and
		// the frame-wide dialog were removed; the check now lives in Settings
		// next to the plugin inventory it guards.
		var SETTINGS_TAB_SLOT = 'settings.plugins.tab';
		var TAB_ENTRY_ID = 'feature-check';
		var TAB_ORDER = 20;
		var STATUS_PATH = 'api/feature-check/status';
		var RUN_PATH = 'api/feature-check/run';
		var STYLE_MARKER = PLUGIN_ID + '/client.css';

		// ==== Design tokens (host theme variables; inline fallbacks keep the
		// surface readable when a theme moves a token) ==========================
		var LABEL_PRIMARY = 'var(--dsw-alias-label-primary, #e6e6e6)';
		var LABEL_SECONDARY = 'var(--dsw-alias-label-secondary, rgba(230, 230, 230, 0.72))';
		var CARD_BG = 'var(--dsw-specific-menu, #262626)';
		var CARD_BORDER = '0.5px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.12))';
		var BTN_BORDER = '0.5px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.16))';
		var CARD_RADIUS = 'var(--dsw-radius-lg, 12px)';
		var BTN_RADIUS = 'var(--dsw-radius-md, 8px)';
		var ELEVATION = 'var(--dsw-elevation-prominent, 0 12px 40px rgba(0, 0, 0, 0.45))';
		var DANGER = 'var(--dsw-alias-state-error-primary, #f85149)';
		var SUCCESS = 'var(--dsw-alias-state-success-primary, #3fb950)';

		// ==== Copy ============================================================
		var DICTS = {
			zh: {
				'tab.label': '启动自检',
				'settings.intro': '每次 DSH 启动都会对比上次的健康基线，检查之前能用的功能是否还在（升级后尤其有用）。',
				'settings.io': '只检查宿主组合与客户端模块清单，不读取会话内容。',
				'settings.healthy': '当前没有发现功能缺失。',
				'footer.ok': 'DSH 自检：通过',
				'footer.issues': 'DSH 自检：{count} 项缺失',
				'footer.pending': 'DSH 自检：检查中…',
				'footer.unknown': 'DSH 自检',
				'panel.title': '启动自检',
				'panel.loading': '正在检查…',
				'panel.pending': '等待宿主完成组合…',
				'panel.ok': '自检通过（DSH {version}）：{entries} 个 Loader 条目、{modules} 个客户端模块齐备。',
				'panel.okUpgrade': 'DSH 已从 {from} 升级到 {to}，自检通过：{entries} 个 Loader 条目、{modules} 个客户端模块齐备。',
				'panel.okBaseline': '已建立功能基线（{entries} 个 Loader 条目、{modules} 个客户端模块）；以后启动会与它对比。',
				'panel.fail': '发现 {count} 项功能缺失（DSH {version}）。',
				'panel.failUpgrade': 'DSH 已从 {from} 升级到 {to}，发现 {count} 项功能缺失。',
				'panel.issues': '缺失项',
				'panel.warnings': '提示：{count} 条（已忽略）',
				'panel.recheck': '重新检查',
				'panel.checking': '正在检查…',
				'panel.close': '关闭',
				'panel.reportPath': '报告：{path}',
				'panel.checkedAt': '检查时间：{time}',
				'panel.error': '自检请求失败：{message}',
				'panel.noVersion': '未知版本',
				'panel.hint': '处理建议',
				'kind.client-module': '客户端模块',
				'kind.loader-entry': '宿主条目',
				'kind.bundle': '插件包',
				'kind.unknown': '其它',
			},
			en: {
				'tab.label': 'Self-check',
				'settings.intro': 'Every DSH start compares the composition with the last healthy baseline and reports features that disappeared (especially after an upgrade).',
				'settings.io': 'Reads the host composition and the client module list only; session content is never touched.',
				'settings.healthy': 'No missing feature was found.',
				'footer.ok': 'DSH self-check: passed',
				'footer.issues': 'DSH self-check: {count} missing',
				'footer.pending': 'DSH self-check: running…',
				'footer.unknown': 'DSH self-check',
				'panel.title': 'Startup self-check',
				'panel.loading': 'Checking…',
				'panel.pending': 'Waiting for the host composition…',
				'panel.ok': 'Self-check passed (DSH {version}): {entries} Loader entries and {modules} client modules present.',
				'panel.okUpgrade': 'DSH upgraded from {from} to {to}; self-check passed: {entries} Loader entries and {modules} client modules present.',
				'panel.okBaseline': 'Feature baseline recorded ({entries} Loader entries, {modules} client modules); later starts compare against it.',
				'panel.fail': '{count} missing feature(s) found (DSH {version}).',
				'panel.failUpgrade': 'DSH upgraded from {from} to {to}; {count} missing feature(s) found.',
				'panel.issues': 'Missing',
				'panel.warnings': 'Notes: {count} (ignored)',
				'panel.recheck': 'Check again',
				'panel.checking': 'Checking…',
				'panel.close': 'Close',
				'panel.reportPath': 'Report: {path}',
				'panel.checkedAt': 'Checked: {time}',
				'panel.error': 'Self-check request failed: {message}',
				'panel.noVersion': 'unknown version',
				'panel.hint': 'Suggested action',
				'kind.client-module': 'Client module',
				'kind.loader-entry': 'Host entry',
				'kind.bundle': 'Plugin bundle',
				'kind.unknown': 'Other',
			},
		};

		var boundT = null;

		function fallbackLang() {
			try {
				if (typeof navigator !== 'undefined' && navigator && typeof navigator.language === 'string' && /^en/i.test(navigator.language)) return 'en';
			} catch (error) { /* not a page context */ }
			return 'zh';
		}

		function translate(key, params) {
			if (boundT !== null) {
				try {
					var projected = boundT(key, params);
					if (typeof projected === 'string' && projected !== key) return projected;
				} catch (error) { /* fall through to the local table */ }
			}
			var dict = DICTS[fallbackLang()] || DICTS.zh;
			var template = dict[key];
			if (typeof template !== 'string') return key;
			if (params === undefined) return template;
			return template.replace(/\{(\w+)\}/g, function (match, name) {
				return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
			});
		}

		function messageOf(reason) {
			if (reason instanceof Error && typeof reason.message === 'string') return reason.message;
			if (reason !== null && typeof reason === 'object' && typeof reason.message === 'string') return reason.message;
			return String(reason);
		}

		// ==== Store ===========================================================
		function createStore() {
			var current = null;
			var listeners = [];
			return {
				get: function () { return current; },
				subscribe: function (listener) {
					listeners.push(listener);
					return function () {
						var index = listeners.indexOf(listener);
						if (index >= 0) listeners.splice(index, 1);
					};
				},
				set: function (next) {
					current = next;
					var snapshot = listeners.slice();
					for (var index = 0; index < snapshot.length; index += 1) {
						try { snapshot[index](); } catch (error) { /* listener isolation */ }
					}
				},
			};
		}

		var store = createStore();
		/** The plugin's own client ctx (for locale and optional services). */
		var pluginCtx = null;

		// ==== Styles ==========================================================
		var CSS = [
			'.dsh-feature-check__row{border:0.5px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.12));border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:4px}',
			'.dsh-feature-check__btn{min-width:72px;height:32px;padding:0 14px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16));background:transparent;color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:13px;line-height:30px;cursor:pointer}',
			'.dsh-feature-check__btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.14))}',
			'.dsh-feature-check__btn:disabled{opacity:0.55;cursor:default}',
			// Settings page (settings.plugins.tab): inline content, no dialog chrome.
			'.dsh-feature-check__settings{display:flex;flex-direction:column;gap:14px;max-width:760px;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;line-height:20px}',
			'.dsh-feature-check__settingsHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
			'.dsh-feature-check__settingsTitle{margin:0;font-size:15px;font-weight:600;line-height:22px}',
			'.dsh-feature-check__settingsVersion{color:var(--dsw-alias-label-tertiary,rgba(230,230,230,0.55));font-size:12px}',
			'.dsh-feature-check__settingsIntro{margin:0;color:var(--dsw-alias-label-secondary,rgba(230,230,230,0.72));font-size:12px;line-height:18px}',
			'.dsh-feature-check__settingsSummary{margin:0;font-size:13px;line-height:20px}',
			'.dsh-feature-check__settingsMeta{margin:0;color:var(--dsw-alias-label-tertiary,rgba(230,230,230,0.55));font-size:11px;line-height:17px;word-break:break-all}',
			'.dsh-feature-check__settingsActions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
			'.dsh-feature-check__settingsIssues{display:flex;flex-direction:column;gap:8px;max-height:46vh;overflow-y:auto}',
			'.dsh-feature-check__settingsHealthy{color:var(--dsw-alias-state-success-primary,#3fb950);font-size:12px}',
		].join('');

		function ensureStyles() {
			if (typeof document === 'undefined' || document === null || typeof document.createElement !== 'function') return function () {};
			var selector = 'style[data-plugin-css="' + STYLE_MARKER + '"]';
			if (typeof document.querySelector === 'function' && document.querySelector(selector) !== null) return function () {};
			var style = document.createElement('style');
			style.setAttribute('data-plugin', PLUGIN_ID);
			style.setAttribute('data-plugin-css', STYLE_MARKER);
			style.textContent = CSS;
			if (document.head && typeof document.head.appendChild === 'function') document.head.appendChild(style);
			return function () {
				if (style.parentNode && typeof style.parentNode.removeChild === 'function') style.parentNode.removeChild(style);
			};
		}

		// ==== HTTP ============================================================
		function readTransport() {
			try {
				if (typeof globalThis !== 'undefined' && globalThis !== null && typeof globalThis.__DSH_TRANSPORT__ === 'object' && globalThis.__DSH_TRANSPORT__ !== null) return globalThis.__DSH_TRANSPORT__;
			} catch (error) { /* not a page context */ }
			return undefined;
		}

		function pageBaseUrl() {
			try {
				if (typeof document !== 'undefined' && document !== null && typeof document.baseURI === 'string' && document.baseURI !== '') return document.baseURI;
			} catch (error) { /* no document */ }
			return '';
		}

		function resolveUrl(path, locationLike, transportLike) {
			var loc = locationLike !== undefined ? locationLike : (typeof location !== 'undefined' ? location : undefined);
			var transport = transportLike !== undefined ? transportLike : readTransport();
			if (pageBaseUrl() !== '') return path;
			var protocol = loc && typeof loc.protocol === 'string' ? loc.protocol : '';
			if (protocol === 'dsh-app:') {
				var base = transport && typeof transport.streamBaseUrl === 'string' ? transport.streamBaseUrl : '';
				if (base === '') throw new Error('desktop host address unavailable');
				return new URL(path, base).href;
			}
			return '/' + path;
		}

		function resolveTarget(path) {
			var transport = readTransport();
			if (transport !== undefined && typeof transport.fetch === 'function') {
				// The desktop shell bridge owns host routing and auth; call it with
				// its own receiver (a bare function copy loses `this`).
				return { fetch: function (url, init) { return transport.fetch(url, init); }, url: path };
			}
			var host = typeof globalThis !== 'undefined' && globalThis !== null ? globalThis : undefined;
			var doFetch = host !== undefined && typeof host.fetch === 'function' ? host.fetch : undefined;
			if (typeof doFetch !== 'function') return { fetch: undefined, url: resolveUrl(path, undefined, transport) };
			return {
				// `window.fetch` is a Window method: calling it as a property of this
				// plain object throws "Illegal invocation", so bind the host receiver.
				fetch: function (url, init) { return doFetch.call(host, url, init); },
				url: resolveUrl(path, undefined, transport),
			};
		}

		async function requestJson(path, method, body) {
			var target = resolveTarget(path);
			if (typeof target.fetch !== 'function') throw new Error('fetch is unavailable');
			var init = { method: method, headers: {}, credentials: 'same-origin' };
			if (body !== undefined) {
				init.headers['content-type'] = 'application/json';
				init.body = JSON.stringify(body);
			}
			var response = await target.fetch(target.url, init);
			var payload = null;
			try { payload = await response.json(); } catch (error) { payload = null; }
			if (!response.ok) {
				var httpMessage = payload && payload.error && typeof payload.error.message === 'string' ? payload.error.message : 'HTTP ' + response.status;
				throw new Error(httpMessage);
			}
			if (payload !== null && typeof payload === 'object' && payload.ok === false) {
				throw new Error(payload.error && typeof payload.error.message === 'string' ? payload.error.message : 'request failed');
			}
			return payload;
		}

		// ==== State ===========================================================
		function state() {
			var current = store.get();
			if (current !== null && typeof current === 'object') return current;
			return { report: null, open: false, busy: false, loading: true, error: null, autoOpened: false };
		}

		function update(patch) {
			// Publish a NEW snapshot object: mutating the current one would make
			// Object.is() bail out and React would never re-render the panel.
			var next = Object.assign({}, state(), patch);
			store.set(next);
			return next;
		}

		/** Open the panel once per page load when the result needs attention. */
		function maybeAutoOpen(report) {
			if (report === null || typeof report !== 'object') return;
			if (report.pending === true) return;
			if (state().autoOpened === true) return;
			var needsAttention = report.ok !== true || report.upgraded === true;
			update({ autoOpened: true, open: needsAttention ? true : state().open });
		}

		async function loadStatus() {
			update({ loading: true, error: null });
			try {
				var payload = await requestJson(STATUS_PATH, 'GET');
				var report = payload !== null && typeof payload === 'object' && payload.report !== undefined ? payload.report : null;
				update({ report: report, loading: false, error: null });
				maybeAutoOpen(report);
				return report;
			} catch (reason) {
				update({ loading: false, error: messageOf(reason) });
				return null;
			}
		}

		async function runCheck() {
			if (state().busy === true) return null;
			update({ busy: true, error: null });
			try {
				var payload = await requestJson(RUN_PATH, 'POST', {});
				var report = payload !== null && typeof payload === 'object' && payload.report !== undefined ? payload.report : null;
				update({ report: report, busy: false, error: null });
				maybeAutoOpen(report);
				return report;
			} catch (reason) {
				update({ busy: false, error: messageOf(reason) });
				return null;
			}
		}

		function openPanel() {
			update({ open: true });
		}

		function closePanel() {
			update({ open: false });
		}

		/** Poll the status while the host composition is still settling. */
		function startPolling() {
			var attempts = 0;
			var tick = function () {
				attempts += 1;
				loadStatus().then(function () {
					var current = state().report;
					var pending = current === null || (current !== null && current.pending === true);
					if (pending && attempts < 12) {
						var timer = setTimeout(tick, 2500);
						if (timer && typeof timer.unref === 'function') timer.unref();
					}
				});
			};
			var first = setTimeout(tick, 1500);
			if (first && typeof first.unref === 'function') first.unref();
		}

		// ==== Presentation helpers ===========================================
		function countOf(report, key) {
			if (report === null || typeof report !== 'object' || report.counts === null || typeof report.counts !== 'object') return 0;
			var value = report.counts[key];
			return typeof value === 'number' && Number.isFinite(value) ? value : 0;
		}

		function issueCount(report) {
			if (report === null || typeof report !== 'object') return 0;
			if (Array.isArray(report.issues)) return report.issues.length;
			return countOf(report, 'issues');
		}

		function runtimeVersionOf(report) {
			if (report !== null && typeof report === 'object' && typeof report.runtimeVersion === 'string' && report.runtimeVersion.length > 0) return report.runtimeVersion;
			return null;
		}

		function versionText(report) {
			var version = runtimeVersionOf(report);
			return version === null ? translate('panel.noVersion') : version;
		}

		function formatTime(value) {
			if (typeof value !== 'string' || value.length === 0) return '';
			var date = new Date(value);
			if (isNaN(date.getTime())) return value;
			try { return date.toLocaleString(); } catch (error) { return value; }
		}

		function toneOf(report) {
			if (report === null || typeof report !== 'object') return 'unknown';
			if (report.pending === true) return 'pending';
			if (report.ok !== true) return 'issues';
			return 'ok';
		}

		/** 16px status glyph: check / warning triangle / dotted circle. */
		function StatusIcon(props) {
			var tone = props.tone;
			var color = tone === 'issues' ? DANGER : tone === 'ok' ? SUCCESS : LABEL_SECONDARY;
			var paths;
			if (tone === 'issues') {
				paths = [
					React.createElement('path', { d: 'M8 2.2 14.2 13H1.8L8 2.2Z' }),
					React.createElement('path', { d: 'M8 6.2v3.2' }),
					React.createElement('path', { d: 'M8 11.4h.01' }),
				];
			} else if (tone === 'ok') {
				paths = [
					React.createElement('circle', { cx: 8, cy: 8, r: 5.9 }),
					React.createElement('path', { d: 'M5.1 8.2 7.1 10.2 10.9 5.9' }),
				];
			} else {
				paths = [
					React.createElement('circle', { cx: 8, cy: 8, r: 5.9, strokeDasharray: '2.4 2.4' }),
					React.createElement('path', { d: 'M8 8h.01' }),
				];
			}
			return React.createElement('svg', {
				viewBox: '0 0 16 16',
				width: 16,
				height: 16,
				'aria-hidden': 'true',
				fill: 'none',
				stroke: color,
				strokeWidth: 1.4,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
				style: { flex: '0 0 auto' },
			}, paths);
		}

		function useStoreState() {
			var pair = React.useState(state());
			var setSnapshot = pair[1];
			React.useEffect(function () {
				var unsubscribe = store.subscribe(function () { setSnapshot(state()); });
				setSnapshot(state());
				return unsubscribe;
			}, []);
			return pair[0];
		}

		/** Compact sidebar-footer status entry (badge only; no layout growth). */
		function FooterAction(props) {
			var wide = props.wide !== false;
			var current = useStoreState();
			var report = current.report;
			var tone = toneOf(report);
			var issues = issueCount(report);
			var label = tone === 'issues'
				? translate('footer.issues', { count: issues })
				: tone === 'pending' || report === null
					? translate('footer.pending')
					: tone === 'ok'
						? translate('footer.ok')
						: translate('footer.unknown');
			return React.createElement('button', {
				type: 'button',
				className: 'dsh-feature-check__footer',
				title: label,
				'aria-label': label,
				onClick: openPanel,
			},
			React.createElement(StatusIcon, { tone: tone }),
			wide ? React.createElement('span', { style: { maxWidth: '72px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, translate('panel.title')) : null,
			issues > 0 ? React.createElement('span', { className: 'dsh-feature-check__badge' }, String(issues)) : null);
		}

		/** One issue row inside the panel. */
		function IssueRow(props) {
			var issue = props.issue;
			var kindKey = issue !== null && typeof issue === 'object' && typeof issue.kind === 'string' ? 'kind.' + issue.kind : 'kind.unknown';
			var kindLabel = translate(kindKey);
			var name = issue !== null && typeof issue === 'object' && typeof issue.name === 'string' ? issue.name : '?';
			var detail = issue !== null && typeof issue === 'object' && typeof issue.detail === 'string' ? issue.detail : '';
			var hint = issue !== null && typeof issue === 'object' && typeof issue.hint === 'string' ? issue.hint : '';
			return React.createElement('div', { className: 'dsh-feature-check__row' },
				React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
					React.createElement('span', {
						style: { flex: '0 0 auto', fontSize: '11px', lineHeight: '16px', padding: '0 6px', borderRadius: '999px', border: '0.5px solid ' + (issue && issue.kind === 'bundle' ? DANGER : 'rgba(255,255,255,0.2)'), color: issue && issue.kind === 'bundle' ? DANGER : LABEL_SECONDARY }
					}, kindLabel),
					React.createElement('code', { style: { color: LABEL_PRIMARY, fontSize: '13px', wordBreak: 'break-all' } }, name)),
				detail !== '' ? React.createElement('div', { style: { color: LABEL_SECONDARY, fontSize: '12px', lineHeight: '18px' } }, detail) : null,
				hint !== '' ? React.createElement('div', { style: { color: LABEL_SECONDARY, fontSize: '12px', lineHeight: '18px' } },
					React.createElement('span', { style: { color: LABEL_SECONDARY, opacity: 0.8 } }, translate('panel.hint') + '：'),
					hint) : null);
		}

		/** Frame-wide self-check panel. */
		function Panel(props) {
			var current = useStoreState();
			if (current.open !== true) return null;
			var report = current.report;
			var tone = toneOf(report);
			var issues = report !== null && typeof report === 'object' && Array.isArray(report.issues) ? report.issues : [];
			var warningCount = report !== null && typeof report === 'object' && Array.isArray(report.warnings) ? report.warnings.length : 0;
			var pending = report === null || (report !== null && report.pending === true);
			var busy = current.busy === true;
			var version = versionText(report);
			var from = report !== null && typeof report === 'object' && typeof report.baselineRuntimeVersion === 'string' ? report.baselineRuntimeVersion : null;
			var upgraded = report !== null && typeof report === 'object' && report.upgraded === true;

			var summary;
			if (pending) summary = current.loading === true ? translate('panel.loading') : translate('panel.pending');
			else if (tone === 'ok') {
				if (report.baselineCreated === true) summary = translate('panel.okBaseline', { entries: countOf(report, 'entries'), modules: countOf(report, 'clientModules') });
				else if (upgraded && from !== null) summary = translate('panel.okUpgrade', { from: from, to: version, entries: countOf(report, 'entries'), modules: countOf(report, 'clientModules') });
				else summary = translate('panel.ok', { version: version, entries: countOf(report, 'entries'), modules: countOf(report, 'clientModules') });
			} else {
				if (upgraded && from !== null) summary = translate('panel.failUpgrade', { from: from, to: version, count: issueCount(report) });
				else summary = translate('panel.fail', { version: version, count: issueCount(report) });
			}

			var onBackdropClick = function (event) {
				if (event && event.target === event.currentTarget && current.busy !== true) closePanel();
			};
			var stopPropagation = function (event) {
				if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
			};

			var rows = issues.map(function (issue, index) {
				return React.createElement(IssueRow, { key: (issue && issue.name ? String(issue.name) : 'issue') + ':' + index, issue: issue });
			});

			var meta = [];
			if (report !== null && typeof report === 'object') {
				var checkedAt = formatTime(report.checkedAt);
				if (checkedAt !== '') meta.push(translate('panel.checkedAt', { time: checkedAt }));
				var reportPath = report.paths && typeof report.paths.report === 'string' ? report.paths.report : null;
				if (reportPath !== null) meta.push(translate('panel.reportPath', { path: reportPath }));
			}

			return React.createElement('div', {
				className: 'dsh-feature-check__backdrop',
				style: {
					position: 'fixed', inset: 0, zIndex: 1000,
					display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px',
					background: 'rgba(0, 0, 0, 0.45)', pointerEvents: 'auto',
				},
				onClick: onBackdropClick,
			},
			React.createElement('div', {
				role: 'dialog',
				'aria-modal': 'true',
				'aria-label': translate('panel.title'),
				style: {
					boxSizing: 'border-box', width: 'min(620px, 100%)', maxHeight: '82vh',
					display: 'flex', flexDirection: 'column',
					background: CARD_BG, color: LABEL_PRIMARY, border: CARD_BORDER, borderRadius: CARD_RADIUS,
					boxShadow: ELEVATION, padding: '20px', fontSize: '14px', lineHeight: '22px',
				},
				onClick: stopPropagation,
			},
			React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' } },
				React.createElement(StatusIcon, { tone: tone }),
				React.createElement('h2', { style: { margin: 0, fontSize: '15px', fontWeight: 500, lineHeight: '22px' } }, translate('panel.title')),
				React.createElement('span', { style: { color: LABEL_SECONDARY, fontSize: '12px' } }, version)),
			React.createElement('p', { style: { margin: '0 0 12px', color: tone === 'issues' ? DANGER : LABEL_PRIMARY, fontSize: '13px', lineHeight: '20px' } }, summary),
			busy ? React.createElement('div', { role: 'status', style: { margin: '0 0 10px', color: LABEL_SECONDARY, fontSize: '12px' } }, translate('panel.checking')) : null,
			current.error !== null && current.error !== undefined ? React.createElement('div', { role: 'alert', style: { margin: '0 0 10px', color: DANGER, fontSize: '12px', lineHeight: '18px' } }, translate('panel.error', { message: messageOf(current.error) })) : null,
			rows.length > 0 ? React.createElement('div', { className: 'dsh-feature-check__issues', style: { display: 'flex', flexDirection: 'column', gap: '8px', overflowY: 'auto', minHeight: '60px', flex: '1 1 auto', marginBottom: '10px' } }, rows) : null,
			warningCount > 0 ? React.createElement('div', { style: { color: LABEL_SECONDARY, fontSize: '11px', lineHeight: '16px', marginBottom: '8px' } }, translate('panel.warnings', { count: warningCount })) : null,
			meta.length > 0 ? React.createElement('div', { style: { color: LABEL_SECONDARY, fontSize: '11px', lineHeight: '16px', marginBottom: '10px', wordBreak: 'break-all' } }, meta.join(' · ')) : null,
			React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
				React.createElement('button', {
					type: 'button',
					className: 'dsh-feature-check__btn',
					disabled: busy,
					style: { borderRadius: BTN_RADIUS, border: BTN_BORDER },
					onClick: function () { void runCheck(); },
				}, busy ? translate('panel.checking') : translate('panel.recheck')),
				React.createElement('button', {
					type: 'button',
					className: 'dsh-feature-check__btn',
					disabled: busy,
					style: { borderRadius: BTN_RADIUS, border: BTN_BORDER },
					onClick: closePanel,
				}, translate('panel.close')))));
		}

		/**
		 * Settings → 内置插件 → 启动自检 tab: the same report the frame-wide dialog
		 * used to show, rendered inline as a settings page (no backdrop, no
		 * modal chrome), with one action to re-run the check.
		 */
		function SettingsTab() {
			var current = useStoreState();
			React.useEffect(function () {
				void loadStatus();
			}, []);
			var report = current.report;
			var tone = toneOf(report);
			var issues = report !== null && typeof report === 'object' && Array.isArray(report.issues) ? report.issues : [];
			var warningCount = report !== null && typeof report === 'object' && Array.isArray(report.warnings) ? report.warnings.length : 0;
			var pending = report === null || (report !== null && report.pending === true);
			var busy = current.busy === true;
			var version = versionText(report);
			var from = report !== null && typeof report === 'object' && typeof report.baselineRuntimeVersion === 'string' ? report.baselineRuntimeVersion : null;
			var upgraded = report !== null && typeof report === 'object' && report.upgraded === true;

			var summary;
			if (pending) summary = current.loading === true ? translate('panel.loading') : translate('panel.pending');
			else if (tone === 'ok') {
				if (report.baselineCreated === true) summary = translate('panel.okBaseline', { entries: countOf(report, 'entries'), modules: countOf(report, 'clientModules') });
				else if (upgraded && from !== null) summary = translate('panel.okUpgrade', { from: from, to: version, entries: countOf(report, 'entries'), modules: countOf(report, 'clientModules') });
				else summary = translate('panel.ok', { version: version, entries: countOf(report, 'entries'), modules: countOf(report, 'clientModules') });
			} else if (upgraded && from !== null) summary = translate('panel.failUpgrade', { from: from, to: version, count: issueCount(report) });
			else summary = translate('panel.fail', { version: version, count: issueCount(report) });

			var meta = [];
			if (report !== null && typeof report === 'object') {
				var checkedAt = formatTime(report.checkedAt);
				if (checkedAt !== '') meta.push(translate('panel.checkedAt', { time: checkedAt }));
				var reportPath = report.paths && typeof report.paths.report === 'string' ? report.paths.report : null;
				if (reportPath !== null) meta.push(translate('panel.reportPath', { path: reportPath }));
			}

			var rows = issues.map(function (issue, index) {
				return React.createElement(IssueRow, { key: (issue && issue.name ? String(issue.name) : 'issue') + ':' + index, issue: issue });
			});

			return React.createElement('div', { className: 'dsh-feature-check__settings' },
				React.createElement('p', { className: 'dsh-feature-check__settingsIntro' }, translate('settings.intro')),
				React.createElement('div', { className: 'dsh-feature-check__settingsHead' },
					React.createElement(StatusIcon, { tone: tone }),
					React.createElement('h3', { className: 'dsh-feature-check__settingsTitle' }, translate('panel.title')),
					React.createElement('span', { className: 'dsh-feature-check__settingsVersion' }, version)),
				React.createElement('p', {
					className: 'dsh-feature-check__settingsSummary',
					style: tone === 'issues' ? { color: DANGER } : undefined,
				}, summary),
				busy ? React.createElement('div', { role: 'status', className: 'dsh-feature-check__settingsMeta' }, translate('panel.checking')) : null,
				current.error !== null && current.error !== undefined ? React.createElement('div', { role: 'alert', className: 'dsh-feature-check__settingsMeta', style: { color: DANGER } }, translate('panel.error', { message: messageOf(current.error) })) : null,
				rows.length > 0
					? React.createElement('div', { className: 'dsh-feature-check__settingsIssues' }, rows)
					: (pending ? null : React.createElement('p', { className: 'dsh-feature-check__settingsHealthy' }, translate('settings.healthy'))),
				warningCount > 0 ? React.createElement('p', { className: 'dsh-feature-check__settingsMeta' }, translate('panel.warnings', { count: warningCount })) : null,
				meta.length > 0 ? React.createElement('p', { className: 'dsh-feature-check__settingsMeta' }, meta.join('  ·  ')) : null,
				React.createElement('div', { className: 'dsh-feature-check__settingsActions' },
					React.createElement('button', {
						type: 'button',
						className: 'dsh-feature-check__btn',
						disabled: busy,
						style: { borderRadius: BTN_RADIUS, border: BTN_BORDER },
						onClick: function () { void runCheck(); },
					}, busy ? translate('panel.checking') : translate('panel.recheck')),
					React.createElement('span', { className: 'dsh-feature-check__settingsMeta' }, translate('settings.io'))));
		}

		// ==== Plugin ==========================================================
		/**
		 * Client plugin body: register the Settings tab and poll the host report
		 * until the startup check settles.
		 */
		function apply(ctx) {
			pluginCtx = ctx;

			var locale = null;
			try {
				locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
			} catch (error) {
				locale = null;
			}
			if (locale && typeof locale.register === 'function') {
				var register = function () { return locale.register(NS, DICTS); };
				if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-feature-check: dictionaries');
				else register();
			}
			if (locale && typeof locale.bind === 'function') {
				try { boundT = locale.bind(NS); } catch (error) { boundT = null; }
			}

			if (typeof ctx.effect === 'function') ctx.effect(function () { return ensureStyles(); }, 'dsh-feature-check: styles');

			ctx.slots.inject(SETTINGS_TAB_SLOT, function () {
				return ctx.slots.register({
					name: SETTINGS_TAB_SLOT,
					id: TAB_ENTRY_ID,
					order: TAB_ORDER,
					locale: NS,
					label: function () { return translate('tab.label'); },
				}, SettingsTab);
			});

			startPolling();
		}

		exports.name = PLUGIN_ID;
		exports.inject = ['slots', 'locale'];
		exports.apply = apply;

		// Test seam (no runtime consumer; cordis ignores extra exports).
		exports.__internal = {
			PLUGIN_ID: PLUGIN_ID,
			NS: NS,
			SETTINGS_TAB_SLOT: SETTINGS_TAB_SLOT,
			TAB_ENTRY_ID: TAB_ENTRY_ID,
			TAB_ORDER: TAB_ORDER,
			SettingsTab: SettingsTab,
			STATUS_PATH: STATUS_PATH,
			RUN_PATH: RUN_PATH,
			DICTS: DICTS,
			CSS: CSS,
			store: store,
			state: state,
			update: update,
			loadStatus: loadStatus,
			runCheck: runCheck,
			openPanel: openPanel,
			closePanel: closePanel,
			maybeAutoOpen: maybeAutoOpen,
			issueCount: issueCount,
			toneOf: toneOf,
			formatTime: formatTime,
			FooterAction: FooterAction,
			Panel: Panel,
			resolveUrl: resolveUrl,
			requestJson: requestJson,
			translate: translate,
		};

		return module.exports;
	},
});
