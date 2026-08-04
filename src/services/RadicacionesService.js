'use strict';

/** Números seguidos sin existir que se toman como "llegué al final". */
const TOLERANCIA_HUECOS = 4;
/** Tope de consultas por corrida: evita una ráfaga larga contra el servidor. */
const MAX_CONSULTAS_POR_CORRIDA = 120;
/** Al activar el conteo, cuántos números hacia atrás se revisan para recuperar lo ya radicado hoy. */
const MAX_RETROCESO_INICIAL = 60;
/** Pausa entre consultas: el recorrido no debe sentirse como un ataque al servidor. */
const PAUSA_MS = 400;

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
  }

  /**
   * @param {import('playwright').Page} page Página autenticada
   * @param {{numerosConocidos?: string[]}} opciones numerosConocidos: radicados
   *   que ya están en la base (los trámites propios), usados como pista para
   *   saber por dónde empezar a buscar en el primer arranque.
   * @returns {Promise<{nuevas: number, consultas: number, omitido?: string}>}
   */
  async detectar(page, { numerosConocidos = [] } = {}) {
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
      const arranque = await this._arranqueInicial(page, anio, numerosConocidos, usuario, contador);
      if (arranque === null) {
        return { nuevas: 0, consultas: contador.consultas, omitido: 'sin-punto-de-partida' };
      }
      ultimo = arranque.ultimo;
      nuevas += arranque.nuevas;
    }

    nuevas += await this._recorrerHaciaArriba(page, anio, ultimo, usuario, contador);
    return { nuevas, consultas: contador.consultas };
  }

  /**
   * Primer arranque: ubica el tope actual de radicados y retrocede mientras
   * sigan siendo de hoy, para no perder lo que ya se radicó antes de activar
   * el conteo. Todo acotado, para no disparar cientos de consultas.
   * @returns {Promise<{ultimo: number, nuevas: number}|null>} punto desde el
   *   cual seguir la próxima vez, y cuántas radicaciones propias se recuperaron
   */
  async _arranqueInicial(page, anio, numerosConocidos, usuario, contador) {
    const pista = this._mayorNumeroConocido(anio, numerosConocidos);
    if (pista === null) {
      this.logger.warn(
        'Radicaciones: todavía no hay ningún radicado conocido de este año para saber por dónde empezar. ' +
        'Sincronice la bandeja primero.'
      );
      return null;
    }

    this.onProgreso('Ubicando el último radicado de la oficina...');
    // Desde la pista, avanzar a saltos hasta pasarse del tope, luego afinar
    // uno por uno: llegar al tope real cuesta unas pocas consultas y no
    // cientos, aunque la pista esté bastante por debajo.
    let ultimoExistente = pista;
    let salto = 32;
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

    const hoy = new Date().toISOString().slice(0, 10);
    let nuevas = 0;
    let numero = ultimoExistente;
    let revisados = 0;
    while (numero > 0 && revisados < MAX_RETROCESO_INICIAL && contador.consultas < MAX_CONSULTAS_POR_CORRIDA) {
      const datos = await this._consultar(page, anio, numero, contador);
      revisados++;
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

    while (huecosSeguidos < TOLERANCIA_HUECOS && contador.consultas < MAX_CONSULTAS_POR_CORRIDA) {
      const datos = await this._consultar(page, anio, numero, contador);
      if (datos === null) break; // error de red: se corta sin mover el puntero

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
    return nuevas;
  }

  async _consultar(page, anio, numero, contador) {
    contador.consultas++;
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
