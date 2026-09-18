/*
 * Regression test for the "wedged connection" bug.
 *
 * miio keeps one cached DeviceInfo per address and stores the in-flight
 * handshake/enrich promises on it. If one of those promises is never settled,
 * every later miio.device() call for that address gets the same dead promise
 * back: no UDP packet is ever sent again, no error is ever raised, and the
 * server node stays silent until the Node-RED process is restarted.
 *
 * This test wedges a cached DeviceInfo on purpose, shows that miio.device()
 * then hangs forever, and verifies that the server node's purgeMiioCache()
 * makes the next attempt behave normally again.
 *
 * Runs entirely offline - it talks to TEST-NET-1 (RFC 5737), which never answers.
 *
 *   node test/reconnect-wedge.js
 */

'use strict';

const assert = require('assert');
const EventEmitter = require('events');

const miio = require('miio');
const network = require('miio/lib/network');

const ADDRESS = '192.0.2.1'; // RFC 5737, guaranteed to go nowhere
const TOKEN = '00'.repeat(16);
const HANG_PROBE = 4000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves with 'hung' if the promise does not settle within `ms`. */
function settlesWithin(promise, ms) {
	let timer;
	const deadline = new Promise((resolve) => {
		timer = setTimeout(() => resolve('hung'), ms);
	});

	return Promise.race([
		promise.then(() => 'resolved', (err) => 'rejected: ' + err.message),
		deadline
	]).then((result) => {
		clearTimeout(timer);
		return result;
	});
}

/** Minimal Node-RED stub: enough to instantiate the server node. */
function loadServerNode() {
	const registered = {};

	const RED = {
		nodes: {
			createNode(node) {
				EventEmitter.call(node);
				Object.getOwnPropertyNames(EventEmitter.prototype).forEach((key) => {
					if (key !== 'constructor' && typeof node[key] === 'undefined') {
						node[key] = EventEmitter.prototype[key];
					}
				});

				node.log = (...args) => console.log('   [node.log]', ...args);
				node.warn = (...args) => console.log('   [node.warn]', ...args);
				node.error = (...args) => console.log('   [node.error]', ...args);
			},
			registerType(name, ctor) {
				registered[name] = ctor;
			}
		}
	};

	require('../nodes/server.js')(RED);
	return registered['miio-roborock-server'];
}

async function main() {
	const ServerNode = loadServerNode();
	assert.ok(ServerNode, 'server node did not register');

	// Poll rarely - this test drives the connection by hand.
	const node = new ServerNode({ ip: ADDRESS, token: TOKEN, polling: '3600' });

	console.log('1. first connect attempt against an unreachable address');
	const firstAttempt = await settlesWithin(node.connect(), 20000);
	assert.strictEqual(firstAttempt, 'resolved', 'connect() must resolve (with null), never hang');
	assert.ok(!node.device, 'no device expected');
	assert.ok(node.reconnectTimer, 'a retry should have been scheduled');
	assert.ok(node.reconnectDelay > 10000, 'the retry delay should back off');
	console.log('   ok - resolved with null, retry scheduled in', Math.round(node.reconnectDelay / 1000), 's\n');

	// Keep the shared socket alive for the raw miio calls below.
	const handle = network.ref();

	console.log('2. wedge the cached DeviceInfo, the way the live failure did');
	const wedged = await settlesWithin(miio.device({ address: ADDRESS, token: TOKEN }), 20000);
	console.log('   plain miio.device() before wedging:', wedged);

	const info = network.addresses.get(ADDRESS);
	assert.ok(info, 'miio should have cached a DeviceInfo for the address');
	info.handshakePromise = new Promise(() => {}); // never settles

	const duringWedge = await settlesWithin(miio.device({ address: ADDRESS, token: TOKEN }), HANG_PROBE);
	assert.strictEqual(duringWedge, 'hung', 'expected the wedged cache to swallow the attempt');
	console.log('   ok - miio.device() hangs forever, exactly the observed failure\n');

	console.log('3. purgeMiioCache() clears the wedge');
	node.config.ip = ADDRESS;
	node.purgeMiioCache();
	assert.ok(!network.addresses.has(ADDRESS), 'the cached entry should be gone');

	const afterPurge = await settlesWithin(miio.device({ address: ADDRESS, token: TOKEN }), 20000);
	assert.ok(afterPurge.startsWith('rejected'), 'expected a real error instead of a hang, got: ' + afterPurge);
	assert.notStrictEqual(network.addresses.get(ADDRESS), info, 'a fresh DeviceInfo should have been created');
	console.log('   ok -', afterPurge, '\n');

	console.log('4. the node reconnects on its own afterwards');
	const recovered = await settlesWithin(node.connect(), 20000);
	assert.strictEqual(recovered, 'resolved', 'connect() must stay usable after a wedge');
	console.log('   ok - connect() still works, no process restart needed\n');

	node.onClose();
	handle.release();
	await sleep(100);

	console.log('all checks passed');
	process.exit(0);
}

main().catch((err) => {
	console.error('FAILED:', err);
	process.exit(1);
});
