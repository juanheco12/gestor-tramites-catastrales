'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Guarda las credenciales del aplicativo de catastro cifradas con la bóveda
 * del sistema operativo (Electron safeStorage, DPAPI en Windows): solo el
 * usuario de Windows que las guardó puede descifrarlas, y nunca se escriben
 * en texto plano.
 *
 * Fuera de Electron (CLI) el servicio queda deshabilitado y el robot cae al
 * login manual.
 */
class CredencialesService {
  /**
   * @param {object} config
   * @param {import('../utils/logger').Logger} logger
   */
  constructor(config, logger) {
    this.logger = logger;
    this.ruta = path.join(path.dirname(config.app.dbPath), 'credenciales.bin');
    this.safeStorage = null;
    try {
      const electron = require('electron');
      if (electron && typeof electron === 'object' && electron.safeStorage) {
        this.safeStorage = electron.safeStorage;
      }
    } catch {
      // CLI / fuera de Electron: sin cifrado disponible.
    }
  }

  disponible() {
    try {
      return Boolean(this.safeStorage && this.safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  existe() {
    return this.disponible() && fs.existsSync(this.ruta);
  }

  /**
   * @param {string} usuario
   * @param {string} clave
   */
  guardar(usuario, clave) {
    if (!this.disponible()) {
      throw new Error('El cifrado del sistema no está disponible en este entorno.');
    }
    const cifrado = this.safeStorage.encryptString(JSON.stringify({ usuario, clave }));
    fs.mkdirSync(path.dirname(this.ruta), { recursive: true });
    fs.writeFileSync(this.ruta, cifrado);
    this.logger.info('Credenciales del aplicativo guardadas (cifradas con la bóveda de Windows).');
  }

  /** @returns {{usuario: string, clave: string}|null} */
  obtener() {
    if (!this.existe()) return null;
    try {
      const texto = this.safeStorage.decryptString(fs.readFileSync(this.ruta));
      const datos = JSON.parse(texto);
      return datos.usuario && datos.clave ? datos : null;
    } catch (error) {
      this.logger.warn(`No se pudieron leer las credenciales guardadas: ${error.message}`);
      return null;
    }
  }

  borrar() {
    if (fs.existsSync(this.ruta)) fs.unlinkSync(this.ruta);
  }
}

module.exports = { CredencialesService };
