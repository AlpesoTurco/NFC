const { Router } = require('express');
const router = Router();
const requireAuthView = require('./middlewares/requireAuthView');
const requireRoles = require('./middlewares/roles');
const connections = require('./database/db');

/** Helper: wrap async to evitar try/catch repetido */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/** Helper: crea rutas que solo renderizan vistas */
const renderRoute = (path, view, middlewares = []) => {
  router.get(
    path,
    ...middlewares,
    (req, res) => res.render(view)
  );
};




/* ========= RUTAS PÚBLICAS ========= */
renderRoute('/login', 'login'); 
renderRoute('/', 'login'); 

/* ========= RUTAS PROTEGIDAS ========= */
const auth = [requireAuthView];
const adminOnly = [requireAuthView, requireRoles('admin')];
const adminOrProv = [requireAuthView, requireRoles('usuario')];


// Dispositivos, Actividad, Configuración, Nuevo Usuario, Perfil
renderRoute('/dispositivos', 'dispositivos', auth);
renderRoute('/nuevousuario', 'nuevousuario', auth);


// GET /miactividad
router.get('/solicitudes', auth, async (req, res) => {
  const f = parseFilters(req.query);

  // WHERE dinámico
  const where = [];
  const params = [];

  // Texto libre (empleado, motivo, tipo)
  if (f.q) {
    where.push(`(empleado LIKE CONCAT('%', ?, '%') OR motivo LIKE CONCAT('%', ?, '%') OR tipo LIKE CONCAT('%', ?, '%'))`);
    params.push(f.q, f.q, f.q);
  }
  if (f.kind) {
    where.push(`kind = ?`);
    params.push(f.kind);
  }
  if (f.estatus) {
    where.push(`estatus = ?`);
    params.push(f.estatus);
  }
  // Rango de fechas (usa fecha_principal que ya trae YYYY-MM-DD)
  where.push(`fecha_principal BETWEEN ? AND ?`);
  params.push(f.desde, f.hasta);

  const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';

  // Consulta principal + conteo total
  const sqlData = `
    SELECT *
    FROM vw_bandeja_solicitudes
    ${whereSql}
    ORDER BY COALESCE(creado_en, fecha_ini) DESC, kind, id
    LIMIT ? OFFSET ?;
  `;
  const sqlCount = `
    SELECT COUNT(*) AS total
    FROM vw_bandeja_solicitudes
    ${whereSql};
  `;

  // Badges por kind
  const sqlBadges = `
    SELECT kind, COUNT(*) AS total
    FROM vw_bandeja_solicitudes
    ${whereSql}
    GROUP BY kind;
  `;

  try {
    const [rows, countRows, badgeRows] = await Promise.all([
      q(sqlData, [...params, f.perPage, f.offset]),
      q(sqlCount, params),
      q(sqlBadges, params)
    ]);

    const total = countRows?.[0]?.total || 0;
    const totalPages = Math.max(Math.ceil(total / f.perPage), 1);

    // Conteos separados para Permisos / Incidencias
    const badgePermisos = badgeRows.find(r => r.kind === 'permiso')?.total || 0;
    const badgeIncidencias = badgeRows.find(r => r.kind === 'incidencia')?.total || 0;

    // Render
    res.render('solicitudes', {
      inbox: rows.map(r => ({
        ...r,
        // por si adjuntos_json viene como string JSON en tu driver:
        adjuntos: Array.isArray(r.adjuntos_json) ? r.adjuntos_json : (r.adjuntos_json ? JSON.parse(r.adjuntos_json) : []),
        estatusClass: badgeClass(r.estatus)
      })),
      badgePermisos,
      badgeIncidencias,
      total, totalPages,
      filters: f
    });
  } catch (err) {
    console.error('Error en /solicitudes:', err);
    res.status(500).send('Error al cargar la bandeja de solicitudes');
  }
});







/* -------------------- Helpers de filtros -------------------- */
function parseFilters(query) {
  const page = Math.max(parseInt(query.page || '1', 10), 1);
  const perPage = Math.min(Math.max(parseInt(query.perPage || '20', 10), 1), 100);

  const range = (query.range || '24h');
  const now = new Date();
  const hasta = new Date(now);
  const desde = new Date(now);
  if (range === 'hoy')   { desde.setHours(0,0,0,0); }
  if (range === '24h')  { desde.setHours(desde.getHours() - 24); }
  if (range === 'semana'){ desde.setDate(desde.getDate() - 7); }
  if (range === 'mes')  { desde.setMonth(desde.getMonth() - 1); }

  const fmt = (d)=> d.toISOString().slice(0,19).replace('T',' ');
  return {
    q: (query.q || '').trim(),
    tipo: (query.tipo || '').trim(),       // entrada|salida|manual|comida_entrada|comida_salida
    estado: (query.estado || '').trim(),   // ok|fail (por ahora solo ok en tu BD)
    device: (query.device || '').trim(),   // id_dispositivo
    range,
    desde: fmt(desde),
    hasta: fmt(hasta),
    page, perPage, offset: (page-1)*perPage
  };
}

function buildWhere(f, onlyUserId = null) {
  const where = [];
  const params = [];

  if (onlyUserId != null) { where.push('id_usuario = ?'); params.push(onlyUserId); }
  if (f.q) {
    where.push(`(
      empleado LIKE CONCAT('%', ?, '%')
      OR puesto LIKE CONCAT('%', ?, '%')
      OR device_name LIKE CONCAT('%', ?, '%')
      OR motivo LIKE CONCAT('%', ?, '%')
      OR CAST(audit_id AS CHAR) LIKE CONCAT('%', ?, '%')
    )`);
    params.push(f.q, f.q, f.q, f.q, f.q);
  }
  if (f.tipo)   { where.push('evento = ?'); params.push(f.tipo); }
  if (f.estado) { where.push('estado = ?'); params.push(f.estado); }
  if (f.device) { where.push('device_id = ?'); params.push(f.device); }

  where.push('fecha BETWEEN ? AND ?'); params.push(f.desde, f.hasta);

  return { whereSql: where.length ? ('WHERE ' + where.join(' AND ')) : '', params };
}

/* -------------------- API: Actividad (general) -------------------- */
router.get('/api/actividad', auth, async (req, res) => {
  const f = parseFilters(req.query);
  const { whereSql, params } = buildWhere(f);

  const sqlData = `
    SELECT * FROM vw_actividad_reciente
    ${whereSql}
    ORDER BY fecha DESC
    LIMIT ? OFFSET ?;
  `;
  const sqlCount = `
    SELECT COUNT(*) AS total
    FROM vw_actividad_reciente
    ${whereSql};
  `;

  try {
    const rows      = await q(sqlData,  [...params, f.perPage, f.offset]);
    const countRows = await q(sqlCount, params);
    const total = countRows?.[0]?.total || 0;

    const items = rows.map(r => ({
      id: r.id_evento,
      empleado: r.empleado,
      puesto: r.puesto || '',
      avatar: '/img/user-placeholder.jpg',
      evento: r.evento,
      fecha: r.fecha,
      deviceId: r.device_id,
      deviceName: r.device_name,
      metodo: r.metodo,
      estado: r.estado,              // 'ok'
      motivo: r.motivo,
      ubicacion: r.ubicacion,
      operador: r.operador,
      auditId: String(r.audit_id),
    }));

    res.json({ ok: true, items, total, page: f.page, perPage: f.perPage });
  } catch (err) {
    console.error('GET /api/actividad', err);
    res.status(500).json({ ok:false, error:'Error al consultar actividad' });
  }
});

/* -------------------- API: Actividad (solo mi ID) -------------------- */
router.get('/api/actividad/mia', auth, async (req, res) => {
  const me = req.user?.id_usuario || res.locals?.user?.id_usuario;
  if (!me) return res.status(401).json({ ok:false, error:'No autenticado' });

  const f = parseFilters(req.query);
  const { whereSql, params } = buildWhere(f, me);

  const sqlData = `
    SELECT * FROM vw_actividad_reciente
    ${whereSql}
    ORDER BY fecha DESC
    LIMIT ? OFFSET ?;
  `;
  const sqlCount = `
    SELECT COUNT(*) AS total
    FROM vw_actividad_reciente
    ${whereSql};
  `;

  try {
    const rows      = await q(sqlData,  [...params, f.perPage, f.offset]);
    const countRows = await q(sqlCount, params);
    const total = countRows?.[0]?.total || 0;

    const items = rows.map(r => ({
      id: r.id_evento,
      empleado: r.empleado,
      puesto: r.puesto || '',
      avatar: '/img/user-placeholder.jpg',
      evento: r.evento,
      fecha: r.fecha,
      deviceId: r.device_id,
      deviceName: r.device_name,
      metodo: r.metodo,
      estado: r.estado,
      motivo: r.motivo,
      ubicacion: r.ubicacion,
      operador: r.operador,
      auditId: String(r.audit_id),
    }));

    res.json({ ok: true, items, total, page: f.page, perPage: f.perPage });
  } catch (err) {
    console.error('GET /api/actividad/mia', err);
    res.status(500).json({ ok:false, error:'Error al consultar mi actividad' });
  }
});

function parseFilters(query) {
  const page = Math.max(parseInt(query.page || '1', 10), 1);
  const perPage = Math.min(Math.max(parseInt(query.perPage || '20', 10), 1), 100);

  const range = (query.range || '24h');
  const now = new Date();
  let hasta = new Date(now);
  let desde = new Date(now);

  if (query.desde && query.hasta) {
    const d = new Date(query.desde + 'T00:00:00');
    const h = new Date(query.hasta + 'T23:59:59');
    if (!isNaN(d) && !isNaN(h)) { desde = d; hasta = h; }
  } else {
    if (range === 'hoy')    { desde.setHours(0,0,0,0); }
    if (range === '24h')    { desde.setHours(desde.getHours() - 24); }
    if (range === 'semana') {
      const dow = (desde.getDay() + 6) % 7; // 0 = Lunes
      desde.setDate(desde.getDate() - dow);
      desde.setHours(0,0,0,0);
      hasta = new Date(desde);
      hasta.setDate(desde.getDate() + 6);
      hasta.setHours(23,59,59,999);
    }
    if (range === 'mes')    { desde.setMonth(desde.getMonth() - 1); }
  }

  const fmt = (d)=> d.toISOString().slice(0,19).replace('T',' ');
  return {
    q: (query.q || '').trim(),
    tipo: (query.tipo || '').trim(),
    estado: (query.estado || '').trim(),
    device: (query.device || '').trim(),
    range,
    desde: fmt(desde),
    hasta: fmt(hasta),
    page, perPage, offset: (page-1)*perPage
  };
}

/* -------------------- API: Dispositivos (combo) -------------------- */
router.get('/api/dispositivos', auth, async (req, res) => {
  try {
    const rows = await q(
      `SELECT id_dispositivo AS id, nombre_dispositivo AS nombre
       FROM dispositivos
       ORDER BY nombre_dispositivo ASC`
    );
    res.json({ ok:true, items: rows });
  } catch (err) {
    console.error('GET /api/dispositivos', err);
    res.status(500).json({ ok:false, error:'Error al listar dispositivos' });
  }
});

/* -------------------- SSR: /actividad con seed -------------------- */
router.get('/actividad', auth, async (req, res) => {
  const f = parseFilters({ page: 1, perPage: 20, range: '24h' });
  const { whereSql, params } = buildWhere(f);
  try {
    const rows = await q(
      `SELECT * FROM vw_actividad_reciente ${whereSql} ORDER BY fecha DESC LIMIT ? OFFSET ?;`,
      [...params, f.perPage, f.offset]
    );
    const countRows = await q(
      `SELECT COUNT(*) AS total FROM vw_actividad_reciente ${whereSql};`,
      params
    );
    const total = countRows?.[0]?.total || 0;

    const items = rows.map(r => ({
      id: r.id_evento,
      empleado: r.empleado,
      puesto: r.puesto || '',
      avatar: '/img/user-placeholder.jpg',
      evento: r.evento,
      fecha: r.fecha,
      deviceId: r.device_id,
      deviceName: r.device_name,
      metodo: r.metodo,
      estado: r.estado,
      motivo: r.motivo,
      ubicacion: r.ubicacion,
      operador: r.operador,
      auditId: String(r.audit_id),
    }));

    res.render('actividad', {
      seed: { items, total, page: f.page, perPage: f.perPage },
      user: req.user || null
    });
  } catch (err) {
    console.error('GET /actividad', err);
    res.status(500).send('Error al cargar actividad');
  }
});

// Helpers (usa tu misma buildWhere ya existente en tu proyecto)
function parseFilters(query) {
  const page = Math.max(parseInt(query.page || '1', 10), 1);
  const perPage = Math.min(Math.max(parseInt(query.perPage || '20', 10), 1), 100);

  const range = (query.range || '24h');
  const now = new Date();
  let hasta = new Date(now);
  let desde = new Date(now);

  // Prioridad: rango manual de fechas
  if (query.desde && query.hasta) {
    const d = new Date(query.desde + 'T00:00:00');
    const h = new Date(query.hasta + 'T23:59:59');
    if (!isNaN(d) && !isNaN(h)) { desde = d; hasta = h; }
  } else {
    // Si no hay desde/hasta, usamos el select "range"
    if (range === 'hoy')    { desde.setHours(0,0,0,0); }
    if (range === '24h')    { desde.setHours(desde.getHours() - 24); }
    if (range === 'semana') {
      const dow = (desde.getDay() + 6) % 7; // 0 = lunes
      desde.setDate(desde.getDate() - dow);
      desde.setHours(0,0,0,0);
      hasta = new Date(desde);
      hasta.setDate(desde.getDate() + 6);
      hasta.setHours(23,59,59,999);
    }
    if (range === 'mes')    { desde.setMonth(desde.getMonth() - 1); }
  }

  const fmt = (d)=> d.toISOString().slice(0,19).replace('T',' ');
  return {
    q: (query.q || '').trim(),
    tipo: (query.tipo || '').trim(),
    estado: (query.estado || '').trim(),
    device: (query.device || '').trim(),
    range,
    desde: fmt(desde),
    hasta: fmt(hasta),
    page, perPage, offset: (page-1)*perPage
  };
}

// buildWhere debe existir (esta es la misma versión que ya usas)
function buildWhere(f, onlyUserId = null) {
  const where = [];
  const params = [];

  if (onlyUserId != null) { where.push('id_usuario = ?'); params.push(onlyUserId); }
  if (f.q) {
    where.push(`(
      empleado LIKE CONCAT('%', ?, '%')
      OR puesto LIKE CONCAT('%', ?, '%')
      OR device_name LIKE CONCAT('%', ?, '%')
      OR motivo LIKE CONCAT('%', ?, '%')
      OR CAST(audit_id AS CHAR) LIKE CONCAT('%', ?, '%')
    )`);
    params.push(f.q, f.q, f.q, f.q, f.q);
  }
  if (f.tipo)   { where.push('evento = ?'); params.push(f.tipo); }
  if (f.estado) { where.push('estado = ?'); params.push(f.estado); }
  if (f.device) { where.push('device_id = ?'); params.push(f.device); }

  where.push('fecha BETWEEN ? AND ?'); params.push(f.desde, f.hasta);

  return { whereSql: where.length ? ('WHERE ' + where.join(' AND ')) : '', params };
}

// ================== RUTA: Vista /actividad ==================
router.get('/actividad', auth, async (req, res) => {
  const f = parseFilters(req.query);              // <-- AHORA sí definimos f
  const { whereSql, params } = buildWhere(f);     // usa tus filtros

  try {
    const rows = await q(
      `SELECT * FROM vw_actividad_reciente
       ${whereSql}
       ORDER BY fecha DESC
       LIMIT ? OFFSET ?;`,
      [...params, f.perPage, f.offset]
    );

    const countRows = await q(
      `SELECT COUNT(*) AS total
       FROM vw_actividad_reciente
       ${whereSql};`,
      params
    );
    const total = countRows?.[0]?.total || 0;

    const items = rows.map(r => ({
      id: r.id_evento,
      empleado: r.empleado,
      puesto: r.puesto || '',
      avatar: '/img/user-placeholder.jpg',
      evento: r.evento,
      fecha: r.fecha,
      deviceId: r.device_id,
      deviceName: r.device_name,
      metodo: r.metodo,
      estado: r.estado,
      motivo: r.motivo,
      ubicacion: r.ubicacion,
      operador: r.operador,
      auditId: String(r.audit_id),
    }));

    res.render('actividad', {
      seed: { items, total, page: f.page, perPage: f.perPage },
      user: req.user || null
    });
  } catch (err) {
    console.error('GET /actividad', err);
    res.status(500).send('Error al cargar actividad');
  }
});

router.get('/api/actividad/export.csv', auth, async (req, res) => {
  const f = parseFilters(req.query);
  const { whereSql, params } = buildWhere(f);

  const sql = `
    SELECT
      id_evento     AS id,
      empleado,
      COALESCE(puesto, '') AS puesto,
      evento,
      DATE_FORMAT(fecha, '%Y-%m-%d %H:%i:%s') AS fecha,
      device_id     AS deviceId,
      device_name   AS deviceName,
      metodo,
      estado,
      COALESCE(motivo,'')    AS motivo,
      COALESCE(ubicacion,'') AS ubicacion,
      COALESCE(operador,'')  AS operador,
      CAST(audit_id AS CHAR) AS auditId
    FROM vw_actividad_reciente
    ${whereSql}
    ORDER BY fecha DESC;
  `;

  try {
    const rows = await q(sql, params);
    const headers = ['id','empleado','puesto','evento','fecha','deviceId','deviceName','metodo','estado','motivo','ubicacion','operador','auditId'];
    const esc = (v='') => `"${String(v ?? '').replace(/"/g,'""').replace(/\r?\n/g,' ')}"`;
    const csv = ['\uFEFF' + headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    const fn = `actividad_${f.range}_${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);
    res.status(200).send(csv);
  } catch (err) {
    console.error('GET /api/actividad/export.csv', err);
    res.status(500).json({ ok:false, error:'Error al exportar CSV' });
  }
});


// === Exportar Actividad a CSV ===
router.get('/api/actividad/export.csv', auth, async (req, res) => {
  const f = parseFilters(req.query);                // usa tu parseFilters
  const { whereSql, params } = buildWhere(f);       // y tus filtros

  const sql = `
    SELECT
      id_evento     AS id,
      empleado,
      COALESCE(puesto, '') AS puesto,
      evento,
      DATE_FORMAT(fecha, '%Y-%m-%d %H:%i:%s') AS fecha,
      device_id     AS deviceId,
      device_name   AS deviceName,
      metodo,
      estado,
      COALESCE(motivo,'')    AS motivo,
      COALESCE(ubicacion,'') AS ubicacion,
      COALESCE(operador,'')  AS operador,
      CAST(audit_id AS CHAR) AS auditId
    FROM vw_actividad_reciente
    ${whereSql}
    ORDER BY fecha DESC;
  `;

  try {
    const rows = await q(sql, params);
    const headers = ['id','empleado','puesto','evento','fecha','deviceId','deviceName','metodo','estado','motivo','ubicacion','operador','auditId'];
    const esc = (v='') => `"${String(v ?? '').replace(/"/g,'""').replace(/\r?\n/g,' ')}"`;
    const csv = ['\uFEFF' + headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    const fn = `actividad_${f.range}_${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);
    res.status(200).send(csv);
  } catch (err) {
    console.error('GET /api/actividad/export.csv', err);
    res.status(500).json({ ok:false, error:'Error al exportar CSV' });
  }
});



//mi actividad
// helper: normaliza parámetros
function parseFilters(query) {
  const page = Math.max(parseInt(query.page || '1', 10), 1);
  const perPage = Math.min(Math.max(parseInt(query.perPage || '20', 10), 1), 100);
  const offset = (page - 1) * perPage;

  const filtros = {
    q: (query.q || '').trim(),
    kind: (query.kind || '').trim(),           // 'permiso' | 'incidencia' | ''
    estatus: (query.estatus || '').trim(),     // 'Pendiente' | 'Aprobado' | ...
    desde: (query.desde || '1970-01-01'),
    hasta: (query.hasta || '2100-12-31'),
    page, perPage, offset
  };
  return filtros;
}

// Mapea de estatus_badge -> clases Tailwind (por si las quieres en server)
function badgeClass(estatus) {
  switch (estatus) {
    case 'Pendiente': return 'bg-yellow-50 text-yellow-700 border border-yellow-200';
    case 'Aprobado':  return 'bg-green-50 text-green-700 border border-green-200';
    case 'Rechazado': return 'bg-red-50 text-red-700 border border-red-200';
    case 'Cancelado': return 'bg-gray-50 text-gray-700 border border-gray-200';
    default:          return 'bg-slate-50 text-slate-700 border border-slate-200';
  }
}

// GET /miactividad
router.get('/miactividad', auth, async (req, res) => {
  const f = parseFilters(req.query);

  // WHERE dinámico
  const where = [];
  const params = [];

  // Texto libre (empleado, motivo, tipo)
  if (f.q) {
    where.push(`(empleado LIKE CONCAT('%', ?, '%') OR motivo LIKE CONCAT('%', ?, '%') OR tipo LIKE CONCAT('%', ?, '%'))`);
    params.push(f.q, f.q, f.q);
  }
  if (f.kind) {
    where.push(`kind = ?`);
    params.push(f.kind);
  }
  if (f.estatus) {
    where.push(`estatus = ?`);
    params.push(f.estatus);
  }
  // Rango de fechas (usa fecha_principal que ya trae YYYY-MM-DD)
  where.push(`fecha_principal BETWEEN ? AND ?`);
  params.push(f.desde, f.hasta);

  const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';

  // Consulta principal + conteo total
  const sqlData = `
    SELECT *
    FROM vw_bandeja_solicitudes
    ${whereSql}
    ORDER BY COALESCE(creado_en, fecha_ini) DESC, kind, id
    LIMIT ? OFFSET ?;
  `;
  const sqlCount = `
    SELECT COUNT(*) AS total
    FROM vw_bandeja_solicitudes
    ${whereSql};
  `;

  // Badges por kind
  const sqlBadges = `
    SELECT kind, COUNT(*) AS total
    FROM vw_bandeja_solicitudes
    ${whereSql}
    GROUP BY kind;
  `;

  try {
    const [rows, countRows, badgeRows] = await Promise.all([
      q(sqlData, [...params, f.perPage, f.offset]),
      q(sqlCount, params),
      q(sqlBadges, params)
    ]);

    const total = countRows?.[0]?.total || 0;
    const totalPages = Math.max(Math.ceil(total / f.perPage), 1);

    // Conteos separados para Permisos / Incidencias
    const badgePermisos = badgeRows.find(r => r.kind === 'permiso')?.total || 0;
    const badgeIncidencias = badgeRows.find(r => r.kind === 'incidencia')?.total || 0;

    // Render
    res.render('miactividad', {
      inbox: rows.map(r => ({
        ...r,
        // por si adjuntos_json viene como string JSON en tu driver:
        adjuntos: Array.isArray(r.adjuntos_json) ? r.adjuntos_json : (r.adjuntos_json ? JSON.parse(r.adjuntos_json) : []),
        estatusClass: badgeClass(r.estatus)
      })),
      badgePermisos,
      badgeIncidencias,
      total, totalPages,
      filters: f
    });
  } catch (err) {
    console.error('Error en /miactividad:', err);
    res.status(500).send('Error al cargar la bandeja de miactividad');
  }
});



// helper
const q = (sql, params = []) =>
  new Promise((resolve, reject) => {
    connections.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });

// home
router.get('/home', ...auth, async (req, res) => {
  
  try {
    
    const [usuariosActivos, dispositivos, horariosActivos, asistenciasRecientes, kpis, ultimoAcceso, motivos] = await Promise.all([
      q(`
        SELECT id_usuario, CONCAT_WS(' ', nombre, apellido_paterno, apellido_materno) AS nombre_completo
        FROM usuarios
        WHERE activo = 1
        ORDER BY nombre, apellido_paterno, apellido_materno
      `),
      q(`SELECT id_dispositivo, nombre_dispositivo, ubicacion FROM dispositivos ORDER BY id_dispositivo`),
      q(`SELECT id_horario, nombre_horario FROM horarios_semanales WHERE activo = 1 ORDER BY nombre_horario`),
      q(`
        SELECT * 
          FROM vw_asistencias_semaforo
          ORDER BY fecha DESC, hora DESC
          LIMIT 20;
      `),
      q(`
        SELECT 
          (SELECT COUNT(*) FROM asistencias INNER JOIN motivos ON id_motivo = motivofk WHERE fecha = CURDATE() AND nombre_motivo = 'Entrada')  AS asistencias_hoy,
          (SELECT COUNT(*) FROM incidencias  WHERE estatus = 'Pendiente') AS incidencias_pendientes,
          (SELECT COUNT(*) FROM permisos    WHERE estatus = 'Pendiente')  AS permisos_pendientes
      `),
      q(`
        SELECT 
          a.id_asistencia, a.fecha, a.hora,
          u.id_usuario,
          CONCAT_WS(' ', u.nombre, u.apellido_paterno, u.apellido_materno) AS nombre_completo,
          COALESCE(p.nombre_puesto, '—') AS nombre_puesto,
          COALESCE(d.nombre_dispositivo, '—') AS nombre_dispositivo
        FROM asistencias a
        INNER JOIN usuarios u       ON u.id_usuario = a.id_usuario
        LEFT  JOIN dispositivos d   ON d.id_dispositivo = a.id_dispositivo
        LEFT  JOIN puesto p         ON p.id_usuariofk = u.id_usuario
        ORDER BY a.fecha DESC, a.hora DESC
        LIMIT 1
      `),
      q(`
        SELECT * FROM motivos
      `)
    ]);

    res.render('home', {
      usuariosActivos,
      dispositivos,
      horariosActivos,
      asistenciasRecientes,
      kpis: kpis?.[0] || {},
      ultimoAcceso: ultimoAcceso?.[0] || null,
      motivos
    });
  } catch (error) {
    console.error('Error en /home:', error);
    res.status(500).send('Error al cargar la página de inicio');
  }
});


// router.get('/home', ...auth, (req, res) => {
//   const sqlUsuariosActivos = `
//     SELECT 
//       id_usuario,
//       CONCAT_WS(' ', nombre, apellido_paterno, apellido_materno) AS nombre_completo
//     FROM usuarios
//     WHERE activo = 1
//     ORDER BY nombre, apellido_paterno, apellido_materno
//   `;

//   connections.query(sqlUsuariosActivos, (error, usuariosActivos) => {
//     if (error) {
//       console.error('Error en consulta de usuarios activos:', error);
//       return res.status(500).send('Error al obtener usuarios activos');
//     }
//     return res.render('home', { usuariosActivos });
//   });
// });


//Ver configuracion
// Ver configuracion
router.get('/configuracion', ...auth, asyncHandler(async (req, res) => {
  const sqlHorarios = 'SELECT * FROM horarios_semanales ORDER BY nombre_horario ASC';
  const sqlUsuarios = `
    SELECT
  u.id_usuario,
  CONCAT_WS(' ', u.nombre, u.apellido_paterno, u.apellido_materno) AS nombre_completo,
  COALESCE(p.nombre_puesto, '') AS puesto
FROM usuarios u
LEFT JOIN puesto p ON p.id_usuariofk = u.id_usuario
WHERE (u.activo = 1 OR u.activo IS NULL)
ORDER BY nombre_completo ASC;

  `;

  connections.query(sqlHorarios, (err1, horarios) => {
    if (err1) {
      console.error('Error en consulta horarios:', err1);
      return res.status(500).send('Error al obtener los horarios');
    }
    connections.query(sqlUsuarios, (err2, usuarios) => {
      if (err2) {
        console.error('Error en consulta usuarios:', err2);
        return res.status(500).send('Error al obtener los usuarios');
      }
      return res.render('configuracion', { horarios, usuarios });
    });
  });
}));

// router.get('/configuracion', ...auth, asyncHandler(async (req, res) => {
//   const sql = 'SELECT * FROM horarios_semanales';
//   connections.query(sql, (error, results) => {
//     if (error) {
//       console.error('Error en consulta:', error);
//       return res.status(500).send('Error al obtener los horarios');
//     }
//     return res.render('configuracion', { horarios: results });
//   });
// }));


//Editar el usuario
router.get('/editusuario/:id_usuario', ...auth, (req, res) => {
  const { id_usuario } = req.params;
  const sql = 'SELECT * FROM usuarios WHERE id_usuario = ? LIMIT 1';
  connections.query(sql, [id_usuario], (error, results) => {
    if (error) {
      console.error('Error en consulta', error);
      return res.status(500).send('Error al obtener el usuario');
    }
    if (!results || results.length === 0) {
      return res.status(404).render('editusuario', { usuario: null, historial: [] });
    }
    return res.render('editusuario', { usuario: results[0], historial: [] });
  });
});

//Un usuario (Con DB)
router.get('/perfil/:id_usuario',  ...auth, (req, res) => {
  const { id_usuario } = req.params;

  const sqlUsuario = `
    SELECT u.*, p.id_horario, p.nombre_puesto,
           h.nombre_horario,
           h.lun_entrada, h.lun_salida, h.lun_comida_ini, h.lun_comida_fin,
           h.mar_entrada, h.mar_salida, h.mar_comida_ini, h.mar_comida_fin,
           h.mie_entrada, h.mie_salida, h.mie_comida_ini, h.mie_comida_fin,
           h.jue_entrada, h.jue_salida, h.jue_comida_ini, h.jue_comida_fin,
           h.vie_entrada, h.vie_salida, h.vie_comida_ini, h.vie_comida_fin,
           h.sab_entrada, h.sab_salida, h.sab_comida_ini, h.sab_comida_fin,
           h.dom_entrada, h.dom_salida, h.dom_comida_ini, h.dom_comida_fin
    FROM usuarios u
    LEFT JOIN puesto p              ON u.id_usuario = p.id_usuariofk
    LEFT JOIN horarios_semanales h  ON p.id_horario = h.id_horario
    WHERE u.id_usuario = ?
    LIMIT 1
  `;

  const sqlHorarios = `
    SELECT id_horario, nombre_horario
    FROM horarios_semanales
    ORDER BY nombre_horario
  `;

  // Historial (corregido: usa m.nombre_motivo)
  const sqlHistorial = `
    SELECT 
      a.id_asistencia, a.fecha, a.hora, a.dia_semana,
      a.registro_manual, a.motivofk, a.observaciones,
      d.nombre_dispositivo,
      CONCAT(a.fecha, ' ', a.hora) AS fecha_hora,
      COALESCE(
        CASE
          WHEN m.nombre_motivo IS NOT NULL THEN
            CASE LOWER(TRIM(m.nombre_motivo))
              WHEN 'entrada'            THEN 'Entrada'
              WHEN 'salida'             THEN 'Salida'
              WHEN 'salida de comida'   THEN 'Salida a comida'
              WHEN 'salida comida'      THEN 'Salida a comida'
              WHEN 'entrada de comida'  THEN 'Regreso de comida'
              WHEN 'entrada comida'     THEN 'Regreso de comida'
              ELSE 'Movimiento'
            END
          ELSE
            CASE a.motivofk
              WHEN 1 THEN 'Entrada'
              WHEN 2 THEN 'Salida'
              WHEN 3 THEN 'Regreso de comida'
              WHEN 4 THEN 'Salida a comida'
              ELSE 'Movimiento'
            END
        END,
        'Movimiento'
      ) AS tipo
    FROM asistencias a
    LEFT JOIN dispositivos d ON d.id_dispositivo = a.id_dispositivo
    LEFT JOIN motivos m      ON m.id_motivo      = a.motivofk
    WHERE a.id_usuario = ?
    ORDER BY a.fecha DESC, a.hora DESC
    LIMIT 100
  `;

  // ===== REPORTE SEMANAL: SOLO ESE USUARIO =====
  const sqlReporteSemanal = `
WITH
/* ===== Normalización de eventos (solo este usuario) ===== */
evt AS (
  SELECT
    a.id_asistencia,
    a.id_usuario,
    a.fecha,
    a.hora,
    CASE LOWER(TRIM(m.nombre_motivo))
      WHEN 'entrada'            THEN 'entrada'
      WHEN 'salida'             THEN 'salida'
      WHEN 'salida de comida'   THEN 'comida_salida'
      WHEN 'entrada de comida'  THEN 'comida_entrada'
      ELSE NULL
    END AS tipo_evento
  FROM asistencias a
  LEFT JOIN motivos m ON m.id_motivo = a.motivofk
  WHERE a.id_usuario = ? AND a.fecha IS NOT NULL AND a.hora IS NOT NULL
),

/* ===== Delimitadores del día ===== */
bounds AS (
  SELECT
    id_usuario,
    fecha,
    MIN(CASE WHEN tipo_evento='entrada' THEN hora END) AS h_entrada,
    MAX(CASE WHEN tipo_evento='salida'  THEN hora END) AS h_salida
  FROM evt
  GROUP BY id_usuario, fecha
),

/* ===== Emparejar comida ===== */
comidas AS (
  SELECT
    e1.id_usuario,
    e1.fecha,
    e1.hora AS h_comida_out,
    MIN(e2.hora) AS h_comida_in
  FROM evt e1
  LEFT JOIN evt e2
    ON  e2.id_usuario  = e1.id_usuario
    AND e2.fecha       = e1.fecha
    AND e2.tipo_evento = 'comida_entrada'
    AND e2.hora       >= e1.hora
  WHERE e1.tipo_evento = 'comida_salida'
  GROUP BY e1.id_usuario, e1.fecha, e1.hora
),

comidas_seg AS (
  SELECT
    id_usuario,
    fecha,
    SUM(GREATEST(TIMESTAMPDIFF(SECOND, h_comida_out, h_comida_in), 0)) AS seg_comida
  FROM comidas
  WHERE h_comida_in IS NOT NULL
  GROUP BY id_usuario, fecha
),

/* ===== Segundos trabajados del día ===== */
dia AS (
  SELECT
    b.id_usuario,
    b.fecha,
    GREATEST(
      TIMESTAMPDIFF(SECOND, b.h_entrada, b.h_salida) - COALESCE(c.seg_comida,0),
      0
    ) AS seg_trabajados
  FROM bounds b
  LEFT JOIN comidas_seg c
    ON c.id_usuario = b.id_usuario AND c.fecha = b.fecha
  WHERE b.h_entrada IS NOT NULL
    AND b.h_salida  IS NOT NULL
    AND b.h_salida  >= b.h_entrada
),

/* ===== Días trabajados por semana (fechas con seg_trabajados > 0) ===== */
dias_real_sem AS (
  SELECT
    id_usuario,
    YEARWEEK(fecha,1) AS semana_iso,
    COUNT(DISTINCT fecha) AS dias_trabajados
  FROM dia
  WHERE seg_trabajados > 0
  GROUP BY id_usuario, YEARWEEK(fecha,1)
),

/* ===== Días programados a la semana según horario asignado ===== */
dias_prog_cfg AS (
  SELECT
    p.id_usuariofk AS id_usuario,
    /* Cuenta cuántos días tienen entrada y salida configuradas */
    ( IF(hs.lun_entrada IS NOT NULL AND hs.lun_salida IS NOT NULL,1,0)
    + IF(hs.mar_entrada IS NOT NULL AND hs.mar_salida IS NOT NULL,1,0)
    + IF(hs.mie_entrada IS NOT NULL AND hs.mie_salida IS NOT NULL,1,0)
    + IF(hs.jue_entrada IS NOT NULL AND hs.jue_salida IS NOT NULL,1,0)
    + IF(hs.vie_entrada IS NOT NULL AND hs.vie_salida IS NOT NULL,1,0)
    + IF(hs.sab_entrada IS NOT NULL AND hs.sab_salida IS NOT NULL,1,0)
    + IF(hs.dom_entrada IS NOT NULL AND hs.dom_salida IS NOT NULL,1,0)
    ) AS dias_programados
  FROM puesto p
  JOIN horarios_semanales hs ON hs.id_horario = p.id_horario
  WHERE p.id_usuariofk = ?
  LIMIT 1
),

/* ===== Fechas a considerar para la programación (salen de evt ya filtrado) ===== */
fechas_usuario AS (
  SELECT DISTINCT id_usuario, fecha
  FROM evt
),

/* ===== Programación por día (segundos esperados) ===== */
prog_por_dia AS (
  SELECT
    fu.id_usuario,
    fu.fecha,
    CASE DAYOFWEEK(fu.fecha)
      WHEN 2 THEN hs.lun_entrada WHEN 3 THEN hs.mar_entrada WHEN 4 THEN hs.mie_entrada
      WHEN 5 THEN hs.jue_entrada WHEN 6 THEN hs.vie_entrada WHEN 7 THEN hs.sab_entrada
      ELSE hs.dom_entrada END AS hin,
    CASE DAYOFWEEK(fu.fecha)
      WHEN 2 THEN hs.lun_salida WHEN 3 THEN hs.mar_salida WHEN 4 THEN hs.mie_salida
      WHEN 5 THEN hs.jue_salida WHEN 6 THEN hs.vie_salida WHEN 7 THEN hs.sab_salida
      ELSE hs.dom_salida END AS hout,
    CASE DAYOFWEEK(fu.fecha)
      WHEN 2 THEN hs.lun_comida_ini WHEN 3 THEN hs.mar_comida_ini WHEN 4 THEN hs.mie_comida_ini
      WHEN 5 THEN hs.jue_comida_ini WHEN 6 THEN hs.vie_comida_ini WHEN 7 THEN hs.sab_comida_ini
      ELSE hs.dom_comida_ini END AS c_in,
    CASE DAYOFWEEK(fu.fecha)
      WHEN 2 THEN hs.lun_comida_fin WHEN 3 THEN hs.mar_comida_fin WHEN 4 THEN hs.mie_comida_fin
      WHEN 5 THEN hs.jue_comida_fin WHEN 6 THEN hs.vie_comida_fin WHEN 7 THEN hs.sab_comida_fin
      ELSE hs.dom_comida_fin END AS c_out
  FROM fechas_usuario fu
  JOIN puesto p              ON p.id_usuariofk = fu.id_usuario
  JOIN horarios_semanales hs ON hs.id_horario  = p.id_horario
),

prog_seg_dia AS (
  SELECT
    id_usuario,
    fecha,
    GREATEST(
      TIMESTAMPDIFF(SECOND, hin, hout)
      - CASE
          WHEN c_in IS NOT NULL AND c_out IS NOT NULL AND c_out > c_in
          THEN TIMESTAMPDIFF(SECOND, c_in, c_out)
          ELSE 0
        END,
      0
    ) AS seg_prog
  FROM prog_por_dia
  WHERE hin IS NOT NULL AND hout IS NOT NULL AND hout > hin
),

/* ===== Agregados por semana (segundos) ===== */
horas_real_sem AS (
  SELECT id_usuario, YEARWEEK(fecha,1) AS semana_iso, SUM(seg_trabajados) AS seg_real_sem
  FROM dia
  GROUP BY id_usuario, YEARWEEK(fecha,1)
),
horas_prog_sem AS (
  SELECT id_usuario, YEARWEEK(fecha,1) AS semana_iso, SUM(seg_prog) AS seg_prog_sem
  FROM prog_seg_dia
  GROUP BY id_usuario, YEARWEEK(fecha,1)
),

/* ===== Combinar reales y programadas (sin FULL JOIN) ===== */
semana_union AS (
  -- A) Semanas con reales (trae programadas si existen)
  SELECT hr.id_usuario, hr.semana_iso, hr.seg_real_sem, COALESCE(hp.seg_prog_sem,0) AS seg_prog_sem
  FROM horas_real_sem hr
  LEFT JOIN horas_prog_sem hp
    ON hp.id_usuario = hr.id_usuario AND hp.semana_iso = hr.semana_iso

  UNION ALL

  -- B) Semanas solo programadas (sin reales)
  SELECT hp.id_usuario, hp.semana_iso, 0 AS seg_real_sem, hp.seg_prog_sem
  FROM horas_prog_sem hp
  LEFT JOIN horas_real_sem hr
    ON hr.id_usuario = hp.id_usuario AND hr.semana_iso = hp.semana_iso
  WHERE hr.id_usuario IS NULL
)

SELECT
  u.id_usuario,
  CONCAT_WS(' ', u.nombre, u.apellido_paterno, u.apellido_materno) AS empleado,
  s.semana_iso,
  SEC_TO_TIME(COALESCE(s.seg_real_sem,0)) AS horas_trabajadas,
  SEC_TO_TIME(COALESCE(s.seg_prog_sem,0)) AS horas_programadas,

  /* ===== Horas extra reales (no duplicadas) ===== */
  SEC_TO_TIME(GREATEST(COALESCE(s.seg_real_sem,0) - COALESCE(s.seg_prog_sem,0), 0)) AS extra_estimado,

  /* ===== Días trabajados / programados y % cumplimiento ===== */
  COALESCE(dr.dias_trabajados, 0) AS dias_trabajados,
  COALESCE(dp.dias_programados, 7) AS dias_programados,
  ROUND(100 * COALESCE(dr.dias_trabajados,0) / NULLIF(dp.dias_programados,0), 1) AS porcentaje_cumplimiento_dias

FROM semana_union s
JOIN usuarios u ON u.id_usuario = s.id_usuario
LEFT JOIN dias_real_sem dr ON dr.id_usuario = s.id_usuario AND dr.semana_iso = s.semana_iso
LEFT JOIN dias_prog_cfg dp ON dp.id_usuario = s.id_usuario
ORDER BY s.semana_iso DESC;
`;



  connections.query(sqlUsuario, [id_usuario], (errU, userRows) => {
    if (errU) {
      console.error('Error usuario:', errU);
      return res.status(500).send('Error al obtener el usuario');
    }
    if (!userRows || userRows.length === 0) {
      return res.status(404).render('perfil', { usuario: null, historial: [], horarios: [], reporteSemanal: [] });
    }

    connections.query(sqlHorarios, (errH, horarios) => {
      if (errH) {
        console.error('Error horarios:', errH);
        return res.status(500).send('Error al obtener horarios');
      }

      connections.query(sqlHistorial, [id_usuario], (errHist, historial) => {
        if (errHist) {
          console.error('Error historial:', errHist);
          historial = [];
        }

        // Ejecuta el reporte semanal SOLO para ese usuario (nota: id va 2 veces en el CTE)
        connections.query(sqlReporteSemanal, [id_usuario, id_usuario, id_usuario], (errRep, reporteSemanal) => {
          if (errRep) {
            console.error('Error reporteSemanal:', errRep);
            reporteSemanal = [];
          }

          return res.render('perfil', {
            usuario: userRows[0],
            historial,
            horarios,
            reporteSemanal, // 👈 lo mandamos a la vista
          });
        });
      });
    });
  });
});


// router.get('/perfil/:id_usuario', ...auth, (req, res) => {
//   const { id_usuario } = req.params;

//   const sqlUsuario = `
//   SELECT *
//   FROM usuarios u
//   LEFT JOIN puesto p ON u.id_usuario = p.id_usuariofk
//   LEFT JOIN horarios_semanales h ON p.id_horario = h.id_horario
//   WHERE u.id_usuario = ?
//   LIMIT 1
// `;
//   const sqlHorarios   = 'SELECT id_horario, nombre_horario FROM horarios_semanales';

//   connections.query(sqlUsuario, [id_usuario], (errU, userRows) => {
//     if (errU) {
//       console.error('Error usuario:', errU);
//       return res.status(500).send('Error al obtener el usuario');
//     }
//     if (!userRows || userRows.length === 0) {
//       return res.status(404).render('perfil', { usuario: null, historial: [], horarios: [], puestoActual: null });
//     }

//     connections.query(sqlHorarios, (errH, horarios) => {
//       if (errH) {
//         console.error('Error horarios:', errH);
//         return res.status(500).send('Error al obtener horarios');
//       }

//         return res.render('perfil', {
//           usuario: userRows[0],
//           historial: [],        // Si luego tienes historial, lo colocas aquí
//           horarios,             // 👈 para llenar el <select>
//         });
//     });
//   });
// });

// Usuarios (con DB)
// GET /usuarios
router.get('/usuarios', ...auth, (req, res) => {
  const { q = '', role = '', status = '' } = req.query;

  const where = [];
  const params = [];

  if (q.trim()) {
    const like = `%${q.trim()}%`;
    where.push(`(u.nombre LIKE ? OR u.apellido_paterno LIKE ? OR u.apellido_materno LIKE ? OR u.correo LIKE ?)`);
    params.push(like, like, like, like);
  }

  if (role) { // 'admin' | 'usuario' | 'proveedor'
    where.push(`u.tipo_usuario = ?`);
    params.push(role);
  }

  if (status) { // 'activo' | 'desactivado'
    if (status === 'activo') where.push('u.activo = 1');
    if (status === 'desactivado') where.push('u.activo = 0');
  }

  const sql = `
    SELECT
      u.id_usuario, u.nombre, u.apellido_paterno, u.apellido_materno,
      u.correo, u.tipo_usuario, u.activo,
      p.id_puesto, p.nombre_puesto,
      h.id_horario AS h_id_horario,
      h.nombre_horario AS h_nombre  -- 👈 corrige el nombre de columna
    FROM usuarios u
    LEFT JOIN puesto p            ON p.id_usuariofk = u.id_usuario   -- 👈 usa id_usuariofk
    LEFT JOIN horarios_semanales h ON h.id_horario   = p.id_horario
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY u.id_usuario DESC
  `;

  connections.query(sql, params, (error, usuarios) => {
    if (error) {
      console.error('Error en consulta:', error);
      return res.status(500).send('Error al obtener los usuarios');
    }

    // Opciones dinámicas para "Rol"
    connections.query(
      `SELECT DISTINCT u.tipo_usuario AS role FROM usuarios u WHERE u.tipo_usuario IS NOT NULL AND u.tipo_usuario<>'' ORDER BY role`,
      (e1, rolesRows) => {
        if (e1) return res.status(500).send('Error cargando roles');

        // Render sin departamento (porque no hay FK en 'puesto')
        res.render('usuarios', {
          usuarios,
          filtros: { q, role, status },   // sin dept
          roles: rolesRows.map(r => r.role),
          departamentos: []               // placeholder si el EJS lo espera
        });
      }
    );
  });
});


module.exports = router;