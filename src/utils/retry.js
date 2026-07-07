'use strict';

/**
 * Error que indica que NO tiene sentido reintentar (p. ej. configuración inválida
 * o login manual cancelado). withRetry lo propaga inmediatamente.
 */
class ErrorNoReintentable extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'ErrorNoReintentable';
    this.noReintentable = true;
  }
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ejecuta una operación asíncrona con reintentos y backoff exponencial.
 *
 * @param {() => Promise<T>} operacion
 * @param {object} opciones
 * @param {number} [opciones.reintentos=3] Intentos totales
 * @param {number} [opciones.backoffBaseMs=2000] Espera base entre intentos
 * @param {number} [opciones.backoffFactor=2] Multiplicador del backoff
 * @param {(error: Error, intento: number) => void} [opciones.onError] Callback por intento fallido
 * @returns {Promise<T>}
 * @template T
 */
async function withRetry(operacion, opciones = {}) {
  const {
    reintentos = 3,
    backoffBaseMs = 2000,
    backoffFactor = 2,
    onError = () => {},
  } = opciones;

  let ultimoError;

  for (let intento = 1; intento <= reintentos; intento++) {
    try {
      return await operacion(intento);
    } catch (error) {
      ultimoError = error;
      onError(error, intento);

      if (error.noReintentable || intento === reintentos) {
        throw error;
      }

      await esperar(backoffBaseMs * Math.pow(backoffFactor, intento - 1));
    }
  }

  throw ultimoError;
}

module.exports = { withRetry, ErrorNoReintentable, esperar };
