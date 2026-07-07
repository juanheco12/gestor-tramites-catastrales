'use strict';

const fs = require('fs');
const path = require('path');

const RUTA_RAIZ = path.resolve(__dirname, '..', '..');

/**
 * Carpeta base para datos, logs y configuración:
 *  - En desarrollo: la carpeta del proyecto.
 *  - Instalado (empaquetado): %APPDATA%/<app> — así los datos del usuario
 *    sobreviven a reinstalaciones y actualizaciones del programa.
 */
function rutaBase() {
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) return app.getPath('userData');
  } catch {
    // Fuera de Electron (CLI en desarrollo): carpeta del proyecto.
  }
  return RUTA_RAIZ;
}

const RUTA_BASE = rutaBase();

// BANDEJA_CONFIG permite usar otra configuración (pruebas, otro entorno)
// sin tocar la de producción.
const RUTA_CONFIG = process.env.BANDEJA_CONFIG
  ? path.resolve(process.env.BANDEJA_CONFIG)
  : path.join(RUTA_BASE, 'config', 'app.config.json');

// App instalada: la configuración del usuario vive en su carpeta de datos.
// - Primera ejecución: se copia la plantilla de fábrica.
// - Actualización del programa (configVersion mayor): se reemplaza por la
//   plantilla nueva CONSERVANDO los ajustes personales del usuario
//   (ruta de su bitácora e intervalo de sincronización).
if (RUTA_BASE !== RUTA_RAIZ && !process.env.BANDEJA_CONFIG) {
  const rutaPlantilla = path.join(RUTA_RAIZ, 'config', 'app.config.json');
  fs.mkdirSync(path.dirname(RUTA_CONFIG), { recursive: true });

  if (!fs.existsSync(RUTA_CONFIG)) {
    fs.copyFileSync(rutaPlantilla, RUTA_CONFIG);
  } else {
    try {
      const plantilla = JSON.parse(fs.readFileSync(rutaPlantilla, 'utf8'));
      const usuario = JSON.parse(fs.readFileSync(RUTA_CONFIG, 'utf8'));
      if ((usuario.configVersion || 0) < (plantilla.configVersion || 0)) {
        if (usuario.bitacora && usuario.bitacora.xlsxPath) {
          plantilla.bitacora = plantilla.bitacora || {};
          plantilla.bitacora.xlsxPath = usuario.bitacora.xlsxPath;
        }
        if (usuario.sync && usuario.sync.autoCadaMinutos) {
          plantilla.sync.autoCadaMinutos = usuario.sync.autoCadaMinutos;
        }
        fs.writeFileSync(RUTA_CONFIG, JSON.stringify(plantilla, null, 2), 'utf8');
      }
    } catch {
      // Configuración de usuario ilegible: se restaura la de fábrica.
      fs.copyFileSync(rutaPlantilla, RUTA_CONFIG);
    }
  }
}

let cache = null;

/**
 * Carga y valida la configuración de la aplicación.
 * Las rutas relativas se resuelven contra la raíz del proyecto.
 */
function cargarConfig() {
  if (cache) return cache;

  if (!fs.existsSync(RUTA_CONFIG)) {
    throw new Error(`No se encontró el archivo de configuración: ${RUTA_CONFIG}`);
  }

  const config = JSON.parse(fs.readFileSync(RUTA_CONFIG, 'utf8'));

  validar(config);

  config.app.dbPath = path.resolve(RUTA_BASE, config.app.dbPath);
  config.app.logsDir = path.resolve(RUTA_BASE, config.app.logsDir);
  config.app.exportXlsxPath = path.resolve(RUTA_BASE, config.app.exportXlsxPath || 'data/Bandeja.xlsx');
  config.browser.userDataDir = path.resolve(RUTA_BASE, config.browser.userDataDir);

  if (config.bitacora && config.bitacora.xlsxPath) {
    config.bitacora.xlsxPath = path.resolve(config.bitacora.xlsxPath);
    config.bitacora.backupsDir = path.resolve(RUTA_BASE, config.bitacora.backupsDir || 'data/backups');
  }

  for (const dir of [path.dirname(config.app.dbPath), config.app.logsDir, config.browser.userDataDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  cache = config;
  return config;
}

function validar(config) {
  const errores = [];
  if (!config.bandeja || !config.bandeja.url) {
    errores.push('bandeja.url es obligatoria');
  }
  if (!config.bandeja || !config.bandeja.selectors || !config.bandeja.selectors.tabla) {
    errores.push('bandeja.selectors.tabla es obligatorio');
  }
  if (!config.bandeja || !config.bandeja.columnas || !config.bandeja.columnas.numero_tramite) {
    errores.push('bandeja.columnas.numero_tramite es obligatorio (identificador único del trámite)');
  }
  if (errores.length > 0) {
    throw new Error(`Configuración inválida:\n- ${errores.join('\n- ')}`);
  }
}

module.exports = { cargarConfig, RUTA_RAIZ };
