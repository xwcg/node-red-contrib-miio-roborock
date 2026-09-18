const EventEmitter = require('events');
const miio = require('miio');
const miioNetwork = require('miio/lib/network');
const MiioRoborockVocabulary = require('../lib/miio-roborock-vocabulary.js');

// A connect attempt that neither resolves nor rejects would block every later
// attempt, so give it a hard deadline.
const CONNECT_TIMEOUT = 15000;
const RECONNECT_MIN_DELAY = 10000;
const RECONNECT_MAX_DELAY = 300000;

module.exports = function (RED) {
    class ServerNode {
        constructor(n) {
            RED.nodes.createNode(this, n);

            var node = this;
            node.config = n;
            node.state = [];
            node.status = {};

            node.setMaxListeners(255);
            node.refreshFindTimer = null;
            node.refreshFindInterval = node.config.polling * 1000;
            node.connectPromise = null;
            node.reconnectTimer = null;
            node.reconnectDelay = RECONNECT_MIN_DELAY;
            node.closing = false;
            node.on('close', () => this.onClose());

            if (node.config.token) {
                node.connect().then(device => {
                    if (!device) return;
                    node.getStatus(true).then(result => {
                        node.emit("onInitEnd", result);
                    }).catch((e) => node.log('No connection:', e));
                });

                node.refreshStatusTimer = setInterval(function() {
                    node.getStatus(true).catch((e) => node.log('No connection (get status)', e));

                }, node.refreshFindInterval);
            }
        }


        onClose() {
            var that = this;
            that.closing = true;
            clearInterval(that.refreshStatusTimer);
            that.clearReconnectTimer();
            that.connectPromise = null;
            that.teardownDevice();
            that.purgeMiioCache();
        }

        /**
         * Only ever run one connect attempt at a time. Resolves with the device
         * or with null; it never rejects.
         */
        connect() {
            var node = this;

            if (node.closing) return Promise.resolve(null);
            if (node.connectPromise) return node.connectPromise;

            node.connectPromise = node.tryConnect();
            node.connectPromise.then(() => { node.connectPromise = null; });

            return node.connectPromise;
        }

        tryConnect() {
            var node = this;

            // Always start from a clean slate: miio caches one DeviceInfo per
            // address and keeps its handshake/enrich promises on it. If one of
            // those is left pending, every later miio.device() call gets that
            // dead promise back and no packet is ever sent again.
            node.teardownDevice();
            node.purgeMiioCache();

            return new Promise(function (resolve) {
                var settled = false;

                var timer = setTimeout(function () {
                    if (settled) return;
                    settled = true;

                    node.warn('Miio Roborock Error: connect timed out');
                    node.purgeMiioCache();
                    node.scheduleReconnect();
                    resolve(null);
                }, CONNECT_TIMEOUT);

                miio.device({
                    address: node.config.ip,
                    token: node.config.token
                }).then(device => {
                    if (settled) {
                        // The deadline already passed, drop the late arrival.
                        try { device.destroy(); } catch (e) {}
                        return;
                    }
                    settled = true;
                    clearTimeout(timer);

                    node.device = device;
                    node.device.updateMaxPollFailures(0);
                    node.device.on('thing:initialized', () => {
                        node.log('Miio Roborock: Initialized');
                    });
                    node.device.on('thing:destroyed', () => {
                        node.log('Miio Roborock: Destroyed');
                    });

                    node.clearReconnectTimer();
                    resolve(device);

                }).catch(err => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);

                    node.warn('Miio Roborock Error: ' + err.message);
                    node.purgeMiioCache();
                    node.scheduleReconnect();
                    resolve(null);
                });
            });
        }

        teardownDevice() {
            var node = this;

            if (!node.device) return;
            try {
                node.device.destroy();
            } catch (e) {
                node.log('Miio Roborock: destroying the old device failed: ' + e.message);
            }
            node.device = null;
        }

        /**
         * Drop miio's cached DeviceInfo for our address, so the next connect
         * starts with a fresh handshake instead of reusing a stuck promise.
         */
        purgeMiioCache() {
            var node = this;

            if (!miioNetwork || !miioNetwork.addresses) return;

            var info = miioNetwork.addresses.get(node.config.ip);
            if (!info) return;

            miioNetwork.addresses.delete(node.config.ip);
            if (info.id !== null && info.id !== undefined) {
                miioNetwork.devices.delete(info.id);
            }

            if (info.handshakeTimeout) {
                clearTimeout(info.handshakeTimeout);
                info.handshakeTimeout = null;
            }
            info.handshakeResolve = null;
            info.handshakePromise = null;
            info.enrichPromise = null;

            // Let callers waiting on this abandoned device fail instead of hang.
            if (info.promises && typeof info.promises.forEach === 'function') {
                info.promises.forEach(promise => {
                    try {
                        promise.reject(new Error('Miio Roborock: connection was reset'));
                    } catch (e) {}
                });
                info.promises.clear();
            }
        }

        scheduleReconnect() {
            var node = this;

            if (node.closing || node.reconnectTimer) return;

            var delay = node.reconnectDelay;
            node.log('Miio Roborock: next connect attempt in ' + Math.round(delay / 1000) + 's');

            node.reconnectTimer = setTimeout(function () {
                node.reconnectTimer = null;
                node.connect().then(device => {
                    if (!device) return;
                    // Replay the initial status so event nodes pick up again.
                    node.getStatus(true).then(result => {
                        node.emit("onInitEnd", result);
                    }).catch((e) => node.log("No connection:", e));
                });
            }, delay);

            node.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_DELAY);
        }

        clearReconnectTimer() {
            var node = this;

            if (node.reconnectTimer) {
                clearTimeout(node.reconnectTimer);
                node.reconnectTimer = null;
            }
            node.reconnectDelay = RECONNECT_MIN_DELAY;
        }

        getStatus(force = false) {
            var that = this;

            return new Promise(function (resolve, reject) {
                // if (!that.connected) {
                //     reject('not connected');
                // }

                if (force || !that.status) {
                    if (that.device !== null && that.device !== undefined) {
                        that.device.call("get_status", [])
                            .then(result => {
                                var result = result[0];
                                var props = {};
                                Object.assign(props, result);

                                //remove unused vars
                                if ("msg_ver" in result) delete(result['msg_ver']);
                                if ("msg_seq" in result) delete(result['msg_seq']);

                                //compatible mode
                                if ('batteryLevel' in result) { result['battery'] = result['batteryLevel']; delete(result['batteryLevel']); }
                                if ('fanSpeed' in result) { result['fan_power'] = result['fanSpeed']; delete(result['fanSpeed']); }
                                if ('cleanTime' in result) { result['clean_time'] = result['cleanTime']; delete(result['cleanTime']); }
                                if ('cleanArea' in result) { result['clean_area'] = result['cleanArea']; delete(result['cleanArea']); }

                                //add texts
                                if ("state" in result && result.state in MiioRoborockVocabulary.states) {
                                    result.state_text = MiioRoborockVocabulary.states[result.state];
                                }
                                if ("fan_power" in result && Object.keys(MiioRoborockVocabulary.fan_power(that.device.miioModel)).length && result.fan_power in MiioRoborockVocabulary.fan_power(that.device.miioModel)) {
                                    result.fan_power_homekit = MiioRoborockVocabulary.fan_power(that.device.miioModel)[result.fan_power].homekitTopLevel;
                                    result.fan_power_text = (MiioRoborockVocabulary.fan_power(that.device.miioModel)[result.fan_power].name).toLowerCase();
                                }
                                if ("water_box_mode" in result && result.water_box_mode in MiioRoborockVocabulary.water_box_mode) {
                                    result.water_box_mode_text = MiioRoborockVocabulary.water_box_mode[result.water_box_mode];
                                }
                                if ("error_code" in result && result.error_code in MiioRoborockVocabulary.errors) {
                                    result.error_code_text = MiioRoborockVocabulary.errors[result.error_code].description;
                                    that.warn('Miio Roborock error: #' + result.error_code + ': ' + result.error_code_text);
                                    that.emit("onStateChangedError", result.error_code_text);
                                }

                                //get changed values
                                for (var key in result) {
                                    var value = result[key];
                                    if (key in that.status) {
                                        if (!(key in that.status) || that.status[key] !== value) {
                                            that.status[key] = value;
                                            that.emit("onStateChanged", {key: key, value: value}, true);
                                        }
                                    } else { //init: silent add
                                        that.status[key] = value;
                                        that.emit("onStateChanged", {key: key, value: value}, false);
                                    }
                                }

                                resolve(that.status);
                            }).catch(err => {
                            console.log('Encountered an error while controlling device');
                            console.log('Error(2) was:');
                            console.log(err.message);
                            that.scheduleReconnect();
                            reject(err);
                        });
                    } else {
                        that.scheduleReconnect();
                        reject('No device');
                    }
                } else {
                    resolve(that.status);
                }
            });
        }


    }

    RED.nodes.registerType('miio-roborock-server', ServerNode, {});
};

