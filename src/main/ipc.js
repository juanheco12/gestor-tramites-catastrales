'use strict';

const { ipcMain, shell, dialog } = require('electron');

const CANALES = {
  SINCRONIZAR: 'bandeja:sincronizar',
  LISTAR_TRAMITES: 'bandeja:listar-tramites',
  LISTAR_LOGS: 'bandeja:listar-logs',
  HISTORIAL: 'bandeja:historial-tramite',
  PROGRESO: 'bandeja:progreso',
  EXPORTAR_EXCEL: 'bandeja:exportar-excel',
  GESTION_LISTAR: 'gestion:listar',
  GESTION_RESUMEN: 'gestion:resumen',
  GESTION_ACTUALIZAR: 'gestion:actualizar',
  IMPORTAR_BITACORA: 'gestion:importar-bitacora',
  POS_LISTAR: 'gestion:pos-listar',
  AGREGAR_HISTORICO: 'gestion:agregar-historico',
  ELIMINAR_MANUAL: 'gestion:eliminar-manual',
  EXPORTAR_VISITAS: 'bandeja:exportar-visitas',
  SISTEMA_RESTABLECER: 'sistema:restablecer',
  CREDENCIALES_GUARDAR: 'credenciales:guardar',
  CREDENCIALES_ESTADO: 'credenciales:estado',
  CREDENCIALES_BORRAR: 'credenciales:borrar',
};

/**
 * Registra los canales IPC que conectan la UI con los servicios.
 * La UI nunca toca Playwright ni SQLite: solo invoca estos canales.
 *
 * @param {ReturnType<import('./contenedor').crearContenedor>} contenedor
 * @param {() => Electron.BrowserWindow|null} obtenerVentana
 */
function registrarIpc(contenedor, obtenerVentana) {
  const {
    syncService,
    tramiteRepository,
    syncLogRepository,
    exportService,
    gestionRepository,
    importService,
    credencialesService,
    logger,
  } = contenedor;

  const notificar = (evento, datos) => {
    const ventana = obtenerVentana();
    if (ventana && !ventana.isDestroyed()) {
      ventana.webContents.send(CANALES.PROGRESO, { evento, ...datos });
    }
  };

  syncService.on('progreso', (datos) => notificar('progreso', datos));
  syncService.on('finalizado', (datos) => notificar('finalizado', datos));
  syncService.on('fallo', (datos) => notificar('fallo', datos));

  ipcMain.handle(CANALES.SINCRONIZAR, async () => {
    try {
      const resumen = await syncService.sincronizar();

      // Si la bitácora cambió, se abre el Excel para que el usuario vea
      // las modificaciones de inmediato (solo en sincronización manual).
      const bitacora = resumen.bitacora;
      const config = contenedor.config;
      if (
        bitacora &&
        config.bitacora &&
        config.bitacora.abrirTrasActualizar &&
        (bitacora.agregados.length > 0 || (bitacora.salieron || []).length > 0)
      ) {
        shell.openPath(bitacora.ruta).catch(() => {});
      }

      return { ok: true, resumen };
    } catch (error) {
      logger.error(`IPC sincronizar: ${error.message}`);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle(CANALES.LISTAR_TRAMITES, (_evento, opciones = {}) => {
    return tramiteRepository.listar(opciones);
  });

  ipcMain.handle(CANALES.LISTAR_LOGS, (_evento, opciones = {}) => {
    return syncLogRepository.listar(opciones);
  });

  ipcMain.handle(CANALES.HISTORIAL, (_evento, tramiteId) => {
    return tramiteRepository.historial(tramiteId);
  });

  ipcMain.handle(CANALES.GESTION_LISTAR, () => {
    return gestionRepository.listarConGestion();
  });

  ipcMain.handle(CANALES.GESTION_RESUMEN, () => {
    return gestionRepository.resumen();
  });

  ipcMain.handle(CANALES.GESTION_ACTUALIZAR, (_evento, { tramiteId, campos }) => {
    try {
      gestionRepository.actualizar(tramiteId, campos);
      return { ok: true };
    } catch (error) {
      logger.error(`IPC gestión actualizar: ${error.message}`);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle(CANALES.IMPORTAR_BITACORA, async () => {
    try {
      // El usuario elige el archivo: sirve para su bitácora o la de otro ejecutor.
      const seleccion = await dialog.showOpenDialog(obtenerVentana(), {
        title: 'Seleccione la bitácora Excel a importar',
        filters: [{ name: 'Excel', extensions: ['xlsx', 'xlsm'] }],
        properties: ['openFile'],
      });
      if (seleccion.canceled || seleccion.filePaths.length === 0) {
        return { ok: false, cancelado: true };
      }

      const resumen = await importService.importar(seleccion.filePaths[0]);
      // Aplicar las reglas de estado a lo que quedó en bandeja.
      const reglas = gestionRepository.aplicarReglasDeEstado();
      return { ok: true, resumen, reglas };
    } catch (error) {
      logger.error(`IPC importar: ${error.message}`);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle(CANALES.POS_LISTAR, () => {
    return gestionRepository.listarPosTramite();
  });

  ipcMain.handle(CANALES.ELIMINAR_MANUAL, async (_evento, tramiteId) => {
    try {
      const respuesta = await dialog.showMessageBox(obtenerVentana(), {
        type: 'warning',
        title: 'Eliminar trámite agregado a mano',
        message: '¿Eliminar este trámite del histórico?',
        detail: 'Solo se puede eliminar porque lo agregó usted a mano. No se puede deshacer.',
        buttons: ['Cancelar', 'Sí, eliminar'],
        defaultId: 0,
        cancelId: 0,
      });
      if (respuesta.response !== 1) return { ok: false, cancelado: true };

      const eliminado = gestionRepository.eliminarManual(tramiteId);
      return { ok: eliminado, error: eliminado ? undefined : 'El trámite no existe.' };
    } catch (error) {
      logger.error(`IPC eliminar manual: ${error.message}`);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle(CANALES.AGREGAR_HISTORICO, (_evento, datos) => {
    try {
      const radicado = String(datos.radicado || '').trim();
      if (!radicado) throw new Error('El radicado es obligatorio.');

      // Igual que en la bitácora de Excel: si el radicado ya existe (p. ej.
      // sigue vivo en la bandeja), se usa el MISMO registro en vez de crear
      // uno nuevo, para que al enviarlo más tarde sea la misma fila la que
      // se cierre con fecha de envío y "EN REVISION".
      let tramite = tramiteRepository.buscarPorNumero(radicado);
      let esNuevo = false;
      if (!tramite) {
        const id = tramiteRepository.insertar(
          { numero_tramite: radicado, tipo: datos.tramite || null, estado: null, fecha: null },
          null,
          { origen: 'manual', presenteEnBandeja: 0 }
        );
        gestionRepository.asegurar(id);
        tramite = { id };
        esNuevo = true;
      }

      const actual = gestionRepository.obtener(tramite.id);
      const campos = {
        fmi: datos.fmi || '',
        // NULL, no "": si queda vacío, el respaldo automático de
        // marcarEnviados (COALESCE) debe poder completarlo al enviarse.
        fecha_realizacion: datos.fecha_realizacion || null,
        estado_seguimiento: datos.estado_seguimiento || 'EN ESPERA',
        observacion: datos.observacion || '',
      };
      // No se retrocede un estado ya avanzado (visita/enviado/devuelto/finalizado);
      // en cualquier otro caso, registrar la nota "en espera" implica Estudiado.
      if (esNuevo || actual.mi_estado === 'por_estudiar') {
        campos.mi_estado = 'estudiado';
      }

      gestionRepository.actualizar(tramite.id, campos);
      return { ok: true, creado: esNuevo };
    } catch (error) {
      logger.error(`IPC agregar histórico: ${error.message}`);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle(CANALES.EXPORTAR_VISITAS, async () => {
    try {
      const ruta = await exportService.exportarVisitas();
      shell.showItemInFolder(ruta);
      return { ok: true, ruta };
    } catch (error) {
      logger.error(`IPC exportar visitas: ${error.message}`);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle(CANALES.SISTEMA_RESTABLECER, async () => {
    const respuesta = await dialog.showMessageBox(obtenerVentana(), {
      type: 'warning',
      title: 'Restablecer el sistema',
      message: '¿Borrar TODOS los trámites, estados, observaciones y el historial de sincronizaciones?',
      detail:
        'El sistema quedará en cero, como recién instalado. Las credenciales de acceso ' +
        'guardadas se conservan. Esta acción NO se puede deshacer.',
      buttons: ['Cancelar', 'Sí, borrar todo'],
      defaultId: 0,
      cancelId: 0,
    });
    if (respuesta.response !== 1) return { ok: false, cancelado: true };

    try {
      contenedor.database.conexion.exec(`
        DELETE FROM tramites_historial;
        DELETE FROM tramites_gestion;
        DELETE FROM pos_tramite;
        DELETE FROM tramites;
        DELETE FROM sync_logs;
      `);
      logger.warn('Sistema restablecido a cero por el usuario.');
      return { ok: true };
    } catch (error) {
      logger.error(`IPC restablecer: ${error.message}`);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle(CANALES.CREDENCIALES_ESTADO, () => ({
    disponible: credencialesService.disponible(),
    guardadas: credencialesService.existe(),
  }));

  ipcMain.handle(CANALES.CREDENCIALES_GUARDAR, (_evento, { usuario, clave }) => {
    try {
      if (!usuario || !clave) throw new Error('Usuario y clave son obligatorios.');
      credencialesService.guardar(usuario, clave);
      return { ok: true };
    } catch (error) {
      logger.error(`IPC credenciales: ${error.message}`);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle(CANALES.CREDENCIALES_BORRAR, () => {
    credencialesService.borrar();
    return { ok: true };
  });

  ipcMain.handle(CANALES.EXPORTAR_EXCEL, async () => {
    try {
      const ruta = await exportService.exportar();
      shell.showItemInFolder(ruta); // abre el Explorador con el archivo seleccionado
      return { ok: true, ruta };
    } catch (error) {
      logger.error(`IPC exportar: ${error.message}`);
      return { ok: false, error: error.message };
    }
  });
}

module.exports = { registrarIpc, CANALES };
