'use strict';

/**
 * Convierte un texto de fecha a formato ISO (YYYY-MM-DD) cuando se puede
 * interpretar con confianza. Soporta:
 *  - Fechas ya en ISO (se devuelven tal cual).
 *  - El typo frecuente de bitácoras escritas a mano: falta una barra
 *    ("14/082025" en vez de "14/08/2025", "2706/2025" en vez de
 *    "27/06/2025"). Si al quitar separadores quedan exactamente 8 dígitos
 *    y forman una fecha DDMMAAAA válida, se reconstruye en ISO.
 * Si no se reconoce con seguridad, devuelve el texto original sin tocar:
 * mejor dejarlo como está que adivinar mal una fecha real del usuario.
 *
 * @param {string} texto
 * @returns {string}
 */
function normalizarFecha(texto) {
  const t = String(texto || '').trim();
  if (!t) return t;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;

  // DD/MM/AAAA o D/M/AAAA (con / o -), incluido día o mes de un solo dígito
  // ("5/3/2026"): el formato más común al escribir fechas a mano.
  const conSeparador = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (conSeparador) {
    const d = Number(conSeparador[1]);
    const m = Number(conSeparador[2]);
    const a = Number(conSeparador[3]);
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12 && a >= 2000 && a <= 2100) {
      return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  const soloDigitos = t.replace(/\D/g, '');
  if (soloDigitos.length === 8) {
    const dia = soloDigitos.slice(0, 2);
    const mes = soloDigitos.slice(2, 4);
    const anio = soloDigitos.slice(4, 8);
    const d = Number(dia);
    const m = Number(mes);
    const a = Number(anio);
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12 && a >= 2000 && a <= 2100) {
      return `${anio}-${mes}-${dia}`;
    }
  }

  return t;
}

module.exports = { normalizarFecha };
