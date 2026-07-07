'use strict';

/** Campos principales que se comparan uno a uno al sincronizar. */
const CAMPOS_SINCRONIZABLES = ['tipo', 'estado', 'fecha', 'solicitante', 'datos_extra'];

/**
 * Acceso a datos de la tabla `tramites` y su historial.
 * Toda la lógica SQL vive aquí; los servicios nunca escriben SQL directamente.
 */
class TramiteRepository {
  /** @param {import('../Database').Database} database */
  constructor(database) {
    this.db = database.conexion;
    this.database = database;

    this.stmtBuscarPorNumero = this.db.prepare(
      'SELECT * FROM tramites WHERE numero_tramite = ?'
    );

    this.stmtInsertar = this.db.prepare(`
      INSERT INTO tramites (numero_tramite, tipo, estado, fecha, solicitante, datos_extra, orden_bandeja, origen, presente_en_bandeja)
      VALUES (@numero_tramite, @tipo, @estado, @fecha, @solicitante, @datos_extra, @orden_bandeja, @origen, @presente_en_bandeja)
    `);

    this.stmtTocarVisto = this.db.prepare(`
      UPDATE tramites
      SET ultima_vez_visto = datetime('now', 'localtime'),
          presente_en_bandeja = 1,
          orden_bandeja = @orden_bandeja
      WHERE id = @id
    `);

    this.stmtInsertarHistorial = this.db.prepare(`
      INSERT INTO tramites_historial (tramite_id, campo, valor_anterior, valor_nuevo)
      VALUES (?, ?, ?, ?)
    `);

    this.stmtSeleccionarAusentes = this.db.prepare(`
      SELECT id FROM tramites
      WHERE presente_en_bandeja = 1
        AND numero_tramite NOT IN (SELECT value FROM json_each(?))
    `);

    this.stmtMarcarAusentes = this.db.prepare(`
      UPDATE tramites
      SET presente_en_bandeja = 0,
          actualizado_en = datetime('now', 'localtime')
      WHERE id IN (SELECT value FROM json_each(?))
    `);
  }

  /** @returns {object|undefined} */
  buscarPorNumero(numeroTramite) {
    return this.stmtBuscarPorNumero.get(numeroTramite);
  }

  /**
   * Inserta un trámite nuevo.
   * @param {{numero_tramite: string, tipo?: string, estado?: string, fecha?: string, solicitante?: string, datos_extra?: string}} tramite
   * @param {number} [ordenBandeja] Posición del trámite en la bandeja web
   */
  insertar(tramite, ordenBandeja = null, { origen = 'bandeja', presenteEnBandeja = 1 } = {}) {
    const resultado = this.stmtInsertar.run({
      numero_tramite: tramite.numero_tramite,
      tipo: tramite.tipo ?? null,
      estado: tramite.estado ?? null,
      fecha: tramite.fecha ?? null,
      solicitante: tramite.solicitante ?? null,
      datos_extra: tramite.datos_extra ?? null,
      orden_bandeja: ordenBandeja,
      origen,
      presente_en_bandeja: presenteEnBandeja,
    });
    return resultado.lastInsertRowid;
  }

  /**
   * Actualiza ÚNICAMENTE los campos que cambiaron y deja rastro en el historial.
   * Si cambia el estado, guarda estado_anterior y fecha_cambio_estado.
   *
   * @param {object} existente Fila actual de la BD
   * @param {object} nuevo Datos extraídos de la web
   * @param {number} [ordenBandeja] Posición actual del trámite en la bandeja
   * @returns {string[]} Lista de campos modificados (vacía si no hubo cambios)
   */
  actualizarSiCambio(existente, nuevo, ordenBandeja = null) {
    const cambios = [];

    for (const campo of CAMPOS_SINCRONIZABLES) {
      const valorNuevo = nuevo[campo] ?? null;
      const valorActual = existente[campo] ?? null;
      if (valorNuevo !== valorActual) {
        cambios.push(campo);
      }
    }

    if (cambios.length === 0) {
      // El orden en bandeja se refresca siempre pero no cuenta como cambio.
      this.stmtTocarVisto.run({ id: existente.id, orden_bandeja: ordenBandeja });
      return [];
    }

    const sets = cambios.map((campo) => `${campo} = @${campo}`);
    if (cambios.includes('estado')) {
      sets.push('estado_anterior = @estado_anterior');
      sets.push("fecha_cambio_estado = datetime('now', 'localtime')");
    }
    sets.push("actualizado_en = datetime('now', 'localtime')");
    sets.push("ultima_vez_visto = datetime('now', 'localtime')");
    sets.push('presente_en_bandeja = 1');
    sets.push('orden_bandeja = @orden_bandeja');

    const parametros = {
      id: existente.id,
      estado_anterior: existente.estado ?? null,
      orden_bandeja: ordenBandeja,
    };
    for (const campo of cambios) {
      parametros[campo] = nuevo[campo] ?? null;
    }

    this.db.prepare(`UPDATE tramites SET ${sets.join(', ')} WHERE id = @id`).run(parametros);

    for (const campo of cambios) {
      this.stmtInsertarHistorial.run(
        existente.id,
        campo,
        existente[campo] ?? null,
        nuevo[campo] ?? null
      );
    }

    return cambios;
  }

  /**
   * Marca como ausentes (presente_en_bandeja = 0) los trámites que ya no
   * aparecen en la bandeja. Nunca elimina registros.
   * @param {string[]} numerosVistos Números de trámite presentes en esta sincronización
   * @returns {number[]} ids de los trámites que acaban de salir de la bandeja
   */
  marcarAusentes(numerosVistos) {
    if (numerosVistos.length === 0) return [];
    const vistosJson = JSON.stringify(numerosVistos);
    const ids = this.stmtSeleccionarAusentes.all(vistosJson).map((f) => f.id);
    if (ids.length > 0) {
      this.stmtMarcarAusentes.run(JSON.stringify(ids));
    }
    return ids;
  }

  /** Listado para la UI, más recientes primero. */
  listar({ limite = 500 } = {}) {
    return this.db
      .prepare('SELECT * FROM tramites ORDER BY actualizado_en DESC LIMIT ?')
      .all(limite);
  }

  /** Trámites actualmente en la bandeja, en el mismo orden de la bandeja web. */
  listarBandejaOrdenada() {
    return this.db
      .prepare('SELECT * FROM tramites WHERE presente_en_bandeja = 1 ORDER BY orden_bandeja ASC')
      .all();
  }

  historial(tramiteId) {
    return this.db
      .prepare('SELECT * FROM tramites_historial WHERE tramite_id = ? ORDER BY fecha DESC')
      .all(tramiteId);
  }
}

module.exports = { TramiteRepository, CAMPOS_SINCRONIZABLES };
