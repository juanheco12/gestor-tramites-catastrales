-- Esquema del Sincronizador de Bandeja.
-- Regla de negocio: NUNCA se eliminan registros. Los trámites que desaparecen
-- de la bandeja se marcan con presente_en_bandeja = 0.

CREATE TABLE IF NOT EXISTS tramites (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    numero_tramite       TEXT    NOT NULL UNIQUE,
    tipo                 TEXT,
    estado               TEXT,
    fecha                TEXT,
    solicitante          TEXT,
    datos_extra          TEXT,   -- JSON con columnas adicionales de la tabla web
    estado_anterior      TEXT,
    fecha_cambio_estado  TEXT,
    presente_en_bandeja  INTEGER NOT NULL DEFAULT 1,
    orden_bandeja        INTEGER,
    origen               TEXT    NOT NULL DEFAULT 'bandeja',  -- bandeja | importado
    creado_en            TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    actualizado_en       TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    ultima_vez_visto     TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_tramites_estado ON tramites (estado);
CREATE INDEX IF NOT EXISTS idx_tramites_presente ON tramites (presente_en_bandeja);

-- Auditoría de cambios campo a campo (permite reconstruir la historia completa).
CREATE TABLE IF NOT EXISTS tramites_historial (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    tramite_id     INTEGER NOT NULL REFERENCES tramites (id),
    campo          TEXT    NOT NULL,
    valor_anterior TEXT,
    valor_nuevo    TEXT,
    fecha          TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_historial_tramite ON tramites_historial (tramite_id);

-- Campos de gestión PROPIOS del ejecutor (lo que antes vivía en su Excel).
-- El robot nunca sobreescribe estos campos: son criterio del usuario.
CREATE TABLE IF NOT EXISTS tramites_gestion (
    tramite_id        INTEGER PRIMARY KEY REFERENCES tramites (id),
    mi_estado         TEXT    NOT NULL DEFAULT 'por_estudiar'
                      CHECK (mi_estado IN ('por_estudiar', 'estudiado', 'visita', 'enviado', 'devuelto', 'finalizado')),
    observacion       TEXT,
    prioridad         TEXT,
    sector            TEXT,   -- editable; si es NULL se muestra el derivado del NPN
    fmi               TEXT,
    fecha_realizacion TEXT,
    fecha_envio       TEXT,
    analisis          TEXT,
    estado_seguimiento TEXT,  -- nota libre tipo "EN REVISION" / "EN ESPERA - PARTE GRAFICA" (equivalente a la columna ESTADO de la bitácora anual del usuario)
    actualizado_en    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- Seguimientos de la hoja ESTADO POS TRAMITE (importados tal cual, por categoría).
CREATE TABLE IF NOT EXISTS pos_tramite (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    categoria TEXT,
    radicado  TEXT,
    detalle   TEXT
);

-- Registro de cada ejecución de sincronización.
CREATE TABLE IF NOT EXISTS sync_logs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha_inicio          TEXT    NOT NULL,
    fecha_fin             TEXT,
    duracion_ms           INTEGER,
    registros_leidos      INTEGER NOT NULL DEFAULT 0,
    registros_nuevos      INTEGER NOT NULL DEFAULT 0,
    registros_actualizados INTEGER NOT NULL DEFAULT 0,
    registros_sin_cambios INTEGER NOT NULL DEFAULT 0,
    errores               TEXT,   -- JSON con la lista de errores encontrados
    estado                TEXT    NOT NULL DEFAULT 'en_curso'
                          CHECK (estado IN ('en_curso', 'exitoso', 'parcial', 'fallido'))
);
