const express = require('express');
const controller = express();
const connections = require ('../database/db');
const requireAuthView = require('../middlewares/requireAuthView');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

controller.use('/', require('./login_controller'));
controller.use('/', require('./pendientes_controller'));

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
        hashedPassword,
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