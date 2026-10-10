'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS script run directly by Node/Electron */

/**
 * Loads the prebuilt addon through this package and tries a short capture of the current process.
 * Used by `.github/workflows/native-prebuild.yml` under Node and under Electron's runtime
 * (`ELECTRON_RUN_AS_NODE=1 electron scripts/smoke.js`). Exit code 1 when the addon cannot be
 * loaded or Process Loopback is unsupported; capture failures are only reported, because CI runners
 * have no audio endpoint.
 */
const path = require('node:path');

const { load } = require(path.join(__dirname, '..'));

const runtime = process.versions.electron
  ? `electron ${process.versions.electron} (node ${process.versions.node})`
  : `node ${process.versions.node}`;
console.log(
  `runtime: ${runtime}, napi ${process.versions.napi}, ${process.platform}-${process.arch}`,
);

const native = load();
if (!native) {
  console.error('FAIL: load() returned null (addon missing or unsupported platform)');
  process.exit(1);
}
console.log(`windows build ${native.windowsBuild()}, isSupported=${native.isSupported()}`);
if (!native.isSupported()) {
  console.error('FAIL: Process Loopback unsupported on this Windows build');
  process.exit(1);
}

const capture = native.createCapture();
let chunks = 0;
try {
  const format = capture.start({ pid: process.pid, mode: 'include' }, () => {
    chunks += 1;
  });
  console.log(`capture started: ${JSON.stringify(format)}`);
} catch (err) {
  const hresult = err && err.hresult ? `0x${err.hresult.toString(16)}` : 'n/a';
  console.log(
    `capture could not start (expected without audio devices): ${err.message} [${hresult}]`,
  );
  process.exit(0);
}

setTimeout(() => {
  capture
    .stop()
    .then(() => {
      console.log(`capture stopped after ${chunks} chunk(s)`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`FAIL: stop() threw: ${err.message}`);
      process.exit(1);
    });
}, 300);
