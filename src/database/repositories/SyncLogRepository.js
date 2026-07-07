'use strict';

/**
 * Acceso a datos de la tabla `sync_logs`.
 * Cada sincronización crea un registro al inicio y lo cierra al terminar,
 * de modo que un cierre abrupto de la app queda visible como 'en_curso'.
 */
class SyncLogRepository {
  /** @param {import('../Database').Database} database */
  constructor(database) {
    this.db = database.conexion;
  }

  /** @returns {number} id del registro de log creado */
  iniciar() {
    const resultado = this.db
      .prepare("INSERT INTO sync_logs (fecha_inicio) VALUES (datetime('now', 'localtime'))")
      .run();
    return resultado.lastInsertRowid;
  }

  /**
   * @param {number} id
   * @param {{duracionMs: number, leidos: number, nuevos: number, actualizados: number,
   *          sinCambios: number, errores: Array<object>, estado: 'exitoso'|'parcial'|'fallido'}} resumen
   */
  finalizar(id, resumen) {
    this.db
      .prepare(`
        UPDATE sync_logs
        SET fecha_fin = datetime('now', 'localtime'),
            duracion_ms = @duracionMs,
            registros_leidos = @leidos,
            registros_nuevos = @nuevos,
            registros_actualizados = @actualizados,
            registros_sin_cambios = @sinCambios,
            errores = @errores,
            estado = @estado
        WHERE id = @id
      `)
      .run({
        id,
        duracionMs: resumen.duracionMs,
        leidos: resumen.leidos,
        nuevos: resumen.nuevos,
        actualizados: resumen.actualizados,
        sinCambios: resumen.sinCambios,
        errores: resumen.errores.length > 0 ? JSON.stringify(resumen.errores) : null,
        estado: resumen.estado,
      });
  }

  listar({ limite = 20 } = {}) {
    return this.db
      .prepare('SELECT * FROM sync_logs ORDER BY id DESC LIMIT ?')
      .all(limite);
  }
}

module.exports = { SyncLogRepository };
