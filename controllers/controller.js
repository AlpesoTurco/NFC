const express = require('express');
const controller = express();
const connections = require ('../database/db');
const requireAuthView = require('../middlewares/requireAuthView');
const requireAuthApi  = require('../middlewares/requireAuthApi');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

controller.use('/', require('./login_controller'));
controller.use('/', require('./pendientes_controller'));
controller.use('/', require('./incidencias_controller'));

// Map de tipos → tabla y PK
const KIND_MAP = {
  permiso:    { table: 'permisos',    pk: 'id_permiso' },
  incidencia: { table: 'incidencias', pk: 'id_incidencia' }
};

// Aprobador desde sesión (JWT)
function getAprobador(req) {
  return (req.user && req.user.id_usuario) || null;
}

// Valida 'kind' → {table, pk} o null
function resolveKind(kind) {
  return KIND_MAP[kind] || null;
}

// Traduce acción → estatus
function statusFromAction(action) {
  if (action === 'aprobar') return 'Aprobado';
  if (action === 'rechazar') return 'Rechazado';
  return null;
}




/**
 * POST /api/solicitudes/:kind/:id/:action
 *   kind: permiso | incidencia
 *   id:   numérico
 *   action: aprobar | rechazar
 * body: { comentario?: string }
 */
controller.post('/api/solicitudes/:kind/:id/:action', requireAuthApi, (req, res) => {
  const { kind, id, action } = req.params;
  const meta = resolveKind(kind);
  const nuevoEstatus = statusFromAction(action);
  const comentario = (req.body?.comentario || '').toString().trim();
  const aprobador = getAprobador(req);

  if (!meta) return res.status(400).json({ ok:false, msg:'Tipo inválido (kind)' });
  const rowId = parseInt(id, 10);
  if (!rowId) return res.status(400).json({ ok:false, msg:'ID inválido' });
  if (!nuevoEstatus) return res.status(400).json({ ok:false, msg:'Acción inválida' });
  if (!aprobador) return res.status(401).json({ ok:false, msg:'No autenticado' });

  // 1) Verifica que exista y esté Pendiente
  const sqlSel = `SELECT ${meta.pk} AS id, estatus FROM ${meta.table} WHERE ${meta.pk} = ? LIMIT 1`;
  connections.query(sqlSel, [rowId], (errS, rows) => {
    if (errS) {
      console.error('Error SELECT:', errS);
      return res.status(500).json({ ok:false, msg:'Error del servidor (select)' });
    }
    const row = rows?.[0];
    if (!row) return res.status(404).json({ ok:false, msg:'No encontrado' });
    if (row.estatus !== 'Pendiente') {
      return res.status(409).json({ ok:false, msg:`Ya está ${row.estatus}` });
    }

    // 2) Actualiza estatus, aprobador, comentario y timestamp
    const sqlUpd = `
      UPDATE ${meta.table}
         SET estatus = ?,
             id_aprobador = ?,
             comentario_resolucion = CASE WHEN ? <> '' THEN ? ELSE comentario_resolucion END,
             actualizado_en = NOW()
       WHERE ${meta.pk} = ? AND estatus = 'Pendiente'
       LIMIT 1
    `;
    const params = [nuevoEstatus, aprobador, comentario, comentario, rowId];

    connections.query(sqlUpd, params, (errU, result) => {
      if (errU) {
        console.error('Error UPDATE:', errU);
        return res.status(500).json({ ok:false, msg:'Error del servidor (update)' });
      }
      if (result.affectedRows === 0) {
        // Alguien lo cambió en paralelo
        return res.status(409).json({ ok:false, msg:'No se pudo cambiar (concurrencia)' });
      }
      return res.json({
        ok: true,
        msg: `Solicitud ${action}da`,
        data: {
          kind,
          id: rowId,
          estatus: nuevoEstatus,
          id_aprobador: aprobador,
          comentario_resolucion: comentario || null
        }
      });
    });
  });
});

/**
 * POST /api/solicitudes/bulk
 * body: { action: 'aprobar'|'rechazar', keys: ['permiso:14','incidencia:3'], comentario?: string }
 */
controller.post('/api/solicitudes/bulk', requireAuthApi, async (req, res) => {
  try {
    const action = (req.body?.action || '').toString().trim();
    const keys = Array.isArray(req.body?.keys) ? req.body.keys : [];
    const comentario = (req.body?.comentario || '').toString().trim();
    const aprobador = getAprobador(req);

    const nuevoEstatus = statusFromAction(action);
    if (!nuevoEstatus) return res.status(400).json({ ok:false, msg:'Acción inválida' });
    if (!aprobador) return res.status(401).json({ ok:false, msg:'No autenticado' });
    if (!keys.length) return res.status(400).json({ ok:false, msg:'Sin keys' });

    // Ejecuta secuencialmente para simplicidad
    const changed = [];
    const skipped = [];

    for (const key of keys) {
      const [kind, idStr] = String(key).split(':');
      const meta = resolveKind(kind);
      const id = parseInt(idStr, 10);

      if (!meta || !id) {
        skipped.push({ key, reason: 'key inválida' });
        continue;
      }

      // WHERE Pendiente para evitar doble decisión
      const sqlUpd = `
        UPDATE ${meta.table}
           SET estatus = ?,
               id_aprobador = ?,
               comentario_resolucion = CASE WHEN ? <> '' THEN ? ELSE comentario_resolucion END,
               actualizado_en = NOW()
         WHERE ${meta.pk} = ? AND estatus = 'Pendiente'
         LIMIT 1
      `;
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await new Promise((resolve, reject) => {
          connections.query(sqlUpd, [nuevoEstatus, aprobador, comentario, comentario, id], (e, r) => {
            if (e) reject(e); else resolve(r);
          });
        });
        if (result.affectedRows > 0) {
          changed.push({ key, estatus: nuevoEstatus, id_aprobador: aprobador });
        } else {
          skipped.push({ key, reason: 'ya no está Pendiente o no existe' });
        }
      } catch (e) {
        console.error('Bulk UPDATE error:', e);
        skipped.push({ key, reason: 'error' });
      }
    }

    return res.json({ ok:true, action, changed, skipped });
  } catch (e) {
    console.error('Bulk error:', e);
    return res.status(500).json({ ok:false, msg:'Error del servidor' });
  }
});


//----------------------------------------------------------------


controller.post('/api/nfc/enroll', (req, res) => {
  let { id_usuario, numero_tarjeta, forceReplace } = req.body;

  // ===== Validaciones básicas =====
  id_usuario = parseInt(id_usuario, 10);
  numero_tarjeta = (numero_tarjeta || '').toString().trim();
  forceReplace = Boolean(forceReplace);

  if (!id_usuario || !numero_tarjeta) {
    return res.status(400).json({ ok: false, msg: 'Faltan datos: id_usuario y numero_tarjeta' });
  }
  if (numero_tarjeta.length > 50) {
    return res.status(400).json({ ok: false, msg: 'numero_tarjeta excede 50 caracteres' });
  }

  // ===== 1) Verificar que el usuario exista =====
  const sqlUser = 'SELECT id_usuario FROM usuarios WHERE id_usuario = ? LIMIT 1';
  connections.query(sqlUser, [id_usuario], (errU, rowsU) => {
    if (errU) {
      console.error('Error verificando usuario:', errU);
      return res.status(500).json({ ok: false, msg: 'Error verificando usuario' });
    }
    if (!rowsU?.length) {
      return res.status(400).json({ ok: false, msg: 'Usuario no existe' });
    }

    // ===== 2) ¿Existe ya esta tarjeta? =====
    const sqlCardByNumber = `
      SELECT id_tarjeta, numero_tarjeta, id_usuario 
      FROM tarjeta_nfc 
      WHERE numero_tarjeta = ? 
      LIMIT 1`;
    connections.query(sqlCardByNumber, [numero_tarjeta], (errC, rowsC) => {
      if (errC) {
        console.error('Error consultando tarjeta por numero:', errC);
        return res.status(500).json({ ok: false, msg: 'Error consultando tarjeta' });
      }

      const card = rowsC?.[0] || null;

      // Helper: borra tarjeta actual del usuario (si tiene) → para poder asignar otra
      const deleteUserCard = (cb) => {
        const sqlDel = 'DELETE FROM tarjeta_nfc WHERE id_usuario = ?';
        connections.query(sqlDel, [id_usuario], (errD) => {
          if (errD) {
            console.error('Error eliminando tarjeta previa del usuario:', errD);
            return cb(errD);
          }
          cb(null);
        });
      };

      // ===== Caso A: la tarjeta ya existe =====
      if (card) {
        // A1) Ya está asociada a este mismo usuario → OK idempotente
        if (card.id_usuario === id_usuario) {
          return res.json({
            ok: true,
            msg: 'Tarjeta ya estaba enrolada con este usuario',
            id_tarjeta: card.id_tarjeta,
            id_usuario,
            numero_tarjeta
          });
        }

        // A2) Tarjeta pertenece a otro usuario
        if (!forceReplace) {
          return res.status(409).json({
            ok: false,
            msg: 'Esta tarjeta ya está asignada a otro usuario. Envía forceReplace=true para reasignar.'
          });
        }

        // A3) Reasignar tarjeta a este usuario (forceReplace=true)
        //    - Primero, elimina cualquier tarjeta que tenga este usuario (por UNIQUE en id_usuario)
        deleteUserCard((errDel) => {
          if (errDel) return res.status(500).json({ ok: false, msg: 'Error preparando reasignación' });

          const sqlUpdate = 'UPDATE tarjeta_nfc SET id_usuario = ? WHERE id_tarjeta = ?';
          connections.query(sqlUpdate, [id_usuario, card.id_tarjeta], (errUp, resultUp) => {
            if (errUp) {
              console.error('Error reasignando tarjeta:', errUp);
              return res.status(500).json({ ok: false, msg: 'Error reasignando tarjeta' });
            }
            return res.json({
              ok: true,
              msg: 'Tarjeta reasignada al usuario',
              id_tarjeta: card.id_tarjeta,
              id_usuario,
              numero_tarjeta
            });
          });
        });

        return; // fin Caso A
      }

      // ===== Caso B: la tarjeta NO existe → intentar insertar nueva fila
      const sqlInsert = `
        INSERT INTO tarjeta_nfc (numero_tarjeta, id_usuario)
        VALUES (?, ?)
      `;
      connections.query(sqlInsert, [numero_tarjeta, id_usuario], (errIns, resultIns) => {
        if (!errIns) {
          return res.status(201).json({
            ok: true,
            msg: 'Tarjeta enrolada',
            id_tarjeta: resultIns.insertId,
            id_usuario,
            numero_tarjeta
          });
        }

        // B1) Violación de UNIQUE en id_usuario → el usuario ya tenía una tarjeta
        if (errIns.code === 'ER_DUP_ENTRY') {
          if (!forceReplace) {
            return res.status(409).json({
              ok: false,
              msg: 'El usuario ya tiene una tarjeta asignada. Envía forceReplace=true para reemplazarla.'
            });
          }

          // Reemplazo controlado: borra la tarjeta del usuario y vuelve a insertar
          deleteUserCard((errDel) => {
            if (errDel) {
              return res.status(500).json({ ok: false, msg: 'Error preparando reemplazo de tarjeta' });
            }
            connections.query(sqlInsert, [numero_tarjeta, id_usuario], (errIns2, resultIns2) => {
              if (errIns2) {
                // Puede fallar si simultáneamente alguien insertó la misma numero_tarjeta
                if (errIns2.code === 'ER_DUP_ENTRY') {
                  return res.status(409).json({
                    ok: false,
                    msg: 'Esta numero_tarjeta fue tomada en paralelo por otro usuario. Intenta nuevamente.'
                  });
                }
                console.error('Error insertando tarjeta tras delete:', errIns2);
                return res.status(500).json({ ok: false, msg: 'Error asignando la nueva tarjeta' });
              }
              return res.status(201).json({
                ok: true,
                msg: 'Tarjeta reemplazada correctamente',
                id_tarjeta: resultIns2.insertId,
                id_usuario,
                numero_tarjeta
              });
            });
          });
          return;
        }

        console.error('Error insertando tarjeta:', errIns);
        return res.status(500).json({ ok: false, msg: 'Error enrolando tarjeta' });
      });
    });
  });
});



controller.post('/acceso/abrir', (req, res) => {
  let { id_usuario, motivofk, observaciones } = req.body;

  // Validaciones básicas
  id_usuario = parseInt(id_usuario, 10);
  motivofk = parseInt(motivofk, 10);
  observaciones = (observaciones || '').toString().trim();

  if (!id_usuario || !motivofk || !observaciones) {
    return res.status(400).json({ ok: false, msg: 'Faltan datos: usuario, motivo u observaciones' });
  }
  if (observaciones.length > 200) {
    return res.status(400).json({ ok: false, msg: 'Observaciones supera 200 caracteres' });
  }

  // Fecha y hora en CDMX
  const nowCdmx = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' })
  );
  const pad = n => String(n).padStart(2, '0');
  const fecha = `${nowCdmx.getFullYear()}-${pad(nowCdmx.getMonth() + 1)}-${pad(nowCdmx.getDate())}`;
  const hora  = `${pad(nowCdmx.getHours())}:${pad(nowCdmx.getMinutes())}:${pad(nowCdmx.getSeconds())}`;
  const dia_semana = nowCdmx
    .toLocaleDateString('es-MX', { weekday: 'long', timeZone: 'America/Mexico_City' })
    .toLowerCase();

  // (Opcional) comprobar que el motivo existe para dar error 400 legible
  const sqlCheckMotivo = 'SELECT id_motivo FROM motivos WHERE id_motivo = ? LIMIT 1';
  connections.query(sqlCheckMotivo, [motivofk], (errCk, rowsCk) => {
    if (errCk) {
      console.error('Error verificando motivo:', errCk);
      return res.status(500).json({ ok: false, msg: 'Error verificando motivo' });
    }
    if (!rowsCk?.length) {
      return res.status(400).json({ ok: false, msg: 'Motivo no válido' });
    }

    // Insert en asistencias (id_dispositivo fijo = 1; ajusta si necesitas)
    const sqlAsistencia = `
      INSERT INTO asistencias
        (id_usuario, id_dispositivo, fecha, hora, dia_semana, registro_manual, motivofk, observaciones)
      VALUES
        (?, 1, ?, ?, ?, 1, ?, ?)
    `;
    const params = [id_usuario, fecha, hora, dia_semana, motivofk, observaciones];

    connections.query(sqlAsistencia, params, (errIns, result) => {
      if (errIns) {
        // ER_NO_REFERENCED_ROW_2 (1452) si la FK no existe
        if (errIns.errno === 1452) {
          return res.status(400).json({ ok: false, msg: 'Motivo no válido (FK)' });
        }
        console.error('Error al insertar asistencia:', errIns);
        return res.status(500).json({ ok: false, msg: 'Error al registrar asistencia' });
      }

      const at = new Date().toISOString();
      return res.json({
        ok: true,
        at,
        asistencia_id: result.insertId,
        fecha,
        hora,
        dia_semana,
        id_usuario,
        motivofk,
      });
    });
  });
});




// POST: guardar o actualizar asignación en la tabla puesto
controller.post('/puestos/asignar', (req, res) => {
  const { id_usuario, nombre_puesto, id_horario } = req.body;
  if (!id_usuario || !nombre_puesto || !id_horario) {
    return res.status(400).send('Faltan datos');
  }

  const sqlUpsert = `
    INSERT INTO puesto (nombre_puesto, id_horario, id_usuariofk)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE
      nombre_puesto = VALUES(nombre_puesto),
      id_horario    = VALUES(id_horario)
  `;

  connections.query(sqlUpsert, [nombre_puesto, id_horario, id_usuario], (err) => {
    if (err) {
      console.error('Error al asignar/actualizar puesto:', err);
      return res.status(500).send('Error al asignar horario');
    }
    res.redirect(`/perfil/${id_usuario}`);
  });
});



// Eliminar un horario semanal
controller.delete('/horarios-semanales/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok:false, msg:'ID inválido' });

  connections.query('DELETE FROM horarios_semanales WHERE id_horario = ? LIMIT 1', [id],
    (err, result) => {
      if (err) return res.status(500).json({ ok:false, msg:'Error del servidor al eliminar' });
      if (result.affectedRows === 0) return res.status(404).json({ ok:false, msg:'Horario no encontrado' });
      return res.json({ ok:true, msg:'Horario eliminado' });
    }
  );
});



// Helpers
function parseActivo(val) {
  // checkbox "on", "1", 1, true => 1 ; cualquier otra cosa => 0
  if (val === 1 || val === '1' || val === true || val === 'true' || val === 'on' || val === 'ON') return 1;
  return 0;
}
function nullIfEmpty(v) {
  return (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
}
function isValidTimeOrNull(v) {
  if (v == null || v === '') return true;
  // Acepta HH:MM o HH:MM:SS (el input <time> envía HH:MM)
  return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(v);
}

// =================== CREAR NUEVO HORARIO ===================
controller.post('/horarios-semanales/new', (req, res) => {
  try {
    // 1) Extraer body
    let {
      nombre,
      activo,

      lun_entrada,  lun_comida_ini,  lun_comida_fin,  lun_salida,
      mar_entrada,  mar_comida_ini,  mar_comida_fin,  mar_salida,
      mie_entrada,  mie_comida_ini,  mie_comida_fin,  mie_salida,
      jue_entrada,  jue_comida_ini,  jue_comida_fin,  jue_salida,
      vie_entrada,  vie_comida_ini,  vie_comida_fin,  vie_salida,
      sab_entrada,  sab_comida_ini,  sab_comida_fin,  sab_salida,
      dom_entrada,  dom_comida_ini,  dom_comida_fin,  dom_salida
    } = req.body;

    // 2) Normalizaciones y nulls
    nombre = (nombre || '').trim();
    activo = parseActivo(activo);

    // Pasar vacíos a null
    const fields = {
      lun_entrada: nullIfEmpty(lun_entrada),
      lun_comida_ini: nullIfEmpty(lun_comida_ini),
      lun_comida_fin: nullIfEmpty(lun_comida_fin),
      lun_salida: nullIfEmpty(lun_salida),

      mar_entrada: nullIfEmpty(mar_entrada),
      mar_comida_ini: nullIfEmpty(mar_comida_ini),
      mar_comida_fin: nullIfEmpty(mar_comida_fin),
      mar_salida: nullIfEmpty(mar_salida),

      mie_entrada: nullIfEmpty(mie_entrada),
      mie_comida_ini: nullIfEmpty(mie_comida_ini),
      mie_comida_fin: nullIfEmpty(mie_comida_fin),
      mie_salida: nullIfEmpty(mie_salida),

      jue_entrada: nullIfEmpty(jue_entrada),
      jue_comida_ini: nullIfEmpty(jue_comida_ini),
      jue_comida_fin: nullIfEmpty(jue_comida_fin),
      jue_salida: nullIfEmpty(jue_salida),

      vie_entrada: nullIfEmpty(vie_entrada),
      vie_comida_ini: nullIfEmpty(vie_comida_ini),
      vie_comida_fin: nullIfEmpty(vie_comida_fin),
      vie_salida: nullIfEmpty(vie_salida),

      sab_entrada: nullIfEmpty(sab_entrada),
      sab_comida_ini: nullIfEmpty(sab_comida_ini),
      sab_comida_fin: nullIfEmpty(sab_comida_fin),
      sab_salida: nullIfEmpty(sab_salida),

      dom_entrada: nullIfEmpty(dom_entrada),
      dom_comida_ini: nullIfEmpty(dom_comida_ini),
      dom_comida_fin: nullIfEmpty(dom_comida_fin),
      dom_salida: nullIfEmpty(dom_salida)
    };

    // 3) Validaciones mínimas
    if (!nombre || nombre.length > 60) {
      return res.status(400).json({ ok: false, msg: 'El nombre es requerido y debe tener máximo 60 caracteres.' });
    }

    // Validar formato de hora (si viene)
    for (const [k, v] of Object.entries(fields)) {
      if (!isValidTimeOrNull(v)) {
        return res.status(400).json({ ok: false, msg: `Formato de hora inválido en ${k} (usa HH:MM).` });
      }
    }

    // (Opcional) exigir al menos un día con entrada/salida
    // const algunDiaConTurno = [
    //   'lun','mar','mie','jue','vie','sab','dom'
    // ].some(d => fields[`${d}_entrada`] && fields[`${d}_salida`]);
    // if (!algunDiaConTurno) {
    //   return res.status(400).json({ ok:false, msg:'Captura al menos un día con entrada y salida.' });
    // }

    // 4) Query parametrizada (orden de columnas explícito)
    const sql = `
      INSERT INTO horarios_semanales (
        nombre_horario, activo,
        lun_entrada, lun_comida_ini, lun_comida_fin, lun_salida,
        mar_entrada, mar_comida_ini, mar_comida_fin, mar_salida,
        mie_entrada, mie_comida_ini, mie_comida_fin, mie_salida,
        jue_entrada, jue_comida_ini, jue_comida_fin, jue_salida,
        vie_entrada, vie_comida_ini, vie_comida_fin, vie_salida,
        sab_entrada, sab_comida_ini, sab_comida_fin, sab_salida,
        dom_entrada, dom_comida_ini, dom_comida_fin, dom_salida
      ) VALUES (?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?)
    `;

    const values = [
      nombre, activo,
      fields.lun_entrada, fields.lun_comida_ini, fields.lun_comida_fin, fields.lun_salida,
      fields.mar_entrada, fields.mar_comida_ini, fields.mar_comida_fin, fields.mar_salida,
      fields.mie_entrada, fields.mie_comida_ini, fields.mie_comida_fin, fields.mie_salida,
      fields.jue_entrada, fields.jue_comida_ini, fields.jue_comida_fin, fields.jue_salida,
      fields.vie_entrada, fields.vie_comida_ini, fields.vie_comida_fin, fields.vie_salida,
      fields.sab_entrada, fields.sab_comida_ini, fields.sab_comida_fin, fields.sab_salida,
      fields.dom_entrada, fields.dom_comida_ini, fields.dom_comida_fin, fields.dom_salida
    ];

    connections.query(sql, values, (err, result) => {
      if (err) {
        console.error('Error al insertar horario:', err);
        if (err.code === 'ER_DUP_ENTRY') {
          // UNIQUE(nombre) violado
          return res.status(409).json({ ok: false, msg: 'Ya existe un horario con ese nombre.' });
        }
        return res.status(500).json({ ok: false, msg: 'Error del servidor al guardar el horario.' });
      }
      return res.json({ ok: true, id_horario: result.insertId });
    });
  } catch (e) {
    console.error('Error en /horarios-semanales/new:', e);
    return res.status(500).json({ ok: false, msg: 'Error del servidor' });
  }
});


controller.post('/updateusuarios', async (req, res) => {
  try {
    let {
      id_usuario,
      nombre,
      apellido_paterno,
      apellido_materno,
      curp,
      rfc,
      nss,
      correo,
      password,          // opcional al editar
      telefono,
      sexo,
      fecha_nacimiento,
      estado_civil,
      domicilio,
      tipo_usuario
    } = req.body;

    // 1) Validaciones básicas
    if (!id_usuario) {
      return res.status(400).send('Falta id_usuario');
    }

    // Checkbox "activo" → 1/0
    const activo = req.body.activo ? 1 : 0;

    // 2) Normalizaciones
    nombre = (nombre || '').trim();
    apellido_paterno = (apellido_paterno || '').trim();
    apellido_materno = (apellido_materno || '').trim();
    curp = (curp || '').toUpperCase().trim();
    rfc = (rfc || '').toUpperCase().trim();
    nss = (nss || '').replace(/\D/g, '').trim();
    correo = (correo || '').toLowerCase().trim();
    telefono = (telefono || '').trim();
    sexo = (sexo || '').trim();
    fecha_nacimiento = (fecha_nacimiento || '').trim();
    estado_civil = (estado_civil || '').trim();
    domicilio = (domicilio || '').trim();
    tipo_usuario = (tipo_usuario || 'usuario').trim();

    // 3) Validación de campos requeridos (salvo password)
    const camposObligatorios = [
      { nombre: "Nombre", valor: nombre },
      { nombre: "Apellido Paterno", valor: apellido_paterno },
      { nombre: "Apellido Materno", valor: apellido_materno },
      { nombre: "CURP", valor: curp },
      { nombre: "RFC", valor: rfc },
      { nombre: "NSS", valor: nss },
      { nombre: "Correo", valor: correo },
      { nombre: "Teléfono", valor: telefono },
      { nombre: "Sexo", valor: sexo },
      { nombre: "Fecha de nacimiento", valor: fecha_nacimiento },
      { nombre: "Estado Civil", valor: estado_civil },
      { nombre: "Domicilio", valor: domicilio },
      { nombre: "Tipo de usuario", valor: tipo_usuario }
    ];

    const campoVacio = camposObligatorios.find(c => !c.valor || c.valor.trim() === "");
    if (campoVacio) {
      return res.render("editusuario", {
        alert: true,
        alertTitle: "Campo requerido",
        alertMessage: `El campo "${campoVacio.nombre}" no puede estar vacío`,
        alertIcon: "warning",
        showConfirmButton: true,
        timer: 3000,
        ruta: "editusuario/${id_usuario}",
        user: req.user || { nombre: "Invitado" }
      });
    }

    // 4) Construir UPDATE dinámico (password solo si se envía)
    const fields = [
      'nombre = ?',
      'apellido_paterno = ?',
      'apellido_materno = ?',
      'curp = ?',
      'rfc = ?',
      'nss = ?',
      'correo = ?',
      'telefono = ?',
      'sexo = ?',
      'fecha_nacimiento = ?',
      'estado_civil = ?',
      'domicilio = ?',
      'activo = ?',
      'tipo_usuario = ?'
    ];

    const values = [
      nombre,
      apellido_paterno,
      apellido_materno,
      curp,
      rfc,
      nss,
      correo,
      telefono,
      sexo,
      fecha_nacimiento,
      estado_civil,
      domicilio,
      activo,
      tipo_usuario
    ];

    // Si password viene (no vacío), lo hasheamos y actualizamos
    if (password && password.trim() !== '') {
      const hashedPassword = await bcrypt.hash(password, 10);
      fields.push('password = ?');
      values.push(hashedPassword);
    }

    values.push(id_usuario);

    const sql = `
      UPDATE usuarios
      SET ${fields.join(', ')}
      WHERE id_usuario = ?
      LIMIT 1
    `;

    connections.query(sql, values, (err, result) => {
      if (err) {
        console.error('Error al actualizar usuario:', err);
        // ER_DUP_ENTRY (únicos: curp/rfc/correo, etc.)
        if (err.code === 'ER_DUP_ENTRY') {
          return res.status(400).render("editarusuario", {
            alert: true,
            alertTitle: "Datos duplicados",
            alertMessage: "CURP/RFC/Correo ya están registrados en otro usuario.",
            alertIcon: "error",
            showConfirmButton: true,
            timer: 4000,
            ruta: `usuarios/${id_usuario}/editar`,
            usuario: {
              id_usuario, nombre, apellido_paterno, apellido_materno, curp, rfc, nss,
              correo, telefono, sexo, fecha_nacimiento, estado_civil, domicilio,
              activo, tipo_usuario
            }
          });
        }
        return res.status(500).send('Error del servidor al actualizar');
      }

      // OK -> redirige al listado o al perfil
      return res.redirect(`/perfil/${id_usuario}`);
      // o: return res.redirect('/usuarios');
    });

  } catch (error) {
    console.error('Error en /updateusuarios:', error);
    return res.status(500).send('Error del servidor');
  }
});

controller.post('/newusuarios', async (req, res) => {
  try {
    let {
      nombre,
      apellido_paterno,
      apellido_materno,
      curp,
      rfc,
      nss,
      correo,
      password,
      telefono,
      sexo,
      fecha_nacimiento,
      estado_civil,
      domicilio,
      tipo_usuario
    } = req.body;

    // Checkbox "activo" → 1/0
    const activo = req.body.activo ? 1 : 0;
    console.log(activo)

    // 2) Normalizaciones
    nombre = (nombre || '').trim();
    apellido_paterno = (apellido_paterno || '').trim();
    apellido_materno = (apellido_materno || '').trim();
    curp = (curp || '').toUpperCase().trim();
    rfc = (rfc || '').toUpperCase().trim();
    nss = (nss || '').replace(/\D/g, '').trim();
    correo = (correo || '').toLowerCase().trim();
    telefono = (telefono || '').trim();
    sexo = (sexo || '').trim();
    fecha_nacimiento = (fecha_nacimiento || '').trim();
    estado_civil = (estado_civil || '').trim();
    domicilio = (domicilio || '').trim();
    tipo_usuario = (tipo_usuario || 'usuario').trim();

    // Validación de campos vacíos
    const camposObligatorios = [
      { nombre: "Nombre", valor: nombre },
      { nombre: "Apellido Paterno", valor: apellido_paterno },
      { nombre: "Apellido Materno", valor: apellido_materno },
      { nombre: "CURP", valor: curp },
      { nombre: "RFC", valor: rfc },
      { nombre: "NSS", valor: nss },
      { nombre: "Correo", valor: correo },
      { nombre: "Contraseña", valor: password },
      { nombre: "Teléfono", valor: telefono },
      { nombre: "Sexo", valor: sexo },
      { nombre: "Fecha de nacimiento", valor: fecha_nacimiento },
      { nombre: "Estado Civil", valor: estado_civil },
      { nombre: "Domicilio", valor: domicilio },
      { nombre: "Tipo de usuario", valor: tipo_usuario }
    ];

    const campoVacio = camposObligatorios.find(c => !c.valor || c.valor.trim() === "");

    if (campoVacio) {
      return res.render("nuevousuario", {
        alert: true,
        alertTitle: "Campo requerido",
        alertMessage: `El campo "${campoVacio.nombre}" no puede estar vacío`,
        alertIcon: "warning",
        showConfirmButton: true,
        timer: 3000,
        ruta: "nuevousuario",
        user: req.user || { nombre: "Invitado" }
      });
    }

    

      // Hash de la contraseña
      const hashedPassword = await bcrypt.hash(password, 10);


      // Insertar usuario
      const sql = `
        INSERT INTO usuarios (
          nombre, apellido_paterno, apellido_materno,
          curp, rfc, nss, correo, password,
          telefono, sexo, fecha_nacimiento,
          estado_civil, domicilio, activo, tipo_usuario
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const values = [
        nombre,
        apellido_paterno,
        apellido_materno,
        curp.toUpperCase(),
        rfc.toUpperCase(),
        nss,
        correo,
        password,
        telefono,
        sexo,
        fecha_nacimiento,
        estado_civil,
        domicilio,
        activo,
        tipo_usuario
      ];

      connections.query(sql, values, (err, result) => {
        if (err) {
          console.error('Error al insertar usuario:', err);
          return res.render("nuevousuario", {
            alert: true,
            alertTitle: "Revise los datos",
            alertMessage: `Datos incorrectos, posible confusion de datos personales`,
            alertIcon: "error",
            showConfirmButton: true,
            timer: 3000,
            ruta: "nuevousuario",
            user: req.user || { nombre: "Invitado" }
          });
        }

        // Usuario insertado correctamente
        return res.redirect('/usuarios'); // O renderiza un mensaje de éxito
      });

  } catch (error) {
    console.error('Error en /nuevousuario:', error);
    return res.status(500).send('Error del servidor');
  }
});




module.exports = controller;    