'use strict';

const btnSincronizar = document.getElementById('btn-sincronizar');
const btnExportar = document.getElementById('btn-exportar');
const btnImportar = document.getElementById('btn-importar');
const btnPerfil = document.getElementById('btn-perfil');
const panelEstado = document.getElementById('estado');
const panelEstadoMensaje = document.getElementById('estado-mensaje');
const cuerpoTramites = document.querySelector('#tabla-tramites tbody');
const cuerpoLogs = document.querySelector('#tabla-logs tbody');
const cuerpoHistorico = document.querySelector('#tabla-historico tbody');
const cuerpoPos = document.querySelector('#tabla-pos tbody');
const contadorTramites = document.getElementById('contador-tramites');
const contadorHistorico = document.getElementById('contador-historico');
const contadorPos = document.getElementById('contador-pos');
const buscador = document.getElementById('buscador');
const buscadorHistorico = document.getElementById('buscador-historico');
const buscadorPos = document.getElementById('buscador-pos');
const chips = document.getElementById('chips');
const chipsAnio = document.getElementById('chips-anio');
const chipsCategoria = document.getElementById('chips-categoria');

const ESTADOS = [
  ['por_estudiar', 'Por estudiar'],
  ['estudiado', 'Estudiado'],
  ['visita', 'Visita'],
  ['enviado', 'Enviado'],
  ['devuelto', 'Devuelto'],
  ['finalizado', 'Finalizado'],
];
let tramites = [];
let seguimientos = [];
let filtroActivo = 'bandeja';
let textoBusqueda = '';
let anioActivo = 'todos';
let textoHistorico = '';
let categoriaActiva = 'todas';
let textoPos = '';

/* ------------------------- utilidades ------------------------- */

let temporizadorEstado = null;

/**
 * Muestra un mensaje en la franja superior. Se oculta sola tras unos
 * segundos (o al pulsar la X) para que los avisos no se queden
 * "congelados" acumulando ruido visual.
 */
function mostrarEstado(tipo, mensaje) {
  panelEstado.className = `estado ${tipo}`;
  panelEstadoMensaje.textContent = mensaje;

  if (temporizadorEstado) clearTimeout(temporizadorEstado);
  const duracionMs = tipo === 'error' ? 20000 : 9000;
  temporizadorEstado = setTimeout(() => panelEstado.classList.add('oculto'), duracionMs);
}

document.getElementById('estado-cerrar').addEventListener('click', () => {
  if (temporizadorEstado) clearTimeout(temporizadorEstado);
  panelEstado.classList.add('oculto');
});

function extraDe(t) {
  try { return t.datos_extra ? JSON.parse(t.datos_extra) : {}; } catch { return {}; }
}

function sectorDe(t) {
  if (t.sector) return t.sector;
  const npn = String(extraDe(t).npn || '');
  const seg = npn.split('-');
  if (seg.length < 2) return '';
  if (seg[0] !== '01') return 'R';
  const n = parseInt(seg[1], 10);
  return Number.isFinite(n) && n > 0 ? String(n) : '';
}

function diasDe(t) {
  const n = parseInt(extraDe(t).dias, 10);
  return Number.isFinite(n) ? n : null;
}

function celda(contenido, clase) {
  const td = document.createElement('td');
  if (clase) td.className = clase;
  if (contenido instanceof HTMLElement) td.appendChild(contenido);
  else td.textContent = contenido ?? '—';
  return td;
}

/**
 * Guarda un campo y refresca TODO desde la base de datos (tabla, tarjetas
 * e histórico). No basta con parchear el campo editado en memoria: el
 * sistema aplica reglas automáticas (p. ej. escribir una observación puede
 * cambiar "mi_estado" a Estudiado solo) y esas reglas deben verse en
 * pantalla de inmediato, sin esperar a la próxima sincronización.
 */
async function guardarCampo(tramiteId, campo, valor) {
  const r = await window.bandejaApi.gestionActualizar(tramiteId, { [campo]: valor });
  if (!r.ok) {
    mostrarEstado('error', `No se pudo guardar: ${r.error}`);
    return;
  }
  await Promise.all([cargarTramites(), cargarResumen()]);
}

/* ------------------------- vista bandeja ------------------------- */

function pasaFiltro(t) {
  if (filtroActivo === 'todos') return true;
  if (filtroActivo === 'bandeja') return t.presente_en_bandeja === 1;
  return (t.mi_estado || 'por_estudiar') === filtroActivo;
}

function pasaBusqueda(t, texto) {
  if (!texto) return true;
  const contenido = `${t.numero_tramite} ${t.tipo || ''} ${t.observacion || ''} ${t.fmi || ''} ${t.solicitante || ''} ${t.analisis || ''}`.toLowerCase();
  return contenido.includes(texto);
}

function filaBandeja(t) {
  const fila = document.createElement('tr');
  if (t.mi_estado === 'devuelto') fila.classList.add('fila-devuelta');

  const enlace = document.createElement('a');
  enlace.className = 'enlace-radicado';
  enlace.textContent = t.numero_tramite;
  enlace.addEventListener('click', () => abrirFicha(t.id));
  fila.appendChild(celda(enlace));

  const tdTipo = celda(t.tipo, 'celda-tipo');
  tdTipo.title = t.tipo || '';
  fila.appendChild(tdTipo);

  fila.appendChild(celda(sectorDe(t)));

  const dias = diasDe(t);
  if (dias === null || !t.presente_en_bandeja) {
    fila.appendChild(celda('—'));
  } else {
    // Mismo semáforo del aplicativo edis: positivo = vencido (rojo),
    // de -3 a 0 = próximo a vencer (amarillo), más negativo = dentro de
    // los tiempos legales (verde). Antes estaba invertido.
    const chip = document.createElement('span');
    chip.className = `chip-dias ${dias > 0 ? 'dias-rojo' : dias >= -3 ? 'dias-amarillo' : 'dias-verde'}`;
    chip.textContent = String(dias);
    fila.appendChild(celda(chip));
  }

  const sel = document.createElement('select');
  sel.className = 'sel-estado';
  for (const [valor, etiqueta] of ESTADOS) {
    const opcion = document.createElement('option');
    opcion.value = valor;
    opcion.textContent = etiqueta;
    sel.appendChild(opcion);
  }
  sel.value = t.mi_estado || 'por_estudiar';
  sel.classList.add(`estado-${sel.value}`);
  sel.addEventListener('change', () => {
    sel.className = `sel-estado estado-${sel.value}`;
    guardarCampo(t.id, 'mi_estado', sel.value);
  });
  fila.appendChild(celda(sel));

  const inpPrioridad = document.createElement('input');
  inpPrioridad.className = 'inp-gestion inp-sector';
  inpPrioridad.value = t.prioridad || '';
  inpPrioridad.placeholder = '—';
  inpPrioridad.addEventListener('change', () =>
    guardarCampo(t.id, 'prioridad', inpPrioridad.value.trim())
  );
  fila.appendChild(celda(inpPrioridad));

  // Observación: se muestra COMPLETA (con saltos de línea); clic abre la ficha.
  const divObs = document.createElement('div');
  if (t.observacion) {
    divObs.textContent = t.observacion;
  } else {
    divObs.innerHTML = '<span class="obs-vacia">Clic para escribir observación...</span>';
  }
  const tdObs = celda(divObs, 'celda-obs');
  tdObs.addEventListener('click', () => abrirFicha(t.id));
  fila.appendChild(tdObs);

  const chipBandeja = document.createElement('span');
  chipBandeja.className = `chip-bandeja ${t.presente_en_bandeja ? 'si' : 'no'}`;
  chipBandeja.textContent = t.presente_en_bandeja ? 'Sí' : 'No';
  fila.appendChild(celda(chipBandeja));

  return fila;
}

function pintarTramites() {
  const visibles = tramites.filter((t) => pasaFiltro(t) && pasaBusqueda(t, textoBusqueda));
  contadorTramites.textContent = String(visibles.length);
  cuerpoTramites.replaceChildren(...visibles.slice(0, 800).map(filaBandeja));
}

/* ------------------------- vista histórico ------------------------- */

function anioDe(t) {
  const m = String(t.numero_tramite || '').match(/^(\d{2,4})-/);
  if (!m) return '';
  const n = m[1];
  // Radicados con año de 2 dígitos ("24-...") o con un cero perdido al
  // capturar el dato ("026-..." en vez de "2026-...").
  if (n.length === 2) return `20${n}`;
  if (n.length === 3 && n[0] === '0') return `2${n}`;
  return n;
}

function pintarChipsAnio() {
  const anios = [...new Set(tramites.filter(pasaHistorico).map(anioDe).filter(Boolean))].sort();
  chipsAnio.replaceChildren();
  const crear = (valor, etiqueta) => {
    const b = document.createElement('button');
    b.className = `chip ${anioActivo === valor ? 'activo' : ''}`;
    b.textContent = etiqueta;
    b.addEventListener('click', () => { anioActivo = valor; pintarChipsAnio(); pintarHistorico(); });
    chipsAnio.appendChild(b);
  };
  crear('todos', 'Todos los años');
  anios.forEach((a) => crear(a, a));
}

/**
 * El Histórico replica la hoja anual de la bitácora del usuario: NO es un
 * espejo de la bandeja (eso incluiría hasta los "Por estudiar" o
 * "Devuelto" que solo son estado interno de trabajo). Un trámite entra al
 * Histórico únicamente cuando tiene fecha de realización o de envío —
 * exactamente lo que el usuario anotaba a mano al lograrlo o al enviarlo,
 * con el botón "Agregar trámite" o al cerrarse solo por salir de bandeja.
 */
function pasaHistorico(t) {
  return Boolean(t.fecha_realizacion || t.fecha_envio);
}

/**
 * Orden de Histórico: replica el orden real de la bitácora en Excel.
 * Los trámites YA ENVIADOS van primero, ordenados por fecha de envío (así
 * queda registrado el orden en que se enviaron a revisión). Los que están
 * "en espera" (ya en parte gráfica, con fecha de realización pero SIN
 * fecha de envío todavía) van siempre al final, ordenados entre sí por su
 * fecha de realización. En cuanto un trámite en espera se envía, sube
 * automáticamente al bloque ordenado por fecha de envío.
 */
function pintarHistorico() {
  const visibles = tramites
    .filter((t) => {
      if (!pasaHistorico(t)) return false;
      if (anioActivo !== 'todos' && anioDe(t) !== anioActivo) return false;
      return pasaBusqueda(t, textoHistorico);
    })
    .sort((a, b) => {
      const aEnviado = Boolean(a.fecha_envio);
      const bEnviado = Boolean(b.fecha_envio);
      if (aEnviado !== bEnviado) return aEnviado ? -1 : 1;
      if (aEnviado) {
        const fe = a.fecha_envio.localeCompare(b.fecha_envio);
        if (fe !== 0) return fe;
        return (a.fecha_realizacion || '').localeCompare(b.fecha_realizacion || '');
      }
      return (a.fecha_realizacion || '').localeCompare(b.fecha_realizacion || '');
    });
  contadorHistorico.textContent = String(visibles.length);

  cuerpoHistorico.replaceChildren(
    ...visibles.slice(0, 1000).map((t) => {
      const fila = document.createElement('tr');
      if (t.mi_estado === 'devuelto') fila.classList.add('fila-devuelta');
      const enlace = document.createElement('a');
      enlace.className = 'enlace-radicado';
      enlace.textContent = t.numero_tramite;
      enlace.addEventListener('click', () => abrirFicha(t.id));
      fila.appendChild(celda(enlace));
      const tdTipo = celda(t.tipo, 'celda-tipo');
      tdTipo.title = t.tipo || '';
      fila.appendChild(tdTipo);
      fila.append(
        celda(t.fmi),
        celda(t.fecha_realizacion),
        celda(t.fecha_envio),
        celda(t.estado_seguimiento)
      );
      const obs = celda(t.observacion || '—', 'celda-obs');
      obs.addEventListener('click', () => abrirFicha(t.id));
      fila.appendChild(obs);
      const ana = celda(t.analisis || '—', 'celda-obs');
      ana.addEventListener('click', () => abrirFicha(t.id));
      fila.appendChild(ana);
      return fila;
    })
  );
}

/* ------------------------- vista seguimientos ------------------------- */

function pintarChipsCategoria() {
  const categorias = [...new Set(seguimientos.map((s) => s.categoria).filter(Boolean))];
  chipsCategoria.replaceChildren();
  const crear = (valor, etiqueta) => {
    const b = document.createElement('button');
    b.className = `chip ${categoriaActiva === valor ? 'activo' : ''}`;
    b.textContent = etiqueta;
    b.addEventListener('click', () => { categoriaActiva = valor; pintarChipsCategoria(); pintarPos(); });
    chipsCategoria.appendChild(b);
  };
  crear('todas', 'Todas');
  categorias.forEach((c) => crear(c, c.length > 26 ? c.slice(0, 26) + '…' : c));
}

function pintarPos() {
  const visibles = seguimientos.filter((s) => {
    if (categoriaActiva !== 'todas' && s.categoria !== categoriaActiva) return false;
    if (textoPos && !String(s.radicado).toLowerCase().includes(textoPos)) return false;
    return true;
  });
  contadorPos.textContent = String(visibles.length);
  cuerpoPos.replaceChildren(
    ...visibles.slice(0, 1000).map((s) => {
      const fila = document.createElement('tr');
      fila.append(celda(s.categoria), celda(s.radicado), celda(s.detalle || '—', 'celda-obs'));
      return fila;
    })
  );
}

/* ------------------------- ficha del trámite ------------------------- */

const modalFicha = document.getElementById('modal-ficha');
const fichaEstado = document.getElementById('ficha-estado');
let fichaTramiteId = null;
let fichaEstadoOriginal = null;
let fichaFechaRealizacionOriginal = '';
let fichaFechaEnvioOriginal = '';

for (const [valor, etiqueta] of ESTADOS) {
  const opcion = document.createElement('option');
  opcion.value = valor;
  opcion.textContent = etiqueta;
  fichaEstado.appendChild(opcion);
}

function abrirFicha(tramiteId) {
  const t = tramites.find((x) => x.id === tramiteId);
  if (!t) return;
  fichaTramiteId = tramiteId;

  document.getElementById('ficha-titulo').textContent = `Trámite ${t.numero_tramite}`;
  // Solo se puede eliminar lo que el propio usuario agregó a mano (nunca
  // datos reales sincronizados o importados: esos no se borran jamás).
  document.getElementById('ficha-eliminar').classList.toggle('oculto', t.origen !== 'manual');

  const extra = extraDe(t);
  // "..." al final = el propio aplicativo (no nuestro sistema) ya recorta
  // este texto en su tabla resumen; el valor completo solo existe en el
  // detalle del trámite dentro de edis.
  const observacionRecortada = /\.{3}\s*$/.test(String(extra.observaciones || '').trim());
  const datos = [
    ['Trámite', t.tipo],
    ['NPN', extra.npn],
    ['Estado en el aplicativo', t.estado],
    ['Fecha asignación', t.fecha],
    ['Días', extra.dias],
    ['En bandeja', t.presente_en_bandeja ? 'Sí' : 'No'],
    [
      observacionRecortada ? 'Vista previa del aplicativo (recortada por edis)' : 'Observación del sistema',
      extra.observaciones,
    ],
  ].filter(([, v]) => v);

  const cont = document.getElementById('ficha-datos');
  cont.replaceChildren();
  for (const [etiqueta, valor] of datos) {
    const e = document.createElement('span');
    e.className = 'dato-etiqueta';
    e.textContent = etiqueta;
    const v = document.createElement('span');
    v.className = 'dato-valor';
    v.textContent = valor;
    cont.append(e, v);
  }

  fichaEstadoOriginal = t.mi_estado || 'por_estudiar';
  fichaEstado.value = fichaEstadoOriginal;
  document.getElementById('ficha-estado-seguimiento').value = t.estado_seguimiento || '';
  document.getElementById('ficha-prioridad').value = t.prioridad || '';
  document.getElementById('ficha-sector').value = sectorDe(t);
  document.getElementById('ficha-fmi').value = t.fmi || '';
  fichaFechaRealizacionOriginal = t.fecha_realizacion || '';
  fichaFechaEnvioOriginal = t.fecha_envio || '';
  document.getElementById('ficha-fecha-realizacion').value = fichaFechaRealizacionOriginal;
  document.getElementById('ficha-fecha-envio').value = fichaFechaEnvioOriginal;
  document.getElementById('ficha-observacion').value = t.observacion || '';
  document.getElementById('ficha-analisis').value = t.analisis || '';

  modalFicha.classList.remove('oculto');
}

document.getElementById('ficha-cancelar').addEventListener('click', () => {
  modalFicha.classList.add('oculto');
});

document.getElementById('ficha-eliminar').addEventListener('click', async () => {
  if (fichaTramiteId === null) return;
  const r = await window.bandejaApi.eliminarManual(fichaTramiteId);
  if (r.ok) {
    modalFicha.classList.add('oculto');
    mostrarEstado('exito', 'Trámite eliminado.');
    await refrescarTodo();
  } else if (!r.cancelado) {
    mostrarEstado('error', `No se pudo eliminar: ${r.error}`);
  }
});

document.getElementById('ficha-guardar').addEventListener('click', async () => {
  if (fichaTramiteId === null) return;
  const campos = {
    estado_seguimiento: document.getElementById('ficha-estado-seguimiento').value.trim(),
    prioridad: document.getElementById('ficha-prioridad').value.trim(),
    sector: document.getElementById('ficha-sector').value.trim(),
    fmi: document.getElementById('ficha-fmi').value.trim(),
    observacion: document.getElementById('ficha-observacion').value.trim(),
    analisis: document.getElementById('ficha-analisis').value.trim(),
  };
  // Solo se envía "mi_estado" si el usuario lo cambió a mano en el
  // desplegable. Si lo deja igual, el sistema puede aplicar sus reglas
  // automáticas (observación => Estudiado, VISITA => Visita) sobre lo
  // recién guardado; si el usuario ya eligió un estado, se respeta tal cual.
  if (fichaEstado.value !== fichaEstadoOriginal) {
    campos.mi_estado = fichaEstado.value;
  }
  // Las fechas SOLO se envían si el usuario realmente las tocó: guardar la
  // ficha sin cambiar nada más no debe escribir "" en estos campos (eso
  // rompería el respaldo automático al enviar, que solo completa la fecha
  // cuando el campo está vacío de verdad, no con cadena vacía) ni, mucho
  // menos, hacer que el trámite aparezca solo en Histórico.
  const fechaRealizacionValor = document.getElementById('ficha-fecha-realizacion').value;
  const fechaEnvioValor = document.getElementById('ficha-fecha-envio').value;
  // Se guarda NULL (no "") cuando queda vacío, para que el respaldo
  // automático de marcarEnviados (COALESCE) siga funcionando si más
  // adelante el trámite se envía.
  if (fechaRealizacionValor !== fichaFechaRealizacionOriginal) {
    campos.fecha_realizacion = fechaRealizacionValor || null;
  }
  if (fechaEnvioValor !== fichaFechaEnvioOriginal) {
    campos.fecha_envio = fechaEnvioValor || null;
  }
  const r = await window.bandejaApi.gestionActualizar(fichaTramiteId, campos);
  if (!r.ok) {
    mostrarEstado('error', `No se pudo guardar: ${r.error}`);
    return;
  }
  modalFicha.classList.add('oculto');
  await Promise.all([cargarTramites(), cargarResumen()]);
});

/* ------------------------- carga de datos ------------------------- */

async function cargarTramites() {
  tramites = await window.bandejaApi.gestionListar();
  pintarTramites();
  pintarChipsAnio();
  pintarHistorico();
}

async function cargarResumen() {
  const r = await window.bandejaApi.gestionResumen();
  document.getElementById('m-bandeja').textContent = r.en_bandeja ?? 0;
  document.getElementById('m-estudiar').textContent = r.por_estudiar ?? 0;
  document.getElementById('m-visita').textContent = r.visita ?? 0;
  document.getElementById('m-devueltos').textContent = r.devueltos ?? 0;
}

async function cargarLogs() {
  const logs = await window.bandejaApi.listarLogs({ limite: 15 });
  cuerpoLogs.replaceChildren();
  for (const log of logs) {
    const errores = log.errores ? JSON.parse(log.errores) : [];
    const fila = document.createElement('tr');
    const chip = document.createElement('span');
    chip.className = `chip ${log.estado}`;
    chip.textContent = log.estado;
    fila.append(
      celda(log.fecha_inicio),
      celda(log.duracion_ms != null ? `${(log.duracion_ms / 1000).toFixed(1)} s` : null),
      celda(log.registros_leidos),
      celda(log.registros_nuevos),
      celda(log.registros_actualizados),
      celda(log.registros_sin_cambios),
      celda(chip),
      celda(errores.length > 0 ? errores.map((e) => e.mensaje).join(' | ') : '—')
    );
    cuerpoLogs.appendChild(fila);
  }
}

async function cargarSeguimientos() {
  seguimientos = await window.bandejaApi.posListar();
  pintarChipsCategoria();
  pintarPos();
}

async function refrescarTodo() {
  await Promise.all([cargarTramites(), cargarResumen(), cargarLogs(), cargarSeguimientos()]);
}

/* ------------------------- navegación y filtros ------------------------- */

document.querySelector('.vistas').addEventListener('click', (e) => {
  const boton = e.target.closest('button.vista');
  if (!boton) return;
  document.querySelectorAll('.vista').forEach((v) => v.classList.remove('activo'));
  boton.classList.add('activo');
  const vista = boton.dataset.vista;
  document.getElementById('vista-bandeja').classList.toggle('oculto', vista !== 'bandeja');
  document.getElementById('vista-historico').classList.toggle('oculto', vista !== 'historico');
  document.getElementById('vista-seguimientos').classList.toggle('oculto', vista !== 'seguimientos');
});

chips.addEventListener('click', (e) => {
  const boton = e.target.closest('button.chip');
  if (!boton) return;
  chips.querySelectorAll('.chip').forEach((c) => c.classList.remove('activo'));
  boton.classList.add('activo');
  filtroActivo = boton.dataset.filtro;
  pintarTramites();
});

buscador.addEventListener('input', () => {
  textoBusqueda = buscador.value.trim().toLowerCase();
  pintarTramites();
});

buscadorHistorico.addEventListener('input', () => {
  textoHistorico = buscadorHistorico.value.trim().toLowerCase();
  pintarHistorico();
});

buscadorPos.addEventListener('input', () => {
  textoPos = buscadorPos.value.trim().toLowerCase();
  pintarPos();
});

/* ------------------------- acciones ------------------------- */

btnSincronizar.addEventListener('click', async () => {
  btnSincronizar.disabled = true;
  btnSincronizar.classList.add('girando');
  mostrarEstado('progreso', 'Iniciando sincronización...');
  try {
    const respuesta = await window.bandejaApi.sincronizar();
    if (respuesta.ok) {
      const r = respuesta.resumen;
      const devueltosTexto = r.devueltos > 0 ? ` ${r.devueltos} devuelto(s).` : '';
      mostrarEstado(
        r.estado === 'exitoso' ? 'exito' : 'progreso',
        `Sincronización ${r.estado}: ${r.leidos} leídos, ${r.nuevos} nuevos, ` +
        `${r.actualizados} actualizados (${(r.duracionMs / 1000).toFixed(1)} s).${devueltosTexto} ` +
        (r.mensajeNuevos || '')
      );
    } else {
      mostrarEstado('error', `Error: ${respuesta.error}`);
    }
  } catch (error) {
    mostrarEstado('error', `Error inesperado: ${error.message}`);
  } finally {
    btnSincronizar.disabled = false;
    btnSincronizar.classList.remove('girando');
    await refrescarTodo();
  }
});

btnExportar.addEventListener('click', async () => {
  btnExportar.disabled = true;
  mostrarEstado('progreso', 'Generando archivo Excel...');
  try {
    const respuesta = await window.bandejaApi.exportarExcel();
    mostrarEstado(respuesta.ok ? 'exito' : 'error',
      respuesta.ok ? `Excel generado: ${respuesta.ruta}` : `Error al exportar: ${respuesta.error}`);
  } finally {
    btnExportar.disabled = false;
  }
});

btnImportar.addEventListener('click', async () => {
  btnImportar.disabled = true;
  mostrarEstado('progreso', 'Seleccione el archivo Excel a importar...');
  try {
    const respuesta = await window.bandejaApi.importarBitacora();
    if (respuesta.ok) {
      const r = respuesta.resumen;
      const hojas = Object.entries(r.hojas)
        .map(([hoja, res]) => `${hoja}: ${res.importadas ?? 0}`)
        .join(', ');
      const reglas = respuesta.reglas
        ? ` Estados aplicados: ${respuesta.reglas.aVisita} a Visita, ${respuesta.reglas.aEstudiado} a Estudiado.`
        : '';
      mostrarEstado('exito',
        `Importación completada (${r.tramitesCreados} trámites nuevos, ` +
        `${r.gestionesCompletadas} fichas completadas). Filas por hoja: ${hojas}.${reglas}`);
    } else if (respuesta.cancelado) {
      mostrarEstado('progreso', 'Importación cancelada.');
    } else {
      mostrarEstado('error', `Error al importar: ${respuesta.error}`);
    }
  } finally {
    btnImportar.disabled = false;
    await refrescarTodo();
  }
});

document.getElementById('btn-exportar-visitas').addEventListener('click', async () => {
  mostrarEstado('progreso', 'Generando Excel de visitas...');
  const r = await window.bandejaApi.exportarVisitas();
  mostrarEstado(r.ok ? 'exito' : 'error',
    r.ok ? `Excel de visitas generado: ${r.ruta}` : `Error: ${r.error}`);
});

document.getElementById('btn-restablecer').addEventListener('click', async () => {
  const r = await window.bandejaApi.restablecerSistema();
  if (r.ok) {
    mostrarEstado('exito', 'Sistema restablecido a cero. Puede importar un Excel o sincronizar para empezar.');
    await refrescarTodo();
  } else if (!r.cancelado) {
    mostrarEstado('error', `No se pudo restablecer: ${r.error}`);
  }
});

/* ------------------------- agregar trámite al histórico ------------------------- */

const modalAgregar = document.getElementById('modal-agregar');
const agregarEstado = document.getElementById('agregar-estado');

document.getElementById('btn-agregar-historico').addEventListener('click', () => {
  document.getElementById('agregar-radicado').value = '';
  document.getElementById('agregar-tramite').value = '';
  document.getElementById('agregar-fmi').value = '';
  document.getElementById('agregar-fecha-realizacion').value = new Date().toISOString().slice(0, 10);
  document.getElementById('agregar-estado-seguimiento').value = 'EN ESPERA';
  document.getElementById('agregar-observacion').value = '';
  agregarEstado.textContent = '';
  modalAgregar.classList.remove('oculto');
  document.getElementById('agregar-radicado').focus();
});

document.getElementById('agregar-cancelar').addEventListener('click', () => {
  modalAgregar.classList.add('oculto');
});

document.getElementById('agregar-guardar').addEventListener('click', async () => {
  const datos = {
    radicado: document.getElementById('agregar-radicado').value.trim(),
    tramite: document.getElementById('agregar-tramite').value.trim(),
    fmi: document.getElementById('agregar-fmi').value.trim(),
    fecha_realizacion: document.getElementById('agregar-fecha-realizacion').value,
    estado_seguimiento: document.getElementById('agregar-estado-seguimiento').value.trim(),
    observacion: document.getElementById('agregar-observacion').value.trim(),
  };
  if (!datos.radicado) {
    agregarEstado.textContent = 'Escriba el número de radicado.';
    return;
  }
  const r = await window.bandejaApi.agregarHistorico(datos);
  if (!r.ok) {
    agregarEstado.textContent = `Error: ${r.error}`;
    return;
  }
  modalAgregar.classList.add('oculto');
  mostrarEstado('exito', `Trámite ${datos.radicado} agregado al histórico.`);
  await cargarTramites();
});

/* ------------------------- mi perfil ------------------------- */

const modalPerfil = document.getElementById('modal-perfil');
const perfilAccesoEstado = document.getElementById('perfil-acceso-estado');

async function abrirPerfil() {
  const estado = await window.bandejaApi.credencialesEstado();
  perfilAccesoEstado.textContent = estado.guardadas
    ? 'Acceso guardado: el robot inicia sesión solo cuando la sesión vence.'
    : (estado.disponible
        ? 'Sin acceso guardado: cuando la sesión venza tendrá que iniciar sesión a mano.'
        : 'El cifrado del sistema no está disponible.');
  await cargarLogs();
  modalPerfil.classList.remove('oculto');
}

btnPerfil.addEventListener('click', abrirPerfil);

document.getElementById('perfil-cerrar').addEventListener('click', () => {
  modalPerfil.classList.add('oculto');
});

/* ------------------------- acceso edis ------------------------- */

const modalAcceso = document.getElementById('modal-acceso');
const accesoUsuario = document.getElementById('acceso-usuario');
const accesoClave = document.getElementById('acceso-clave');
const accesoEstado = document.getElementById('acceso-estado');

document.getElementById('btn-cambiar-acceso').addEventListener('click', async () => {
  const estado = await window.bandejaApi.credencialesEstado();
  accesoEstado.textContent = estado.guardadas
    ? 'Ya hay credenciales guardadas: el robot inicia sesión solo.'
    : (estado.disponible ? '' : 'El cifrado del sistema no está disponible.');
  accesoUsuario.value = '';
  accesoClave.value = '';
  modalAcceso.classList.remove('oculto');
  accesoUsuario.focus();
});

document.getElementById('acceso-cancelar').addEventListener('click', () => {
  modalAcceso.classList.add('oculto');
});

document.getElementById('acceso-borrar').addEventListener('click', async () => {
  await window.bandejaApi.credencialesBorrar();
  accesoEstado.textContent = 'Credenciales borradas.';
  perfilAccesoEstado.textContent = 'Sin acceso guardado: cuando la sesión venza tendrá que iniciar sesión a mano.';
});

document.getElementById('acceso-guardar').addEventListener('click', async () => {
  const usuario = accesoUsuario.value.trim();
  const clave = accesoClave.value;
  if (!usuario || !clave) {
    accesoEstado.textContent = 'Escriba usuario y clave.';
    return;
  }
  const r = await window.bandejaApi.credencialesGuardar(usuario, clave);
  if (r.ok) {
    modalAcceso.classList.add('oculto');
    perfilAccesoEstado.textContent = 'Acceso guardado: el robot inicia sesión solo cuando la sesión vence.';
    mostrarEstado('exito', 'Acceso guardado: el robot iniciará sesión automáticamente de ahora en adelante.');
  } else {
    accesoEstado.textContent = `Error: ${r.error}`;
  }
});

/* ------------------------- menús desplegables -------------------------
 * Controla la apertura/cierre de los desplegables de la barra superior
 * (Acciones y Tema). Los botones internos conservan sus IDs y sus handlers
 * originales sin ninguna modificación. */

const menusDesplegables = [];

function configurarMenu(boton, lista) {
  const cerrar = () => {
    lista.classList.add('oculto');
    boton.setAttribute('aria-expanded', 'false');
  };
  boton.addEventListener('click', (e) => {
    e.stopPropagation();
    const estabaAbierto = !lista.classList.contains('oculto');
    menusDesplegables.forEach((m) => m.cerrar()); // solo un menú abierto a la vez
    if (!estabaAbierto) {
      lista.classList.remove('oculto');
      boton.setAttribute('aria-expanded', 'true');
    }
  });
  // Al elegir una opción se cierra el menú (los handlers de cada botón ya
  // corrieron en su propio listener; este solo cierra el desplegable).
  lista.addEventListener('click', cerrar);
  const api = { cerrar };
  menusDesplegables.push(api);
  return api;
}

configurarMenu(document.getElementById('btn-acciones'), document.getElementById('menu-acciones-lista'));
configurarMenu(document.getElementById('btn-tema'), document.getElementById('menu-tema-lista'));

document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu-acciones')) menusDesplegables.forEach((m) => m.cerrar());
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') menusDesplegables.forEach((m) => m.cerrar());
});

/* ------------------------- selector de tema -------------------------
 * Cambia el tema en tiempo real (data-tema en <html>) y recuerda la
 * preferencia del usuario en localStorage. */

const TEMA_KEY = 'gestor-tema';
const TEMAS_VALIDOS = ['claro', 'oscuro', 'corporativo'];
const itemsTema = Array.from(document.querySelectorAll('.menu-item-tema'));

function aplicarTema(tema) {
  const elegido = TEMAS_VALIDOS.includes(tema) ? tema : 'claro';
  document.documentElement.setAttribute('data-tema', elegido);
  itemsTema.forEach((it) => it.classList.toggle('activo', it.dataset.tema === elegido));
  try {
    localStorage.setItem(TEMA_KEY, elegido);
  } catch {
    // Si localStorage no está disponible, el tema aplica igual en esta sesión.
  }
}

itemsTema.forEach((it) => it.addEventListener('click', () => aplicarTema(it.dataset.tema)));

(function inicializarTema() {
  let guardado = 'claro';
  try {
    guardado = localStorage.getItem(TEMA_KEY) || 'claro';
  } catch {
    guardado = 'claro';
  }
  aplicarTema(guardado);
})();

/* ------------------------- panel lateral (sidebar) -------------------------
 * Solo controla el colapso visual y el cierre de la aplicación. La
 * navegación (Bandeja/Histórico/Seguimientos) y Mi perfil conservan sus
 * clases, IDs y handlers originales sin modificación. */

const SIDEBAR_KEY = 'gestor-sidebar-colapsado';
const sidebar = document.getElementById('sidebar');
const btnColapsar = document.getElementById('btn-colapsar');

function aplicarColapso(colapsado) {
  sidebar.classList.toggle('colapsado', colapsado);
  const etiqueta = colapsado ? 'Expandir menú' : 'Contraer menú';
  btnColapsar.setAttribute('aria-label', etiqueta);
  btnColapsar.title = etiqueta;
  try {
    localStorage.setItem(SIDEBAR_KEY, colapsado ? '1' : '0');
  } catch {
    // Sin localStorage el colapso aplica igual en esta sesión.
  }
}

btnColapsar.addEventListener('click', () =>
  aplicarColapso(!sidebar.classList.contains('colapsado'))
);

(function inicializarSidebar() {
  let colapsado = false;
  try {
    colapsado = localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {
    colapsado = false;
  }
  aplicarColapso(colapsado);
})();

document.getElementById('btn-cerrar-sesion').addEventListener('click', () => {
  // App de un solo usuario: "Cerrar sesión" cierra la aplicación. Todo el
  // trabajo se guarda al instante, así que no hay estado sin persistir.
  window.close();
});

/* ------------------------- eventos del proceso principal ------------------------- */

window.bandejaApi.onProgreso((datos) => {
  if (datos.evento === 'progreso') {
    mostrarEstado('progreso', datos.mensaje);
  } else if (datos.evento === 'fallo') {
    mostrarEstado('error', `Error: ${datos.mensaje}`);
  } else if (datos.evento === 'finalizado' && datos.resumen) {
    const r = datos.resumen;
    mostrarEstado('exito',
      `Sincronización ${r.estado} (${new Date().toLocaleTimeString()}): ` +
      `${r.leidos} leídos, ${r.nuevos} nuevos. ${r.mensajeNuevos || ''}`);
    refrescarTodo();
  }
});

refrescarTodo().catch((error) => {
  mostrarEstado('error', `No se pudieron cargar los datos: ${error.message}`);
});
