'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { sectorDesdeNpn } = require('./ExportService');

/** Normaliza un encabezado para localizar columnas por nombre. */
function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/**
 * Cruza la bandeja sincronizada contra la bitácora Excel del usuario
 * (hoja DP TRAMITES) y agrega ÚNICAMENTE los trámites que no existen,
 * insertándolos en la misma posición relativa que ocupan en la bandeja.
 *
 * Reglas de seguridad con el archivo del usuario:
 *  - NUNCA modifica ni elimina filas existentes (las observaciones y
 *    prioridades del usuario son intocables).
 *  - Antes de guardar se crea una copia de respaldo con fecha y hora.
 *  - Si el archivo está abierto en Excel, se informa con un mensaje claro.
 */
class BitacoraService {
  /**
   * @param {import('../database/repositories/TramiteRepository').TramiteRepository} tramiteRepository
   * @param {object} config
   * @param {import('../utils/logger').Logger} logger
   */
  constructor(tramiteRepository, config, logger) {
    this.tramites = tramiteRepository;
    this.config = config;
    this.logger = logger;
  }

  get habilitada() {
    return Boolean(this.config.bitacora && this.config.bitacora.xlsxPath);
  }

  /**
   * @returns {Promise<{agregados: string[], mensaje: string, ruta: string}>}
   */
  async actualizar() {
    if (!this.habilitada) {
      return { agregados: [], mensaje: 'Bitácora no configurada.', ruta: null };
    }

    const ruta = this.config.bitacora.xlsxPath;
    const nombreHoja = this.config.bitacora.hoja || 'DP TRAMITES';

    if (!fs.existsSync(ruta)) {
      throw new Error(`No se encontró la bitácora: ${ruta}`);
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(ruta);

    const hoja = workbook.worksheets.find((w) => normalizar(w.name) === normalizar(nombreHoja));
    if (!hoja) {
      throw new Error(
        `La bitácora no tiene la hoja "${nombreHoja}". Hojas disponibles: ` +
        workbook.worksheets.map((w) => w.name).join(', ')
      );
    }

    const columnas = this._mapearColumnas(hoja);
    const filaPorRadicado = this._indexarRadicados(hoja, columnas.RADICADO);

    const enBandeja = this.tramites.listarBandejaOrdenada();
    const agregados = [];
    let ancla = 1; // fila de encabezados; el primer insert cae en la fila 2

    for (const tramite of enBandeja) {
      const filaExistente = filaPorRadicado.get(tramite.numero_tramite);
      if (filaExistente) {
        ancla = filaExistente;
        continue;
      }

      const posicion = ancla + 1;
      hoja.insertRow(posicion, [], 'i'); // hereda el estilo de la fila superior

      const fila = hoja.getRow(posicion);
      let extra = {};
      try {
        extra = tramite.datos_extra ? JSON.parse(tramite.datos_extra) : {};
      } catch {
        // datos_extra ilegible: se inserta el trámite sin sector.
      }

      fila.getCell(columnas.RADICADO).value = tramite.numero_tramite;
      if (columnas.TRAMITE) fila.getCell(columnas.TRAMITE).value = tramite.tipo ?? '';
      if (columnas.SECTOR) fila.getCell(columnas.SECTOR).value = sectorDesdeNpn(extra.npn);
      // OBSERVACION y PRIORIDAD quedan vacías: son criterio del usuario.

      for (const [rad, numFila] of filaPorRadicado) {
        if (numFila >= posicion) filaPorRadicado.set(rad, numFila + 1);
      }
      filaPorRadicado.set(tramite.numero_tramite, posicion);
      ancla = posicion;
      agregados.push(tramite.numero_tramite);
    }

    // Columna EN BANDEJA: el robot la mantiene con SI/NO para cada radicado
    // que conoce. Cuando un trámite sale de la bandeja (p. ej. ya fue
    // enviado), su fila queda en NO sin tocar nada más de la fila.
    const salieron = this._actualizarColumnaEnBandeja(hoja, columnas, filaPorRadicado);

    const hayCambios = agregados.length > 0 || salieron.huboEscrituras;
    if (hayCambios) {
      this._respaldar(ruta);
      try {
        await workbook.xlsx.writeFile(ruta);
      } catch (error) {
        if (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES') {
          throw new Error(
            'No se pudo guardar la bitácora: el archivo está abierto en Excel. ' +
            'Ciérrelo y vuelva a sincronizar.'
          );
        }
        throw error;
      }
      this.logger.info(
        `Bitácora actualizada: ${agregados.length} nuevo(s), ${salieron.radicados.length} salieron de bandeja`,
        { agregados, salieron: salieron.radicados }
      );
    }

    const partes = [];
    partes.push(
      agregados.length === 0
        ? 'No hay trámites asignados recientemente.'
        : `Se agregaron ${agregados.length} trámite(s) nuevo(s) a la bitácora: ${agregados.join(', ')}.`
    );
    if (salieron.radicados.length > 0) {
      partes.push(
        `Salieron de la bandeja (EN BANDEJA = NO): ${salieron.radicados.join(', ')}.`
      );
    }

    return { agregados, salieron: salieron.radicados, mensaje: partes.join(' '), ruta };
  }

  /**
   * Mantiene la columna EN BANDEJA (SI/NO) para los radicados que el robot
   * conoce. Las filas con radicados que nunca han pasado por la bandeja
   * sincronizada (años anteriores) se dejan intactas.
   *
   * @returns {{huboEscrituras: boolean, radicados: string[]}} radicados que pasaron de SI a NO
   */
  _actualizarColumnaEnBandeja(hoja, columnas, filaPorRadicado) {
    let colEnBandeja = columnas['EN BANDEJA'];
    if (!colEnBandeja) {
      // Se crea al final de los encabezados existentes.
      colEnBandeja = hoja.getRow(1).cellCount + 1;
      const celda = hoja.getRow(1).getCell(colEnBandeja);
      celda.value = 'EN BANDEJA';
      celda.font = { name: 'Arial', bold: true };
    }

    const conocidos = new Map(
      this.tramites.listar({ limite: 100000 }).map((t) => [t.numero_tramite, t])
    );

    let huboEscrituras = false;
    const pasaronANo = [];

    for (const [radicado, numFila] of filaPorRadicado) {
      const tramite = conocidos.get(radicado);
      if (!tramite) continue;

      const valorNuevo = tramite.presente_en_bandeja ? 'SI' : 'NO';
      const celda = hoja.getRow(numFila).getCell(colEnBandeja);
      const valorActual = String(celda.value ?? '').trim().toUpperCase();

      if (valorActual !== valorNuevo) {
        if (valorActual === 'SI' && valorNuevo === 'NO') {
          pasaronANo.push(radicado);
        }
        celda.value = valorNuevo;
        // Colores clásicos de Excel, solo en ESTA celda: verde = en bandeja,
        // rojo = ya salió (probablemente tramitado).
        if (valorNuevo === 'SI') {
          celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } };
          celda.font = { name: 'Arial', color: { argb: 'FF006100' }, bold: true };
        } else {
          celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
          celda.font = { name: 'Arial', color: { argb: 'FF9C0006' }, bold: true };
        }
        celda.alignment = { horizontal: 'center' };
        huboEscrituras = true;
      }
    }

    return { huboEscrituras, radicados: pasaronANo };
  }

  /** Localiza las columnas por su encabezado en la fila 1. */
  _mapearColumnas(hoja) {
    const columnas = {};
    hoja.getRow(1).eachCell({ includeEmpty: false }, (celda, numColumna) => {
      const nombre = normalizar(celda.value);
      if (nombre) columnas[nombre] = numColumna;
    });

    if (!columnas.RADICADO) {
      throw new Error(
        `La hoja "${hoja.name}" no tiene la columna RADICADO en la fila 1. ` +
        `Encabezados encontrados: ${Object.keys(columnas).join(', ') || 'ninguno'}.`
      );
    }
    return columnas;
  }

  /** Mapa radicado -> número de fila, de las filas existentes. */
  _indexarRadicados(hoja, columnaRadicado) {
    const mapa = new Map();
    for (let numFila = 2; numFila <= hoja.rowCount; numFila++) {
      const valor = hoja.getRow(numFila).getCell(columnaRadicado).text;
      const radicado = String(valor || '').trim();
      if (radicado && !mapa.has(radicado)) {
        mapa.set(radicado, numFila);
      }
    }
    return mapa;
  }

  /** Copia de seguridad con fecha/hora antes de escribir. */
  _respaldar(ruta) {
    try {
      const dir = this.config.bitacora.backupsDir;
      fs.mkdirSync(dir, { recursive: true });
      const marca = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const destino = path.join(dir, `BITACORA-respaldo-${marca}.xlsx`);
      fs.copyFileSync(ruta, destino);
      this.logger.info(`Respaldo de la bitácora creado: ${destino}`);
    } catch (error) {
      // Sin respaldo NO se escribe: proteger el archivo del usuario es prioridad.
      throw new Error(`No se pudo crear el respaldo de la bitácora: ${error.message}`);
    }
  }
}

module.exports = { BitacoraService };
