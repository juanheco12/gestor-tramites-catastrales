'use strict';

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { RUTA_RAIZ } = require('../config/config');

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/** Partes del .docx donde puede haber marcadores (cuerpo, encabezado y pie). */
const PARTES = ['word/document.xml', 'word/header1.xml', 'word/footer1.xml'];

/**
 * Genera el acta de visita de un trámite a partir de la plantilla del
 * ejecutor.
 *
 * Se parte del .docx REAL que ya usa la oficina, con sus logos, tipografías,
 * encabezado y pie: solo se reemplazan los marcadores {{...}}. Rearmar el
 * documento desde cero daría un acta parecida pero no idéntica, y esto es un
 * formato institucional que se entrega firmado.
 */
class ActaService {
  /**
   * @param {object} config
   * @param {import('../utils/logger').Logger} logger
   */
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  get rutaPlantilla() {
    const configurada = this.config.acta && this.config.acta.plantilla;
    if (configurada) return path.resolve(configurada);
    return path.join(RUTA_RAIZ, 'plantillas', 'acta-visita.docx');
  }

  /** Carpeta donde quedan las actas generadas (junto a los datos del usuario). */
  get carpetaSalida() {
    return path.join(path.dirname(this.config.app.dbPath), 'actas');
  }

  /**
   * @param {object} tramite Fila de listarConGestion (trámite + gestión)
   * @param {{nombre?: string, telefono?: string, email?: string, direccion?: string}} [interesado]
   *   Datos del interesado leídos de "Consulta de trámite". Los que falten se
   *   dejan en blanco para llenar a mano: es mejor un acta con un dato vacío
   *   que un acta con un dato inventado.
   * @returns {Promise<string>} ruta del archivo generado
   */
  async generar(tramite, interesado = {}) {
    if (!fs.existsSync(this.rutaPlantilla)) {
      throw new Error(
        `No se encontró la plantilla del acta en ${this.rutaPlantilla}. ` +
        'Puede indicar otra en config/app.config.json (acta.plantilla).'
      );
    }

    const valores = this._valores(tramite, interesado);
    const zip = await JSZip.loadAsync(fs.readFileSync(this.rutaPlantilla));

    let reemplazosTotales = 0;
    for (const parte of PARTES) {
      const archivo = zip.file(parte);
      if (!archivo) continue;
      let xml = await archivo.async('string');
      for (const [marcador, valor] of Object.entries(valores)) {
        const antes = xml;
        xml = xml.split(`{{${marcador}}}`).join(this._escapar(valor));
        if (xml !== antes) reemplazosTotales++;
      }
      zip.file(parte, xml);
    }

    if (reemplazosTotales === 0) {
      throw new Error(
        'La plantilla no tiene ningún marcador {{...}}: no se pudo llenar el acta. ' +
        'Revise que sea la plantilla correcta.'
      );
    }

    fs.mkdirSync(this.carpetaSalida, { recursive: true });
    const nombreArchivo = `ACTA ${String(tramite.numero_tramite).replace(/[\\/:*?"<>|]/g, '-')}.docx`;
    const destino = path.join(this.carpetaSalida, nombreArchivo);
    fs.writeFileSync(destino, await zip.generateAsync({ type: 'nodebuffer' }));

    this.logger.info(`Acta de visita generada: ${destino}`);
    return destino;
  }

  /** Qué campos faltaron (para avisarle al usuario que los complete a mano). */
  camposFaltantes(tramite, interesado = {}) {
    const valores = this._valores(tramite, interesado);
    const etiquetas = {
      NOMBRE: 'nombre del interesado',
      TELEFONO: 'teléfono',
      EMAIL: 'e-mail',
      DIRECCION: 'dirección',
      NPN: 'referencia catastral (NPN)',
      TRAMITE: 'tipo de trámite',
    };
    return Object.entries(etiquetas)
      .filter(([clave]) => !valores[clave])
      .map(([, etiqueta]) => etiqueta);
  }

  _valores(tramite, interesado) {
    const hoy = new Date();
    const extra = this._extra(tramite);
    return {
      FECHA: `${String(hoy.getDate()).padStart(2, '0')} de ${MESES[hoy.getMonth()]} de ${hoy.getFullYear()}`,
      RADICADO: String(tramite.numero_tramite || ''),
      NOMBRE: interesado.nombre || tramite.solicitante || '',
      TELEFONO: interesado.telefono || '',
      EMAIL: interesado.email || '',
      DIRECCION: interesado.direccion || '',
      TRAMITE: this._nombreTramite(tramite.tipo),
      NPN: extra.npn || '',
    };
  }

  _extra(tramite) {
    try {
      return tramite.datos_extra ? JSON.parse(tramite.datos_extra) : {};
    } catch {
      return {};
    }
  }

  /**
   * El aplicativo nombra los trámites como
   * "5-Mutación de Quinta-Predios_Nuevos_ Informales"; en el acta va solo la
   * clase ("Mutación de Quinta"), sin el número ni el detalle interno.
   */
  _nombreTramite(tipo) {
    const texto = String(tipo || '').trim();
    if (!texto) return '';
    const partes = texto.split('-').map((p) => p.trim()).filter(Boolean);
    if (partes.length >= 2 && /^\d+$/.test(partes[0])) return partes[1];
    return partes[0] || texto;
  }

  /** Escapa lo que va dentro del XML del documento. */
  _escapar(texto) {
    return String(texto == null ? '' : texto)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

module.exports = { ActaService };
