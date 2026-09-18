# NodeRED Xiaomi Roborock Nodes
[![platform](https://img.shields.io/badge/platform-Node--RED-red?logo=nodered)](https://nodered.org)
[![Min Node Version](https://img.shields.io/node/v/node-red-contrib-miio-roborock.svg)](https://nodejs.org/en/)
[![GitHub version](https://img.shields.io/github/package-json/v/andreypopov/node-red-contrib-miio-roborock?logo=npm)](https://www.npmjs.com/package/node-red-contrib-miio-roborock)
[![GitHub stars](https://img.shields.io/github/stars/andreypopov/node-red-contrib-miio-roborock)](https://github.com/andreypopov/node-red-contrib-miio-roborock/stargazers)
[![Package Quality](https://packagequality.com/shield/node-red-contrib-miio-roborock.svg)](https://packagequality.com/#?package=node-red-contrib-miio-roborock)

[![issues](https://img.shields.io/github/issues/andreypopov/node-red-contrib-miio-roborock?logo=github)](https://github.com/andreypopov/node-red-contrib-miio-roborock/issues)
![GitHub last commit](https://img.shields.io/github/last-commit/andreypopov/node-red-contrib-miio-roborock)
![NPM Total Downloads](https://img.shields.io/npm/dt/node-red-contrib-miio-roborock.svg)
![NPM Downloads per month](https://img.shields.io/npm/dm/node-red-contrib-miio-roborock)
![Repo size](https://img.shields.io/github/repo-size/andreypopov/node-red-contrib-miio-roborock)

Node-Red Nodes for Xiaomi Roborock Vacuum connectivity.

---

## About this fork

This fork fixes the connection getting stuck permanently, reported upstream as
[issue #58](https://github.com/andreypopov/node-red-contrib-miio-roborock/issues/58)
("TypeError: Cannot read properties of undefined (reading 'call')").

**What went wrong.** `miio` caches one `DeviceInfo` per address and keeps the in-flight
handshake and enrich promises on that cached object. The server node used to call
`connect()` again on *every* failed poll - every 10 seconds, without tearing down the
previous attempt. Once one of those cached promises was left pending (for example while
the vacuum reboots), every later `miio.device()` call received that same dead promise:
no UDP packet was sent any more, no error was raised, and the node kept logging
`No connection (get status)` until the whole Node-RED process was restarted. Commands
then failed with `TypeError: ... reading 'call'`, because `server.device` was never set.

**What changed:**

* `connect()` runs one attempt at a time and resolves with the device or `null` - it
  never hangs and never rejects.
* Every attempt first destroys the previous device and drops miio's cached `DeviceInfo`
  for the address, so a stuck promise cannot poison later attempts.
* A connect attempt has a hard 15 s deadline.
* Failed polls no longer hammer `connect()`; retries back off from 10 s up to 5 min.
* `miio-roborock-command` reports "not connected" instead of throwing a `TypeError`.

`npm test` reproduces the stuck state offline (against TEST-NET-1) and verifies the
recovery - see `test/reconnect-wedge.js`.

---

<b>Important:</b> works and tested with Roborock s50 (gen2), Roborock s5 Max (gen3), Roborock S8 Ultra Pro, Xiaomi S1
 
Available nodes are:
* miio-roborock-command: control your vacuum
* miio-roborock-event: get events from vacuum


<b>Examples:</b> Import from node-red menu!

<img src="https://github.com/andreypopov/node-red-contrib-miio-roborock/blob/master/readme/1.png?raw=true">
<img src="https://github.com/andreypopov/node-red-contrib-miio-roborock/blob/master/readme/2.png?raw=true">
<img src="https://github.com/andreypopov/node-red-contrib-miio-roborock/blob/master/readme/3.png?raw=true">



# Support
Developing and supporting this plugin needs time and efforts. Appreciate your support on [Patreon](https://www.patreon.com/bePatron?u=12661781). Here, you can sign up to be a member and help support my project.
