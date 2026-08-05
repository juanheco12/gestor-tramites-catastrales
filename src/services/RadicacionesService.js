'use strict';

/**
 * Números seguidos sin existir ("TRÁMITE NO ENCONTRADO") que se toman como
 * "llegué al final de la numeración". Con 4 alcanzaba para el final real,
 * pero un hueco algo más largo en el medio (radicados anulados, saltos del
 * aplicativo) cortaba el recorrido antes de tiempo y dejaba afuera lo que
 * venía después.
 */
const TOLERANCIA_HUECOS = 12;
/**
 * Tope de consultas por corrida. Solo se acerca a este número la PRIMERA
 * vez (hay que ubicar el tope de radicados de la oficina partiendo de cero);
 * después de eso cada corrida gasta apenas unas pocas.
 */
const MAX_CONSULTAS_POR_CORRIDA = 200;
/** Al activar el conteo, cuántos números hacia atrás se revisan para recuperar lo ya radicado hoy. */
const MAX_RETROCESO_INICIAL = 60;
/** Pausa entre consultas: el recorrido no debe sentirse como un ataque al servidor. */
const PAUSA_MS = 250;

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizarNombre(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Cuenta las radicaciones propias del personal de ventanilla.
 *
 * edis no tiene ningún reporte de "qué radiqué hoy" y ventanilla no tiene
 * permiso para generarlo: lo único disponible es consultar un radicado
 * puntual. Como los números son consecutivos y suben con la fecha, se
 * recorren hacia arriba desde el último ya explorado y se guardan los que
 * tienen "Usuario que radica" = el usuario logueado.
 *
 * Solo corre si el usuario activó el conteo en Mi perfil: el resto de los
 * ejecutores no radica, y gastarían consultas para nada.
 */
class RadicacionesService {
  /**
   * @param {import('../database/repositories/RadicacionRepository').RadicacionRepository} repo
   * @param {import('./ConsultaTramiteService').ConsultaTramiteService} consultaTramite
   * @param {import('../utils/logger').Logger} logger
   * @param {(mensaje: string) => void} [onProgreso]
   */
  constructor(repo, consultaTramite, logger, onProgreso = () => {}) {
    this.repo = repo;
    this.consulta = consultaTramite;
    this.logger = logger;
    this.onProgreso = onProgreso;
    // Traza de las últimas consultas (qué número se pidió y qué nombre se
    // leyó). Se muestra en pantalla: es la única forma de ver si el problema
    // está en el número que se busca, en la lectura del nombre, o en la
    // comparación, sin tener que suponerlo.
    this.muestras = [];
  }

  /**
   * @param {import('playwright').Page} page Página autenticada
   * @param {{numerosConocidos?: string[]}} opciones numerosConocidos: radicados
   *   que ya están en la base (los trámites propios), usados como pista para
   *   saber por dónde empezar a buscar en el primer arranque.
   * @returns {Promise<{nuevas: number, consultas: number, omitido?: string}>}
   */
  async detectar(page, { numerosConocidos = [] } = {}) {
    this.muestras = [];
    this.consulta.ultimaRadiografia = '';
    const resultado = await this._detectar(page, { numerosConocidos });
    // Si no se pudo leer "Usuario que radica" en ninguna consulta, se muestra
    // el HTML real de esa fila: es lo único que permite escribir el selector
    // correcto sin seguir adivinando la estructura de la página.
    const radiografia = this.consulta.ultimaRadiografia;
    const traza = this.muestras.join(' · ') + (radiografia ? ` ⟶ ${radiografia}` : '');
    this.repo.guardarEstado('radicaciones.traza', traza);
    // Queda registrado SIEMPRE, también cuando no hizo nada: una tabla vacía
    // sin explicación es lo que hizo perder tiempo antes.
    this.repo.guardarDiagnostico(this._explicar(resultado));
    return resultado;
  }

  async _detectar(page, { numerosConocidos = [] } = {}) {
    if (!this.repo.activo()) return { nuevas: 0, consultas: 0, omitido: 'inactivo' };

    const usuario = this.repo.obtenerEstado('radicaciones.usuario');
    if (!usuario) {
      return { nuevas: 0, consultas: 0, omitido: 'sin-usuario' };
    }

    const anio = String(new Date().getFullYear());
    const contador = { consultas: 0 };
    let ultimo = this.repo.ultimoExplorado(anio);
    let nuevas = 0;

    if (ultimo === null) {
      // Si el usuario indicó desde qué radicado empezar (sabe uno suyo), se
      // arranca ahí: es exacto y gratis, frente a adivinar por tanteo dónde
      // va la numeración de la oficina (decenas de consultas).
      const desde = this._numeroDesde(anio);
      if (desde !== null) {
        ultimo = desde - 1;
        this.logger.info(`Radicaciones: empezando el conteo desde ${anio}-${desde} (indicado por el usuario).`);
      } else {
        const arranque = await this._arranqueInicial(page, anio, numerosConocidos, usuario, contador);
        if (arranque === null) {
          return { nuevas: 0, consultas: contador.consultas, omitido: 'sin-punto-de-partida' };
        }
        ultimo = arranque.ultimo;
        nuevas += arranque.nuevas;
      }
    }

    const desdeDonde = ultimo + 1;
    const recorrido = await this._recorrerHaciaArriba(page, anio, ultimo, usuario, contador);
    nuevas += recorrido.nuevas;
    return {
      nuevas,
      consultas: contador.consultas,
      usuario,
      corte: recorrido.corte,
      anio,
      desdeDonde,
      hastaDonde: this.repo.ultimoExplorado(anio),
    };
  }

  /** Número de arranque configurado por el usuario ("2026-7272" -> 7272), si es de este año. */
  _numeroDesde(anio) {
    const m = String(this.repo.desde() || '').match(/^(\d{4})-(\d+)$/);
    if (!m || m[1] !== anio) return null;
    const n = parseInt(m[2], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  _explicar(r) {
    if (r.omitido === 'inactivo') return 'Conteo desactivado en Mi perfil.';
    if (r.omitido === 'sin-usuario') return 'Falta escribir su nombre de edis en Mi perfil.';
    if (r.omitido === 'sin-punto-de-partida') {
      return 'No se pudo ubicar el último radicado de la oficina. Indique en Mi perfil un radicado suyo desde el cual empezar.';
    }
    // Decir SIEMPRE desde y hasta qué radicado se revisó: "4 consultas" no
    // dejaba ver que el recorrido ya venía parado más allá de las
    // radicaciones del usuario, que era justamente el problema.
    const tramo = `revisado ${r.anio}-${r.desdeDonde} en adelante`;
    if (r.nuevas > 0) return `${r.nuevas} radicación(es) nuevas detectadas (${tramo}).`;
    // Si el recorrido se cortó por fallas al consultar, decirlo: antes esto
    // se veía igual que "revisé y no había nada suyo", que es muy distinto.
    if (r.corte === 'errores') {
      return `No se pudo leer la consulta de trámites: ${this.consulta.ultimoProblema || 'motivo desconocido'}`;
    }
    const base = `Sin radicaciones nuevas a nombre de "${r.usuario}" (${tramo}).`;
    // La sugerencia solo tiene sentido mientras no se haya detectado NADA:
    // ahí es cuando el puntero suele estar por encima de lo que se busca.
    if (this.repo.listar({ limite: 1 }).length > 0) return base;
    return `${base} Si las suyas son ANTERIORES a ese número, use "Volver a revisar" para retroceder.`;
  }

  /**
   * Primer arranque: ubica el tope actual de radicados y retrocede mientras
   * sigan siendo de hoy, para no perder lo que ya se radicó antes de activar
   * el conteo. Todo acotado, para no disparar cientos de consultas.
   * @returns {Promise<{ultimo: number, nuevas: number}|null>} punto desde el
   *   cual seguir la próxima vez, y cuántas radicaciones propias se recuperaron
   */
  async _arranqueInicial(page, anio, numerosConocidos, usuario, contador) {
    // La pista (el mayor radicado propio ya conocido) solo ahorra consultas.
    // Ventanilla NO tiene trámites asignados, así que casi siempre no hay
    // pista: en ese caso se arranca desde cero y el tanteo la encuentra igual.
    const pista = this._mayorNumeroConocido(anio, numerosConocidos) || 0;

    this.onProgreso('Ubicando el último radicado de la oficina (solo la primera vez)...');
    // Se avanza a saltos que se duplican hasta pasarse del tope y luego se
    // afina hacia atrás: llegar al tope real cuesta unas pocas decenas de
    // consultas aunque se empiece desde cero, no miles.
    let ultimoExistente = pista;
    let salto = pista > 0 ? 32 : 512;
    while (contador.consultas < MAX_CONSULTAS_POR_CORRIDA) {
      const datos = await this._consultar(page, anio, ultimoExistente + salto, contador);
      if (datos === null) break;
      if (datos.existe) {
        ultimoExistente += salto;
        salto *= 2;
      } else if (salto === 1) {
        break;
      } else {
        salto = Math.max(1, Math.floor(salto / 4));
      }
    }

    if (ultimoExistente === 0) {
      this.logger.warn('Radicaciones: no se encontró ningún radicado de este año para ubicar el punto de partida.');
      return null;
    }

    this.onProgreso(`Último radicado de la oficina: ${anio}-${ultimoExistente}. Buscando los suyos de hoy...`);

    const hoy = new Date().toISOString().slice(0, 10);
    let nuevas = 0;
    let numero = ultimoExistente;
    let revisados = 0;
    while (numero > 0 && revisados < MAX_RETROCESO_INICIAL && contador.consultas < MAX_CONSULTAS_POR_CORRIDA) {
      const datos = await this._consultar(page, anio, numero, contador);
      revisados++;
      if (revisados % 10 === 0) {
        this.onProgreso(`Revisando radicados de hoy: ${anio}-${numero} (${nuevas} suyas hasta ahora)...`);
      }
      if (datos === null) break;
      if (datos.existe) {
        // Los anteriores ya son de días previos: no interesan para el arranque.
        if (datos.fechaRadicacion && datos.fechaRadicacion < hoy) break;
        if (this._esDelUsuario(datos.usuarioRadica, usuario)) {
          if (this._registrar(anio, numero, datos)) nuevas++;
        }
      }
      numero--;
    }

    if (nuevas > 0) {
      this.logger.info(`Radicaciones: se recuperaron ${nuevas} radicación(es) de hoy al activar el conteo.`);
    }
    this.repo.guardarUltimoExplorado(anio, ultimoExistente);
    return { ultimo: ultimoExistente, nuevas };
  }

  /** Recorre desde el último explorado hacia arriba buscando radicados nuevos. */
  async _recorrerHaciaArriba(page, anio, ultimoExplorado, usuario, contador) {
    let nuevas = 0;
    let numero = ultimoExplorado + 1;
    let huecosSeguidos = 0;
    // Solo se avanza el puntero hasta el último número CONFIRMADO: si un
    // número todavía no existe, la próxima corrida lo vuelve a mirar en vez
    // de saltárselo para siempre.
    let ultimoConfirmado = ultimoExplorado;
    let erroresSeguidos = 0;
    let corte = null;

    while (huecosSeguidos < TOLERANCIA_HUECOS && contador.consultas < MAX_CONSULTAS_POR_CORRIDA) {
      const datos = await this._consultar(page, anio, numero, contador);

      if (datos === null) {
        // Un tropiezo suelto (red lenta, postback que tardó) no debe cortar
        // el recorrido entero: se reintenta el mismo número un par de veces.
        erroresSeguidos++;
        if (erroresSeguidos >= 3) {
          this.logger.warn(`Radicaciones: 3 errores seguidos en ${anio}-${numero}; se corta el recorrido.`);
          corte = 'errores';
          break;
        }
        continue;
      }
      erroresSeguidos = 0;
      this._anotarMuestra(anio, numero, datos, usuario);

      if (!datos.existe) {
        huecosSeguidos++;
        numero++;
        continue;
      }

      huecosSeguidos = 0;
      ultimoConfirmado = numero;
      if (this._esDelUsuario(datos.usuarioRadica, usuario)) {
        if (this._registrar(anio, numero, datos)) {
          nuevas++;
          this.onProgreso(`Radicación propia detectada: ${anio}-${numero}`);
        }
      }
      numero++;
    }

    if (ultimoConfirmado > ultimoExplorado) {
      this.repo.guardarUltimoExplorado(anio, ultimoConfirmado);
    }
    return { nuevas, corte };
  }

  /** Guarda una muestra de lo consultado, para poder mostrarla en pantalla. */
  _anotarMuestra(anio, numero, datos, usuario) {
    if (this.muestras.length >= 6) return;
    if (datos === null) {
      this.muestras.push(`${anio}-${numero}: no se pudo consultar`);
      return;
    }
    if (!datos.existe) {
      // Si edis SÍ tenía la ficha en pantalla pero no se entendió ningún
      // campo, "no existe" es engañoso. Se muestra qué se leyó de verdad:
      //  - pares etiqueta=valor => la ficha se leyó pero no coinciden los
      //    nombres de los campos que busco;
      //  - solo etiquetas sin valor => encuentro las filas pero leo mal el
      //    valor;
      //  - nada => la ficha no estaba (ese radicado no existe de verdad).
      const pares = this.consulta.ultimosPares || [];
      const filas = this.consulta.ultimoTotalFilas || 0;
      let pista = '';
      if (pares.length > 0) pista = ` [ficha leída: ${pares.slice(0, 6).join(' | ')}]`;
      else if (filas > 0) pista = ` [${filas} filas en pantalla, todas sin valor]`;
      this.muestras.push(`${anio}-${numero}: no existe${pista}`);
      return;
    }
    const coincide = this._esDelUsuario(datos.usuarioRadica, usuario) ? 'SÍ' : 'no';
    this.muestras.push(`${anio}-${numero}: radicó "${datos.usuarioRadica}" (¿suyo? ${coincide})`);
  }

  async _consultar(page, anio, numero, contador) {
    contador.consultas++;
    // Se recarga la página en cada consulta a propósito. Reutilizar el
    // formulario ya abierto era ~3x más rápido, pero tras la búsqueda la
    // página queda en un estado en el que volver a escribir el número falla:
    // el recorrido se cortaba en la segunda consulta y no contaba nada.
    const datos = await this.consulta.consultar(page, { anio, numero });
    await esperar(PAUSA_MS);
    return datos;
  }

  _registrar(anio, numero, datos) {
    return this.repo.registrar({
      numero_radicado: `${anio}-${numero}`,
      fecha_radicacion: datos.fechaRadicacion,
      usuario_radica: datos.usuarioRadica,
      clase: datos.clase,
      npn: datos.npn,
      interesado: datos.interesado,
    });
  }

  _esDelUsuario(usuarioRadica, usuarioActual) {
    return normalizarNombre(usuarioRadica) === normalizarNombre(usuarioActual);
  }

  /** Mayor número de radicado del año que ya conoce la base (pista de arranque). */
  _mayorNumeroConocido(anio, numeros) {
    let mayor = null;
    for (const n of numeros) {
      const m = String(n || '').match(/^(\d{2,4})-(\d+)/);
      if (!m) continue;
      const crudo = m[1];
      const anioNum =
        crudo.length <= 2 ? `20${crudo}` : crudo.length === 3 && crudo[0] === '0' ? `2${crudo}` : crudo;
      if (anioNum !== anio) continue;
      const valor = parseInt(m[2], 10);
      if (Number.isFinite(valor) && (mayor === null || valor > mayor)) mayor = valor;
    }
    return mayor;
  }
}

module.exports = { RadicacionesService, normalizarNombre };
