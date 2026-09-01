'use strict';

const fs = require('fs');
const path = require('path');
const { RUTA_RAIZ } = require('../config/config');

/**
 * jszip se carga SOLO cuando se va a generar un acta, no al arrancar.
 *
 * Si el programa se instala dentro de OneDrive, "Liberar espacio" puede dejar
 * archivos del propio programa como marcadores que ya no están en el disco.
 * Con el require arriba, un archivo faltante de jszip tumbaba el arranque
 * entero con un error de JavaScript y no se podía ni abrir la aplicación.
 * Cargándolo aquí, lo único que falla es generar el acta, con un mensaje que
 * dice qué hacer.
 */
function cargarJSZip() {
  try {
    return require('jszip');
  } catch (error) {
    throw new Error(
      'Falta un archivo del programa para armar el Word (jszip). ' +
      'Suele pasar cuando el programa quedó instalado dentro de OneDrive: ' +
      'reinstálelo en la carpeta que propone el instalador, fuera de OneDrive. ' +
      `Detalle: ${error.message.split('\n')[0]}`
    );
  }
}

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

  /** Reemplaza los marcadores {{...}} de una parte del documento. */
  _reemplazar(xml, valores) {
    let salida = xml;
    let hubo = 0;
    for (const [marcador, valor] of Object.entries(valores)) {
      const antes = salida;
      salida = salida.split(`{{${marcador}}}`).join(this._escapar(valor));
      if (salida !== antes) hubo++;
    }
    return { xml: salida, reemplazos: hubo };
  }

  /**
   * Genera UN solo Word con todas las actas, una por hoja, para poder
   * imprimirlas de una vez en lugar de abrir un archivo por trámite.
   *
   * El radicado va en el ENCABEZADO, y en Word el encabezado es propio de cada
   * SECCIÓN, no de cada página: por eso no alcanza con pegar las actas una
   * detrás de otra (todas mostrarían el mismo radicado arriba). Se crea una
   * sección por acta, cada una con su propio encabezado. El salto de sección
   * por omisión ya empieza en página nueva, y como cada sección reinicia la
   * numeración, el pie sigue diciendo "Página 1 de 1" igual que las
   * individuales.
   *
   * @param {Array<{tramite: object, interesado: object}>} items
   * @returns {Promise<string>} ruta del archivo generado
   */
  async generarUnido(items) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('No hay trámites para generar el documento.');
    }
    if (!fs.existsSync(this.rutaPlantilla)) {
      throw new Error(
        `No se encontró la plantilla del acta en ${this.rutaPlantilla}. ` +
        'Puede indicar otra en config/app.config.json (acta.plantilla).'
      );
    }

    const zip = await cargarJSZip().loadAsync(fs.readFileSync(this.rutaPlantilla));
    const leer = async (parte) => {
      const f = zip.file(parte);
      if (!f) throw new Error(`La plantilla no tiene la parte ${parte}.`);
      return f.async('string');
    };

    const docXml = await leer('word/document.xml');
    let relsXml = await leer('word/_rels/document.xml.rels');
    let tiposXml = await leer('[Content_Types].xml');

    // --- Cuerpo y propiedades de sección de la plantilla ---
    const cuerpo = docXml.match(/<w:body>([\s\S]*)<\/w:body>/);
    if (!cuerpo) throw new Error('No se encontró el cuerpo del documento en la plantilla.');
    const sect = cuerpo[1].match(/<w:sectPr[\s\S]*<\/w:sectPr>\s*$/);
    if (!sect) throw new Error('La plantilla no tiene propiedades de sección (sectPr).');
    const sectPrBase = sect[0];
    const contenidoBase = cuerpo[1].slice(0, sect.index);

    // --- Encabezado al que apunta la sección (no se supone que sea header1) ---
    const refEncabezado = sectPrBase.match(/<w:headerReference[^>]*r:id="([^"]+)"/);
    if (!refEncabezado) throw new Error('La sección de la plantilla no referencia ningún encabezado.');
    const destino = relsXml.match(
      new RegExp(`<Relationship[^>]*Id="${refEncabezado[1]}"[^>]*Target="([^"]+)"`)
    );
    if (!destino) throw new Error(`No se encontró la relación ${refEncabezado[1]} del encabezado.`);
    const parteEncabezado = `word/${destino[1].replace(/^\/?word\//, '')}`;
    const encabezadoBase = await leer(parteEncabezado);
    const relsEncabezado = zip.file(`word/_rels/${path.basename(parteEncabezado)}.rels`);
    const relsEncabezadoXml = relsEncabezado ? await relsEncabezado.async('string') : null;

    // Siguiente rId libre: hay que no chocar con los que ya existen.
    let siguienteId = 1 + Math.max(
      0,
      ...[...relsXml.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]))
    );

    const bloques = [];
    let reemplazosTotales = 0;

    for (let i = 0; i < items.length; i++) {
      const { tramite, interesado = {} } = items[i];
      const valores = this._valores(tramite, interesado);

      // Encabezado propio de esta acta, con SU radicado.
      const nombreParte = `word/headerActa${i + 1}.xml`;
      const rId = `rId${siguienteId++}`;
      const encabezado = this._reemplazar(encabezadoBase, valores);
      zip.file(nombreParte, encabezado.xml);
      if (relsEncabezadoXml) {
        // Mismas relaciones que el original: apuntan a los logos por ruta
        // relativa, así que la copia sirve tal cual.
        zip.file(`word/_rels/headerActa${i + 1}.xml.rels`, relsEncabezadoXml);
      }
      relsXml = relsXml.replace(
        '</Relationships>',
        `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="headerActa${i + 1}.xml"/></Relationships>`
      );
      tiposXml = tiposXml.replace(
        '</Types>',
        `<Override PartName="/${nombreParte}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>`
      );

      const contenido = this._reemplazar(contenidoBase, valores);
      reemplazosTotales += contenido.reemplazos + encabezado.reemplazos;

      // La sección de esta acta apunta a SU encabezado.
      const sectPr = sectPrBase.replace(
        /(<w:headerReference[^>]*r:id=")[^"]*(")/g,
        `$1${rId}$2`
      );

      if (i < items.length - 1) {
        // Salto de sección intermedio: va en el pPr de un párrafo al cierre
        // de la sección, que es como Word representa el corte.
        bloques.push(`${contenido.xml}<w:p><w:pPr>${sectPr}</w:pPr></w:p>`);
      } else {
        // La última sección se declara al final del cuerpo.
        bloques.push(`${contenido.xml}${sectPr}`);
      }
    }

    if (reemplazosTotales === 0) {
      throw new Error(
        'La plantilla no tiene ningún marcador {{...}}: no se pudo llenar el acta. ' +
        'Revise que sea la plantilla correcta.'
      );
    }

    zip.file('word/document.xml', docXml.replace(
      /<w:body>[\s\S]*<\/w:body>/,
      `<w:body>${bloques.join('')}</w:body>`
    ));
    zip.file('word/_rels/document.xml.rels', relsXml);
    zip.file('[Content_Types].xml', tiposXml);

    fs.mkdirSync(this.carpetaSalida, { recursive: true });
    const hoy = new Date();
    const sello = `${String(hoy.getDate()).padStart(2, '0')}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${hoy.getFullYear()}`;
    const destinoArchivo = path.join(this.carpetaSalida, `ACTAS DE VISITA (${items.length}) ${sello}.docx`);
    fs.writeFileSync(destinoArchivo, await zip.generateAsync({ type: 'nodebuffer' }));

    this.logger.info(`Actas de visita en un solo documento: ${destinoArchivo} (${items.length} hojas)`);
    return destinoArchivo;
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
    const zip = await cargarJSZip().loadAsync(fs.readFileSync(this.rutaPlantilla));

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
