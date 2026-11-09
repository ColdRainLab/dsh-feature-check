/**
 * Host-half unit tests for dsh-feature-check.
 *
 * Every test runs against a throw-away DSH home under the OS temp directory
 * and fake service accessors shaped like `ctx.loader.entries()`,
 * `clientModules.graph()` and `pluginManager.listBundles()`.
 *
 * Layers covered: pure snapshot helpers, the check core (baseline creation,
 * regression detection, upgrade detection, pending state, report persistence)
 * and the HTTP handlers.
 *
 * Run with:
 *   node plugins/dsh-feature-check/tests/host.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	apply,
	BASELINE_FILE,
	bundleDiagnostics,
	clientModuleIds,
	collectSnapshot,
	compareSnapshots,
	createFeatureCheckCore,
	createRouteHandlers,
	HEALTH_PATH,
	inject,
	loaderEntryNames,
	PLUGIN_VERSION,
	readJsonDocument,
	REPORT_FILE,
	resolveHome,
	RUN_PATH,
	statePaths,
	STATUS_PATH,
	writeJsonDocument
} from "../lib/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = () => new Date("2026-01-01T00:00:00.000Z");

async function createHome() {
	const home = await mkdtemp(join(tmpdir(), "dsh-feature-check-"));
	return home;
}

async function destroyHome(home) {
	await rm(home, { recursive: true, force: true });
}

/** One mutable fake composition (loader entries, client graph, bundles). */
function createWorld(overrides = {}) {
	const world = {
		entries: [
			{ options: { name: "dsh-session-delete" } },
			{ options: { name: "dsh-worktable" } },
			{ options: { name: "cordis:internal" } },
			{ options: { name: "dsh-gacha-calendar" } }
		],
		modules: ["dsh-session-delete", "dsh-worktable", "dsh-gacha-calendar"],
		version: "0.2.1-rc.3",
		bundles: [],
		...overrides
	};
	return {
		world,
		accessors: {
			getLoaderEntries: () => world.entries,
			getClientGraph: () => ({ release: { version: world.version }, entries: world.modules.map((id) => ({ id })) }),
			getBundles: async () => world.bundles,
			getRuntimeVersion: () => world.version
		}
	};
}

/** Create the production core over one fixture home. */
function createCore(home, accessors, overrides = {}) {
	return createFeatureCheckCore({
		...accessors,
		env: { DSH_HOME: home },
		now: FIXED_NOW,
		logger: { info() {}, warn() {} },
		...overrides
	});
}

async function withCore(options, body) {
	const home = await createHome();
	try {
		const { world, accessors } = createWorld(options.world);
		const core = createCore(home, accessors, options.overrides);
		return await body({ home, world, accessors, core });
	} finally {
		await destroyHome(home);
	}
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("resolveHome honours DSH_HOME, trims it, and falls back to ~/.dsh", () => {
	assert.equal(resolveHome({ DSH_HOME: "C:\\custom\\home" }), "C:\\custom\\home");
	assert.equal(resolveHome({ DSH_HOME: "  " }), join(resolveHome({}), ""));
	assert.ok(resolveHome({}).endsWith(".dsh"));
});

test("loaderEntryNames keeps configured names, drops cordis rows, dedupes and sorts", () => {
	const names = loaderEntryNames([
		{ options: { name: "b-entry" } },
		{ options: { name: "a-entry" } },
		{ options: { name: "b-entry" } },
		{ options: { name: "cordis:loader" } },
		{ options: { name: "  " } },
		{ options: {} },
		{},
		null
	]);
	assert.deepEqual(names, ["a-entry", "b-entry"]);
});

test("loaderEntryNames accepts the loader's iterable result", () => {
	const entries = new Set([
		{ options: { name: "iterable-entry" } },
		{ options: { name: "cordis:skip" } }
	]);
	assert.deepEqual(loaderEntryNames(entries), ["iterable-entry"]);
	function* generate() {
		yield { options: { name: "generated-entry" } };
	}
	assert.deepEqual(loaderEntryNames(generate()), ["generated-entry"]);
});

test("clientModuleIds reads ids and the release version from the graph", () => {
	const result = clientModuleIds({ release: { version: "0.2.1-rc.3" }, entries: [{ id: "b" }, { id: "a" }, { id: "a" }, {}] });
	assert.deepEqual(result.modules, ["a", "b"]);
	assert.equal(result.runtimeVersion, "0.2.1-rc.3");
	assert.deepEqual(clientModuleIds(undefined), { modules: [], runtimeVersion: null });
});

test("bundleDiagnostics reports enabled errors and ignores disabled ones", () => {
	const { issues, warnings } = bundleDiagnostics([
		{
			name: "dsh-session-delete",
			version: "0.2.2",
			enabled: true,
			error: {
				code: "incompatible-version",
				incompatible: [{ name: "dsh-session-delete", version: "0.2.2", runtimeVersion: "0.2.1-rc.3", requirements: { "engines.dsh": "0.2.1-rc.2" } }]
			}
		},
		{ name: "better-sidebar", enabled: false, error: { code: "incompatible-version" } },
		{ name: "healthy", enabled: true }
	]);
	assert.equal(issues.length, 1);
	assert.equal(issues[0].kind, "bundle");
	assert.equal(issues[0].name, "dsh-session-delete");
	assert.equal(issues[0].code, "incompatible-version");
	assert.match(issues[0].detail, /0\.2\.1-rc\.3/);
	assert.match(issues[0].hint, /allow-version/);
	assert.equal(warnings.length, 1);
	assert.equal(warnings[0].kind, "bundle-disabled");
});

test("compareSnapshots reports missing modules/entries and respects disabled bundles", () => {
	const baseline = { entries: ["a-entry", "b-entry"], clientModules: ["mod-a", "mod-b"], runtimeVersion: "0.2.1-rc.3" };
	const current = {
		entries: ["a-entry"],
		modules: ["mod-a"],
		bundles: [{ name: "mod-b", enabled: false }, { name: "b-entry", enabled: false }]
	};
	const { issues, warnings } = compareSnapshots(baseline, current);
	assert.equal(issues.length, 0, "missing names whose bundles are disabled are not regressions");
	assert.equal(warnings.filter((entry) => entry.kind === "disabled-feature").length, 2);

	const removed = compareSnapshots(baseline, { entries: ["a-entry"], modules: ["mod-a"], bundles: [] });
	assert.deepEqual(removed.issues.map((entry) => entry.name).sort(), ["b-entry", "mod-b"]);
	assert.equal(removed.issues.find((entry) => entry.name === "mod-b").kind, "client-module");
	assert.equal(removed.issues.find((entry) => entry.name === "b-entry").kind, "loader-entry");
});

test("compareSnapshots merges caller expectations", () => {
	const { issues } = compareSnapshots(
		{ entries: [], clientModules: [], runtimeVersion: "x" },
		{ entries: [], modules: [], bundles: [] },
		{ entries: ["pinned-entry"], clientModules: ["pinned-module"] }
	);
	assert.deepEqual(issues.map((entry) => entry.name).sort(), ["pinned-entry", "pinned-module"]);
});

test("JSON documents round-trip and tolerate missing/invalid files", async () => {
	const home = await createHome();
	try {
		const target = join(home, "doc.json");
		await writeJsonDocument(target, { hello: "world" });
		assert.deepEqual(await readJsonDocument(target), { hello: "world" });
		assert.equal(await readJsonDocument(join(home, "missing.json")), null);
		await writeFile(join(home, "broken.json"), "{not json");
		assert.equal(await readJsonDocument(join(home, "broken.json")), null);
	} finally {
		await destroyHome(home);
	}
});

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

test("first run records a baseline and reports success", async () => {
	await withCore({}, async ({ home, core }) => {
		const report = await core.run();
		assert.equal(report.ok, true);
		assert.equal(report.baselineCreated, true);
		assert.equal(report.pending, false);
		assert.equal(report.runtimeVersion, "0.2.1-rc.3");
		assert.deepEqual(report.counts, { entries: 3, clientModules: 3, issues: 0 });
		const paths = statePaths(home);
		const baseline = JSON.parse(await readFile(paths.baseline, "utf8"));
		assert.equal(baseline.schemaVersion, 1);
		assert.equal(baseline.runtimeVersion, "0.2.1-rc.3");
		assert.deepEqual(baseline.entries, ["dsh-gacha-calendar", "dsh-session-delete", "dsh-worktable"]);
		assert.deepEqual(baseline.clientModules, ["dsh-gacha-calendar", "dsh-session-delete", "dsh-worktable"]);
		assert.equal((await stat(paths.report)).isFile(), true);
	});
});

test("a healthy second start keeps passing without new issues", async () => {
	await withCore({}, async ({ core }) => {
		await core.run();
		const report = await core.run();
		assert.equal(report.ok, true);
		assert.equal(report.baselineCreated, false);
		assert.equal(report.upgraded, false);
		assert.deepEqual(report.issues, []);
	});
});

test("a missing client module is reported and the baseline is kept", async () => {
	await withCore({}, async ({ home, world, core }) => {
		await core.run();
		world.modules = world.modules.filter((id) => id !== "dsh-worktable");
		world.entries = world.entries.filter((entry) => entry.options.name !== "dsh-worktable");
		const report = await core.run();
		assert.equal(report.ok, false);
		assert.equal(report.pending, false);
		assert.deepEqual(report.issues.map((entry) => entry.name).sort(), ["dsh-worktable", "dsh-worktable"]);
		const kinds = report.issues.map((entry) => entry.kind).sort();
		assert.deepEqual(kinds, ["client-module", "loader-entry"]);
		const baseline = JSON.parse(await readFile(statePaths(home).baseline, "utf8"));
		assert.ok(baseline.clientModules.includes("dsh-worktable"), "the failing run must not overwrite the baseline");
	});
});

test("an enabled incompatible bundle is reported with a fix hint", async () => {
	await withCore({}, async ({ world, core }) => {
		await core.run();
		world.bundles = [{
			name: "dsh-session-delete",
			version: "0.2.2",
			enabled: true,
			error: {
				code: "incompatible-version",
				incompatible: [{ name: "dsh-session-delete", version: "0.2.2", runtimeVersion: "0.2.1-rc.3", requirements: { "engines.dsh": "0.2.1-rc.2" } }]
			}
		}];
		const report = await core.run();
		assert.equal(report.ok, false);
		const issue = report.issues.find((entry) => entry.kind === "bundle");
		assert.ok(issue);
		assert.equal(issue.name, "dsh-session-delete");
		assert.match(issue.hint, /allow-version/);
	});
});

test("a DSH upgrade with everything present passes and moves the baseline", async () => {
	await withCore({}, async ({ home, world, core }) => {
		await core.run();
		world.version = "0.2.1-rc.4";
		const report = await core.run();
		assert.equal(report.ok, true);
		assert.equal(report.upgraded, true);
		assert.equal(report.runtimeVersion, "0.2.1-rc.4");
		assert.equal(report.baselineRuntimeVersion, "0.2.1-rc.3");
		const baseline = JSON.parse(await readFile(statePaths(home).baseline, "utf8"));
		assert.equal(baseline.runtimeVersion, "0.2.1-rc.4");
	});
});

test("an upgrade that dropped a feature reports it and keeps the old baseline", async () => {
	await withCore({}, async ({ home, world, core }) => {
		await core.run();
		world.version = "0.2.1-rc.4";
		world.modules = world.modules.filter((id) => id !== "dsh-gacha-calendar");
		world.entries = world.entries.filter((entry) => entry.options.name !== "dsh-gacha-calendar");
		const report = await core.run();
		assert.equal(report.ok, false);
		assert.equal(report.upgraded, true);
		assert.equal(report.baselineRuntimeVersion, "0.2.1-rc.3");
		const baseline = JSON.parse(await readFile(statePaths(home).baseline, "utf8"));
		assert.equal(baseline.runtimeVersion, "0.2.1-rc.3");
	});
});

test("an unsettled composition reports pending and writes no baseline", async () => {
	await withCore({ world: { entries: [], modules: [] } }, async ({ home, core }) => {
		const report = await core.run();
		assert.equal(report.pending, true);
		assert.equal(report.ok, null);
		await assert.rejects(stat(statePaths(home).baseline), { code: "ENOENT" });
	});
});

test("expect.json adds caller-pinned expectations", async () => {
	await withCore({}, async ({ home, core }) => {
		await core.run();
		const paths = statePaths(home);
		await writeFile(paths.expect, JSON.stringify({ clientModules: ["a-removed-module"], entries: ["a-removed-entry"] }));
		const report = await core.run();
		assert.equal(report.ok, false);
		assert.deepEqual(report.issues.map((entry) => entry.name).sort(), ["a-removed-entry", "a-removed-module"]);
	});
});

test("a report write failure is surfaced as a warning instead of a crash", async () => {
	await withCore({ overrides: { fsOps: { writeFile: async () => { throw new Error("disk full"); } } } }, async ({ core }) => {
		const report = await core.run();
		assert.equal(report.ok, true);
		assert.ok(report.warnings.some((warning) => warning.kind === "report-write-failed"));
	});
});

test("a later core instance reads the persisted report", async () => {
	const home = await createHome();
	try {
		const first = createCore(home, createWorld().accessors);
		await first.run();
		const { accessors } = createWorld();
		const second = createCore(home, accessors);
		const state = await second.status();
		assert.equal(state.pending, false);
		assert.equal(state.report.ok, true);
		assert.equal(state.report.runtimeVersion, "0.2.1-rc.3");
		const paths = statePaths(home);
		assert.equal(JSON.parse(await readFile(paths.report, "utf8")).ok, true);
	} finally {
		await destroyHome(home);
	}
});

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

function createRequest(method, url, body) {
	const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
	return {
		method,
		url,
		async *[Symbol.asyncIterator]() {
			for (const chunk of payload) yield chunk;
		}
	};
}

function createResponse() {
	return {
		statusCode: 0,
		headersSent: false,
		body: "",
		writeHead(status) { this.statusCode = status; this.headersSent = true; },
		end(chunk) { if (chunk !== undefined) this.body += String(chunk); }
	};
}

async function call(handler, request) {
	const response = createResponse();
	await handler(request, response);
	return { status: response.statusCode, json: response.body === "" ? undefined : JSON.parse(response.body) };
}

test("health/status/run handlers answer the wire contract", async () => {
	await withCore({}, async ({ core }) => {
		const handlers = createRouteHandlers(core);

		const health = await call(handlers.health, createRequest("GET", HEALTH_PATH));
		assert.equal(health.status, 200);
		assert.equal(health.json.ok, true);
		assert.equal(typeof health.json.version, "string");

		const pendingStatus = await call(handlers.status, createRequest("GET", STATUS_PATH));
		assert.equal(pendingStatus.status, 200);
		assert.equal(pendingStatus.json.pending, true);
		assert.equal(pendingStatus.json.report, null);

		const run = await call(handlers.run, createRequest("POST", RUN_PATH, {}));
		assert.equal(run.status, 200);
		assert.equal(run.json.ok, true);
		assert.equal(run.json.report.ok, true);
		assert.equal(run.json.pending, false);

		const afterStatus = await call(handlers.status, createRequest("GET", STATUS_PATH));
		assert.equal(afterStatus.json.pending, false);
		assert.equal(afterStatus.json.report.ok, true);

		assert.equal((await call(handlers.health, createRequest("POST", HEALTH_PATH))).status, 405);
		assert.equal((await call(handlers.status, createRequest("POST", STATUS_PATH))).status, 405);
		assert.equal((await call(handlers.run, createRequest("GET", RUN_PATH))).status, 405);
	});
});

test("plugin entry exposes the wide-compatibility contract", () => {
	assert.deepEqual([...inject], ["webServer", "loader"]);
	assert.equal(typeof apply, "function");
	assert.equal(typeof PLUGIN_VERSION, "string");
	assert.equal(typeof createFeatureCheckCore, "function");
	assert.equal(typeof collectSnapshot, "function");
});
