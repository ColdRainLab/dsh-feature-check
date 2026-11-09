/**
 * dsh-feature-check — host half.
 *
 * DSH upgrades can silently drop previously working features: a profile bundle
 * whose manifest does not accept the new runtime version is skipped by the
 * launcher (`skipping profile bundle "<name>" ...`), and nothing visible tells
 * the user that a menu, tool or panel is gone. This plugin keeps a snapshot of
 * the last healthy startup — active Loader entries, client-module rows and the
 * runtime version — and on every startup compares the current composition with
 * that baseline.
 *
 * What a check reports:
 *   - Loader entries that disappeared since the baseline (host-side features);
 *   - client modules missing from the `/plugins` boot graph (UI features);
 *   - enabled profile bundles whose manifest carries an error, e.g. an
 *     incompatible `engines.dsh` after a DSH upgrade.
 *
 * A healthy start rewrites the baseline (so an upgrade that kept everything
 * working becomes the new reference); a failing start keeps the old baseline
 * so the same features are reported again until they are fixed.
 *
 * The file is plain ESM with no build step and imports only Node builtins:
 * every DSH service is reached through the injected context, never through an
 * `@deepseek-ai/*` import.
 *
 * Routes (exact match on ctx.webServer):
 *   GET  /api/feature-check/health  -> { ok, version }
 *   GET  /api/feature-check/status  -> { ok, report, pending }
 *   POST /api/feature-check/run     -> { ok, report }
 *
 * Evidence for every service name / line of behavior used here lives in
 * research/host.md next to this package.
 */

import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Plugin name as mounted by the Cordis loader. */
export const name = "dsh-feature-check";

/**
 * Services required before the check can run. `webServer` serves the routes
 * and `loader` lists the active Loader entries (the same service
 * `clientModules` injects). `clientModules` and `pluginManager` are read
 * defensively through `ctx.get`, because a profile without the web app or the
 * plugin manager still deserves a partial report rather than a parked plugin.
 */
export const inject = ["webServer", "loader"];

/** Health route (no side effects). */
export const HEALTH_PATH = "/api/feature-check/health";
/** Latest report route. */
export const STATUS_PATH = "/api/feature-check/status";
/** Run-now route (POST). */
export const RUN_PATH = "/api/feature-check/run";

/** Directory under the DSH home holding the baseline and the last report. */
export const STATE_DIR_NAME = "feature-check";
/** Last healthy snapshot. */
export const BASELINE_FILE = "baseline.json";
/** Latest check result. */
export const REPORT_FILE = "report.json";
/** Optional caller-maintained expectations merged into the baseline. */
export const EXPECT_FILE = "expect.json";
/** On-disk schema version for both documents. */
export const SCHEMA_VERSION = 1;

/** How long to wait before the first automatic check (the Loader settles late). */
export const FIRST_CHECK_DELAY_MS = 6000;
/** Retry cadence while the composition still looks incomplete. */
export const RETRY_DELAY_MS = 2500;
/** Give up on the automatic check after this many attempts. */
export const MAX_ATTEMPTS = 12;
/** Bound on one document read (defensive; both files are small). */
const MAX_DOCUMENT_BYTES = 1024 * 1024;

/** Version reported by the health route, read from the package manifest. */
export const PLUGIN_VERSION = readPluginVersion();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Read this package's version from `../package.json`, or a neutral value. */
function readPluginVersion() {
	try {
		const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
		const parsed = JSON.parse(raw);
		if (parsed !== null && typeof parsed === "object" && typeof parsed.version === "string" && parsed.version.length > 0) return parsed.version;
	} catch {
		/* fall through to the neutral version */
	}
	return "0.0.0";
}

/** Resolve the DSH home the way `@deepseek-ai/dsh-home-paths` does. */
export function resolveHome(env = process.env) {
	const configured = env?.DSH_HOME;
	const value = typeof configured === "string" && configured.trim().length > 0 ? configured : join(homedir(), ".dsh");
	return resolve(expandHome(value));
}

/** Expand `~`, `~/`, `~\`; other values pass through. */
function expandHome(value) {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
	return value;
}

/** Absolute paths used by one DSH home. */
export function statePaths(home) {
	const directory = join(resolve(home), STATE_DIR_NAME);
	return {
		directory,
		baseline: join(directory, BASELINE_FILE),
		report: join(directory, REPORT_FILE),
		expect: join(directory, EXPECT_FILE)
	};
}

/** Human-readable message of any thrown value. */
function messageOf(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}

/** Whether an fs error means "the path is absent". */
function isMissing(error) {
	return error !== null && typeof error === "object" && error.code === "ENOENT";
}

/** Read one JSON document; missing/unreadable/invalid files yield `null`. */
export async function readJsonDocument(path, fsOps = defaultFsOps()) {
	let raw;
	try {
		raw = await fsOps.readFile(path, "utf8");
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
	if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_DOCUMENT_BYTES) return null;
	try {
		const parsed = JSON.parse(raw);
		return parsed !== null && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

/** Write one JSON document atomically (temp file + rename). */
export async function writeJsonDocument(path, value, fsOps = defaultFsOps()) {
	const directory = dirname(path);
	await fsOps.mkdir(directory, { recursive: true });
	const temporary = join(directory, `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
	await fsOps.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await fsOps.rename(temporary, path);
}

/** Default fs operations; tests inject replacements to exercise failures. */
function defaultFsOps() {
	return { mkdir, readFile, rename, writeFile };
}

/** Trim and deduplicate a list of non-empty strings, keeping order. */
function uniqueStrings(values) {
	const seen = new Set();
	const out = [];
	for (const value of values) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed.length === 0 || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Snapshot collection
// ---------------------------------------------------------------------------

/**
 * Turn Loader entries into stable names.
 *
 * A Loader entry exposes its configured name through `options.name`; entries
 * without one cannot be tracked by name and are skipped. Internal Cordis rows
 * (`cordis:` specifiers) are skipped too: they belong to the loader itself and
 * are not user features.
 * @param entries - result of `ctx.loader.entries()` (or an equivalent list).
 * @returns sorted unique entry names.
 */
export function loaderEntryNames(entries) {
	if (entries === null || entries === undefined) return [];
	let list = entries;
	if (!Array.isArray(list)) {
		// `loader.entries()` yields an iterable in current DSH versions.
		try {
			list = Array.from(list);
		} catch {
			return [];
		}
	}
	const names = [];
	for (const entry of list) {
		let candidate;
		try {
			candidate = entry?.options?.name;
		} catch {
			candidate = undefined;
		}
		if (typeof candidate !== "string") continue;
		const value = candidate.trim();
		if (value.length === 0 || value.startsWith("cordis:")) continue;
		names.push(value);
	}
	return uniqueStrings(names).sort();
}

/**
 * Turn a client-module graph into stable module ids.
 * @param graph - `clientModules.graph()` result, or undefined.
 * @returns sorted unique ids, and the release version when the graph carries one.
 */
export function clientModuleIds(graph) {
	const modules = [];
	let runtimeVersion = null;
	if (graph !== null && typeof graph === "object") {
		if (graph.release !== null && typeof graph.release === "object" && typeof graph.release.version === "string") runtimeVersion = graph.release.version;
		if (Array.isArray(graph.entries)) {
			for (const entry of graph.entries) {
				let id;
				try {
					id = entry?.id;
				} catch {
					id = undefined;
				}
				if (typeof id === "string") modules.push(id);
			}
		}
	}
	return { modules: uniqueStrings(modules).sort(), runtimeVersion };
}

/**
 * Extract the diagnostics of enabled profile bundles.
 *
 * `pluginManager.listBundles()` reports a bundle that cannot load without
 * throwing; the interesting subset here is `enabled === true` with an `error`
 * (typically `incompatible-version` after a DSH upgrade).
 * @param bundles - `pluginManager.listBundles()` result, or undefined.
 * @returns `{ issues, warnings }`.
 */
export function bundleDiagnostics(bundles) {
	const issues = [];
	const warnings = [];
	if (!Array.isArray(bundles)) return { issues, warnings };
	for (const bundle of bundles) {
		if (bundle === null || typeof bundle !== "object") continue;
		const bundleName = typeof bundle.name === "string" ? bundle.name : undefined;
		if (bundleName === undefined) continue;
		const error = bundle.error;
		const enabled = bundle.enabled === true;
		if (error === undefined || error === null) continue;
		if (enabled === false) {
			warnings.push({ kind: "bundle-disabled", name: bundleName, detail: "bundle is installed but not enabled" });
			continue;
		}
		const code = typeof error.code === "string" ? error.code : "unknown";
		const entry = {
			kind: "bundle",
			name: bundleName,
			code,
			version: typeof bundle.version === "string" ? bundle.version : null,
			detail: null,
			hint: null
		};
		if (Array.isArray(error.incompatible)) {
			const first = error.incompatible[0];
			if (first !== null && typeof first === "object") {
				entry.detail = `incompatible with dsh ${String(first.runtimeVersion)} — requires ${JSON.stringify(first.requirements ?? {})}`;
				entry.hint = `更新该插件；或临时授权：dsh plugin --profile desktop allow-version ${String(first.name ?? bundleName)}@${String(first.version ?? "")} --dsh-version ${String(first.runtimeVersion)} --accept-risk`;
			}
		}
		if (entry.detail === null && typeof error.diagnostic === "string" && error.diagnostic.length > 0) entry.detail = error.diagnostic;
		if (entry.detail === null) entry.detail = `bundle error: ${code}`;
		issues.push(entry);
	}
	return { issues, warnings };
}

/**
 * Collect one composition snapshot.
 * @param options.getLoaderEntries - accessor for `ctx.loader.entries()`.
 * @param options.getClientGraph - accessor for `clientModules.graph()`.
 * @param options.getBundles - async accessor for `pluginManager.listBundles()`.
 * @param options.getRuntimeVersion - accessor for a fallback runtime version.
 * @returns `{ entries, modules, runtimeVersion, bundles, warnings }`.
 */
export async function collectSnapshot(options = {}) {
	const warnings = [];
	let entries = [];
	try {
		entries = loaderEntryNames(options.getLoaderEntries === undefined ? [] : options.getLoaderEntries());
	} catch (error) {
		warnings.push({ kind: "loader-unavailable", detail: messageOf(error) });
	}

	let graph = undefined;
	try {
		graph = options.getClientGraph === undefined ? undefined : options.getClientGraph();
	} catch (error) {
		warnings.push({ kind: "client-modules-unavailable", detail: messageOf(error) });
	}
	const { modules, runtimeVersion: graphVersion } = clientModuleIds(graph);

	let runtimeVersion = graphVersion;
	if (runtimeVersion === null) {
		try {
			const fallback = options.getRuntimeVersion === undefined ? undefined : options.getRuntimeVersion();
			if (typeof fallback === "string" && fallback.trim().length > 0) runtimeVersion = fallback.trim();
		} catch {
			/* the report can live without a version */
		}
	}

	let bundles = undefined;
	if (typeof options.getBundles === "function") {
		try {
			bundles = await options.getBundles();
		} catch (error) {
			warnings.push({ kind: "plugin-manager-unavailable", detail: messageOf(error) });
		}
	}

	return { entries, modules, runtimeVersion, bundles, warnings };
}

/** Read the optional caller-maintained expectations (best effort). */
export async function readExpectations(path, fsOps = defaultFsOps()) {
	let document;
	try {
		document = await readJsonDocument(path, fsOps);
	} catch {
		return { entries: [], clientModules: [], warnings: [{ kind: "expect-unreadable", detail: `cannot read ${path}` }] };
	}
	if (document === null) return { entries: [], clientModules: [], warnings: [] };
	return {
		entries: uniqueStrings(Array.isArray(document.entries) ? document.entries : []),
		clientModules: uniqueStrings(Array.isArray(document.clientModules) ? document.clientModules : []),
		warnings: []
	};
}

/**
 * Compare one snapshot against a baseline.
 * @param baseline - parsed baseline document (schema 1).
 * @param current - snapshot from {@link collectSnapshot}.
 * @param expectations - optional extra expected names.
 * @returns `{ issues, warnings }`; issues are user-visible regressions.
 */
export function compareSnapshots(baseline, current, expectations = { entries: [], clientModules: [] }) {
	const issues = [];
	const warnings = [];
	if (baseline === null || typeof baseline !== "object") {
		return { issues, warnings: [{ kind: "baseline-missing", detail: "no baseline snapshot exists yet" }] };
	}
	const expectedEntries = uniqueStrings([
		...(Array.isArray(baseline.entries) ? baseline.entries : []),
		...(expectations.entries ?? [])
	]);
	const expectedModules = uniqueStrings([
		...(Array.isArray(baseline.clientModules) ? baseline.clientModules : []),
		...(expectations.clientModules ?? [])
	]);
	const currentEntries = new Set(current.entries ?? []);
	const currentModules = new Set(current.modules ?? []);
	const disabledBundles = new Set();
	for (const bundle of Array.isArray(current.bundles) ? current.bundles : []) {
		if (bundle !== null && typeof bundle === "object" && bundle.enabled === false && typeof bundle.name === "string") disabledBundles.add(bundle.name);
	}

	for (const name of expectedModules) {
		if (currentModules.has(name)) continue;
		if (disabledBundles.has(name)) {
			warnings.push({ kind: "disabled-feature", name, detail: "client module is missing because its bundle is disabled" });
			continue;
		}
		issues.push({
			kind: "client-module",
			name,
			detail: "client module is missing from the boot graph — its UI is not available",
			hint: "查看插件页/日志；升级后常见原因是插件被兼容性检查跳过，或客户端 bundle 构建失败"
		});
	}
	for (const name of expectedEntries) {
		if (currentEntries.has(name)) continue;
		if (disabledBundles.has(name)) {
			warnings.push({ kind: "disabled-feature", name, detail: "Loader entry is missing because its bundle is disabled" });
			continue;
		}
		issues.push({
			kind: "loader-entry",
			name,
			detail: "Loader entry is missing from the active composition — its host-side feature is not running",
			hint: "查看 DSH 启动日志；升级后常见原因是插件被兼容性检查跳过"
		});
	}
	return { issues, warnings };
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Build the check core.
 *
 * Services arrive as accessors so the unit tests can drive the production code
 * path with fakes and a temporary DSH home.
 *
 * @param options.getLoaderEntries - `ctx.loader.entries()` accessor.
 * @param options.getClientGraph - `clientModules.graph()` accessor.
 * @param options.getBundles - `pluginManager.listBundles()` accessor.
 * @param options.getRuntimeVersion - fallback runtime version accessor.
 * @param options.getHome - DSH home accessor (defaults to env resolution).
 * @param options.fsOps - injectable filesystem operations.
 * @param options.now - clock, injectable for tests.
 * @param options.logger - Cordis logger (optional).
 * @param options.env - environment for home resolution.
 * @returns the core: `{ run, status, paths, snapshot }`.
 */
export function createFeatureCheckCore(options = {}) {
	const fsOps = { ...defaultFsOps(), ...(options.fsOps ?? {}) };
	const env = options.env ?? process.env;
	const logger = options.logger ?? { info() {}, warn() {} };
	const now = options.now ?? (() => new Date());
	const getHome = options.getHome ?? (() => resolveHome(env));

	/** One in-flight check; a manual run joins the automatic one. */
	let inFlight = null;
	/** The latest finished report (also mirrored to disk). */
	let latest = null;
	let lastReadAttempt = false;

	const paths = () => statePaths(getHome());

	/** Read the persisted report once, when no in-memory report exists yet. */
	const ensureLatest = async () => {
		if (latest !== null || lastReadAttempt) return latest;
		lastReadAttempt = true;
		try {
			const stored = await readJsonDocument(paths().report, fsOps);
			if (stored !== null && typeof stored === "object") latest = stored;
		} catch {
			/* a missing/unreadable report simply means "no result yet" */
		}
		return latest;
	};

	/** Gather one snapshot with the production accessors. */
	const snapshot = () => collectSnapshot({
		getLoaderEntries: options.getLoaderEntries,
		getClientGraph: options.getClientGraph,
		getBundles: options.getBundles,
		getRuntimeVersion: options.getRuntimeVersion
	});

	/** Whether the composition looks settled enough to compare. */
	const looksReady = (current) => (Array.isArray(current.entries) && current.entries.length > 0) || (Array.isArray(current.modules) && current.modules.length > 0);

	/**
	 * Read (or create) the baseline and produce one report.
	 *
	 * Readiness is reported as `pending:true` instead of an issue so the caller
	 * can retry without showing a spurious failure to the user.
	 */
	const checkOnce = async () => {
		const current = await snapshot();
		const checkedAt = now().toISOString();
		const reportPaths = paths();

		if (!looksReady(current)) {
			latest = {
				schemaVersion: SCHEMA_VERSION,
				ok: null,
				pending: true,
				checkedAt,
				runtimeVersion: current.runtimeVersion,
				baseline: null,
				upgraded: false,
				issues: [],
				warnings: current.warnings,
				counts: { entries: current.entries.length, clientModules: current.modules.length, issues: 0 },
				paths: reportPaths
			};
			return latest;
		}

		let baseline = null;
		try {
			baseline = await readJsonDocument(reportPaths.baseline, fsOps);
		} catch (error) {
			baseline = null;
			current.warnings.push({ kind: "baseline-unreadable", detail: messageOf(error) });
		}
		const expectations = await readExpectations(reportPaths.expect, fsOps);
		current.warnings.push(...expectations.warnings);

		const { issues: bundleIssues } = bundleDiagnostics(current.bundles);

		if (baseline === null) {
			const issues = [];
			const report = {
				schemaVersion: SCHEMA_VERSION,
				ok: bundleIssues.length === 0,
				pending: false,
				baselineCreated: false,
				checkedAt,
				runtimeVersion: current.runtimeVersion,
				baseline: null,
				upgraded: false,
				issues: [...bundleIssues, ...issues],
				warnings: current.warnings,
				counts: {
					entries: current.entries.length,
					clientModules: current.modules.length,
					issues: issues.length + bundleIssues.length
				},
				paths: reportPaths
			};
			if (report.ok) {
				try {
					await writeBaseline(reportPaths.baseline, current, checkedAt);
					report.baselineCreated = true;
					report.baseline = { exists: true, runtimeVersion: current.runtimeVersion, checkedAt };
				} catch (error) {
					report.warnings = [...(report.warnings ?? []), { kind: "baseline-write-failed", detail: messageOf(error) }];
				}
			}
			await persistReport(reportPaths.report, report);
			latest = report;
			return report;
		}

		const comparison = compareSnapshots(baseline, current, expectations);
		const issues = [...bundleIssues, ...comparison.issues];
		const upgraded = typeof baseline.runtimeVersion === "string" && typeof current.runtimeVersion === "string" && baseline.runtimeVersion !== current.runtimeVersion;
		const report = {
			schemaVersion: SCHEMA_VERSION,
			ok: issues.length === 0,
			pending: false,
			baselineCreated: false,
			checkedAt,
			runtimeVersion: current.runtimeVersion,
			baselineRuntimeVersion: typeof baseline.runtimeVersion === "string" ? baseline.runtimeVersion : null,
			baseline: {
				exists: true,
				runtimeVersion: typeof baseline.runtimeVersion === "string" ? baseline.runtimeVersion : null,
				checkedAt: typeof baseline.checkedAt === "string" ? baseline.checkedAt : null
			},
			upgraded,
			issues,
			warnings: [...current.warnings, ...comparison.warnings],
			counts: {
				entries: current.entries.length,
				clientModules: current.modules.length,
				issues: issues.length
			},
			paths: reportPaths
		};
		if (report.ok) {
			try {
				await writeBaseline(reportPaths.baseline, current, checkedAt);
			} catch (error) {
				report.warnings = [...(report.warnings ?? []), { kind: "baseline-write-failed", detail: messageOf(error) }];
			}
		}
		await persistReport(reportPaths.report, report);
		latest = report;
		return report;
	};

	/** Write the baseline from one snapshot. */
	const writeBaseline = async (path, current, checkedAt) => {
		await writeJsonDocument(path, {
			schemaVersion: SCHEMA_VERSION,
			runtimeVersion: current.runtimeVersion,
			entries: current.entries,
			clientModules: current.modules,
			checkedAt
		}, fsOps);
	};

	/** Persist a report, keeping an in-memory copy regardless of I/O. */
	const persistReport = async (path, report) => {
		try {
			await writeJsonDocument(path, report, fsOps);
		} catch (error) {
			report.warnings = [...(report.warnings ?? []), { kind: "report-write-failed", detail: messageOf(error) }];
			logger.warn?.(`[dsh-feature-check] cannot write the report: ${messageOf(error)}`);
		}
	};

	/** Run one check, joining an in-flight run. */
	const run = async () => {
		if (inFlight !== null) return inFlight;
		inFlight = (async () => {
			try {
				return await checkOnce();
			} finally {
				inFlight = null;
			}
		})();
		return inFlight;
	};

	/** Latest report (memory first, then disk). */
	const status = async () => {
		const report = await ensureLatest();
		return { report, pending: report === null ? true : report.pending === true };
	};

	return { run, status, paths, snapshot };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** Write one JSON response; a committed response is left alone. */
function writeJson(res, status, body) {
	if (res === null || typeof res !== "object" || res.headersSent === true) {
		try {
			res?.destroy?.();
		} catch {
			/* the socket is already gone */
		}
		return;
	}
	try {
		res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		res.end(JSON.stringify(body));
	} catch {
		try {
			res.destroy?.();
		} catch {
			/* ignore */
		}
	}
}

/** Read one optional JSON body (bounded). */
async function readJsonBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_DOCUMENT_BYTES) throw new Error("request body is too large");
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim().length === 0) return {};
	try {
		const parsed = JSON.parse(text);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		throw new Error("request body is not valid JSON");
	}
}

// ---------------------------------------------------------------------------
// Cordis plugin entry
// ---------------------------------------------------------------------------

/**
 * Read one optional service from the context without failing when the service
 * is absent (a headless or partial composition).
 */
function serviceOf(ctx, serviceName) {
	try {
		if (typeof ctx.get === "function") {
			const value = ctx.get(serviceName);
			if (value !== undefined && value !== null) return value;
		}
	} catch {
		/* fall through to the direct access probe */
	}
	try {
		return ctx?.[serviceName];
	} catch {
		return undefined;
	}
}

/**
 * Build the three HTTP handlers around one core. Exported so the unit tests
 * can exercise the wire contract without mounting a Cordis context.
 * @param core - result of {@link createFeatureCheckCore}.
 * @returns `{ health, status, run }` Node request handlers.
 */
export function createRouteHandlers(core) {
	const health = (req, res) => {
		if (req?.method !== "GET") {
			writeJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: "use GET" } });
			return;
		}
		writeJson(res, 200, { ok: true, version: PLUGIN_VERSION });
	};

	const status = async (req, res) => {
		if (req?.method !== "GET") {
			writeJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: "use GET" } });
			return;
		}
		try {
			const state = await core.status();
			writeJson(res, 200, { ok: true, report: state.report, pending: state.pending });
		} catch (error) {
			writeJson(res, 500, { ok: false, error: { code: "internal", message: messageOf(error) } });
		}
	};

	const run = async (req, res) => {
		if (req?.method !== "POST") {
			writeJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: "use POST" } });
			return;
		}
		try {
			await readJsonBody(req);
			const report = await core.run();
			writeJson(res, 200, { ok: true, report, pending: report !== null && report.pending === true });
		} catch (error) {
			writeJson(res, 500, { ok: false, error: { code: "internal", message: messageOf(error) } });
		}
	};

	return { health, status, run };
}

/**
 * Mount the plugin: build the core against the live context, register the
 * routes, then run the automatic startup check with bounded retries.
 * @param ctx - Cordis host context.
 */
export function apply(ctx) {
	const webServer = ctx?.webServer;
	const logger = ctx?.logger;

	const core = createFeatureCheckCore({
		getLoaderEntries: () => {
			// `loader` is a declared dependency, so the direct access is safe; the
			// dynamic lookup keeps older/newer compositions working.
			let loader;
			try {
				loader = ctx.loader;
			} catch {
				loader = undefined;
			}
			if (loader === undefined) loader = serviceOf(ctx, "loader");
			if (loader === undefined || typeof loader.entries !== "function") return [];
			const entries = loader.entries();
			// Current DSH returns an iterable; normalize so the collector and the
			// baseline stay plain arrays.
			return Array.isArray(entries) ? entries : Array.from(entries);
		},
		getClientGraph: () => {
			const clientModules = serviceOf(ctx, "clientModules");
			if (clientModules === undefined || typeof clientModules.graph !== "function") return undefined;
			return clientModules.graph();
		},
		getBundles: async () => {
			const pluginManager = serviceOf(ctx, "pluginManager");
			if (pluginManager === undefined || typeof pluginManager.listBundles !== "function") return undefined;
			return pluginManager.listBundles();
		},
		getRuntimeVersion: () => {
			const clientModules = serviceOf(ctx, "clientModules");
			return clientModules !== undefined && typeof clientModules.release?.version === "string" ? clientModules.release.version : undefined;
		},
		logger,
		env: process.env
	});

	/** Announce the outcome once per startup. */
	const announce = (report) => {
		try {
			if (report === null || typeof report !== "object") return;
			if (report.pending === true) return;
			if (report.ok === true) {
				logger?.info?.(`[dsh-feature-check] startup check passed (dsh ${String(report.runtimeVersion)}${report.baselineCreated === true ? ", baseline created" : ""}${report.upgraded === true ? ", upgrade verified" : ""})`);
				return;
			}
			const summary = (report.issues ?? []).map((issue) => `${issue.kind}:${issue.name}`).join(", ");
			logger?.warn?.(`[dsh-feature-check] startup check found ${String(report.counts?.issues ?? (report.issues ?? []).length)} missing feature(s): ${summary}`);
		} catch {
			/* logging must never break the check */
		}
	};

	/** Run the automatic check with retries until the composition settles. */
	let attempts = 0;
	let timer = null;
	const attempt = async () => {
		attempts += 1;
		let report = null;
		try {
			report = await core.run();
		} catch (error) {
			logger?.warn?.(`[dsh-feature-check] startup check failed: ${messageOf(error)}`);
			return;
		}
		const pending = report === null || report.pending === true;
		if (pending && attempts < MAX_ATTEMPTS) {
			timer = setTimeout(() => { void attempt(); }, RETRY_DELAY_MS);
			if (typeof timer?.unref === "function") timer.unref();
			return;
		}
		announce(report);
	};

	if (webServer !== undefined && webServer !== null && typeof webServer.register === "function" && typeof ctx?.effect === "function") {
		const handlers = createRouteHandlers(core);
		ctx.effect(() => webServer.register({
			kind: "exact",
			path: HEALTH_PATH,
			handler: handlers.health
		}), "dsh-feature-check: health route");

		ctx.effect(() => webServer.register({
			kind: "exact",
			path: STATUS_PATH,
			handler: handlers.status
		}), "dsh-feature-check: status route");

		ctx.effect(() => webServer.register({
			kind: "exact",
			path: RUN_PATH,
			handler: handlers.run
		}), "dsh-feature-check: run route");

		logger?.info?.(`[dsh-feature-check] routes mounted (version ${PLUGIN_VERSION})`);
	} else {
		logger?.warn?.("[dsh-feature-check] ctx.webServer is unavailable; the report is file-only");
	}

	timer = setTimeout(() => { void attempt(); }, FIRST_CHECK_DELAY_MS);
	if (typeof timer?.unref === "function") timer.unref();
	if (typeof ctx?.effect === "function") {
		ctx.effect(() => () => {
			if (timer !== null) clearTimeout(timer);
			timer = null;
		}, "dsh-feature-check: startup check timer");
	}

	return { core };
}
