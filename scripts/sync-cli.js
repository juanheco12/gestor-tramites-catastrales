'use strict';

/**
 * Lanzador de la CLI de sincronización.
 *
 * better-sqlite3 se compila para el ABI de Electron (postinstall), por lo que
 * la CLI debe ejecutarse con el Node embebido de Electron
 * (ELECTRON_RUN_AS_NODE=1) y no con el Node del sistema.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const electron = require('electron'); // desde Node devuelve la ruta al ejecutable

const resultado = spawnSync(
  electron,
  [path.join(__dirname, '..', 'src', 'cli', 'sync.js')],
  {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }
);

process.exit(resultado.status ?? 1);
