'use strict';

const path = require('path');
const { app, BrowserWindow, dialog, Notification, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');

// Sin barra de menú (File/Edit/View...): interfaz limpia de producto.
Menu.setApplicationMenu(null);

// App instalada: los navegadores de Playwright van empaquetados en los
// recursos del programa (no dependen de npx playwright install).
if (app.isPackaged) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'ms-playwright');
}
const { crearContenedor } = require('./contenedor');
const { registrarIpc } = require('./ipc');

let ventana = null;
let contenedor = null;
let temporizadorAuto = null;
let fallosSeguidosAuto = 0;

/**
 * Sincronización automática silenciosa (sin ventanas ni login). Avisa con
 * UNA sola notificación de Windows por ciclo exitoso, sin bombardear al
 * usuario con avisos separados por cada tipo de cambio.
 *
 * Un solo fallo casi siempre es un tropiezo pasajero de red (ya se
 * reintenta varias veces puertas adentro antes de llegar acá) que se
 * resuelve solo en el próximo ciclo automático: avisar de entrada
 * generaría una alarma falsa recurrente. Solo se notifica al usuario a
 * partir del SEGUNDO fallo seguido, cuando ya es más probable que sea un
 * problema real (sesión/credenciales) que necesite su atención.
 */
async function sincronizarAutomatico() {
  const { syncService, logger } = contenedor;
  try {
    const resumen = await syncService.sincronizar({ interactivo: false });
    fallosSeguidosAuto = 0;

    const partes = [];
    if (resumen.nuevos > 0) partes.push(`${resumen.nuevos} nuevo(s)`);
    if (resumen.marcadosAusentes > 0) partes.push(`${resumen.marcadosAusentes} enviado(s)`);
    if (resumen.devueltos > 0) partes.push(`${resumen.devueltos} devuelto(s)`);

    new Notification({
      title: 'Sincronización completada',
      body:
        partes.length > 0
          ? `${resumen.leidos} trámites revisados: ${partes.join(', ')}.`
          : `${resumen.leidos} trámites revisados, sin novedades.`,
    }).show();
  } catch (error) {
    fallosSeguidosAuto++;
    // Sesión vencida o red caída: se registra y se reintenta en el próximo ciclo.
    logger.warn(`Sincronización automática pospuesta (fallo ${fallosSeguidosAuto} seguido(s)): ${error.message}`);
    if (fallosSeguidosAuto >= 2) {
      new Notification({
        title: 'No se pudo sincronizar',
        body: 'Abra el programa: puede que deba iniciar sesión de nuevo en el aplicativo.',
      }).show();
    }
  }
}

function programarSincronizacionAutomatica() {
  const minutos = contenedor.config.sync.autoCadaMinutos;
  if (!minutos || minutos <= 0) return;
  temporizadorAuto = setInterval(sincronizarAutomatico, minutos * 60 * 1000);
  contenedor.logger.info(`Sincronización automática activada: cada ${minutos} minutos.`);
}

/**
 * Revisa GitHub Releases en busca de una versión nueva. Si la encuentra, la
 * baja en segundo plano y avisa con una notificación: se instala sola al
 * reiniciar el programa (no interrumpe la sesión actual del usuario).
 */
function iniciarAutoActualizacion() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (error) => {
    contenedor?.logger?.warn(`Auto-actualización: ${error.message}`);
  });
  autoUpdater.on('update-downloaded', (info) => {
    contenedor?.logger?.info(`Actualización ${info.version} descargada.`);
    new Notification({
      title: 'Actualización lista',
      body: `Versión ${info.version} descargada. Se instalará al cerrar el programa.`,
    }).show();
  });

  autoUpdater.checkForUpdates().catch((error) => {
    contenedor?.logger?.warn(`No se pudo revisar actualizaciones: ${error.message}`);
  });
}

function crearVentana() {
  ventana = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Sincronizador de Bandeja',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  ventana.loadFile(path.join(__dirname, '..', 'renderer', 'index.html')).catch((error) => {
    contenedor?.logger?.error(`No se pudo cargar la interfaz: ${error.message}`);
  });
  ventana.webContents.on('render-process-gone', (_e, detalles) => {
    contenedor?.logger?.error(`Proceso de interfaz caído: ${JSON.stringify(detalles)}`);
  });
  ventana.webContents.on('did-fail-load', (_e, codigo, descripcion) => {
    contenedor?.logger?.error(`Fallo al cargar interfaz: ${codigo} ${descripcion}`);
  });
  ventana.webContents.on('console-message', (_e, nivel, mensaje) => {
    if (nivel >= 2) contenedor?.logger?.warn(`[interfaz] ${mensaje}`);
  });
  ventana.on('close', () => {
    contenedor?.logger?.info('Evento close de la ventana (algo pidió cerrarla).');
  });
  ventana.on('closed', () => {
    contenedor?.logger?.info('Ventana principal cerrada.');
    ventana = null;
  });
}

process.on('uncaughtException', (error) => {
  try {
    contenedor?.logger?.error(`Excepción no capturada: ${error.stack || error.message}`);
  } catch { /* sin logger aún */ }
});

app.setAppUserModelId('com.catastro.gestortramites');

app.whenReady().then(() => {
  try {
    contenedor = crearContenedor();
  } catch (error) {
    dialog.showErrorBox('Error de configuración', error.message);
    app.quit();
    return;
  }

  registrarIpc(contenedor, () => ventana);
  crearVentana();
  programarSincronizacionAutomatica();
  iniciarAutoActualizacion();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) crearVentana();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (evento) => {
  contenedor?.logger?.info('Evento before-quit recibido.');
  if (temporizadorAuto) {
    clearInterval(temporizadorAuto);
    temporizadorAuto = null;
  }
  if (contenedor) {
    evento.preventDefault();
    const c = contenedor;
    contenedor = null;
    try {
      await c.syncService.destruir();
      c.database.cerrar();
    } finally {
      app.quit();
    }
  }
});
