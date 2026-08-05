'use strict';

const { normalizarFecha } = require('../utils/fechas');

/**
 * Cuánto se espera, tras pulsar la lupa, a que aparezcan los datos de la
 * ficha. No puede ser un tiempo fijo corto: en una red lenta la ficha aún no
 * cargó y se leería el formulario en blanco, o sea "no existe" para TODOS los
 * radicados. Se sondea hasta este límite; agotarlo sí significa que el
 * radicado no existe.
 */
const ESPERA_RESULTADO_MS = 8000;

/**
 * Ubica los tres controles de la caja "TRÁMITE A CONSULTAR" (AÑO, NÚMERO y
 * la lupa) y los marca con data-robot-campo para poder llenarlos sin
 * ambigüedad. Corre DENTRO del navegador.
 *
 * No se usan selectores de proximidad (":near"): los dos campos están
 * pegados, así que ambos resolvían al MISMO input y el número terminaba
 * escrito en AÑO. Aquí se recorre la página en orden de lectura y se toma,
 * para cada etiqueta, el campo que viene justo después.
 */
function UBICAR_FORMULARIO() {
  const normalizar = (t) =>
    (t || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/:$/, '');

  const items = [];
  const recorrer = (nodo) => {
    for (const hijo of nodo.children) {
      const tag = hijo.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        // Se guarda el tag aparte: un <select> no tiene atributo "type", y
        // tomarlo como campo de texto hacía que AÑO/NÚMERO cayeran sobre los
        // desplegables de departamento y municipio.
        items.push({ campo: true, el: hijo, tag, tipo: (hijo.getAttribute('type') || 'text').toLowerCase() });
        continue;
      }
      const propio = Array.from(hijo.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join(' ')
        .trim();
      if (propio) items.push({ campo: false, texto: normalizar(propio) });
      recorrer(hijo);
    }
  };
  recorrer(document.body);

  document
    .querySelectorAll('[data-robot-campo]')
    .forEach((el) => el.removeAttribute('data-robot-campo'));

  const esCasillaTexto = (it) =>
    it.campo && it.tag === 'INPUT' && (it.tipo === 'text' || it.tipo === 'number');

  // Primer campo escribible que aparece después de la etiqueta.
  const campoTras = (desde) => {
    for (let j = desde + 1; j < items.length && j <= desde + 4; j++) {
      if (esCasillaTexto(items[j])) return items[j].el;
    }
    return null;
  };

  let anio = null;
  let numero = null;
  let indiceNumero = -1;
  let estrategia = 'etiquetas';
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.campo) continue;
    // La etiqueta "AÑO" pierde la tilde de la Ñ al normalizar: queda "ANO".
    // Se acepta que la celda traiga algo más ("AÑO DE RADICACIÓN").
    const esAnio = it.texto === 'ANO' || it.texto.startsWith('ANO ');
    const esNumero = it.texto === 'NUMERO' || it.texto.startsWith('NUMERO ');
    if (!anio && esAnio) anio = campoTras(i);
    if (!numero && esNumero) {
      numero = campoTras(i);
      indiceNumero = i;
    }
  }

  // Plan B: si las etiquetas no aparecen como se espera, se usan los dos
  // primeros campos de texto VISIBLES de la página. En esta pantalla son
  // justamente AÑO y NÚMERO (departamento y municipio son desplegables, y
  // los campos de la ficha vienen después).
  const visiblesTexto = items.filter((i) => esCasillaTexto(i) && i.el.offsetParent !== null);
  if ((!anio || !numero) && visiblesTexto.length >= 2) {
    estrategia = 'posicion';
    anio = visiblesTexto[0].el;
    numero = visiblesTexto[1].el;
    indiceNumero = items.indexOf(visiblesTexto[1]);
  }

  // La lupa es el primer botón-imagen que aparece tras la caja de búsqueda.
  let buscar = null;
  if (indiceNumero >= 0) {
    for (let j = indiceNumero + 1; j < items.length && j <= indiceNumero + 10; j++) {
      const it = items[j];
      if (it.campo && (it.tipo === 'image' || it.tipo === 'submit')) {
        buscar = it.el;
        break;
      }
    }
  }
  if (!buscar) {
    buscar = Array.from(document.querySelectorAll("input[type='image']")).find(
      (el) => el.offsetParent !== null
    );
  }

  if (anio) anio.setAttribute('data-robot-campo', 'anio');
  if (numero) numero.setAttribute('data-robot-campo', 'numero');
  if (buscar) buscar.setAttribute('data-robot-campo', 'buscar');

  return {
    anio: Boolean(anio),
    numero: Boolean(numero),
    buscar: Boolean(buscar),
    estrategia,
    camposTextoVisibles: visiblesTexto.length,
    // Distintas: si algo falla, dice qué etiquetas había en pantalla.
    etiquetas: [...new Set(items.filter((i) => !i.campo).map((i) => i.texto))].slice(0, 40),
  };
}

/**
 * Lee los campos de la ficha del trámite. Corre DENTRO del navegador.
 *
 * La ficha está armada como filas de tabla: una celda con la etiqueta
 * ("Usuario que radica") y la de al lado con un input que trae el valor. Esa
 * es la vía principal, porque no depende de cómo esté anidado el resto de la
 * página. Si alguna etiqueta no aparece así, se cae a un segundo método que
 * recorre la página en orden de lectura emparejando etiqueta -> campo.
 */
function LECTOR_FICHA() {
  const normalizar = (t) =>
    (t || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/:$/, '');

  const esBoton = (campo) => {
    const tipo = (campo.getAttribute('type') || '').toLowerCase();
    return tipo === 'image' || tipo === 'submit' || tipo === 'button' || tipo === 'hidden';
  };

  /**
   * Valor de una celda. Se recorren TODOS sus controles y se toma el primero
   * que no sea un botón: los campos de la ficha traen al lado un control de
   * flechitas (▲▼) que es un botón-imagen, y quedarse con el primer control
   * de la celda hacía descartar la fila entera. Por eso se leían Observaciones
   * y los datos del interesado (sin flechitas) pero no Fecha Radicación,
   * Clase, NPN ni Usuario que radica (con flechitas).
   */
  const valorDe = (contenedor) => {
    for (const campo of contenedor.querySelectorAll('input, textarea, select')) {
      if (esBoton(campo)) continue;
      return (campo.value || '').trim();
    }
    return null;
  };

  /**
   * Texto de la etiqueta. Si la celda no tiene texto propio, la etiqueta
   * puede venir dentro de un control de solo lectura o de una imagen: en esos
   * casos innerText no devuelve nada y la fila se perdería.
   */
  const etiquetaDe = (celda) => {
    const propio = normalizar(celda.innerText || celda.textContent);
    if (propio) return propio;
    for (const campo of celda.querySelectorAll('input, textarea')) {
      if (esBoton(campo)) continue;
      const v = normalizar(campo.value);
      if (v) return v;
    }
    const img = celda.querySelector('img');
    if (img) return normalizar(img.getAttribute('alt') || img.getAttribute('title'));
    return '';
  };

  // --- Método 1: fila de tabla (etiqueta | valor) ---
  const porFila = {};
  for (const fila of document.querySelectorAll('tr')) {
    const celdas = fila.children;
    if (celdas.length < 2) continue;
    const etiqueta = etiquetaDe(celdas[0]);
    if (!etiqueta || etiqueta.length > 60) continue;
    for (let j = 1; j < celdas.length; j++) {
      const valor = valorDe(celdas[j]);
      if (valor !== null) {
        // La primera fila que use esa etiqueta manda: más abajo puede
        // repetirse en otra sección con otro sentido.
        if (!(etiqueta in porFila)) porFila[etiqueta] = valor;
        break;
      }
    }
  }

  // --- Método 2 (respaldo): orden de lectura, etiqueta -> siguiente campo ---
  const secuencia = [];
  const recorrer = (nodo) => {
    for (const hijo of nodo.children) {
      const tag = hijo.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        if (!esBoton(hijo)) secuencia.push({ campo: true, valor: (hijo.value || '').trim() });
        continue;
      }
      const propio = Array.from(hijo.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join(' ')
        .trim();
      if (propio) secuencia.push({ campo: false, texto: normalizar(propio) });
      recorrer(hijo);
    }
  };
  recorrer(document.body);

  const porSecuencia = (objetivo) => {
    for (let i = 0; i < secuencia.length; i++) {
      if (secuencia[i].campo || secuencia[i].texto !== objetivo) continue;
      for (let j = i + 1; j < secuencia.length && j <= i + 4; j++) {
        if (secuencia[j].campo) return secuencia[j].valor;
      }
    }
    return '';
  };

  const leer = (etiqueta) => {
    const objetivo = normalizar(etiqueta);
    if (porFila[objetivo]) return porFila[objetivo];
    return porSecuencia(objetivo);
  };

  /**
   * Último recurso para "Usuario que radica": buscar el texto en cualquier
   * parte de la página y tomar el primer control con valor que venga después,
   * sin suponer nada sobre tablas ni celdas.
   */
  const buscarPorTextoSuelto = (etiqueta) => {
    const objetivo = normalizar(etiqueta);
    const todos = Array.from(document.querySelectorAll('*'));
    for (let i = 0; i < todos.length; i++) {
      const el = todos[i];
      if (el.children.length > 0) continue; // solo el nodo más interno
      if (normalizar(el.textContent) !== objetivo) continue;
      // Desde ahí, el primer control con valor en orden de documento.
      for (let j = i + 1; j < todos.length && j <= i + 30; j++) {
        const cand = todos[j];
        const tag = cand.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') continue;
        if (esBoton(cand)) continue;
        const v = (cand.value || '').trim();
        if (v) return v;
      }
    }
    return '';
  };

  /**
   * Radiografía de la fila de "Usuario que radica": si los tres métodos
   * fallan, esto trae el HTML real de esa parte de la página. Es lo único
   * que permite escribir el selector correcto sin adivinar la estructura.
   */
  const radiografia = () => {
    const objetivo = normalizar('Usuario que radica');
    const limpiar = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 400);
    for (const el of document.querySelectorAll('td, th, span, div, label, b, font')) {
      if (el.children.length > 0) continue;
      if (!normalizar(el.textContent).includes(objetivo)) continue;
      const contenedor = el.closest('tr') || el.parentElement;
      return `HTML: ${limpiar(contenedor ? contenedor.outerHTML : el.outerHTML)}`;
    }
    // Quizá la etiqueta no es texto sino el valor de un control.
    for (const campo of document.querySelectorAll('input, textarea')) {
      if (!normalizar(campo.value).includes(objetivo)) continue;
      const contenedor = campo.closest('tr') || campo.parentElement;
      return `ETIQUETA-EN-CAMPO: ${limpiar(contenedor ? contenedor.outerHTML : '')}`;
    }
    return 'El texto "Usuario que radica" NO aparece en la página.';
  };

  const usuarioRadica = leer('Usuario que radica') || buscarPorTextoSuelto('Usuario que radica');

  return {
    fechaRadicacion: leer('Fecha Radicación'),
    usuarioRadica,
    clase: leer('Clase'),
    npn: leer('NPN'),
    interesado: leer('Nombre'),
    // Datos de contacto del interesado: son los que el acta de visita pide y
    // que no están en la bandeja.
    direccion: leer('Dirección'),
    ciudad: leer('Ciudad'),
    telefono: leer('Teléfono'),
    email: leer('Email'),
    fechaEnvioRevision: leer('Fecha envío a revisión'),
    estado: leer('Estado del trámite'),
    radiografia: usuarioRadica ? '' : radiografia(),
    // Para diagnosticar si la lectura falla. Se devuelven PARES
    // etiqueta=valor, no solo etiquetas: así se distingue "no encontré la
    // etiqueta" (estructura distinta) de "la encontré pero el valor vino
    // vacío" (leo el campo equivocado), que necesitan arreglos distintos.
    etiquetas: Object.keys(porFila).slice(0, 60),
    pares: Object.entries(porFila)
      .filter(([, v]) => v)
      .slice(0, 10)
      .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`),
    totalFilas: Object.keys(porFila).length,
  };
}

/**
 * Lee la pantalla "Consulta de Trámites" de edis (búsqueda por año + número
 * de radicado). Es la única fuente disponible para dos cosas que el
 * aplicativo no expone en ningún reporte:
 *
 *  1. La "Fecha envío a revisión" REAL de un trámite, cuando el robot
 *     detecta que salió de la bandeja tras una brecha larga sin sincronizar
 *     (asumir "hoy" sería incorrecto en ese caso).
 *  2. Quién radicó un número dado, para contar las radicaciones propias del
 *     personal de ventanilla recorriendo los números consecutivos.
 *
 * Cualquier usuario puede consultar cualquier radicado: basta con el número.
 */
class ConsultaTramiteService {
  /**
   * @param {object} config
   * @param {import('../utils/logger').Logger} logger
   */
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.diagnosticoDado = false;
    // Motivo del último fallo, para poder mostrarlo en pantalla en vez de
    // obligar a ir a buscarlo al archivo de log.
    this.ultimoProblema = '';
  }

  /**
   * Consulta un radicado y devuelve sus datos.
   * @param {import('playwright').Page} page Página ya autenticada (misma sesión de la bandeja)
   * @param {string|{anio: string, numero: string|number}} radicado "2026-6431" o {anio, numero}
   * @returns {Promise<{existe: boolean, fechaRadicacion: string, usuarioRadica: string,
   *   clase: string, npn: string, interesado: string, fechaEnvioRevision: string}|null>}
   *   null si no se pudo consultar (error de red/página); `existe: false` si la
   *   consulta funcionó pero ese número todavía no está radicado.
   */
  async consultar(page, radicado) {
    const cfg = this.config.consultaTramite;
    if (!cfg || !cfg.url) return null;

    const partes = this._partes(radicado);
    if (!partes) return null;
    const timeout = this.config.browser.timeoutMs;

    try {
      await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout });

      // Ubicar AÑO, NÚMERO y la lupa por su etiqueta, en orden de lectura.
      // Antes se usaba ":near(texto)", pero los dos campos están pegados y
      // AMBOS selectores caían en el mismo input: el número terminaba escrito
      // en AÑO, NÚMERO quedaba vacío y edis respondía "Digite el año y el
      // número de radicación". Se marcan los elementos y luego se llenan.
      const ubicados = await page.evaluate(UBICAR_FORMULARIO);
      if (!ubicados.anio || !ubicados.numero || !ubicados.buscar) {
        this.ultimoProblema =
          `No se ubicó el formulario de búsqueda (año=${ubicados.anio}, ` +
          `número=${ubicados.numero}, lupa=${ubicados.buscar}, ` +
          `campos de texto visibles=${ubicados.camposTextoVisibles}).`;
        this.logger.warn(
          `Consulta ${partes.anio}-${partes.numero}: ${this.ultimoProblema} ` +
          `Etiquetas: ${(ubicados.etiquetas || []).join(' / ')}`
        );
        return null;
      }

      const campoAnio = page.locator('[data-robot-campo="anio"]');
      const campoNumero = page.locator('[data-robot-campo="numero"]');
      await campoAnio.waitFor({ state: 'visible', timeout: 10000 });
      await campoAnio.fill(partes.anio);
      await campoNumero.fill(partes.numero);

      // Verificar ANTES de buscar que cada dato quedó en su campo: si no,
      // la búsqueda saldría mal y el radicado se daría por inexistente.
      const puestos = {
        anio: await campoAnio.inputValue(),
        numero: await campoNumero.inputValue(),
      };
      if (puestos.anio !== partes.anio || puestos.numero !== partes.numero) {
        this.ultimoProblema =
          `Los datos no quedaron en su campo (AÑO="${puestos.anio}", NÚMERO="${puestos.numero}").`;
        this.logger.warn(`Consulta ${partes.anio}-${partes.numero}: ${this.ultimoProblema} No se busca.`);
        return null;
      }

      await page.locator('[data-robot-campo="buscar"]').click({ timeout: 8000 });
      await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});

      // edis muestra un aviso propio ("Digite el año y el número de
      // radicación") cuando la búsqueda le llega incompleta. Si aparece, se
      // cierra: dejarlo abierto bloquearía todas las consultas siguientes.
      // edis contesta con un cartel propio. "TRÁMITE NO ENCONTRADO" es una
      // respuesta NORMAL (ese número todavía no se radicó) y así hay que
      // tratarla: tomarla como falla cortaba el recorrido a los 3 seguidos,
      // justo al llegar al final de la numeración, que es lo esperable.
      const aviso = await this._descartarAviso(page);
      if (aviso.tipo === 'no-encontrado') {
        return {
          existe: false,
          fechaRadicacion: '',
          usuarioRadica: '',
          clase: '',
          npn: '',
          interesado: '',
          fechaEnvioRevision: '',
        };
      }
      if (aviso.tipo === 'error') {
        this.ultimoProblema = `edis respondió: ${aviso.texto}`;
        this.logger.warn(`Consulta ${partes.anio}-${partes.numero}: ${this.ultimoProblema}`);
        return null;
      }

      // Sondeo hasta que la ficha traiga algo (ver ESPERA_RESULTADO_MS).
      const limite = Date.now() + ESPERA_RESULTADO_MS;
      let datos = await this._leerFicha(page);
      while (!this._tieneAlgo(datos) && Date.now() < limite) {
        await page.waitForTimeout(400);
        datos = await this._leerFicha(page);
      }
      // Queda a la vista de quien orquesta: si la ficha no se pudo leer, la
      // traza en pantalla muestra estas etiquetas en vez de dejar "no existe"
      // sin explicación.
      this.ultimasEtiquetas = datos.etiquetas || [];
      this.ultimosPares = datos.pares || [];
      this.ultimoTotalFilas = datos.totalFilas || 0;
      // Solo viene cuando NO se pudo leer "Usuario que radica": trae el HTML
      // real de esa fila, que es lo que hace falta para corregir el lector.
      if (datos.radiografia) this.ultimaRadiografia = datos.radiografia;

      const fechaRadicacion = this._fecha(datos.fechaRadicacion);
      const existe = this._tieneAlgo(datos);

      // La PRIMERA consulta de cada corrida deja rastro de lo que vio: si algo
      // cambia en edis, el log dice qué había en pantalla en vez de dejarnos
      // adivinando por qué no se detectó nada.
      if (!this.diagnosticoDado) {
        this.diagnosticoDado = true;
        this.logger.info(
          `Consulta ${partes.anio}-${partes.numero}: existe=${existe} ` +
          `fechaRad="${datos.fechaRadicacion}" usuarioRadica="${datos.usuarioRadica}" ` +
          `clase="${datos.clase}" estado="${datos.estado}" | url=${page.url()} | ` +
          `etiquetas: ${(datos.etiquetas || []).join(' / ')}`
        );
      }

      return {
        existe,
        fechaRadicacion,
        usuarioRadica: datos.usuarioRadica || '',
        clase: datos.clase || '',
        npn: datos.npn || '',
        interesado: datos.interesado || '',
        direccion: datos.direccion || '',
        ciudad: datos.ciudad || '',
        telefono: datos.telefono || '',
        email: datos.email || '',
        fechaEnvioRevision: this._fecha(datos.fechaEnvioRevision),
      };
    } catch (error) {
      this.ultimoProblema = error.message.split('\n')[0];
      this.logger.warn(
        `No se pudo consultar el trámite ${partes.anio}-${partes.numero}: ${this.ultimoProblema}`
      );
      return null;
    }
  }

  /**
   * Fecha REAL de envío a revisión de un trámite, o null si no se pudo leer
   * (el llamador debe caer de vuelta a la fecha de hoy en ese caso).
   * @returns {Promise<string|null>} ISO AAAA-MM-DD
   */
  async consultarFechaEnvio(page, numeroTramite) {
    const datos = await this.consultar(page, numeroTramite);
    return datos && datos.fechaEnvioRevision ? datos.fechaEnvioRevision : null;
  }

  /**
   * Lee la ficha probando en TODOS los marcos de la página, no solo el
   * principal: si el detalle del trámite vive dentro de un frame, mirar solo
   * el documento de arriba devuelve todo vacío (o sea "no existe") para
   * cualquier radicado. Se queda con el primer marco que traiga datos.
   */
  async _leerFicha(page) {
    let mejor = null;
    for (const marco of page.frames()) {
      const datos = await marco.evaluate(LECTOR_FICHA).catch(() => null);
      if (!datos) continue;
      if (this._tieneAlgo(datos)) return datos;
      // Se guarda el que más etiquetas haya visto, para el diagnóstico.
      if (!mejor || (datos.etiquetas || []).length > (mejor.etiquetas || []).length) {
        mejor = datos;
      }
    }
    return mejor || { fechaRadicacion: '', usuarioRadica: '', clase: '', npn: '', interesado: '', fechaEnvioRevision: '', estado: '', etiquetas: [] };
  }

  /**
   * Cierra el cartel emergente de edis si está en pantalla y lo clasifica.
   *
   * Distinguir el tipo es lo importante: "TRÁMITE NO ENCONTRADO" significa
   * simplemente que ese número todavía no existe (respuesta normal al llegar
   * al final de la numeración), mientras que "Digite el año y el número" sí
   * es una falla del robot que hay que corregir.
   *
   * @returns {Promise<{tipo: ''|'no-encontrado'|'error', texto: string}>}
   */
  async _descartarAviso(page) {
    const sinAviso = { tipo: '', texto: '' };
    try {
      const boton = page.locator("button:has-text('Aceptar'), input[value='Aceptar']").first();
      if (!(await boton.isVisible({ timeout: 800 }).catch(() => false))) return sinAviso;

      const texto = await page
        .evaluate(() => {
          const normalizar = (t) =>
            (t || '')
              .normalize('NFD')
              .replace(/[̀-ͯ]/g, '')
              .toUpperCase()
              .replace(/\s+/g, ' ');
          const cuerpo = normalizar(document.body.innerText);
          const m = cuerpo.match(/[^\n]*(NO ENCONTRAD|ERROR|DIGITE)[^\n]*/);
          return m ? m[0].trim() : '';
        })
        .catch(() => '');

      await boton.click({ timeout: 3000 }).catch(() => {});

      if (/NO ENCONTRAD/.test(texto)) return { tipo: 'no-encontrado', texto };
      return { tipo: 'error', texto: texto || 'aviso sin texto reconocible' };
    } catch {
      return sinAviso;
    }
  }

  /**
   * Un radicado inexistente deja TODOS los campos en blanco; basta con que
   * uno traiga algo para saber que la ficha ya cargó y el radicado existe.
   *
   * Se incluyen los datos del interesado a propósito: en esta pantalla son los
   * que se leen con más fiabilidad, y mirar solo los de la izquierda (estado,
   * fecha, clase) daba "no existe" para trámites que sí existían y de los que
   * ya se había leído el nombre y el teléfono.
   */
  _tieneAlgo(datos) {
    if (!datos) return false;
    return Boolean(
      this._fecha(datos.fechaRadicacion) ||
        datos.usuarioRadica ||
        datos.clase ||
        datos.estado ||
        datos.interesado ||
        datos.telefono ||
        datos.direccion
    );
  }

  /** "2026-6431" -> {anio:'2026', numero:'6431'} (tolera "26-..." y "026-..."). */
  _partes(radicado) {
    if (radicado && typeof radicado === 'object') {
      return { anio: String(radicado.anio), numero: String(radicado.numero) };
    }
    const m = String(radicado || '').match(/^(\d{2,4})-(\d+)/);
    if (!m) return null;
    const crudo = m[1];
    const anio =
      crudo.length <= 2 ? `20${crudo}` : crudo.length === 3 && crudo[0] === '0' ? `2${crudo}` : crudo;
    return { anio, numero: m[2] };
  }

  /** Devuelve la fecha en ISO solo si se reconoció con seguridad; si no, ''. */
  _fecha(texto) {
    const iso = normalizarFecha(String(texto || '').trim());
    return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : '';
  }
}

// Las funciones que corren dentro del navegador se exportan para poder
// verificarlas contra una réplica de la pantalla real, sin duplicar su código
// en la prueba (fue justamente probar una copia lo que dejó pasar dos bugs).
module.exports = { ConsultaTramiteService, LECTOR_FICHA, UBICAR_FORMULARIO };
