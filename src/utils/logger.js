'use strict';

const fs = require('fs');
const path = require('path');

const NIVELES = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Logger simple con salida a consola y archivo diario (logs/sync-YYYY-MM-DD.log).
 * Sin dependencias externas para mantener el módulo liviano.
 */
class Logger {
  /**
   * @param {string} logsDir Directorio donde se escriben los archivos de log
   * @param {string} [nivelMinimo='info']
   */
  constructor(logsDir, nivelMinimo = 'info') {
    this.logsDir = logsDir;
    this.nivelMinimo = NIVELES[nivelMinimo] || NIVELES.info;
    fs.mkdirSync(logsDir, { recursive: true });
  }

  _archivoDelDia() {
    const fecha = new Date().toISOString().slice(0, 10);
    return path.join(this.logsDir, `sync-${fecha}.log`);
  }

  _escribir(nivel, mensaje, datos) {
    if (NIVELES[nivel] < this.nivelMinimo) return;

    const timestamp = new Date().toISOString();
    const sufijo = datos !== undefined ? ` | ${JSON.stringify(datos)}` : '';
    const linea = `[${timestamp}] [${nivel.toUpperCase()}] ${mensaje}${sufijo}`;

    const salida = nivel === 'error' ? console.error : console.log;
    salida(linea);

    try {
      fs.appendFileSync(this._archivoDelDia(), linea + '\n', 'utf8');
    } catch {
      // Un fallo de escritura en disco no debe interrumpir la sincronización.
    }
  }

  debug(mensaje, datos) { this._escribir('debug', mensaje, datos); }
  info(mensaje, datos) { this._escribir('info', mensaje, datos); }
  warn(mensaje, datos) { this._escribir('warn', mensaje, datos); }
  error(mensaje, datos) { this._escribir('error', mensaje, datos); }
}

let instancia = null;

function obtenerLogger(logsDir) {
  if (!instancia) {
    instancia = new Logger(logsDir);
  }
  return instancia;
}

module.exports = { Logger, obtenerLogger };
