'use strict';

const path = require('path');
const ExcelJS = require('exceljs');

/**
 * Deriva el sector catastral desde el NPN (número predial nacional),
 * replicando la convención de la bitácora del usuario:
 *   01-06-00-... -> zona urbana, sector "6"
 *   02-00-00-... -> zona rural, sector "R"
 *   00-01-00-... -> zona informal, sector "R"
 */
function sectorDesdeNpn(npn) {
  if (!npn) return '';
  const segmentos = String(npn).split('-');
  if (segmentos.length < 2) return '';
  if (segmentos[0] !== '01') return 'R';
  const numero = parseInt(segmentos[1], 10);
  return Number.isFinite(numero) && numero > 0 ? String(numero) : '';
}

/** Columnas de la hoja de detalle. */
const COLUMNAS_FIJAS = [
  ['numero_tramite', 'RADICADO'],
  ['tipo', 'TRAMITE'],
  ['estado', 'ESTADO'],
  ['fecha', 'FECHA ASIGNACION'],
  ['solicitante', 'SOLICITANTE'],
];

const COLUMNAS_CONTROL = [
  ['estado_anterior', 'ESTADO ANTERIOR'],
  ['fecha_cambio_estado', 'FECHA CAMBIO ESTADO'],
  ['presente_en_bandeja', 'EN BANDEJA'],
  ['ultima_vez_visto', 'ULTIMA VEZ VISTO'],
  ['actualizado_en', 'ACTUALIZADO'],
];

const AZUL = 'FF1A5FB4';

/**
 * Exporta los trámites sincronizados a un .xlsx con dos hojas:
 *
 *  - "DP TRAMITES": el formato de la bitácora del usuario
 *    (RADICADO | TRAMITE | SECTOR | OBSERVACION | PRIORIDAD), solo con los
 *    trámites presentes en la bandeja. OBSERVACION y PRIORIDAD quedan
 *    vacías: son el criterio jurídico del usuario, no datos del sistema.
 *  - "DETALLE": todos los trámites con todos los campos, para consulta.
 *
 * Siempre escribe un archivo propio: nunca toca la bitácora manual.
 */
class ExportService {
  /**
   * @param {import('../database/repositories/TramiteRepository').TramiteRepository} tramiteRepository
   * @param {object} config
   * @param {import('../utils/logger').Logger} logger
   */
  constructor(tramiteRepository, config, logger, gestionRepository = null) {
    this.tramites = tramiteRepository;
    this.config = config;
    this.logger = logger;
    this.gestion = gestionRepository;
  }

  /**
   * Excel de trámites que requieren VISITA (en bandeja), con el formato que
   * el ejecutor lleva a campo: RADICADO | TIPO DE TRAMITE | SECTOR | OBSERVACION.
   * @returns {Promise<string>} Ruta del archivo generado
   */
  async exportarVisitas() {
    if (!this.gestion) throw new Error('Repositorio de gestión no disponible.');
    const visitas = this.gestion.listarVisitas();

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Gestor de Trámites Catastrales';
    const hoja = workbook.addWorksheet('VISITAS');
    this._encabezado(hoja, ['RADICADO', 'TIPO DE TRAMITE', 'SECTOR', 'OBSERVACION']);

    for (const v of visitas) {
      let extra = {};
      try { extra = v.datos_extra ? JSON.parse(v.datos_extra) : {}; } catch { /* ignorar */ }
      const fila = hoja.addRow([
        v.numero_tramite,
        v.tipo ?? '',
        v.sector || sectorDesdeNpn(extra.npn),
        v.observacion ?? '',
      ]);
      fila.font = { name: 'Arial' };
    }

    this._ajustarAnchos(hoja);
    const ruta = path.join(path.dirname(path.resolve(this.config.app.exportXlsxPath)), 'Visitas.xlsx');
    await workbook.xlsx.writeFile(ruta);
    this.logger.info(`Excel de visitas exportado: ${ruta} (${visitas.length} trámites)`);
    return ruta;
  }

  /** @returns {Promise<string>} Ruta absoluta del archivo generado */
  async exportar() {
    const tramites = this.tramites.listar({ limite: 100000 });
    const extrasPorTramite = new Map();
    const clavesExtra = new Set();

    for (const t of tramites) {
      if (!t.datos_extra) continue;
      try {
        const extra = JSON.parse(t.datos_extra);
        extrasPorTramite.set(t.id, extra);
        Object.keys(extra).forEach((k) => clavesExtra.add(k));
      } catch {
        // datos_extra corrupto: se ignora, el resto del trámite se exporta.
      }
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Sincronizador de Bandeja';

    this._hojaBitacora(workbook, tramites, extrasPorTramite);
    this._hojaDetalle(workbook, tramites, extrasPorTramite, [...clavesExtra].sort());

    const ruta = path.resolve(this.config.app.exportXlsxPath);
    await workbook.xlsx.writeFile(ruta);
    this.logger.info(`Excel exportado: ${ruta} (${tramites.length} trámites)`);
    return ruta;
  }

  /** Hoja principal con el formato de la bitácora DP TRAMITES. */
  _hojaBitacora(workbook, tramites, extrasPorTramite) {
    const hoja = workbook.addWorksheet('DP TRAMITES');
    this._encabezado(hoja, ['RADICADO', 'TRAMITE', 'SECTOR', 'OBSERVACION', 'PRIORIDAD']);

    const enBandeja = tramites.filter((t) => t.presente_en_bandeja);
    for (const t of enBandeja) {
      const extra = extrasPorTramite.get(t.id) || {};
      const fila = hoja.addRow([
        t.numero_tramite,
        t.tipo ?? '',
        sectorDesdeNpn(extra.npn),
        '', // observación: la escribe el usuario tras su estudio jurídico
        '', // prioridad: criterio del usuario
      ]);
      fila.font = { name: 'Arial' };
    }

    this._ajustarAnchos(hoja);
  }

  /** Hoja de consulta con todos los campos sincronizados. */
  _hojaDetalle(workbook, tramites, extrasPorTramite, columnasExtra) {
    const hoja = workbook.addWorksheet('DETALLE');
    this._encabezado(hoja, [
      ...COLUMNAS_FIJAS.map(([, etiqueta]) => etiqueta),
      'SECTOR',
      ...columnasExtra.map((k) => k.replace(/_/g, ' ').toUpperCase()),
      ...COLUMNAS_CONTROL.map(([, etiqueta]) => etiqueta),
    ]);

    for (const t of tramites) {
      const extra = extrasPorTramite.get(t.id) || {};
      const fila = hoja.addRow([
        ...COLUMNAS_FIJAS.map(([campo]) => t[campo] ?? ''),
        sectorDesdeNpn(extra.npn),
        ...columnasExtra.map((k) => extra[k] ?? ''),
        t.estado_anterior ?? '',
        t.fecha_cambio_estado ?? '',
        t.presente_en_bandeja ? 'SI' : 'NO',
        t.ultima_vez_visto ?? '',
        t.actualizado_en ?? '',
      ]);
      fila.font = { name: 'Arial' };
    }

    this._ajustarAnchos(hoja);
  }

  _encabezado(hoja, etiquetas) {
    const fila = hoja.addRow(etiquetas);
    fila.font = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' } };
    fila.eachCell((celda) => {
      celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL } };
      celda.alignment = { horizontal: 'center' };
    });
    hoja.views = [{ state: 'frozen', ySplit: 1 }];
    hoja.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: etiquetas.length } };
  }

  _ajustarAnchos(hoja) {
    hoja.columns.forEach((columna) => {
      let ancho = 12;
      columna.eachCell({ includeEmpty: false }, (celda) => {
        ancho = Math.max(ancho, String(celda.value ?? '').length + 2);
      });
      columna.width = Math.min(ancho, 55);
    });
  }
}

module.exports = { ExportService, sectorDesdeNpn };
