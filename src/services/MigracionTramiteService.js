'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Localiza los campos AÑO, NÚMERO y lupa de la sección "Radicación" en la
 * página de resolución.  Se busca específicamente dentro del contenedor que
 * tiene el texto "Radicación" para NO confundir con otros campos AÑO que
 * hay en otras secciones (ej. Construcciones).  Solo se marcan campos
 * VISIBLES.
 */
function UBICAR_BUSQUEDA() {
  const normalizar = (t) =>
    (t || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/\s+/g, ' ')
      .trim();

  document
    .querySelectorAll('[data-robot-campo]')
    .forEach((el) => el.removeAttribute('data-robot-campo'));

  for (const el of document.querySelectorAll('td, th, div, span, b, font, label, p')) {
    if (!normalizar(el.textContent).includes('RADICACION')) continue;
    if (el.textContent.length > 150) continue;

    let contenedor = el.parentElement;
    for (let nivel = 0; nivel < 8 && contenedor; nivel++) {
      const inputs = Array.from(
        contenedor.querySelectorAll('input[type="text"], input[type="number"]')
      ).filter((inp) => inp.offsetParent !== null);

      if (inputs.length >= 2) {
        inputs[0].setAttribute('data-robot-campo', 'anio');
        inputs[1].setAttribute('data-robot-campo', 'numero');

        const boton = Array.from(
          contenedor.querySelectorAll('input[type="image"]')
        ).find((b) => b.offsetParent !== null);
        if (boton) boton.setAttribute('data-robot-campo', 'buscar');

        return {
          anio: true,
          numero: true,
          buscar: Boolean(boton),
          estrategia: 'radicacion',
          ids: inputs.slice(0, 2).map((i) => i.id),
        };
      }
      contenedor = contenedor.parentElement;
    }
  }

  const visibles = Array.from(
    document.querySelectorAll('input[type="text"], input[type="number"]')
  ).filter((inp) => inp.offsetParent !== null && inp.maxLength <= 10);

  if (visibles.length >= 2) {
    visibles[0].setAttribute('data-robot-campo', 'anio');
    visibles[1].setAttribute('data-robot-campo', 'numero');
    const buscar = Array.from(document.querySelectorAll('input[type="image"]')).find(
      (b) => b.offsetParent !== null
    );
    if (buscar) buscar.setAttribute('data-robot-campo', 'buscar');
    return { anio: true, numero: true, buscar: Boolean(buscar), estrategia: 'fallback' };
  }

  return { anio: false, numero: false, buscar: false, estrategia: 'ninguna' };
}

/**
 * Encuentra y MARCA la pestaña cuyo rótulo coincide con `nombre` dentro del
 * documento actual (se ejecuta con page.evaluate en cada marco).  Devuelve si
 * se encontró y, si no, la lista de enlaces visibles para diagnóstico.
 *
 * Prioriza coincidencia EXACTA del texto propio (el <a>Predio</a> gana sobre
 * la barra que contiene todos los rótulos juntos) y, en su defecto, una
 * coincidencia por inclusión con un rótulo corto (para "Fte Administrativa"
 * dentro de "Fte Administrativa y Decretos").
 */
/**
 * Corre DENTRO de la página: NPN del recuadro de predios de la segregación.
 * Sube desde el título ("PREDIOS DE LA ...") o desde "Inserta Predio" hasta
 * el contenedor que tiene NPN, sin tocar la grilla de la bandeja (GridRad) ni
 * el NPN del propio trámite.
 */
function LEER_PREDIOS_SEGREGACION() {
  const PATRON = /\b\d{2}-\d{2}-\d{2}-\d{2}-\d{4}-\d{4}-\d-\d{2}-\d{2}-\d{4}\b/g;
  const norm = (t) =>
    String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
  const matrizEl = document.querySelector('[id$="_LblNpnRadicado"]');
  const npnMatriz = matrizEl ? (matrizEl.textContent || '').trim() : '';
  const claseEl = document.querySelector('[id$="_LblClaseRad"], [id$="_LblClase"]');
  const clase = claseEl ? (claseEl.textContent || '').trim() : '';

  const npnsDe = (raiz) => {
    const vistos = [];
    const caminante = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = caminante.nextNode())) {
      if (n.parentElement && n.parentElement.closest('[id$="_GridRad"], [id$="_LblNpnRadicado"]')) continue;
      for (const m of (n.textContent || '').match(PATRON) || []) {
        if (m !== npnMatriz && !vistos.includes(m)) vistos.push(m);
      }
    }
    return vistos;
  };

  const anclas = [];
  for (const el of document.querySelectorAll('div, span, td, th, h1, h2, h3, h4, p, b, font, label')) {
    const propio = norm(Array.from(el.childNodes).filter((x) => x.nodeType === 3).map((x) => x.textContent).join(' '));
    if (/^PREDIOS DE(L| LA| LOS)? /.test(propio)) anclas.push({ el, como: `título "${propio.slice(0, 40)}"` });
  }
  for (const el of document.querySelectorAll('input[type="submit"], input[type="button"], button, a')) {
    if (/INSERTA PREDIO/.test(norm(el.value || el.textContent))) anclas.push({ el, como: 'botón Inserta Predio' });
  }

  for (const { el, como } of anclas) {
    let cont = el;
    for (let nivel = 0; nivel < 7 && cont && cont !== document.body; nivel++) {
      if (cont.querySelector('[id$="_GridRad"]')) break;
      const predios = npnsDe(cont);
      if (predios.length > 0) return { npnMatriz, clase, predios, ubicado: true, como };
      cont = cont.parentElement;
    }
  }

  // Respaldo: una grilla con columnas NPN y Elimina que no sea la bandeja.
  for (const tabla of document.querySelectorAll('table')) {
    if (tabla.matches('[id$="_GridRad"]') || tabla.closest('[id$="_GridRad"]')) continue;
    const cab = Array.from(tabla.querySelectorAll('th, tr:first-child td')).map((c) => norm(c.textContent));
    if (cab.includes('NPN') && cab.some((c) => c.startsWith('ELIMINA'))) {
      const predios = npnsDe(tabla);
      if (predios.length > 0) return { npnMatriz, clase, predios, ubicado: true, como: 'grilla NPN/Elimina' };
    }
  }
  return { npnMatriz, clase, predios: [], ubicado: anclas.length > 0, como: anclas.length > 0 ? 'recuadro sin NPN' : 'no se encontró el recuadro' };
}

function MARCAR_PESTANA({ nombre }) {
  const norm = (t) =>
    (t || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/\s+/g, ' ')
      .trim();
  const objetivo = norm(nombre);

  document
    .querySelectorAll('[data-robot-pestana]')
    .forEach((el) => el.removeAttribute('data-robot-pestana'));

  const esVisible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;

  const candidatos = Array.from(
    document.querySelectorAll(
      'a, input[type="submit"], input[type="button"], span, td, div, li, b, font, label'
    )
  );

  let exacto = null;
  let contiene = null;
  for (const el of candidatos) {
    if (!esVisible(el)) continue;

    const textoPropio = norm(
      Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join(' ')
    );
    const textoCompleto =
      el.tagName === 'INPUT' ? norm(el.value) : norm(el.textContent);

    if (textoPropio === objetivo || textoCompleto === objetivo) {
      exacto = el;
      break;
    }
    if (
      !contiene &&
      textoCompleto.includes(objetivo) &&
      textoCompleto.length <= objetivo.length + 25
    ) {
      contiene = el;
    }
  }

  const elegido = exacto || contiene;
  if (elegido) {
    const enlace = elegido.closest('a') || elegido;
    enlace.setAttribute('data-robot-pestana', '1');
    return {
      encontrado: true,
      tag: enlace.tagName,
      href: enlace.getAttribute('href') || '',
      texto: norm(enlace.textContent || enlace.value).slice(0, 40),
    };
  }

  const enlaces = [
    ...new Set(
      Array.from(document.querySelectorAll('a'))
        .filter((a) => esVisible(a))
        .map((a) => norm(a.textContent))
        .filter(Boolean)
    ),
  ].slice(0, 40);
  return { encontrado: false, enlaces };
}

class MigracionTramiteService {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  /* ===================== API PÚBLICA ===================== */

  /**
   * edis pide confirmación con confirm()/alert() en varios botones (entre
   * ellos "Aplica Zonas Digitales").  Playwright, si nadie atiende el diálogo,
   * lo DESCARTA, que equivale a pulsar "Cancelar": la acción se anulaba en
   * silencio y el log decía que el botón sí se había pulsado.  Aceptándolos el
   * robot se comporta como la persona que da "Aceptar".
   */
  _atenderDialogos(page) {
    if (page.__robotDialogos) return;
    page.__robotDialogos = true;
    page.on('dialog', async (dialogo) => {
      this.logger.info(
        `Diálogo de edis aceptado: "${String(dialogo.message()).slice(0, 150)}"`
      );
      await dialogo.accept().catch(() => {});
    });
  }

  async leerOrigen(page, radicado, onProgreso = () => {}) {
    this._atenderDialogos(page);
    onProgreso('Abriendo trámite origen...');
    await this._abrirTramite(page, radicado);

    // Datos del solicitante (pestaña "Datos de la radicación"): de aquí sale el
    // número de documento y el nombre del propietario.
    const solicitante = await this._leerPorIds(page, {
      cedula: '_TxtCedula',
      nombre: '_TxtNombre',
    });

    onProgreso('Leyendo pestaña Predio...');
    await this._irAPestana(page, 'Predio');
    const predio = await this._leerCamposVisibles(page);
    // Lectura precisa por id (los rótulos de la tabla no son fiables).
    const campos = await this._leerPorIds(page, {
      destino: '_CmbDestino',
      orip: '_TCodigoORIP',
      matricula: '_TMatricula',
      avaluo: '_TAvaluo',
    });
    campos.cedula = solicitante.cedula;
    campos.nombre = solicitante.nombre;
    campos.direccion = this._normalizarDireccion(await this._leerDireccionOrigen(page));

    onProgreso('Leyendo pestaña Terreno...');
    await this._irAPestana(page, 'Terreno');
    const terreno = await this._leerPorIds(page, { areaPrivada: '_TAreaTTPrivada' });
    campos.areaTerreno = terreno.areaPrivada;

    onProgreso('Leyendo pestaña Propietarios...');
    await this._irAPestana(page, 'Propietarios');
    const propietarios = await this._leerCamposVisibles(page);
    campos.propietarios = await this._leerPropietariosOrigen(page);

    // La Fte Administrativa del origen (cancelación) viene vacía: esos datos
    // salen siempre de los predeterminados que indica el usuario.
    const fuente = {};

    await this._guardarDiagnostico(page, `origen-${radicado}`);

    this.logger.info(
      `Origen ${radicado}: destino="${campos.destino}" matricula="${campos.orip}-${campos.matricula}" ` +
        `direccion="${campos.direccion}" area="${campos.areaTerreno}" ` +
        `cedula="${campos.cedula}" nombre="${campos.nombre}"`
    );

    return { predio, propietarios, fuente, campos };
  }

  /**
   * La dirección pasa al destino "limpia": la vía va como "C" (no "CL") y sin
   * el guion separador.  Ej.: "CL 129 5C - 36" -> "C 129 5C 36".  El prefijo
   * es lo único que cambia de letra: los "5C" internos quedan intactos.
   */
  _normalizarDireccion(direccion) {
    const limpia = String(direccion || '').trim();
    if (!limpia) return '';
    const ajustada = limpia
      .replace(/^CL\b\s*/i, 'C ')
      .replace(/-/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (ajustada !== limpia) {
      this.logger.info(`Dirección ajustada: "${limpia}" -> "${ajustada}"`);
    }
    return ajustada;
  }

  /** Lee varios campos por sufijo de id. Devuelve {clave: valor}. */
  async _leerPorIds(page, mapa) {
    return page
      .evaluate((mapa) => {
        const salida = {};
        for (const [clave, sufijo] of Object.entries(mapa)) {
          // Se prefiere el campo VISIBLE, igual que al escribir: si hay un
          // duplicado oculto con el mismo final de id, leer el equivocado hacía
          // dar por bueno un campo que en pantalla estaba vacío.
          const todos = Array.from(document.querySelectorAll(`[id$="${sufijo}"]`));
          const el =
            todos.find((e) => e.offsetParent !== null || e.getClientRects().length > 0) ||
            todos[0];
          if (!el) {
            salida[clave] = '';
            continue;
          }
          if (el.tagName === 'SELECT') {
            const op = el.options[el.selectedIndex];
            salida[clave] = op ? op.text.trim() : '';
          } else {
            salida[clave] = (el.value || el.textContent || '').trim();
          }
        }
        return salida;
      }, mapa)
      .catch(() => Object.fromEntries(Object.keys(mapa).map((k) => [k, ''])));
  }

  /**
   * Propietarios del origen: filas de la grilla PROPIETARIOS (NOMBRE, TIPO
   * DOCUMENTO, DOCUMENTO, Porc).  Puede venir vacía —en las cancelaciones lo
   * está—, y entonces el dueño se toma del solicitante del trámite.
   * @returns {Promise<Array<{nombre, tipoDocumento, documento, porcentaje}>>}
   */
  async _leerPropietariosOrigen(page) {
    return page
      .evaluate(() => {
        const norm = (t) =>
          (t || '')
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .toUpperCase()
            .replace(/\s+/g, ' ')
            .trim();

        for (const tabla of document.querySelectorAll('table')) {
          const filas = Array.from(tabla.querySelectorAll('tr'));
          if (filas.length < 2) continue;
          const cab = Array.from(filas[0].children).map((c) => norm(c.textContent));
          const iNombre = cab.indexOf('NOMBRE');
          const iDoc = cab.indexOf('DOCUMENTO');
          if (iNombre < 0 || iDoc < 0) continue;
          const iTipo = cab.indexOf('TIPO DOCUMENTO');
          const iPorc = cab.findIndex((c) => c.startsWith('PORC'));

          const texto = (fila, i) =>
            i >= 0 && fila.children[i] ? (fila.children[i].textContent || '').trim() : '';

          const salida = [];
          for (const fila of filas.slice(1)) {
            const nombre = texto(fila, iNombre);
            if (!nombre) continue;
            salida.push({
              nombre,
              tipoDocumento: texto(fila, iTipo),
              documento: texto(fila, iDoc),
              porcentaje: texto(fila, iPorc),
            });
          }
          return salida;
        }
        return [];
      })
      .catch(() => []);
  }

  /**
   * Dirección del predio en el origen: primera fila de la grilla DIRECCIONES
   * DEL PREDIO (la columna DIRECCION, p. ej. "CL 129 5C - 36").
   */
  async _leerDireccionOrigen(page) {
    return page
      .evaluate(() => {
        const norm = (t) =>
          (t || '')
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .toUpperCase()
            .trim();
        for (const tabla of document.querySelectorAll('table')) {
          const filas = Array.from(tabla.querySelectorAll('tr'));
          if (filas.length < 2) continue;
          const encabezados = Array.from(filas[0].children).map((c) => norm(c.textContent));
          const iDir = encabezados.findIndex((h) => h === 'DIRECCION');
          if (iDir < 0) continue;
          for (const fila of filas.slice(1)) {
            const celdas = Array.from(fila.children);
            const valor = ((celdas[iDir] && celdas[iDir].textContent) || '').trim();
            if (valor) return valor;
          }
        }
        return '';
      })
      .catch(() => '');
  }

  /**
   * Llena la Fuente Administrativa del trámite que esté abierto en pantalla.
   * Se usa en el destino y TAMBIÉN en el origen: las cancelaciones no la traen
   * y no puede quedar vacía, así que lleva la misma escritura predeterminada.
   * @returns {Promise<boolean>} true si se pudo llenar
   */
  async _escribirFuenteAdministrativa(page, datosFuente, extras, onProgreso, avisos) {
    onProgreso('Navegando a pestaña Fte Administrativa...');
    await this._irAPestana(page, 'Fte Administrativa');
    onProgreso('Abriendo modo edición...');
    if (
      !(await this._abrirModalConReintento(
        page,
        'PanelPopEscritura',
        '_BtnModEscritura',
        'Modifica'
      ))
    ) {
      avisos.push('No se pudo abrir la fuente administrativa.');
      return false;
    }
    await this._cerrarAviso(page);
    onProgreso('Llenando campos de Fuente Administrativa...');
    const vacios = await this._llenarCamposFuente(page, datosFuente, extras);
    if (vacios && vacios.length > 0) {
      // Se avisa en pantalla: guardar con campos vacíos deja el trámite mal.
      avisos.push(`Fuente administrativa sin llenar: ${vacios.join(', ')}.`);
    }
    // Un campo deshabilitado NO viaja en el envío aunque en pantalla se vea
    // lleno: se habilitan todos justo antes de guardar para que lo escrito
    // llegue al servidor. De paso queda en el log su estado real.
    const estado = await page
      .evaluate((sufijos) => {
        const salida = {};
        for (const s of sufijos) {
          const todos = Array.from(document.querySelectorAll(`[id$="${s}"]`));
          const el =
            todos.find((e) => e.offsetParent !== null || e.getClientRects().length > 0) ||
            todos[0];
          if (!el) {
            salida[s] = 'no existe';
            continue;
          }
          salida[s] = `"${el.value}" disabled=${el.disabled} readonly=${!!el.readOnly}`;
          el.removeAttribute('disabled');
          el.removeAttribute('readonly');
          el.disabled = false;
          if ('readOnly' in el) el.readOnly = false;
        }
        return salida;
      }, ['_CmbTipoFuente', '_TEscrituraM', '_TFechaEscrituraM', '_TNotariaM', '_TFechaICM', '_TFechaVigM'])
      .catch(() => ({}));
    this.logger.info(`Fuente al guardar: ${JSON.stringify(estado)}`);

    onProgreso('Guardando Fuente Administrativa...');
    if (!(await this._guardarConRespaldo(page, '_BtnGuardaEscritura'))) {
      avisos.push('No se pudo guardar la fuente administrativa.');
    }
    const aviso = await this._cerrarAviso(page);
    if (aviso && /error/i.test(aviso)) avisos.push(`Fuente administrativa: ${aviso}`);
    await this._cerrarModalAbierto(page);
    return true;
  }

  /**
   * Escribe la fuente administrativa en el trámite ORIGEN, que ya está abierto
   * tras leerOrigen.  Se hace aquí para no tener que volver a abrirlo.
   * @returns {Promise<{avisos: string[]}>}
   */
  async escribirFuenteEnOrigen(page, extras, onProgreso = () => {}) {
    this._atenderDialogos(page);
    const avisos = [];
    onProgreso('Llenando la fuente administrativa del trámite origen...');
    await this._escribirFuenteAdministrativa(page, {}, extras, onProgreso, avisos);
    return { avisos: avisos.map((a) => `Origen: ${a}`) };
  }

  async escribirDestino(page, radicado, datos, extras, onProgreso = () => {}) {
    this._atenderDialogos(page);
    // Lo que edis rechace se junta aquí para avisarlo al final, en vez de
    // dejarlo solo en el log.
    const avisos = [];
    onProgreso('Abriendo trámite destino...');
    await this._abrirTramite(page, radicado);

    const campos = datos.campos || {};

    /* --- Predio: "Modifica" abre el modal PanelPopPredio con su propia copia
       de los campos (los de la pantalla de atrás son de solo lectura). --- */
    onProgreso('Navegando a pestaña Predio...');
    await this._irAPestana(page, 'Predio');
    onProgreso('Abriendo modo edición (Modifica)...');
    await this._abrirModalConReintento(page, 'PanelPopPredio', '_BtnModPredio', 'Modifica');

    onProgreso('Llenando campos de Predio...');
    await this._llenarCamposPredio(page, campos, extras);
    onProgreso('Guardando Predio...');
    await this._guardarConRespaldo(page, '_BtnGuardaPred');
    await this._cerrarAviso(page);
    await this._cerrarModalAbierto(page);

    /* --- Dirección del predio: "+" abre PanelPopDireccion; la dirección del
       origen se pega en "Complemento dirección". --- */
    // La escrita a mano también se limpia (sin "L" de CL y sin guion).
    const direccion = extras.direccion
      ? this._normalizarDireccion(extras.direccion)
      : campos.direccion || '';
    if (direccion) {
      onProgreso('Agregando dirección del predio...');
      if (await this._abrirModalConReintento(page, 'PanelPopDireccion', '_BtnAgregaDir')) {
        await this._llenarInput(page, 'Complemento direccion', direccion, {
          idSufijo: '_TComplementoDir',
        });
        await this._guardarConRespaldo(page, '_BtnGuardaDir');
        await this._cerrarAviso(page);
        await this._cerrarModalAbierto(page);
      }
    }

    /* --- Propietarios: se pasan TODOS los del origen.  Si su grilla viene
       vacía (caso de las cancelaciones) se crea uno con el solicitante. --- */
    onProgreso('Navegando a pestaña Propietarios...');
    await this._irAPestana(page, 'Propietarios');

    const delOrigen = Array.isArray(campos.propietarios) ? campos.propietarios : [];
    const aCrear = delOrigen.length > 0 ? delOrigen : [null];
    this.logger.info(
      `Propietarios a crear: ${aCrear.length}` +
        (delOrigen.length > 0 ? ' (de la grilla del origen)' : ' (del solicitante)')
    );

    for (let i = 0; i < aCrear.length; i++) {
      onProgreso(`Agregando propietario ${i + 1} de ${aCrear.length}...`);
      if (!(await this._abrirModalConReintento(page, 'PanelPopPropietario', '_BtnAgregaProp'))) {
        avisos.push(`No se pudo abrir el formulario del propietario ${i + 1}.`);
        break;
      }
      await this._llenarCamposPropietarios(page, datos.propietarios, extras, campos, aCrear[i]);
      onProgreso(`Guardando propietario ${i + 1}...`);
      await this._guardarConRespaldo(page, '_BtnGuardaProp');
      const aviso = await this._cerrarAviso(page);
      if (aviso && /error/i.test(aviso)) avisos.push(`Propietario ${i + 1}: ${aviso}`);
      await this._cerrarModalAbierto(page);
    }

    /* --- Terreno: se copia el área del origen y se aplican zonas digitales.
       El botón tarda bastante (carga del servidor) y al terminar edis avisa
       "zona aplicada". --- */
    const areaTerreno = extras.areaTerreno || campos.areaTerreno || '';
    if (areaTerreno) {
      onProgreso('Navegando a pestaña Terreno...');
      await this._irAPestana(page, 'Terreno');
      onProgreso(`Copiando área de terreno (${areaTerreno})...`);
      await this._llenarInput(page, 'Area Terreno Privado', areaTerreno, {
        idSufijo: '_TAreaTTPrivada',
      });
      // Sacar el foco del campo para que el valor quede confirmado antes de
      // enviar el formulario.
      await page
        .locator('[id$="_TAreaTTPrivada"]')
        .first()
        .press('Tab', { timeout: 5000 })
        .catch(() => {});
      await page.waitForTimeout(500);
      onProgreso('Aplicando zonas digitales...');
      const zonas = await this._aplicarZonasDigitales(page);
      if (!zonas.aplicada) {
        // Suele ser un problema de la base gráfica del predio, no del robot:
        // hay que verlo, no dejarlo pasar en silencio.
        avisos.push(
          zonas.aviso
            ? `Zonas digitales: ${zonas.aviso}`
            : 'Zonas digitales: no quedaron aplicadas.'
        );
        onProgreso(`Zonas no aplicadas: ${zonas.aviso || 'sin detalle'}`);
      }
    } else {
      this.logger.warn('Sin área de terreno del origen: se omite el paso de Terreno.');
    }

    /* --- Fte Administrativa (datos SIEMPRE de los predeterminados/extras) --- */
    await this._escribirFuenteAdministrativa(page, datos.fuente, extras, onProgreso, avisos);

    await this._guardarDiagnostico(page, `destino-${radicado}`);
    onProgreso('Migración completada. Revise en pantalla.');
    return { avisos };
  }

  /* ===================== PREDIOS DE LA SEGREGACIÓN ===================== */

  /**
   * Lee los NPN creados en un trámite de segunda (recuadro "PREDIOS DE LA
   * SEGREGACIÓN", a la izquierda).  El recuadro se ubica por su título o por
   * el botón "Inserta Predio", no por id: el id real aún no se ha visto.
   * @returns {Promise<{npnMatriz: string, clase: string, predios: string[], ubicado: boolean}>}
   */
  async leerPrediosSegregacion(page, radicado, { guardarHtml = false } = {}) {
    this._atenderDialogos(page);
    await this._abrirTramite(page, radicado);
    await this._esperarPostbackTerminado(page);

    let datos = null;
    const fin = Date.now() + 10000;
    while (Date.now() < fin) {
      datos = await page.evaluate(LEER_PREDIOS_SEGREGACION).catch(() => null);
      if (datos && datos.predios.length > 0) break;
      await page.waitForTimeout(500);
    }
    datos = datos || { npnMatriz: '', clase: '', predios: [], ubicado: false, como: 'error al leer' };
    this.logger.info(
      `Predios de ${radicado}: ${datos.predios.length} (matriz ${datos.npnMatriz}, ubicado por: ${datos.como})`
    );
    if (guardarHtml || datos.predios.length === 0) {
      await this._guardarDiagnostico(page, `predios-${radicado}`);
    }
    return datos;
  }

  /* ===================== TRÁMITE DE TERCERA ===================== */

  /**
   * Mutación de tercera (modificación de características constructivas): no
   * hay trámite origen; se escriben los valores que da el usuario. Dirección,
   * propietarios y terreno se dejan como están.
   *
   * @param {{destino, tipoPredio, construccion, fuente, visita}} datos
   * @returns {Promise<{avisos: string[]}>}
   */
  async escribirTercera(page, radicado, datos, onProgreso = () => {}) {
    this._atenderDialogos(page);
    const avisos = [];
    onProgreso(`Abriendo trámite ${radicado}...`);
    await this._abrirTramite(page, radicado);

    onProgreso('Navegando a pestaña Predio...');
    await this._irAPestana(page, 'Predio');
    // Matrícula y NPN propios de ESTE radicado: van en la motivada.
    const delPredio = await this._leerMatriculaYNpn(page);
    this.logger.info(
      `Tercera ${radicado}: matricula="${delPredio.matricula}" npn="${delPredio.npn}"`
    );
    if (await this._abrirModalConReintento(page, 'PanelPopPredio', '_BtnModPredio', 'Modifica')) {
      onProgreso('Cambiando destino económico y tipo de predio...');
      await this._llenarCamposPredio(page, {}, {
        destino: datos.destino,
        tipoPredio: datos.tipoPredio,
      });
      if (!(await this._guardarConRespaldo(page, '_BtnGuardaPred'))) {
        avisos.push('No se pudo guardar el predio.');
      }
      const aviso = await this._cerrarAviso(page);
      if (aviso && /error/i.test(aviso)) avisos.push(`Predio: ${aviso}`);
      await this._cerrarModalAbierto(page);
    } else {
      avisos.push('No se pudo abrir el predio (destino económico sin cambiar).');
    }

    await this._escribirConstruccion(page, datos.construccion || {}, onProgreso, avisos);
    await this._escribirFuenteAdministrativa(page, {}, datos.fuente || {}, onProgreso, avisos);
    await this._escribirVisita(page, datos.visita || {}, onProgreso, avisos);
    await this._subirFotos(page, datos.fotos || [], onProgreso, avisos);
    const modeloCargado = await this._cargarModeloTexto(
      page,
      datos.modeloTexto,
      onProgreso,
      avisos
    );
    if (datos.motivada && datos.motivada.activa) {
      if (modeloCargado) {
        await this._escribirMotivada(page, datos.motivada, delPredio, radicado, onProgreso, avisos);
      } else {
        avisos.push('Motivada: no se escribió porque el modelo de texto motivo no se cargó.');
      }
    }

    await this._guardarDiagnostico(page, `tercera-${radicado}`);
    onProgreso('Trámite de tercera completado. Revise en pantalla.');
    return { avisos };
  }

  /**
   * "+" de Construcciones abre PanelTipologia.  Los desplegables van en
   * cascada (el tipo carga los usos, la clase carga los tipos) y cada uno
   * hace postback que redibuja el modal: por eso van primero y los textos
   * después, con verificación.
   */
  async _escribirConstruccion(page, c, onProgreso, avisos) {
    onProgreso('Navegando a pestaña Construcciones...');
    await this._irAPestana(page, 'Construcciones');
    onProgreso('Agregando unidad de construcción (+)...');
    if (!(await this._abrirModalConReintento(page, 'PanelTipologia', '_BtnAgregaConstruccion'))) {
      avisos.push('No se pudo abrir el formulario de construcción.');
      return;
    }
    await this._cerrarAviso(page);

    const desplegables = [
      ['Tipo', c.tipo, '_CmbTipoUnidad2'],
      ['Uso', c.uso, '_cmbUsoCons2'],
      ['Estado de conservación', c.conservacion, '_CmbEstadoConservacion2'],
      ['Clase', c.clase, '_CmbClaseTipologia'],
      ['Tipo de tipología', c.tipologia, '_CmbTipoTipologia'],
    ];
    onProgreso('Eligiendo tipo, uso, conservación y tipología...');
    await this._llenarDesplegables(page, desplegables);

    if (c.codigo) {
      onProgreso(`Eligiendo código de tipología ${c.codigo}...`);
      if (!(await this._elegirCodigoTipologia(page, c.codigo))) {
        avisos.push(
          `Construcción: no se pudo elegir el código ${c.codigo}; elíjalo a mano con "Seleccionar...".`
        );
      }
    }

    onProgreso('Llenando unidad, pisos, área y año...');
    const textos = [
      ['Unidad', c.unidad, '_TNumUnidad2'],
      ['Núm. pisos', c.pisos, '_TNpisos2'],
      ['Área', c.area, '_TAreaCons2'],
      ['Año construcción', c.anio, '_TAnoConstruccion2'],
    ];
    const vacios = await this._llenarTextosConVerificacion(page, textos);
    if (vacios.length > 0) avisos.push(`Construcción sin llenar: ${vacios.join(', ')}.`);

    const mal = await this._verificarDesplegables(page, desplegables);
    if (mal.length > 0) avisos.push(`Construcción: ${mal.join('; ')}.`);

    await this._habilitarParaEnvio(page, [...desplegables, ...textos].map((x) => x[2]));
    onProgreso('Guardando construcción...');
    if (!(await this._guardarConRespaldo(page, '_BtnGuardaTipologia'))) {
      avisos.push('No se pudo guardar la construcción.');
    }
    const aviso = await this._cerrarAviso(page);
    if (aviso && /error|digite|seleccione|debe/i.test(aviso)) avisos.push(`Construcción: ${aviso}`);

    // PanelTipologia no es un "PanelPop*": _cerrarModalAbierto no lo ve. Si
    // sigue abierto tras guardar, edis no aceptó el guardado; se cierra para
    // poder seguir con las demás pestañas y se avisa.
    if (await this._modalVisible(page, 'PanelTipologia')) {
      avisos.push('Construcción: el formulario siguió abierto tras guardar; revísela en edis.');
      await this._guardarDiagnostico(page, 'construccion-sin-guardar');
      await this._clickPorIdSufijo(page, '_BtnSalirTipologia');
      await this._esperarPostbackTerminado(page);
    }
  }

  /**
   * "Seleccionar..." abre PanelCodigoTipologia, una lista de códigos según la
   * clase y el tipo elegidos.  Se pulsa la fila del código pedido.
   */
  async _elegirCodigoTipologia(page, codigo) {
    const cod = String(codigo).trim();
    await this._esperarPostbackTerminado(page);
    if (!(await this._clickPorIdSufijo(page, '_BtnCodigoTipologia'))) {
      await page
        .evaluate(() => {
          const b = document.querySelector('[id$="_BtnCodigoTipologia"]');
          if (b) b.click();
        })
        .catch(() => {});
    }
    if (!(await this._esperarModal(page, 'PanelCodigoTipologia'))) return false;
    await this._esperarPostbackTerminado(page);

    const marcado = await page
      .evaluate((c) => {
        document
          .querySelectorAll('[data-robot-codigo]')
          .forEach((e) => e.removeAttribute('data-robot-codigo'));
        const panel = document.querySelector('[id$="PanelCodigoTipologia"]');
        if (!panel) return { ok: false, texto: 'sin panel' };
        const clicables =
          'a, input[type="submit"], input[type="button"], input[type="radio"], input[type="checkbox"], button';
        const fila = Array.from(panel.querySelectorAll('tr')).find((tr) =>
          (tr.textContent || '').replace(/\s+/g, '').includes(c)
        );
        let objetivo = fila ? fila.querySelector(clicables) || fila : null;
        if (!objetivo) {
          objetivo =
            Array.from(panel.querySelectorAll(clicables)).find((b) =>
              `${b.value || ''} ${b.textContent || ''}`.includes(c)
            ) || null;
        }
        if (!objetivo) return { ok: false, texto: (panel.innerText || '').slice(0, 600) };
        objetivo.setAttribute('data-robot-codigo', '1');
        return { ok: true };
      }, cod)
      .catch(() => ({ ok: false, texto: 'error al leer la lista' }));

    if (!marcado.ok) {
      this.logger.warn(`Código ${cod} no está en la lista de tipologías. Contenido: ${marcado.texto}`);
      await this._guardarDiagnostico(page, `codigo-tipologia-${cod}`);
      await this._clickPorIdSufijo(page, '_BtnSalirCodigoTipologia');
      await this._esperarPostbackTerminado(page);
      return false;
    }

    await page
      .locator('[data-robot-codigo="1"]')
      .first()
      .click({ timeout: 8000 })
      .catch(() =>
        page.evaluate(() => {
          const e = document.querySelector('[data-robot-codigo="1"]');
          if (e) e.click();
        })
      )
      .catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await this._esperarPostbackTerminado(page);
    await page.waitForTimeout(800);

    const texto = await page
      .evaluate(() => {
        const b = document.querySelector('[id$="_BtnCodigoTipologia"]');
        const l = document.querySelector('[id$="_LblDescripcionTipologia"]');
        return `${b ? b.value : ''} | ${l ? l.textContent : ''}`;
      })
      .catch(() => '');
    this.logger.info(`Tipología tras elegir código: ${texto.slice(0, 250)}`);
    if (await this._modalVisible(page, 'PanelCodigoTipologia')) {
      await this._clickPorIdSufijo(page, '_BtnSalirCodigoTipologia');
      await this._esperarPostbackTerminado(page);
    }
    return texto.includes(cod);
  }

  /** "Modifica" de Datos de la visita abre PanelPopVisita. */
  async _escribirVisita(page, v, onProgreso, avisos) {
    if (!v.resultado && !v.nombre1 && !v.documento) return;
    onProgreso('Navegando a pestaña Datos de la visita...');
    await this._irAPestana(page, 'Datos de la visita');
    if (
      !(await this._abrirModalConReintento(page, 'PanelPopVisita', '_BtnModificaVisita', 'Modifica'))
    ) {
      avisos.push('No se pudo abrir los datos de la visita.');
      return;
    }
    await this._cerrarAviso(page);

    const desplegables = [
      ['Resultado visita', v.resultado, '_CmbResultadoVisita'],
      ['Tipo Documento', v.tipoDocumento, '_CmbTipoDocVisita'],
    ];
    onProgreso('Llenando datos de la visita...');
    await this._llenarDesplegables(page, desplegables);
    const textos = [
      ['Fecha visita', v.fecha, '_TxtFechaVisita'],
      ['1er Nombre', v.nombre1, '_TxtNombre1'],
      ['2do Nombre', v.nombre2, '_TxtNombre2'],
      ['1er Apellido', v.apellido1, '_TxtApellido1'],
      ['2do Apellido', v.apellido2, '_TxtApellido2'],
      ['Documento', v.documento, '_TDctoVisita'],
    ];
    const vacios = await this._llenarTextosConVerificacion(page, textos);
    if (vacios.length > 0) avisos.push(`Visita sin llenar: ${vacios.join(', ')}.`);
    const mal = await this._verificarDesplegables(page, desplegables);
    if (mal.length > 0) avisos.push(`Visita: ${mal.join('; ')}.`);

    await this._habilitarParaEnvio(page, [...desplegables, ...textos].map((x) => x[2]));
    onProgreso('Guardando datos de la visita...');
    if (!(await this._guardarConRespaldo(page, '_BtnGuardaVisita'))) {
      avisos.push('No se pudo guardar la visita.');
    }
    const aviso = await this._cerrarAviso(page);
    if (aviso && /error|digite|seleccione|debe/i.test(aviso)) avisos.push(`Visita: ${aviso}`);
    await this._cerrarModalAbierto(page);
  }

  /**
   * Fotoreconocimiento: "+" abre PanelPopFoto (referencia + archivo). "Subir
   * Archivo" hace un postback COMPLETO (lleva un archivo, no puede ir por
   * UpdatePanel): la página se recarga y hay que volver a la pestaña antes
   * de la foto siguiente.
   * @param {Array<{ruta: string, titulo: string}>} fotos
   */
  async _subirFotos(page, fotos, onProgreso, avisos) {
    for (let i = 0; i < fotos.length; i++) {
      const foto = fotos[i];
      onProgreso(`Subiendo foto ${i + 1} de ${fotos.length}: ${foto.titulo}...`);
      await this._irAPestana(page, 'Datos de la visita');
      if (!(await this._abrirModalConReintento(page, 'PanelPopFoto', '_BtnAgregaFoto'))) {
        avisos.push(`No se pudo abrir "Subir fotografía" (faltaron ${fotos.length - i} foto(s)).`);
        return;
      }
      await this._llenarInput(page, 'Referencia', foto.titulo, { idSufijo: '_TRef' });
      try {
        await page.locator('[id$="_FileUpload1"]').first().setInputFiles(foto.ruta, { timeout: 10000 });
      } catch (error) {
        avisos.push(`Foto "${foto.titulo}": no se pudo adjuntar el archivo (${error.message}).`);
        await this._cerrarModalAbierto(page);
        continue;
      }
      const resultado = await this._enviarFoto(page, foto.titulo);
      if (!resultado) {
        avisos.push(`Foto "${foto.titulo}": no se confirmó la subida; revísela en edis.`);
        await this._guardarDiagnostico(page, `foto-${foto.titulo}`);
      }
      await this._cerrarAviso(page);
      await this._cerrarModalAbierto(page);
    }
  }

  /**
   * Pulsa "Subir Archivo" y espera a que la página se recargue o a que la
   * referencia aparezca en la lista de fotografías.
   */
  async _enviarFoto(page, titulo) {
    await page.evaluate(() => { window.__robotFoto = 1; }).catch(() => {});
    await page
      .locator('[id$="BtnSubirFoto"]')
      .first()
      .click({ timeout: 8000 })
      .catch(() =>
        page.evaluate(() => {
          const b = document.querySelector('[id$="BtnSubirFoto"]');
          if (b) b.click();
        })
      )
      .catch(() => {});

    const fin = Date.now() + 90000;
    while (Date.now() < fin) {
      await page.waitForTimeout(700);
      const estado = await page
        .evaluate((ref) => {
          if (document.readyState !== 'complete') return 'cargando';
          const panel = document.querySelector('[id$="_PanelFotografias"]');
          const texto = panel ? (panel.textContent || '').toUpperCase() : '';
          if (texto.includes(ref.toUpperCase())) return 'listo';
          return window.__robotFoto ? 'esperando' : 'recargada';
        }, titulo)
        .catch(() => 'cargando');
      if (estado === 'listo') return true;
      if (estado === 'recargada') {
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await this._esperarPostbackTerminado(page);
        this.logger.info(`Foto "${titulo}": la página se recargó tras subirla.`);
        return true;
      }
    }
    this.logger.warn(`Foto "${titulo}": ni recarga ni referencia en la lista tras 90 s.`);
    return false;
  }

  /**
   * Texto Motivo: la nube (BtnCargaTexto) abre PanelPopTexto con los
   * modelos; se pulsa el pedido, que llena epígrafe, encabezado, etc., y se
   * guarda.
   */
  async _cargarModeloTexto(page, modelo, onProgreso, avisos) {
    if (!modelo) return false;
    onProgreso('Navegando a pestaña Texto Motivo...');
    await this._irAPestana(page, 'Texto Motivo');
    onProgreso(`Cargando el modelo "${modelo}"...`);
    if (!(await this._abrirModalConReintento(page, 'PanelPopTexto', '_BtnCargaTexto'))) {
      avisos.push('No se pudo abrir la lista de modelos de texto motivo.');
      return false;
    }
    await this._esperarPostbackTerminado(page);

    const marcado = await page
      .evaluate((pedido) => {
        const norm = (t) =>
          String(t || '')
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .toUpperCase()
            .replace(/[_\s]+/g, ' ')
            .trim();
        document
          .querySelectorAll('[data-robot-modelo]')
          .forEach((e) => e.removeAttribute('data-robot-modelo'));
        const panel = document.querySelector('[id$="PanelPopTexto"]');
        if (!panel) return { ok: false, texto: 'sin panel' };
        const objetivo = norm(pedido);
        const textoDe = (el) => norm(`${el.value || ''} ${el.textContent || ''}`);
        const elegir = (selector) =>
          Array.from(panel.querySelectorAll(selector))
            .filter((el) => !/^SALIR$/.test(textoDe(el)) && textoDe(el).includes(objetivo))
            // El más corto es el más parecido: evita "Mutación de Tercera -
            // Englobe" cuando se pidió "Mutación de Tercera".
            .sort((a, b) => textoDe(a).length - textoDe(b).length)[0];
        const el =
          elegir('a, button, input[type="submit"], input[type="button"], input[type="image"]') ||
          elegir('tr') ||
          elegir('li, span, div');
        if (!el) return { ok: false, texto: (panel.innerText || '').slice(0, 800) };
        const clic =
          el.tagName === 'TR'
            ? el.querySelector('a, button, input[type="submit"], input[type="button"], input[type="image"]') || el
            : el;
        clic.setAttribute('data-robot-modelo', '1');
        return { ok: true, elegido: textoDe(el).slice(0, 120) };
      }, modelo)
      .catch(() => ({ ok: false, texto: 'error al leer la lista' }));

    if (!marcado.ok) {
      this.logger.warn(`Modelo "${modelo}" no encontrado. Lista: ${marcado.texto}`);
      avisos.push(`Texto motivo: no se encontró el modelo "${modelo}"; elíjalo a mano con la nube.`);
      await this._guardarDiagnostico(page, 'modelo-texto');
      await this._clickPorIdSufijo(page, '_BtnSalirTexto');
      await this._esperarPostbackTerminado(page);
      return false;
    }
    this.logger.info(`Modelo de texto elegido: ${marcado.elegido}`);

    await page
      .locator('[data-robot-modelo="1"]')
      .first()
      .click({ timeout: 8000 })
      .catch(() =>
        page.evaluate(() => {
          const e = document.querySelector('[data-robot-modelo="1"]');
          if (e) e.click();
        })
      )
      .catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    await this._esperarPostbackTerminado(page);
    await page.waitForTimeout(800);
    if (await this._modalVisible(page, 'PanelPopTexto')) {
      await this._clickPorIdSufijo(page, '_BtnSalirTexto');
      await this._esperarPostbackTerminado(page);
    }

    const epigrafe = await page
      .evaluate(() => {
        const el = document.querySelector('[id$="_TEpigrafe"]');
        return el ? el.value : '';
      })
      .catch(() => '');
    if (!epigrafe.trim()) {
      avisos.push(`Texto motivo: el modelo "${modelo}" no llenó el epígrafe; revíselo.`);
      return false;
    }

    onProgreso('Guardando texto motivo...');
    if (!(await this._guardarConRespaldo(page, '_BtnGuardaTexto'))) {
      avisos.push('No se pudo guardar el texto motivo.');
    }
    const aviso = await this._cerrarAviso(page);
    if (aviso && /error|digite|debe/i.test(aviso)) avisos.push(`Texto motivo: ${aviso}`);
    return true;
  }

  /** Matrícula ("140-198046") y NPN del trámite abierto. */
  async _leerMatriculaYNpn(page) {
    const d = await this._leerPorIds(page, {
      orip: '_TCodigoORIP',
      numero: '_TMatricula',
      npn: '_LblNpnRadicado',
    });
    const matricula = d.orip && d.numero ? `${d.orip}-${d.numero}` : d.numero || '';
    return { matricula, npn: d.npn || '' };
  }

  /**
   * Motivada: en "Considerando" se deja el texto del modelo hasta la frase de
   * corte y desde ahí se pone la motivada; en "Artículos finales" se
   * reemplazan los artículos (del segundo en adelante).  {MATRICULA} y {NPN}
   * se cambian por los del radicado.  Cada parte se guarda y se comprueba
   * que quedó.
   */
  async _escribirMotivada(page, motivada, delPredio, radicado, onProgreso, avisos) {
    const valores = { MATRICULA: delPredio.matricula, NPN: delPredio.npn, RADICADO: radicado };
    const usadas = [...`${motivada.considerando || ''} ${motivada.articulos || ''}`.matchAll(/\{(\w+)\}/g)].map(
      (m) => m[1]
    );
    const faltan = [...new Set(usadas)].filter((k) => !valores[k]);
    if (faltan.length > 0) {
      avisos.push(
        `Motivada: no se escribió porque no se pudo leer ${faltan.join(' y ')} del trámite.`
      );
      return;
    }
    const rellenar = (texto) =>
      String(texto || '')
        .replace(/\r\n/g, '\n')
        .replace(/\{(\w+)\}/g, (todo, k) => (k in valores ? valores[k] : todo))
        .trim();

    if (motivada.considerando) {
      onProgreso('Escribiendo la motivada en Considerando...');
      await this._irAPestana(page, 'Considerando');
      const actual = String(
        (await this._leerPorIds(page, { t: '_TConsiderando' })).t || ''
      ).replace(/\r\n/g, '\n');
      const corte = String(motivada.corte || '').trim();
      let indice = corte ? actual.indexOf(corte) : -1;
      if (indice < 0 && corte) indice = actual.toLowerCase().indexOf(corte.toLowerCase());
      if (indice < 0) {
        avisos.push(
          `Motivada: no se encontró la frase de corte "${corte}" en Considerando; no se cambió.`
        );
      } else {
        const nuevo = [actual.slice(0, indice).trim(), rellenar(motivada.considerando)]
          .filter(Boolean)
          .join('\n\n');
        await this._escribirTextoLargo(page, 'Considerando', '_TConsiderando', nuevo);
        await this._guardarTextoYComprobar(
          page,
          '_TConsiderando',
          rellenar(motivada.considerando).slice(0, 60),
          'Considerando',
          onProgreso,
          avisos
        );
      }
    }

    if (motivada.articulos) {
      onProgreso('Escribiendo los artículos finales...');
      await this._irAPestana(page, 'Artículos finales');
      await this._escribirTextoLargo(page, 'Artículos finales', '_TArticulos', rellenar(motivada.articulos));
      await this._guardarTextoYComprobar(
        page,
        '_TArticulos',
        rellenar(motivada.articulos).slice(0, 60),
        'Artículos finales',
        onProgreso,
        avisos
      );
    }
  }

  /** Escribe un texto largo en un área de texto y confirma que quedó entero. */
  async _escribirTextoLargo(page, etiqueta, sufijo, texto) {
    await this._esperarPostbackTerminado(page);
    await this._llenarInput(page, etiqueta, texto, { idSufijo: sufijo });
    const quedo = String((await this._leerPorIds(page, { t: sufijo })).t || '').replace(/\r\n/g, '\n');
    if (quedo !== texto.trim()) {
      // Respaldo por JS si el llenado normal no dejó el texto completo.
      await page
        .evaluate(
          ({ s, v }) => {
            for (const el of document.querySelectorAll(`[id$="${s}"]`)) {
              el.removeAttribute('disabled');
              el.removeAttribute('readonly');
              el.value = v;
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          },
          { s: sufijo, v: texto }
        )
        .catch(() => {});
      this.logger.warn(`${etiqueta}: el texto se puso por JS.`);
    }
  }

  /** Pulsa "Guardar Texto" y comprueba que el texto siguió ahí tras el postback. */
  async _guardarTextoYComprobar(page, sufijo, inicioEsperado, etiqueta, onProgreso, avisos) {
    onProgreso(`Guardando ${etiqueta}...`);
    await this._habilitarParaEnvio(page, ['_TEpigrafe', '_TEncabezado', '_TConsiderando', '_TArticulo1', '_TArticulos']);
    if (!(await this._guardarConRespaldo(page, '_BtnGuardaTexto'))) {
      avisos.push(`No se pudo guardar ${etiqueta}.`);
      return;
    }
    const aviso = await this._cerrarAviso(page);
    if (aviso && /error|digite|debe/i.test(aviso)) avisos.push(`${etiqueta}: ${aviso}`);
    await this._esperarPostbackTerminado(page);
    const quedo = String((await this._leerPorIds(page, { t: sufijo })).t || '').replace(/\s+/g, ' ');
    if (!quedo.includes(inicioEsperado.replace(/\s+/g, ' '))) {
      avisos.push(`${etiqueta}: tras guardar, el texto no aparece; revíselo en edis.`);
      await this._guardarDiagnostico(page, `motivada-${etiqueta}`);
    } else {
      this.logger.info(`${etiqueta} guardado y comprobado.`);
    }
  }

  /* ----- ayudantes de llenado con verificación ----- */

  /** Desplegables en orden, esperando el postback de cada uno antes del siguiente. */
  async _llenarDesplegables(page, campos) {
    for (const [etiqueta, valor, sufijo] of campos) {
      if (!valor) continue;
      await this._esperarPostbackTerminado(page);
      await this._llenarInput(page, etiqueta, valor, { idSufijo: sufijo });
      await this._esperarPostbackTerminado(page);
    }
  }

  /** Devuelve los desplegables cuyo valor elegido no es el pedido. */
  async _verificarDesplegables(page, campos) {
    const pedidos = campos.filter(([, valor]) => valor);
    const elegidos = await page
      .evaluate((sufijos) => {
        const salida = {};
        for (const s of sufijos) {
          const todos = Array.from(document.querySelectorAll(`[id$="${s}"]`));
          const el =
            todos.find((e) => e.offsetParent !== null || e.getClientRects().length > 0) ||
            todos[0];
          const op = el && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
          salida[s] = op ? op.text : '';
        }
        return salida;
      }, pedidos.map((c) => c[2]))
      .catch(() => ({}));
    const norm = (t) =>
      String(t || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toUpperCase()
        .replace(/[_\s.]+/g, ' ')
        .trim();
    const mal = [];
    for (const [etiqueta, valor, sufijo] of pedidos) {
      const elegido = norm(elegidos[sufijo]);
      if (!elegido || !elegido.includes(norm(valor))) {
        mal.push(`${etiqueta} quedó "${elegidos[sufijo] || 'vacío'}" en vez de "${valor}"`);
      }
    }
    if (mal.length > 0) this.logger.warn(`Desplegables distintos a lo pedido: ${mal.join('; ')}`);
    return mal;
  }

  /**
   * Escribe textos y rehace los que un postback dejó vacíos (hasta 3 rondas).
   * Devuelve las etiquetas que siguieron vacías.
   */
  async _llenarTextosConVerificacion(page, campos) {
    const pedidos = campos.filter(([, valor]) => valor);
    for (const [etiqueta, valor, sufijo] of pedidos) {
      await this._llenarInput(page, etiqueta, valor, { idSufijo: sufijo });
    }
    let vacios = [];
    for (let ronda = 1; ronda <= 3; ronda++) {
      await this._esperarPostbackTerminado(page);
      const valores = await page
        .evaluate((sufijos) => {
          const salida = {};
          for (const s of sufijos) {
            const todos = Array.from(document.querySelectorAll(`[id$="${s}"]`));
            const el =
              todos.find((e) => e.offsetParent !== null || e.getClientRects().length > 0) ||
              todos[0];
            salida[s] = el ? el.value : '';
          }
          return salida;
        }, pedidos.map((c) => c[2]))
        .catch(() => ({}));
      vacios = pedidos.filter(([, , sufijo]) => !String(valores[sufijo] || '').trim());
      if (vacios.length === 0) break;
      this.logger.warn(`Ronda ${ronda}: rehaciendo ${vacios.map((c) => c[0]).join(', ')}.`);
      for (const [etiqueta, valor, sufijo] of vacios) {
        await this._llenarInput(page, etiqueta, valor, { idSufijo: sufijo });
      }
    }
    return vacios.map((c) => c[0]);
  }

  /** Un campo deshabilitado no viaja al guardar: se habilitan justo antes. */
  async _habilitarParaEnvio(page, sufijos) {
    await page
      .evaluate((lista) => {
        for (const s of lista) {
          for (const el of document.querySelectorAll(`[id$="${s}"]`)) {
            el.removeAttribute('disabled');
            el.removeAttribute('readonly');
            el.disabled = false;
            if ('readOnly' in el) el.readOnly = false;
          }
        }
      }, sufijos)
      .catch(() => {});
  }

  async _modalVisible(page, idParcial) {
    return page
      .evaluate((id) => {
        const el = document.querySelector(`[id$="${id}"]`);
        if (!el) return false;
        const est = getComputedStyle(el);
        return est.display !== 'none' && est.visibility !== 'hidden';
      }, idParcial)
      .catch(() => false);
  }

  /* ===================== NAVEGACIÓN ===================== */

  async _abrirTramite(page, radicado) {
    const timeout = this.config.browser.timeoutMs;
    const partes = this._partes(radicado);
    const num = `${partes.anio}-${partes.numero}`;

    await page.goto(this.config.bandeja.url, {
      waitUntil: 'domcontentloaded',
      timeout,
    });

    // 1) Abrir el modal con la cuadrícula "TRÁMITES ASIGNADOS" (GridRad, dentro
    //    del PanelPopRad). No se llenan AÑO/NÚMERO: están disabled y la
    //    cuadrícula ya lista TODOS los trámites asignados.
    await this._clickBuscarRadicado(page);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // 2) Clic en el radicado dentro de la cuadrícula. Cada fila trae el radicado
    //    como <input type="submit" value="2026-8728">; pulsarlo hace postback,
    //    carga el trámite y cierra el modal.
    const pulsado = await this._clickRadicadoEnGrid(page, num, 15000);
    if (!pulsado) {
      await this._guardarDiagnostico(page, `busqueda-${radicado}`);
      throw new Error(
        `No se encontró el radicado ${num} en la cuadrícula TRÁMITES ASIGNADOS. ` +
          `Se guardó el HTML en la carpeta 'diagnostico'.`
      );
    }
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await this._cerrarAviso(page);

    // 3) Esperar a que el modal se cierre y el trámite quede realmente cargado
    //    (el campo Radicación NÚMERO debe pasar a ser el buscado).
    const cargado = await this._esperarTramiteCargado(page, partes.numero, 15000);

    await this._guardarDiagnostico(page, `busqueda-${radicado}`);
    this.logger.info(
      `Trámite ${radicado} abierto (cargado=${cargado ? 'sí' : 'NO'}). URL: ${page.url()}`
    );

    if (!cargado) {
      throw new Error(
        `Se pulsó el radicado ${num} pero el trámite no terminó de cargar ` +
          `(el modal no se cerró o el NÚMERO no coincidió). Ver 'diagnostico'.`
      );
    }
  }

  /**
   * Pulsa el radicado dentro de la cuadrícula GridRad (es un
   * <input type="submit" value="AAAA-NNNN">). Sondea hasta `limiteMs` porque la
   * cuadrícula se llena por postback tras abrir el modal.
   */
  async _clickRadicadoEnGrid(page, num, limiteMs) {
    const objetivo = String(num).replace(/\s+/g, '').trim();
    const fin = Date.now() + limiteMs;

    while (Date.now() < fin) {
      for (const frame of page.frames()) {
        const marcado = await frame
          .evaluate((objetivo) => {
            document
              .querySelectorAll('[data-robot-abrir]')
              .forEach((e) => e.removeAttribute('data-robot-abrir'));
            const norm = (t) => (t || '').replace(/\s+/g, '').trim();
            // El radicado es un botón submit con value="AAAA-NNNN"; se acepta
            // también un enlace por si en otra pantalla cambia.
            for (const el of document.querySelectorAll(
              'input[type="submit"], input[type="button"], a'
            )) {
              const txt = el.tagName === 'INPUT' ? norm(el.value) : norm(el.textContent);
              if (txt === objetivo) {
                el.setAttribute('data-robot-abrir', '1');
                return true;
              }
            }
            return false;
          }, objetivo)
          .catch(() => false);

        if (marcado) {
          await frame
            .locator('[data-robot-abrir="1"]')
            .click({ timeout: 6000 })
            .catch(() => {});
          this.logger.info(`Radicado ${num} pulsado en la cuadrícula.`);
          return true;
        }
      }
      await page.waitForTimeout(500);
    }
    this.logger.warn(`Radicado ${num} no apareció en la cuadrícula.`);
    return false;
  }

  /**
   * Espera a que el modal PanelPopRad se cierre y el trámite buscado quede
   * cargado (el input Radicación NÚMERO pasa a ser el número buscado).
   */
  async _esperarTramiteCargado(page, numero, limiteMs) {
    const fin = Date.now() + limiteMs;
    while (Date.now() < fin) {
      const estado = await page
        .evaluate((numero) => {
          const modal = document.getElementById('ctl00_ContentPlaceHolder1_PanelPopRad');
          // El modal es position:fixed, así que offsetParent no sirve; se mira
          // display/visibility computados.
          const est = modal ? getComputedStyle(modal) : null;
          const modalVisible = Boolean(
            modal && est && est.display !== 'none' && est.visibility !== 'hidden'
          );
          const tnum =
            document.getElementById('ctl00_ContentPlaceHolder1_TNumRad') ||
            document.querySelector('[id$="TNumRad"]');
          const cargadoNum = Boolean(tnum && String(tnum.value).trim() === String(numero));
          return { modalVisible, cargadoNum };
        }, numero)
        .catch(() => ({ modalVisible: true, cargadoNum: false }));

      if (!estado.modalVisible && estado.cargadoNum) return true;
      await this._cerrarAviso(page);
      await page.waitForTimeout(500);
    }
    return false;
  }

  /**
   * Pulsa el botón que busca un radicado en la página de resolución.  Se
   * prueba primero el ID conocido (BtnBuscaRad) y los candidatos de config
   * (los mismos que usa el BandejaScraper), y por último la lupa marcada.
   */
  async _clickBuscarRadicado(page) {
    const candidatos = [
      '#ctl00_ContentPlaceHolder1_BtnBuscaRad',
      ...(this.config.bandeja.accionesApertura || []),
      '[data-robot-campo="buscar"]',
    ];
    for (const sel of candidatos) {
      for (const frame of page.frames()) {
        try {
          const el = frame.locator(sel).first();
          if ((await el.count().catch(() => 0)) === 0) continue;
          await el.click({ timeout: 6000 });
          this.logger.info(`Búsqueda de radicado con: ${sel}`);
          return sel;
        } catch {
          // No clicable en este marco; siguiente candidato.
        }
      }
    }
    this.logger.warn('No se pudo pulsar ningún botón de búsqueda de radicado.');
    return null;
  }

  /**
   * Pulsa un botón por el SUFIJO de su id (los controles de edis tienen ids
   * largos tipo ctl00_ContentPlaceHolder1_TabContainer1_TabPanel1_BtnModPredio;
   * el sufijo "_BtnModPredio" lo identifica sin ambigüedad). Busca en todos los
   * marcos y solo pulsa el que esté visible.  Devuelve true si pulsó alguno.
   */
  async _clickPorIdSufijo(page, sufijo, { timeout = 8000, espera = 5000 } = {}) {
    // Se espera a que aparezca visible en vez de descartarlo al instante: tras
    // un postback el panel puede tardar en mostrarse y el botón existía pero
    // todavía no era visible.
    await page
      .locator(`[id$="${sufijo}"]`)
      .first()
      .waitFor({ state: 'visible', timeout: espera })
      .catch(() => {});

    for (const frame of page.frames()) {
      const candidatos = frame.locator(`[id$="${sufijo}"]`);
      const total = await candidatos.count().catch(() => 0);
      for (let i = 0; i < total; i++) {
        const el = candidatos.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        try {
          await el.click({ timeout });
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(1000);
          this.logger.info(`Botón *${sufijo} pulsado.`);
          return true;
        } catch {
          // Visible pero no clicable ahora; se prueba el siguiente.
        }
      }
    }
    this.logger.warn(`Botón *${sufijo} no encontrado/clicable.`);
    return false;
  }

  /**
   * Cierra el cartel emergente de edis (botón "Aceptar") si está en pantalla y
   * devuelve su texto. Dejarlo abierto tapa la página y bloquea todo lo demás.
   */
  async _cerrarAviso(page) {
    try {
      const boton = page
        .locator("button:has-text('Aceptar'), input[value='Aceptar'], a:has-text('Aceptar')")
        .first();
      if (!(await boton.isVisible({ timeout: 1500 }).catch(() => false))) return '';

      // El texto del cartel, no el de toda la página: se sube desde el botón
      // hasta el contenedor que trae el mensaje (p. ej. "ERROR: NO HUBO
      // INTERSECCIÓN CON ZONAS").
      const texto = await boton
        .evaluate((b) => {
          let nodo = b.parentElement;
          for (let i = 0; i < 5 && nodo; i++) {
            const t = (nodo.innerText || '').replace(/\s+/g, ' ').trim();
            if (t.length > 8 && t.length < 400) return t;
            nodo = nodo.parentElement;
          }
          return '';
        })
        .catch(() => '');
      await boton.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(800);
      this.logger.info(`Aviso de edis: "${texto.slice(0, 200)}"`);
      return texto;
    } catch {
      return '';
    }
  }

  async _irAPestana(page, nombre) {
    // Se busca y MARCA la pestaña con JS dentro de la página (patrón probado en
    // el resto del código), en TODOS los marcos, y luego se hace clic con
    // Playwright sobre el elemento marcado. Es mucho más robusto que un
    // locator de texto: encuentra el enlace aunque el rótulo esté dentro de un
    // <span>, tolera acentos/espacios y funciona con los LinkButton de ASP.NET
    // (href="javascript:__doPostBack(...)").
    for (const frame of page.frames()) {
      const info = await frame
        .evaluate(MARCAR_PESTANA, { nombre })
        .catch(() => ({ encontrado: false }));
      if (!info.encontrado) continue;

      const tab = frame.locator('[data-robot-pestana="1"]');
      // Se COMPRUEBA que la pestaña quedó activa: un clic tras un postback
      // puede perderse y el panel seguir oculto, con lo que sus botones
      // "no existen" aunque estén en la página.
      for (let intento = 1; intento <= 3; intento++) {
        await tab.click({ timeout: 8000 }).catch(async () => {
          await frame.evaluate(() => {
            const el = document.querySelector('[data-robot-pestana="1"]');
            if (el) el.click();
          });
        });
        await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});

        const fin = Date.now() + 6000;
        while (Date.now() < fin) {
          const activa = await frame
            .evaluate(() => {
              const el = document.querySelector('[data-robot-pestana="1"]');
              if (!el) return false;
              for (let n = el, i = 0; n && i < 4; n = n.parentElement, i++) {
                if ((n.className || '').toString().includes('ajax__tab_active')) return true;
              }
              return false;
            })
            .catch(() => false);
          if (activa) {
            await page.waitForTimeout(800);
            this.logger.info(`Pestaña "${nombre}" activa (${info.tag}, texto="${info.texto}").`);
            return;
          }
          await page.waitForTimeout(400);
        }
        this.logger.warn(`La pestaña "${nombre}" no quedó activa (intento ${intento}).`);
      }
      // No se pudo confirmar, pero se sigue: puede ser una pestaña sin la
      // marca de activa del toolkit.
      await page.waitForTimeout(1500);
      this.logger.warn(`Se continúa sin confirmar la pestaña "${nombre}".`);
      return;
    }

    // No se encontró en ningún marco: guardar diagnóstico y reportar qué había.
    const diag = await page.evaluate(MARCAR_PESTANA, { nombre }).catch(() => ({ enlaces: [] }));
    const frames = page.frames().map((f) => f.url());
    this.logger.warn(
      `Pestaña "${nombre}" no encontrada.\n` +
        `  URL: ${page.url()}\n` +
        `  Enlaces en página: ${(diag.enlaces || []).join(' | ')}\n` +
        `  Marcos: ${frames.join(', ')}`
    );
    await this._guardarDiagnostico(page, `pestana-no-encontrada-${nombre}`);
    throw new Error(
      `No se encontró la pestaña "${nombre}". ` +
        `Enlaces vistos: ${(diag.enlaces || []).slice(0, 15).join(', ') || '(ninguno)'}.`
    );
  }

  async _clickBotonAccion(page, texto) {
    for (const selector of [
      `a:has-text("${texto}")`,
      `input[value="${texto}"]`,
      `button:has-text("${texto}")`,
    ]) {
      const boton = page.locator(selector).first();
      if (await boton.isVisible({ timeout: 2000 }).catch(() => false)) {
        await boton.click({ timeout: 5000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1500);
        this.logger.info(`Botón "${texto}" pulsado.`);
        return true;
      }
    }
    this.logger.warn(`Botón "${texto}" no encontrado.`);
    return false;
  }

  /**
   * Pulsa "Aplica Zonas Digitales" y devuelve el resultado.  edis puede
   * responder con un cartel propio ("ERROR: NO HUBO INTERSECCIÓN CON ZONAS"
   * cuando el predio no tiene geometría que cruce con las zonas); ese mensaje
   * se recoge y se devuelve para poder mostrárselo a quien usa el programa, en
   * vez de quedar enterrado en el log.
   * @returns {Promise<{aplicada: boolean, aviso: string}>}
   */
  async _aplicarZonasDigitales(page) {
    let avisoEdis = '';
    // Comprobar que el área sigue escrita justo antes de pulsar: si un postback
    // anterior la borró, aplicar zonas no haría nada y quedaría sin explicación.
    // Si edis vuelve a deshabilitar el campo, su valor NO viaja en el envío y
    // el servidor recibiría 0: por eso se deja constancia del estado exacto.
    const antes = await page
      .evaluate(() => {
        const el = document.querySelector('[id$="_TAreaTTPrivada"]');
        if (!el) return { area: '', disabled: null, nombre: '' };
        return {
          area: el.value,
          disabled: el.disabled,
          nombre: el.getAttribute('name') || '',
        };
      })
      .catch(() => ({ area: '', disabled: null, nombre: '' }));
    this.logger.info(
      `Área antes de aplicar zonas: "${antes.area}" disabled=${antes.disabled} ` +
        `name="${antes.nombre}"`
    );

    const boton = page.locator('[id$="_BtnGetZonasD"]').first();
    if (!(await boton.isVisible({ timeout: 8000 }).catch(() => false))) {
      this.logger.warn('No se encontró el botón "Aplica Zonas Digitales".');
      return false;
    }

    // La página usa UpdatePanel (Sys.WebForms.PageRequestManager): el botón
    // dispara un postback ASÍNCRONO, sin navegación.  Esperar navegación era lo
    // que agotaba los 2 minutos sin que pasara nada.  Se engancha el fin de la
    // petición para saber cuándo terminó y para ver el error si el servidor
    // falla (de otro modo el fallo es invisible).
    await page
      .evaluate(() => {
        window.__robotZonas = { fin: 0, error: '' };
        const S = window.Sys;
        if (!S || !S.WebForms || !S.WebForms.PageRequestManager) return;
        if (window.__robotZonasHook) return;
        window.__robotZonasHook = true;
        S.WebForms.PageRequestManager.getInstance().add_endRequest((s, e) => {
          const err = e.get_error && e.get_error();
          window.__robotZonas.error = err ? String(err.message || err) : '';
          window.__robotZonas.fin = Date.now();
          if (err && e.set_errorHandled) e.set_errorHandled(true);
        });
      })
      .catch(() => {});

    // Capturar la RESPUESTA del postback asíncrono: es la única forma de ver
    // qué contesta edis cuando no aplica las zonas y no muestra aviso.
    const respuestas = [];
    const onResponse = async (res) => {
      try {
        if (res.request().method() !== 'POST') return;
        const cuerpo = await res.text();
        if (cuerpo && /zona/i.test(cuerpo)) respuestas.push(cuerpo);
      } catch {
        // Respuesta no legible; se ignora.
      }
    };
    page.on('response', onResponse);

    const inicio = Date.now();
    await boton.click({ timeout: 15000 }).catch((e) => {
      this.logger.warn(`No se pudo pulsar zonas digitales: ${e.message.split('\n')[0]}`);
    });

    // El cálculo tarda unos segundos: se espera un mínimo antes de dar por
    // terminado, porque el primer endRequest puede ser de otro postback.
    await page.waitForTimeout(5000);

    const limite = Date.now() + 40000;
    let estado = await this._leerEstadoTerreno(page);
    let postback = { fin: 0, error: '' };
    while (Date.now() < limite) {
      postback = await page
        .evaluate(() => window.__robotZonas || { fin: 0, error: '' })
        .catch(() => postback);
      estado = await this._leerEstadoTerreno(page);
      if (estado.filasZonas > 0) break;
      const aviso = await this._cerrarAviso(page);
      if (aviso) {
        avisoEdis = aviso;
        break;
      }
      await page.waitForTimeout(1000);
    }
    page.off('response', onResponse);

    this.logger.info(
      `Zonas digitales: ${Date.now() - inicio} ms, postback=${postback.fin ? 'sí' : 'NO'}` +
        `${postback.error ? `, error="${postback.error}"` : ''}`
    );
    for (const cuerpo of respuestas.slice(-2)) {
      const limpio = cuerpo.replace(/\s+/g, ' ');
      const zona = limpio.match(/.{0,120}zona.{0,200}/i);
      this.logger.info(`Respuesta de edis (zonas): ${zona ? zona[0] : limpio.slice(0, 300)}`);
    }
    avisoEdis = avisoEdis || (await this._cerrarAviso(page));

    estado = await this._leerEstadoTerreno(page);
    this.logger.info(
      `Terreno tras aplicar zonas: area="${estado.area}" total="${estado.total}" ` +
        `filasZonas=${estado.filasZonas}`
    );

    if (estado.filasZonas > 0 || parseFloat(String(estado.total).replace(',', '.')) > 0) {
      this.logger.info('Zonas digitales aplicadas.');
      return { aplicada: true, aviso: avisoEdis };
    }
    await this._guardarDiagnostico(page, 'zonas-digitales');
    this.logger.warn(
      `Las zonas no quedaron aplicadas${avisoEdis ? `: ${avisoEdis}` : ''}.`
    );
    return { aplicada: false, aviso: avisoEdis };
  }

  /** Estado de la pestaña Terreno: área, suma, filas de zonas y avisos. */
  async _leerEstadoTerreno(page) {
    return page
      .evaluate(() => {
        const val = (s) => {
          const el = document.querySelector(`[id$="${s}"]`);
          if (!el) return '';
          return (el.value !== undefined ? el.value : el.textContent || '').trim();
        };
        // Filas con datos de la grilla de ZONAS (encabezado IdCIZona).
        let filasZonas = 0;
        for (const tabla of document.querySelectorAll('table')) {
          const filas = Array.from(tabla.querySelectorAll('tr'));
          if (filas.length < 2) continue;
          const cab = (filas[0].textContent || '').toUpperCase();
          if (!cab.includes('IDCIZONA')) continue;
          filasZonas = filas.slice(1).filter((f) => (f.textContent || '').trim()).length;
          break;
        }
        const texto = (document.body.innerText || '').replace(/\s+/g, ' ');
        const m = texto.match(/[^.]*(ZONA[^.]{0,80}|no se encontr[^.]{0,80})/i);
        return {
          area: val('_TAreaTTPrivada'),
          total: val('_LblAreaTotalTerreno'),
          filasZonas,
          mensaje: m ? m[0].trim().slice(0, 150) : '',
        };
      })
      .catch(() => ({ area: '', total: '', filasZonas: 0, mensaje: '' }));
  }

  /**
   * Abre un modal pulsando su botón y verifica que quedó visible; si no,
   * reintenta (por id y luego por texto).  Sin esta comprobación se escribía
   * dentro de un modal cerrado y los datos nunca llegaban a edis.
   */
  async _abrirModalConReintento(page, idModal, sufijoBoton, textoBoton) {
    for (let intento = 1; intento <= 3; intento++) {
      let pulsado =
        (await this._clickPorIdSufijo(page, sufijoBoton)) ||
        (textoBoton ? await this._clickBotonAccion(page, textoBoton) : false);

      // Último recurso: pulsarlo por JS aunque su panel no esté visible. Es un
      // botón de envío de ASP.NET, así que el postback se dispara igual. Sin
      // esto, si la pestaña no llegaba a mostrarse el modal nunca se abría y la
      // sección quedaba en blanco (pasaba en el trámite origen).
      if (!pulsado) {
        pulsado = await page
          .evaluate((s) => {
            const el = document.querySelector(`[id$="${s}"]`);
            if (!el) return false;
            el.click();
            return true;
          }, sufijoBoton)
          .catch(() => false);
        if (pulsado) {
          this.logger.info(`Botón *${sufijoBoton} pulsado por JS (panel no visible).`);
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(800);
        }
      }

      if (pulsado && (await this._esperarModal(page, idModal))) return true;
      this.logger.warn(`No se abrió ${idModal} (intento ${intento}).`);
      await this._cerrarAviso(page);
      await page.waitForTimeout(800);
    }
    this.logger.warn(`El modal ${idModal} no se pudo abrir; su sección no se llenará.`);
    return false;
  }

  /**
   * Espera a que el modal indicado quede visible (edis los abre por postback).
   * Devuelve true si apareció.
   */
  async _esperarModal(page, idParcial, limiteMs = 10000) {
    const fin = Date.now() + limiteMs;
    while (Date.now() < fin) {
      const visible = await page
        .evaluate((id) => {
          const el = document.querySelector(`[id$="${id}"]`);
          if (!el) return false;
          const est = getComputedStyle(el);
          return est.display !== 'none' && est.visibility !== 'hidden';
        }, idParcial)
        .catch(() => false);
      if (visible) {
        await page.waitForTimeout(600);
        this.logger.info(`Modal ${idParcial} visible.`);
        return true;
      }
      await page.waitForTimeout(400);
    }
    this.logger.warn(`El modal ${idParcial} no apareció.`);
    return false;
  }

  /**
   * Pulsa un botón de guardar con respaldo por JS.  Si no se puede pulsar de
   * la forma normal y no se insiste, el modal termina cerrándose con "Salir" y
   * se pierde TODO lo escrito (es lo que pasaba con la escritura: los campos
   * quedaban llenos y el guardado nunca llegaba a ejecutarse).
   */
  /**
   * Espera a que no quede ningún postback asíncrono en curso.  La página usa
   * UpdatePanel: si se escribe mientras uno está en vuelo, el formulario se
   * redibuja encima y lo escrito se pierde.
   */
  async _esperarPostbackTerminado(page, limiteMs = 12000) {
    const fin = Date.now() + limiteMs;
    while (Date.now() < fin) {
      const enCurso = await page
        .evaluate(() => {
          const S = window.Sys;
          if (!S || !S.WebForms || !S.WebForms.PageRequestManager) return false;
          return S.WebForms.PageRequestManager.getInstance().get_isInAsyncPostBack();
        })
        .catch(() => false);
      if (!enCurso) return true;
      await page.waitForTimeout(300);
    }
    this.logger.warn('Un postback asíncrono seguía en curso tras la espera.');
    return false;
  }

  async _guardarConRespaldo(page, sufijo, texto = 'Guardar') {
    if (await this._clickPorIdSufijo(page, sufijo)) return true;
    if (await this._clickBotonAccion(page, texto)) return true;

    const pulsado = await page
      .evaluate((s) => {
        const el = document.querySelector(`[id$="${s}"]`);
        if (!el) return false;
        el.click();
        return true;
      }, sufijo)
      .catch(() => false);

    if (!pulsado) {
      this.logger.warn(`No se pudo guardar con *${sufijo}.`);
      return false;
    }
    this.logger.info(`Botón *${sufijo} pulsado por JS (guardado).`);
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(1200);
    return true;
  }

  /**
   * Cierra cualquier modal PanelPop* que haya quedado abierto.  Son overlays a
   * pantalla completa (bg-black bg-opacity-75): si uno queda abierto, TODOS los
   * clics posteriores chocan contra él.  Se pulsa su botón "Salir".
   * @returns {Promise<string>} id del modal cerrado, o '' si no había ninguno
   */
  async _cerrarModalAbierto(page) {
    const abierto = await page
      .evaluate(() => {
        for (const el of document.querySelectorAll(
          '[id^="ctl00_ContentPlaceHolder1_PanelPop"]'
        )) {
          const est = getComputedStyle(el);
          if (est.display !== 'none' && est.visibility !== 'hidden') return el.id;
        }
        return '';
      })
      .catch(() => '');
    if (!abierto) return '';

    const marcado = await page
      .evaluate((id) => {
        document
          .querySelectorAll('[data-robot-cerrar]')
          .forEach((e) => e.removeAttribute('data-robot-cerrar'));
        const modal = document.getElementById(id);
        if (!modal) return false;
        const salir = Array.from(
          modal.querySelectorAll('input[type="submit"], input[type="button"], button, a')
        ).find((b) => /salir|cerrar|cancelar/i.test(b.value || b.textContent || ''));
        if (!salir) return false;
        salir.setAttribute('data-robot-cerrar', '1');
        return true;
      }, abierto)
      .catch(() => false);

    if (marcado) {
      await page
        .locator('[data-robot-cerrar="1"]')
        .click({ timeout: 5000 })
        .catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(800);
    }
    this.logger.warn(`Modal ${abierto} quedó abierto; se cerró antes de seguir.`);
    return abierto;
  }

  /* ===================== LECTURA ===================== */

  async _leerCamposVisibles(page) {
    return page.evaluate(() => {
      const resultado = {};
      const normalizar = (t) =>
        (t || '')
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '')
          .toUpperCase()
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/:$/, '');

      for (const fila of document.querySelectorAll('tr')) {
        const celdas = Array.from(fila.querySelectorAll('td, th'));
        if (celdas.length < 2) continue;

        for (let i = 0; i < celdas.length - 1; i++) {
          const celda = celdas[i];
          const tieneCampoVisible = Array.from(
            celda.querySelectorAll('select, input, textarea')
          ).some((c) => {
            const tipo = (c.getAttribute('type') || '').toLowerCase();
            return !['hidden', 'image', 'submit', 'button'].includes(tipo) && c.offsetParent;
          });
          if (tieneCampoVisible) continue;

          const etiqueta = normalizar(celda.innerText || celda.textContent);
          if (!etiqueta || etiqueta.length > 60 || etiqueta in resultado) continue;

          const siguiente = celdas[i + 1];
          for (const campo of siguiente.querySelectorAll('select, input, textarea')) {
            const tipo = (campo.getAttribute('type') || '').toLowerCase();
            if (['hidden', 'submit', 'image', 'button'].includes(tipo)) continue;
            if (!campo.offsetParent) continue;

            let valor;
            if (campo.tagName === 'SELECT') {
              const op = campo.options[campo.selectedIndex];
              valor = op ? op.text.trim() : '';
            } else {
              valor = (campo.value || '').trim();
            }
            if (valor && valor !== 'Label') {
              resultado[etiqueta] = {
                valor,
                id: campo.id || '',
                tipo: campo.tagName === 'SELECT' ? 'select' : 'text',
              };
            }
            break;
          }
          if (resultado[etiqueta]) continue;

          for (const span of celdas[i + 1].querySelectorAll('span')) {
            if (span.children.length > 0) continue;
            const t = (span.textContent || '').trim();
            if (t && t !== 'Label') {
              resultado[etiqueta] = { valor: t, id: span.id || '', tipo: 'readonly' };
              break;
            }
          }
        }
      }
      return resultado;
    });
  }

  /* ===================== MARCADO + LLENADO ===================== */

  async _marcarCampo(page, etiqueta, tag, { indice = 0 } = {}) {
    await page
      .evaluate((t) => {
        const prev = document.querySelector(`[data-robot-campo="${t}"]`);
        if (prev) prev.removeAttribute('data-robot-campo');
      }, tag)
      .catch(() => {});

    return page.evaluate(
      ({ etiqueta, tag, indice }) => {
        const normalizar = (t) =>
          (t || '')
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .toUpperCase()
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/:$/, '');
        const objetivo = normalizar(etiqueta);

        const esEditable = (campo) => {
          const tipo = (campo.getAttribute('type') || '').toLowerCase();
          if (['hidden', 'submit', 'image', 'button'].includes(tipo)) return false;
          return campo.offsetParent !== null;
        };

        for (const fila of document.querySelectorAll('tr')) {
          const celdas = Array.from(fila.querySelectorAll('td, th'));
          if (celdas.length < 2) continue;

          for (let i = 0; i < celdas.length - 1; i++) {
            const celda = celdas[i];
            const tieneCampoVisible = Array.from(
              celda.querySelectorAll('select, input, textarea')
            ).some((c) => esEditable(c));
            if (tieneCampoVisible) continue;

            const textoEtiqueta = normalizar(celda.innerText || celda.textContent);
            if (!textoEtiqueta.includes(objetivo)) continue;

            let encontrados = 0;
            const siguiente = celdas[i + 1];
            for (const campo of siguiente.querySelectorAll('select, input, textarea')) {
              if (!esEditable(campo)) continue;

              if (encontrados === indice) {
                campo.setAttribute('data-robot-campo', tag);
                if (campo.tagName === 'SELECT') {
                  const opciones = Array.from(campo.options).map((o) => ({
                    value: o.value,
                    text: o.text.trim(),
                    textNorm: normalizar(o.text),
                  }));
                  return { encontrado: true, tipo: 'select', id: campo.id || '', opciones };
                }
                return { encontrado: true, tipo: 'input', id: campo.id || '' };
              }
              encontrados++;
            }
          }
        }
        return { encontrado: false };
      },
      { etiqueta, tag, indice }
    );
  }

  /**
   * Marca un campo por el SUFIJO de su id.  Es la vía preferida: los ids de
   * edis son estables (p. ej. "_CmbDestino", "_TMatricula") mientras que las
   * etiquetas dependen del armado de la tabla.
   */
  async _marcarPorId(page, sufijo, tag) {
    return page
      .evaluate(
        ({ s, t }) => {
          const prev = document.querySelector(`[data-robot-campo="${t}"]`);
          if (prev) prev.removeAttribute('data-robot-campo');

          // Se exige que el campo esté VISIBLE: los modales de edis existen en
          // el DOM aunque estén cerrados, y escribir en uno cerrado no surte
          // efecto y además lo oculta como si hubiera funcionado.
          const els = Array.from(document.querySelectorAll(`[id$="${s}"]`));
          const visible = els.find(
            (e) => e.offsetParent !== null || e.getClientRects().length > 0
          );
          // Se prefiere el visible; si ninguno lo está pero el campo existe, se
          // usa igual: antes de guardar se habilitan, así que el valor viaja.
          const el = visible || els[0];
          if (!el) return { encontrado: false, oculto: false };
          el.setAttribute('data-robot-campo', t);

          if (el.tagName === 'SELECT') {
            const normalizar = (x) =>
              (x || '')
                .normalize('NFD')
                .replace(/[̀-ͯ]/g, '')
                .toUpperCase()
                .replace(/\s+/g, ' ')
                .trim();
            return {
              encontrado: true,
              tipo: 'select',
              id: el.id || '',
              opciones: Array.from(el.options).map((o) => ({
                value: o.value,
                text: o.text.trim(),
                textNorm: normalizar(o.text),
              })),
            };
          }
          return { encontrado: true, tipo: 'input', id: el.id || '' };
        },
        { s: sufijo, t: tag }
      )
      .catch(() => ({ encontrado: false }));
  }

  async _llenarInput(page, etiqueta, valor, { indice = 0, idSufijo = null } = {}) {
    if (!valor) return;
    const tag = `migrar-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Primero por id (estable); si no está, se cae a la búsqueda por etiqueta.
    let info = idSufijo ? await this._marcarPorId(page, idSufijo, tag) : null;
    if (!info || !info.encontrado) {
      info = await this._marcarCampo(page, etiqueta, tag, { indice });
    }
    if (!info.encontrado) {
      this.logger.warn(
        `Campo "${etiqueta}"${idSufijo ? ` (${idSufijo})` : ''} no encontrado` +
          `${info.oculto ? ' (existe pero está oculto: su modal no se abrió)' : ''}.`
      );
      return;
    }

    const locator = page.locator(`[data-robot-campo="${tag}"]`);

    // edis deja los campos deshabilitados hasta pulsar "Modifica". Si el botón
    // no los habilitó, se quita el disabled para poder escribir igualmente: al
    // guardar, el valor sí se envía porque el control ya no va deshabilitado.
    await page
      .evaluate((t) => {
        const el = document.querySelector(`[data-robot-campo="${t}"]`);
        if (!el) return;
        el.removeAttribute('disabled');
        el.removeAttribute('readonly');
        el.disabled = false;
        if ('readOnly' in el) el.readOnly = false;
      }, tag)
      .catch(() => {});

    if (info.tipo === 'select') {
      const norm = (t) =>
        (t || '')
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '')
          .toUpperCase()
          .replace(/[_\s]+/g, ' ')
          .trim();
      const objetivo = norm(valor);

      let mejor = null;
      for (const op of info.opciones) {
        const textoOp = norm(op.text);
        const valorOp = norm(op.value);
        if (textoOp === objetivo || valorOp === objetivo) {
          mejor = op;
          break;
        }
        if (!mejor && (textoOp.includes(objetivo) || objetivo.includes(textoOp))) mejor = op;
        if (!mejor && (valorOp.includes(objetivo) || objetivo.includes(valorOp))) mejor = op;
      }

      if (!mejor) {
        this.logger.warn(
          `Opción "${valor}" no encontrada en "${etiqueta}". ` +
            `Opciones: ${info.opciones.map((o) => o.text).join(', ')}`
        );
        return;
      }

      const puesto = await locator
        .selectOption(mejor.value, { timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      if (!puesto) {
        // Respaldo: fijar el valor por JS y avisar del cambio, por si el
        // control sigue bloqueado para la interacción normal.
        await page
          .evaluate(
            ({ t, v }) => {
              const el = document.querySelector(`[data-robot-campo="${t}"]`);
              if (!el) return;
              el.value = v;
              el.dispatchEvent(new Event('change', { bubbles: true }));
            },
            { t: tag, v: mejor.value }
          )
          .catch(() => {});
      }
      // Un desplegable de edis puede disparar un postback que vuelve a dibujar
      // el formulario: hay que dejarlo terminar antes de escribir lo demás, o
      // lo siguiente se pierde al redibujarse.
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1200);
      this.logger.info(`Select "${etiqueta}" = "${mejor.text}"${puesto ? '' : ' (por JS)'}`);
    } else {
      const puesto = await locator
        .fill(String(valor), { timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      if (!puesto) {
        await page
          .evaluate(
            ({ t, v }) => {
              const el = document.querySelector(`[data-robot-campo="${t}"]`);
              if (!el) return;
              el.value = v;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            },
            { t: tag, v: String(valor) }
          )
          .catch(() => {});
      }
      this.logger.info(`Input "${etiqueta}" = "${valor}"${puesto ? '' : ' (por JS)'}`);
    }
  }

  /* ===================== LLENADO POR SECCIÓN ===================== */

  /**
   * Campos del MODAL "DATOS DEL PREDIO" (PanelPopPredio).  Sus ids terminan en
   * "M" (CmbDestinoM, TMatriculaM...); los de la pantalla de atrás son de solo
   * lectura y escribir en ellos no surte efecto.
   */
  async _llenarCamposPredio(page, campos, extras) {
    await this._llenarInput(page, 'Destino', extras.destino || campos.destino, {
      idSufijo: '_CmbDestinoM',
    });

    // Matrícula partida: ORIP (círculo, p. ej. 140) + número (p. ej. 152987).
    let circulo = extras.matriculaCirculo || campos.orip || '';
    let numero = extras.matriculaNumero || campos.matricula || '';
    if (!circulo && numero && numero.includes('-')) {
      [circulo, numero] = numero.split('-', 2);
    }
    if (circulo) {
      await this._llenarInput(page, 'ORIP', circulo, { idSufijo: '_TCodigoORIPM' });
    }
    if (numero) {
      await this._llenarInput(page, 'Matricula', numero, { idSufijo: '_TMatriculaM' });
    }

    // El tipo de predio no viene del origen: siempre Predio.Privado.
    await this._llenarInput(page, 'Tipo Predio', extras.tipoPredio || 'Predio.Privado', {
      idSufijo: '_CmbTipoPredioM',
    });
  }

  /** Campos del modal PROPIETARIO (PanelPopPropietario), por id real. */
  /**
   * @param {object|null} propietario Fila de la grilla del origen; si es null
   *   se usa el solicitante del trámite (caso de las cancelaciones).
   */
  async _llenarCamposPropietarios(page, datosOrigen, extras, campos = {}, propietario = null) {
    const buscar = this._crearBuscador(datosOrigen);
    const p = propietario || {};

    await this._llenarInput(
      page,
      'Tipo Dcto',
      p.tipoDocumento || extras.tipoDocumento || buscar('TIPO DOC', 'TIPO DCTO'),
      { idSufijo: '_CmbTipoDoc' }
    );
    // Sin propietario en el origen, el documento sale de la cédula del
    // solicitante del trámite.
    await this._llenarInput(
      page,
      'Documento',
      p.documento || extras.documento || campos.cedula || buscar('DOCUMENTO', 'CEDULA'),
      { idSufijo: '_TDcto' }
    );
    await this._llenarInput(page, 'Tipo Derecho', extras.tipoDerecho || 'Dominio', {
      idSufijo: '_CmbTipoDerecho',
    });
    await this._llenarInput(
      page,
      'Fraccion de Derecho',
      p.porcentaje || extras.porcentaje || buscar('PORCENTAJE', 'FRACCION') || '1',
      { idSufijo: '_TPorcProp' }
    );

    // La fecha de inicio de tenencia es la de la escritura salvo que se indique.
    const fechaTenencia = extras.fechaTenencia || extras.fechaFuente || '';
    if (fechaTenencia) {
      await this._llenarInput(page, 'Fecha inicio tenencia', fechaTenencia, {
        idSufijo: '_TFechaTenencia',
      });
    }

    await this._llenarInput(page, 'Autoreconocimiento Etnico', extras.etnico || 'Ninguno', {
      idSufijo: '_CmbGrupoEtnico',
    });

    const nombreCompleto = p.nombre || extras.nombre || campos.nombre || buscar('NOMBRE');
    if (nombreCompleto) {
      const n = this._separarNombre(nombreCompleto);
      await this._llenarInput(page, '1er Nombre', n.primerNombre, { idSufijo: '_TNombre1' });
      await this._llenarInput(page, '2do Nombre', n.segundoNombre, { idSufijo: '_TNombre2' });
      await this._llenarInput(page, '1er Apellido', n.primerApellido, {
        idSufijo: '_TApellido1',
      });
      await this._llenarInput(page, '2do Apellido', n.segundoApellido, {
        idSufijo: '_TApellido2',
      });
    }

    await this._llenarInput(page, 'Sexo', extras.sexo || 'Masculino', { idSufijo: '_CmbSexo' });
  }

  /**
   * Campos del modal ESCRITURA / fuente administrativa (PanelPopEscritura).
   *
   * El desplegable "Tipo Fuente" dispara un postback que vuelve a dibujar el
   * modal, así que lo escrito después se perdía (en el origen quedaba solo el
   * tipo y el resto en blanco).  Por eso, tras llenar todo, se comprueba campo
   * por campo y se reescribe lo que haya quedado vacío.
   */
  async _llenarCamposFuente(page, datosOrigen, extras) {
    const buscar = this._crearBuscador(datosOrigen);
    const campos = [
      ['Tipo Fuente', extras.tipoFuente || 'Escritura', '_CmbTipoFuente'],
      ['Numero', extras.numeroFuente || buscar('NUMERO'), '_TEscrituraM'],
      ['Fecha', extras.fechaFuente || buscar('FECHA'), '_TFechaEscrituraM'],
      [
        'Ente Emisor',
        extras.enteEmisor || buscar('ENTE EMISOR', 'ENTE', 'NOTARIA'),
        '_TNotariaM',
      ],
      [
        'Fecha Inscripcion Catastral',
        extras.fechaInscripcion || buscar('INSCRIPCION'),
        '_TFechaICM',
      ],
      // edis la exige ("digite fecha de vigencia fiscal").
      [
        'Fecha Vigencia Fiscal',
        extras.fechaVigencia || buscar('VIGENCIA') || '01/01/2027',
        '_TFechaVigM',
      ],
    ];

    // El tipo de fuente va primero y SOLO: su postback vuelve a dibujar el
    // modal, así que todo lo demás se escribe cuando ya terminó.
    const [tipo, ...resto] = campos;
    await this._llenarInput(page, tipo[0], tipo[1], { idSufijo: tipo[2] });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await this._esperarPostbackTerminado(page);
    await page.waitForTimeout(1200);

    // Cada campo se escribe y se comprueba en el acto, reintentando el suyo:
    // así un redibujado a destiempo no deja el formulario a medias.
    for (const [etiqueta, valor, idSufijo] of resto) {
      if (!valor) continue;
      for (let intento = 1; intento <= 3; intento++) {
        await this._llenarInput(page, etiqueta, valor, { idSufijo });
        const actual = await this._leerPorIds(page, { v: idSufijo });
        if (String(actual.v || '').trim()) break;
        this.logger.warn(`"${etiqueta}" quedó vacío; se reescribe (intento ${intento}).`);
        await page.waitForTimeout(600);
      }
    }

    // Pasada final: no basta con MIRAR si quedó algo vacío, hay que volver a
    // llenarlo. El postback del tipo de fuente puede redibujar el formulario
    // después de escribir, y entonces se guardaba solo el tipo.
    const lectura = {};
    for (const [, , idSufijo] of campos) lectura[idSufijo] = idSufijo;

    let puestos = {};
    let vacios = [];
    for (let ronda = 1; ronda <= 3; ronda++) {
      puestos = await this._leerPorIds(page, lectura);
      vacios = campos.filter(
        ([, valor, idSufijo]) => valor && !String(puestos[idSufijo] || '').trim()
      );
      if (vacios.length === 0) break;

      this.logger.warn(
        `Fuente: se perdieron ${vacios.map((c) => c[0]).join(', ')}; ` +
          `se vuelven a llenar (ronda ${ronda}).`
      );
      for (const [etiqueta, valor, idSufijo] of vacios) {
        await this._llenarInput(page, etiqueta, valor, { idSufijo });
      }
      await page.waitForTimeout(800);
    }

    this.logger.info(
      `Fuente administrativa antes de guardar: ` +
        campos.map(([e, , id]) => `${e}="${puestos[id] || ''}"`).join(', ')
    );
    return vacios.map(([etiqueta]) => etiqueta);
  }

  /* ===================== UTILIDADES ===================== */

  _crearBuscador(datos) {
    return (...patrones) => {
      if (!datos) return '';
      for (const patron of patrones) {
        const norm = patron.toUpperCase();
        for (const [k, v] of Object.entries(datos)) {
          if (k.toUpperCase().includes(norm) && v.valor) return v.valor;
        }
      }
      return '';
    };
  }

  _buscarEn(datos, ...patrones) {
    return this._crearBuscador(datos)(...patrones);
  }

  _separarNombre(nombreCompleto) {
    const partes = String(nombreCompleto).trim().split(/\s+/);
    if (partes.length >= 4) {
      return {
        primerNombre: partes[0],
        segundoNombre: partes[1],
        primerApellido: partes[2],
        segundoApellido: partes.slice(3).join(' '),
      };
    }
    if (partes.length === 3) {
      return {
        primerNombre: partes[0],
        segundoNombre: '',
        primerApellido: partes[1],
        segundoApellido: partes[2],
      };
    }
    if (partes.length === 2) {
      return {
        primerNombre: partes[0],
        segundoNombre: '',
        primerApellido: partes[1],
        segundoApellido: '',
      };
    }
    return { primerNombre: nombreCompleto, segundoNombre: '', primerApellido: '', segundoApellido: '' };
  }

  _partes(radicado) {
    if (radicado && typeof radicado === 'object') {
      return { anio: String(radicado.anio), numero: String(radicado.numero) };
    }
    const texto = String(radicado || '').trim();
    // En la oficina se habla del radicado sin el año ("9642"): se asume el actual.
    if (/^\d+$/.test(texto)) return { anio: String(new Date().getFullYear()), numero: texto };
    const m = texto.match(/^(\d{2,4})-(\d+)/);
    if (!m) throw new Error(`Formato de radicado inválido: "${radicado}". Use AAAA-NNNN.`);
    const crudo = m[1];
    const anio = crudo.length <= 2 ? `20${crudo}` : crudo;
    return { anio, numero: m[2] };
  }

  async _guardarDiagnostico(page, nombre) {
    const carpeta = path.join(path.dirname(this.config.app.dbPath), 'diagnostico');
    const base = path.join(carpeta, String(nombre).replace(/[\\/:*?"<>|]/g, '-'));
    try {
      fs.mkdirSync(carpeta, { recursive: true });
    } catch (error) {
      this.logger.warn(`No se pudo crear carpeta de diagnóstico: ${error.message}`);
      return '';
    }

    // El HTML es lo más importante (trae el DOM real): se guarda por separado
    // para que un fallo al tomar la foto no impida capturarlo.
    try {
      const html = await page.content();
      fs.writeFileSync(`${base}.html`, html, 'utf8');
      this.logger.info(`Diagnóstico HTML guardado: ${base}.html`);
    } catch (error) {
      this.logger.warn(`No se pudo guardar HTML de diagnóstico: ${error.message}`);
    }

    try {
      await page.screenshot({ path: `${base}.png`, fullPage: true });
      return `${base}.png`;
    } catch (error) {
      this.logger.warn(`No se pudo guardar foto de diagnóstico: ${error.message}`);
      return '';
    }
  }
}

module.exports = { MigracionTramiteService };
