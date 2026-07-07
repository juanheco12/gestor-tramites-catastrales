'use strict';

const fs = require('fs');
const path = require('path');
const BetterSqlite3 = require('better-sqlite3');
const { normalizarFecha } = require('../utils/fechas');

/**
 * Conexión única a SQLite (better-sqlite3, síncrono: ideal para el proceso
 * main de Electron). Aplica el esquema al abrir y habilita WAL para permitir
 * lecturas concurrentes desde la UI mientras corre la sincronización.
 */
class Database {
  /** @param {string} dbPath Ruta absoluta al archivo .db */
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    this.db = new BetterSqlite3(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    this.db.exec(schema);
    this._migrar();
  }

  /** Migraciones para bases creadas con esquemas anteriores. */
  _migrar() {
    const columnas = this.db.prepare('PRAGMA table_info(tramites)').all().map((c) => c.name);
    if (!columnas.includes('orden_bandeja')) {
      this.db.exec('ALTER TABLE tramites ADD COLUMN orden_bandeja INTEGER');
    }
    if (!columnas.includes('origen')) {
      this.db.exec("ALTER TABLE tramites ADD COLUMN origen TEXT NOT NULL DEFAULT 'bandeja'");
    }
    const columnasGestion = this.db.prepare('PRAGMA table_info(tramites_gestion)').all().map((c) => c.name);
    if (!columnasGestion.includes('estado_seguimiento')) {
      this.db.exec('ALTER TABLE tramites_gestion ADD COLUMN estado_seguimiento TEXT');
    }
    // Todo trámite debe tener su fila de gestión (campos propios del usuario).
    this.db.exec(`
      INSERT OR IGNORE INTO tramites_gestion (tramite_id)
      SELECT id FROM tramites
    `);

    // Migraciones de datos, UNA sola vez por archivo (PRAGMA user_version
    // vive en el propio .db y sobrevive a reinstalaciones del programa).
    const version = this.db.pragma('user_version', { simple: true });

    if (version < 1) {
      // La v1.5.0 tenía un bug que ponía fecha_realizacion sola al pasar un
      // trámite a "Estudiado", lo que lo hacía aparecer en Histórico sin
      // que el usuario lo hubiera registrado a mano. Se retira esa fecha
      // SOLO de trámites que siguen activos en bandeja, sincronizados
      // (nunca importados ni agregados a mano) y en estado no terminal:
      // el historial real (enviado/devuelto/finalizado, importado o
      // agregado a mano) nunca se toca.
      const limpieza = this.db
        .prepare(`
          UPDATE tramites_gestion
          SET fecha_realizacion = NULL
          WHERE fecha_envio IS NULL
            AND mi_estado NOT IN ('enviado', 'finalizado', 'devuelto')
            AND tramite_id IN (
              SELECT id FROM tramites WHERE origen = 'bandeja' AND presente_en_bandeja = 1
            )
        `)
        .run();
      if (limpieza.changes > 0) {
        console.log(`[migración] Se limpiaron ${limpieza.changes} fecha(s) de realización puestas de más por el bug de la v1.5.0.`);
      }
      this.db.pragma('user_version = 1');
    }

    if (version < 2) {
      // Bitácoras escritas a mano traen typos frecuentes en las fechas
      // ("14/082025" en vez de "14/08/2025", falta una barra). Guardadas
      // como texto, esas fechas NO se ordenan bien alfabéticamente junto a
      // las que sí están en ISO. Se reparan las que se puedan interpretar
      // con seguridad; el resto se deja igual (mejor no tocar que adivinar mal).
      const filas = this.db
        .prepare(`
          SELECT tramite_id, fecha_realizacion, fecha_envio FROM tramites_gestion
          WHERE (fecha_realizacion IS NOT NULL AND fecha_realizacion NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
             OR (fecha_envio IS NOT NULL AND fecha_envio NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
        `)
        .all();

      if (filas.length > 0) {
        const actualizar = this.db.prepare(
          'UPDATE tramites_gestion SET fecha_realizacion = ?, fecha_envio = ? WHERE tramite_id = ?'
        );
        let reparadas = 0;
        const aplicar = this.db.transaction(() => {
          for (const fila of filas) {
            const nuevaRealizacion = normalizarFecha(fila.fecha_realizacion);
            const nuevoEnvio = normalizarFecha(fila.fecha_envio);
            if (nuevaRealizacion !== fila.fecha_realizacion || nuevoEnvio !== fila.fecha_envio) {
              actualizar.run(nuevaRealizacion, nuevoEnvio, fila.tramite_id);
              reparadas++;
            }
          }
        });
        aplicar();
        if (reparadas > 0) {
          console.log(`[migración] Se corrigió el formato de ${reparadas} fecha(s) mal escritas (faltaba una barra) para que Histórico ordene bien.`);
        }
      }
      this.db.pragma('user_version = 2');
    }
  }

  get conexion() {
    return this.db;
  }

  /**
   * Ejecuta una función dentro de una transacción. Si lanza, se hace rollback.
   * @param {(...args: any[]) => T} fn
   * @returns {(...args: any[]) => T}
   * @template T
   */
  transaccion(fn) {
    return this.db.transaction(fn);
  }

  cerrar() {
    if (this.db && this.db.open) {
      this.db.close();
    }
  }
}

let instancia = null;

/** @param {string} dbPath */
function obtenerDatabase(dbPath) {
  if (!instancia) {
    instancia = new Database(dbPath);
  }
  return instancia;
}

module.exports = { Database, obtenerDatabase };
