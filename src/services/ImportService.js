'use strict';

const fs = require('fs');
const ExcelJS = require('exceljs');
const { normalizarFecha } = require('../utils/fechas');

/** Normaliza encabezados/valores para comparar sin tildes ni mayúsculas. */
function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/** Convierte una celda de exceljs a texto plano (maneja fechas y fórmulas). */
function textoCelda(celda) {
  const v = celda.value;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.result instanceof Date) return v.result.toISOString().slice(0, 10);
    if (v.result !== undefined) return String(v.result).trim();
    if (v.richText) return v.richText.map((r) => r.text).join('').trim();
    return String(celda.text ?? '').trim();
  }
  return String(v).trim();
}

const PATRON_RADICADO = /^\d{2,4}-\d+/;
// Fecha embebida en un texto libre, p. ej. "EN REVISION 27/02/2024".
// Solo se reconoce con año de 4 dígitos: evita falsos positivos con
// otros números sueltos (folios, medidas, etc.) que no son fechas.
const PATRON_FECHA_EMBEBIDA = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/;

/**
 * Palabras que, dentro de la observación (de cualquier ejecutor, en
 * cualquier idioma de bitácora), indican que el trámite YA se envió a
 * revisión aunque el Excel no tenga una columna "FECHA ENVIO" separada.
 */
const PALABRAS_ENVIADO = ['EJECUTADO', 'TRAMITADO', 'EN REVISION'];
// "Anulado"/"no procede": el radicado se cerró sin llegar a revisión.
const PALABRAS_ANULADO = ['ANULADO', 'NO PROCEDE'];

/**
 * Alias de encabezados: permite importar bitácoras de OTROS ejecutores
 * aunque nombren sus columnas distinto. La comparación ignora tildes,
 * mayúsculas y signos.
 */
const ALIAS_COLUMNAS = {
  radicado: ['RADICADO', 'RADICADOS', 'RAD', 'NO RADICADO', 'NRO RADICADO', 'NUMERO DE RADICADO', 'NUMERO DE TRAMITE', 'NUMERO', 'EXPEDIENTE'],
  tramite: ['TRAMITE', 'MUTACION', 'CLASE', 'TIPO', 'TIPO DE TRAMITE', 'TIPO TRAMITE', 'CLASE DE MUTACION', 'TIPO DE MUTACION'],
  fmi: ['FMI', 'FOLIO', 'MATRICULA', 'FOLIO DE MATRICULA', 'MATRICULA INMOBILIARIA', 'PREDIO'],
  fecha_realizacion: ['FECHA REALIZACION', 'FECHA DE REALIZACION', 'FECHA ELABORACION', 'FECHA DE ELABORACION', 'FECHA'],
  fecha_envio: ['FECHA ENVIO', 'FECHA DE ENVIO', 'ENVIO', 'FECHA REMISION'],
  estado: ['ESTADO', 'ESTATUS', 'SITUACION', 'ESTADO TRAMITE'],
  observacion: ['OBSERVACION', 'OBSERVACIONES', 'NOTA', 'NOTAS', 'COMENTARIO', 'COMENTARIOS'],
  // Columna adicional de detalle libre que algunos ejecutores usan aparte
  // de OBSERVACION (p. ej. "PROCESO"): se fusiona con la observación en
  // vez de perderse, porque ahí suelen ir pistas como "VISITADO" o la
  // fecha de envío a revisión.
  proceso: ['PROCESO', 'DETALLE', 'SEGUIMIENTO'],
  analisis: ['ANALISIS', 'ANALISIS JURIDICO', 'CONCEPTO', 'ESTUDIO'],
  sector: ['SECTOR', 'ZONA'],
  prioridad: ['PRIORIDAD', 'URGENCIA', 'PRIORITARIO'],
  // Hojas compartidas entre varios ejecutores (p. ej. "Predios a
  // Visitar" de toda la oficina): si esta columna tiene más de un
  // nombre distinto, la hoja no se relaciona a un solo usuario.
  ejecutor: ['EJECUTOR', 'RESPONSABLE', 'FUNCIONARIO', 'ASIGNADO A'],
};

/** Año de 4 dígitos detectado en el nombre de la hoja (p. ej. "RADICADOS 2026" -> "2026"). */
function extraerAnioDeNombreHoja(nombreHoja) {
  const m = String(nombreHoja || '').match(/(20\d{2})/);
  return m ? m[1] : null;
}

/**
 * Algunos ejecutores radican solo con el número ("420", "137") sin el
 * prefijo de año que sí usa la bitácora de Juan ("2026-137"). Se le
 * antepone el año de la hoja para que el radicado quede único en todo
 * el sistema y comparable entre años.
 */
function normalizarRadicado(valorCrudo, anioHoja) {
  const texto = String(valorCrudo || '').trim();
  if (!texto) return '';
  if (PATRON_RADICADO.test(texto)) return texto;
  if (/^\d+$/.test(texto) && anioHoja) return `${anioHoja}-${texto}`;
  return texto;
}

/** Busca una fecha DD/MM/AAAA (con / o -) dentro de un texto libre. */
function extraerFechaEmbebida(texto) {
  const m = String(texto || '').match(PATRON_FECHA_EMBEBIDA);
  if (!m) return '';
  return normalizarFecha(`${m[1]}/${m[2]}/${m[3]}`);
}

/** ¿El texto contiene alguna de las palabras clave (ignorando tildes/mayúsculas)? */
function contieneAlguna(texto, palabras) {
  const t = normalizar(texto);
  return palabras.some((p) => t.includes(p));
}

/**
 * Importa una bitácora Excel a la base de datos. Funciona con la bitácora
 * del usuario Y con las de otros ejecutores: detecta las columnas por sus
 * encabezados (con alias) en cada hoja, en vez de exigir un formato fijo.
 *
 *  - Cualquier hoja con una columna de radicado se importa.
 *  - Las hojas cuyo nombre contiene POS se tratan como seguimientos.
 *  - El estado propio se deduce: ESTADO=TRAMITADA => finalizado;
 *    prioridad VISITA => visita; con fecha de envío => enviado;
 *    con observación => estudiado.
 *  - NUNCA sobreescribe campos de gestión que ya tengan valor: reimportar
 *    es seguro y no pisa ediciones del usuario.
 */
class ImportService {
  /**
   * @param {import('../database/Database').Database} database
   * @param {import('../database/repositories/TramiteRepository').TramiteRepository} tramiteRepository
   * @param {import('../database/repositories/GestionRepository').GestionRepository} gestionRepository
   * @param {object} config
   * @param {import('../utils/logger').Logger} logger
   */
  constructor(database, tramiteRepository, gestionRepository, config, logger) {
    this.database = database;
    this.tramites = tramiteRepository;
    this.gestion = gestionRepository;
    this.config = config;
    this.logger = logger;
  }

  /**
   * @param {string} [ruta] Ruta del Excel; por defecto la bitácora configurada
   * @returns {Promise<object>} Resumen de la importación
   */
  async importar(ruta = null) {
    const archivo = ruta || (this.config.bitacora && this.config.bitacora.xlsxPath);
    if (!archivo || !fs.existsSync(archivo)) {
      throw new Error(`No se encontró el archivo a importar: ${archivo}`);
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(archivo);

    const resumen = { archivo, hojas: {}, tramitesCreados: 0, gestionesCompletadas: 0, seguimientos: 0 };

    const aplicar = this.database.transaccion(() => {
      for (const hoja of workbook.worksheets) {
        const nombre = normalizar(hoja.name);
        if (nombre.includes('POS')) {
          resumen.hojas[hoja.name] = this._importarPosTramite(hoja, resumen);
        } else {
          resumen.hojas[hoja.name] = this._importarHojaGenerica(hoja, resumen);
        }
      }
    });
    aplicar();

    this.logger.info('Importación de bitácora completada', resumen);
    return resumen;
  }

/**
   * Detecta la fila de encabezados y sus columnas usando los alias. No
   * todos los ejecutores ponen los títulos en la fila 1 (algunos usan la
   * fila 1 para un título general y los encabezados reales quedan en la
   * fila 2): se prueban las primeras filas y se toma la que más columnas
   * conocidas resuelve, siempre que incluya al menos "radicado".
   * @returns {Object<string, number> & { __filaEncabezado: number }}
   */
  _detectarColumnas(hoja) {
    const maxFilas = Math.min(hoja.rowCount, 5);
    let mejor = null;
    let mejorFila = 1;
    let mejorPuntaje = -1;

    for (let f = 1; f <= maxFilas; f++) {
      const porNombre = {};
      hoja.getRow(f).eachCell({ includeEmpty: false }, (celda, n) => {
        const nombre = normalizar(textoCelda(celda));
        if (nombre && porNombre[nombre] === undefined) porNombre[nombre] = n;
      });

      const columnas = {};
      for (const [campo, alias] of Object.entries(ALIAS_COLUMNAS)) {
        for (const a of alias) {
          if (porNombre[a] !== undefined) {
            columnas[campo] = porNombre[a];
            break;
          }
        }
      }

      if (!columnas.radicado) continue;
      const puntaje = Object.keys(columnas).length;
      if (puntaje > mejorPuntaje) {
        mejorPuntaje = puntaje;
        mejor = columnas;
        mejorFila = f;
      }
    }

    const resultado = mejor || {};
    resultado.__filaEncabezado = mejorFila;
    return resultado;
  }

  /**
   * ¿Esta hoja se comparte entre varios ejecutores (p. ej. "Predios a
   * Visitar" de toda la oficina)? La sola presencia de una columna de
   * "ejecutor/responsable" ya es señal de que la hoja identifica de
   * quién es cada fila (aunque en una copia puntual solo aparezca un
   * nombre): no hay forma confiable de saber cuál es "el usuario actual",
   * así que se omite en vez de arriesgarse a mezclar el trabajo de otro.
   */
  _esHojaCompartida(hoja, col) {
    return Boolean(col.ejecutor);
  }

  /**
   * Deduce el estado propio del ejecutor a partir de los datos de la fila.
   * Orden de prioridad: anulado/no-procede y enviado/tramitado (etapas ya
   * resueltas) primero, luego visita, y por último los valores explícitos
   * de fecha de envío u observación simple que ya traía el sistema.
   */
  _deducirEstado(fila) {
    if (normalizar(fila.estado) === 'TRAMITADA') return 'finalizado';
    if (contieneAlguna(fila.observacion, PALABRAS_ANULADO)) return 'finalizado';
    if (contieneAlguna(fila.observacion, PALABRAS_ENVIADO)) return 'enviado';
    if (/VISITA/i.test(fila.prioridad || '') || /VISITA/i.test(fila.observacion || '')) return 'visita';
    if (fila.fecha_envio) return 'enviado';
    if (fila.observacion) return 'estudiado';
    return null;
  }

  /** Busca el trámite por radicado; si no existe lo crea como importado. */
  _asegurarTramite(radicado, { tipo = null, estado = null, fecha = null } = {}, resumen) {
    const existente = this.tramites.buscarPorNumero(radicado);
    if (existente) return { id: existente.id, creado: false };

    const id = this.tramites.insertar(
      { numero_tramite: radicado, tipo, estado, fecha },
      null,
      { origen: 'importado', presenteEnBandeja: 0 }
    );
    this.gestion.asegurar(id);
    resumen.tramitesCreados++;
    return { id, creado: true };
  }

  /** Llena SOLO los campos de gestión vacíos. */
  _completarGestion(tramiteId, campos, resumen) {
    this.gestion.asegurar(tramiteId);
    const actual = this.database.conexion
      .prepare('SELECT * FROM tramites_gestion WHERE tramite_id = ?')
      .get(tramiteId);

    const pendientes = {};
    for (const [campo, valor] of Object.entries(campos)) {
      if (valor === null || valor === undefined || valor === '') continue;
      const vigente = actual[campo];
      const esEstadoPorDefecto = campo === 'mi_estado' && vigente === 'por_estudiar';
      if (vigente === null || vigente === undefined || vigente === '' || esEstadoPorDefecto) {
        pendientes[campo] = valor;
      }
    }

    if (Object.keys(pendientes).length > 0) {
      this.gestion.actualizar(tramiteId, pendientes);
      resumen.gestionesCompletadas++;
    }
  }

  /**
   * Importa cualquier hoja con columna de radicado (bitácoras anuales,
   * pendientes, o formatos de otros ejecutores).
   */
  _importarHojaGenerica(hoja, resumen) {
    const col = this._detectarColumnas(hoja);
    if (!col.radicado) {
      return { omitida: 'no se encontró una columna de radicado en ninguna de las primeras filas' };
    }
    if (this._esHojaCompartida(hoja, col)) {
      return { omitida: 'hoja compartida entre varios ejecutores (columna de responsable con más de un nombre): no se relaciona automáticamente para no mezclar el trabajo de otros' };
    }

    const anioHoja = extraerAnioDeNombreHoja(hoja.name);
    let filas = 0;
    for (let n = col.__filaEncabezado + 1; n <= hoja.rowCount; n++) {
      const filaHoja = hoja.getRow(n);
      const leer = (campo) => (col[campo] ? textoCelda(filaHoja.getCell(col[campo])) : '');

      const radicado = normalizarRadicado(leer('radicado'), anioHoja);
      if (!PATRON_RADICADO.test(radicado)) continue;

      // Algunos ejecutores no tienen columna OBSERVACION y FECHA de envío
      // separadas: usan una sola celda de detalle libre (p. ej. "PROCESO")
      // donde va todo junto ("EN REVISION 27/02/2024", "VISITADO..."). Se
      // fusiona con la observación para no perder esa información.
      const proceso = leer('proceso');
      const observacionBase = leer('observacion');
      const partesObservacion = [observacionBase];
      if (proceso && proceso.trim() !== observacionBase.trim()) partesObservacion.push(proceso);
      const observacion = partesObservacion.filter(Boolean).join(' / ');

      let fechaRealizacion = normalizarFecha(leer('fecha_realizacion'));
      let fechaEnvio = normalizarFecha(leer('fecha_envio'));
      const enviado = contieneAlguna(observacion, PALABRAS_ENVIADO);
      if (enviado) {
        // La fecha embebida en el texto ("EN REVISION 27/02/2024") es la
        // fecha en que se envió a revisión; si además hay una columna de
        // fecha propia (recepción/realización), esa se conserva aparte.
        const fechaEmbebida = extraerFechaEmbebida(observacion);
        if (!fechaEnvio) fechaEnvio = fechaEmbebida || fechaRealizacion || '';
        if (!fechaRealizacion) fechaRealizacion = fechaEmbebida || fechaEnvio || '';
      }

      const datos = {
        tramite: leer('tramite'),
        fmi: leer('fmi'),
        // Normalizada: la bitácora a mano trae typos frecuentes como
        // "14/082025" (falta una barra); en ISO se ordena bien como texto.
        fecha_realizacion: fechaRealizacion,
        fecha_envio: fechaEnvio,
        estado: leer('estado'),
        observacion,
        analisis: leer('analisis'),
        sector: leer('sector'),
        prioridad: leer('prioridad'),
      };

      const { id } = this._asegurarTramite(
        radicado,
        { tipo: datos.tramite || null, estado: datos.estado || null, fecha: datos.fecha_realizacion || null },
        resumen
      );

      this._completarGestion(
        id,
        {
          fmi: datos.fmi,
          fecha_realizacion: datos.fecha_realizacion,
          fecha_envio: datos.fecha_envio,
          observacion: datos.observacion,
          analisis: datos.analisis,
          sector: datos.sector,
          prioridad: datos.prioridad,
          mi_estado: this._deducirEstado(datos),
          // Se conserva la nota literal que el ejecutor escribía a mano
          // (p. ej. "TRAMITADA", "EN REVISION"), separada del estado
          // interno del sistema.
          estado_seguimiento: datos.estado,
        },
        resumen
      );
      filas++;
    }

    return {
      importadas: filas,
      columnasDetectadas: Object.keys(col).filter((c) => c !== '__filaEncabezado'),
    };
  }

  /**
   * Hojas de seguimiento POS: varias listas paralelas de pares
   * (radicado, detalle) bajo encabezados de categoría. Se reemplaza completa.
   */
  _importarPosTramite(hoja, resumen) {
    const db = this.database.conexion;
    db.prepare('DELETE FROM pos_tramite').run();
    const insertar = db.prepare(
      'INSERT INTO pos_tramite (categoria, radicado, detalle) VALUES (?, ?, ?)'
    );

    const encabezados = {};
    hoja.getRow(1).eachCell({ includeEmpty: false }, (celda, n) => {
      const nombre = textoCelda(celda);
      if (nombre) encabezados[n] = nombre;
    });

    let filas = 0;
    for (let n = 2; n <= hoja.rowCount; n++) {
      const fila = hoja.getRow(n);
      fila.eachCell({ includeEmpty: false }, (celda, c) => {
        const valor = textoCelda(celda);
        if (!PATRON_RADICADO.test(valor)) return;
        const detalle = textoCelda(fila.getCell(c + 1));
        const categoria = encabezados[c] || encabezados[c - 1] || `columna ${c}`;
        insertar.run(categoria, valor, detalle || null);
        filas++;
      });
    }
    resumen.seguimientos = filas;
    return { importadas: filas };
  }
}

module.exports = { ImportService };
