'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Los nombres de canal se duplican aquí a propósito: el preload corre en
// sandbox y no puede hacer require de módulos del proyecto.
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

contextBridge.exposeInMainWorld('bandejaApi', {
  sincronizar: () => ipcRenderer.invoke(CANALES.SINCRONIZAR),
  listarTramites: (opciones) => ipcRenderer.invoke(CANALES.LISTAR_TRAMITES, opciones),
  listarLogs: (opciones) => ipcRenderer.invoke(CANALES.LISTAR_LOGS, opciones),
  historialTramite: (tramiteId) => ipcRenderer.invoke(CANALES.HISTORIAL, tramiteId),
  exportarExcel: () => ipcRenderer.invoke(CANALES.EXPORTAR_EXCEL),
  gestionListar: () => ipcRenderer.invoke(CANALES.GESTION_LISTAR),
  gestionResumen: () => ipcRenderer.invoke(CANALES.GESTION_RESUMEN),
  gestionActualizar: (tramiteId, campos) =>
    ipcRenderer.invoke(CANALES.GESTION_ACTUALIZAR, { tramiteId, campos }),
  importarBitacora: () => ipcRenderer.invoke(CANALES.IMPORTAR_BITACORA),
  posListar: () => ipcRenderer.invoke(CANALES.POS_LISTAR),
  agregarHistorico: (datos) => ipcRenderer.invoke(CANALES.AGREGAR_HISTORICO, datos),
  eliminarManual: (tramiteId) => ipcRenderer.invoke(CANALES.ELIMINAR_MANUAL, tramiteId),
  exportarVisitas: () => ipcRenderer.invoke(CANALES.EXPORTAR_VISITAS),
  restablecerSistema: () => ipcRenderer.invoke(CANALES.SISTEMA_RESTABLECER),
  credencialesEstado: () => ipcRenderer.invoke(CANALES.CREDENCIALES_ESTADO),
  credencialesGuardar: (usuario, clave) =>
    ipcRenderer.invoke(CANALES.CREDENCIALES_GUARDAR, { usuario, clave }),
  credencialesBorrar: () => ipcRenderer.invoke(CANALES.CREDENCIALES_BORRAR),
  onProgreso: (callback) => {
    const listener = (_evento, datos) => callback(datos);
    ipcRenderer.on(CANALES.PROGRESO, listener);
    return () => ipcRenderer.removeListener(CANALES.PROGRESO, listener);
  },
});
