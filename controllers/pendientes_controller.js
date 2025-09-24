const express = require('express');
const pendientes_controller = express();
const connections = require('../database/db'); // conexión simple (createConnection)
const requireAuthView = require('../middlewares/requireAuthView');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// deps
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]/g, '_');
    cb(null, Date.now() + '_' + safe);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB por archivo
  // Opcional: fileFilter para limitar tipos MIME
});

// Utilidad para borrar archivos en caso de rollback
function borrarArchivos(files) {
  (files || []).forEach(f => {
    try { fs.unlinkSync(f.path); } catch (_) {}
  });
}

// POST /permisos — Crea el permiso + adjuntos (transacción sobre conexión simple)
pendientes_controller.post('/permisos', upload.array('files', 10), (req, res) => {
  console.log('BODY ->', req.body);
  console.log('FILES ->', (req.files || []).map(f => ({
    fieldname: f.fieldname, originalname: f.originalname, mimetype: f.mimetype, size: f.size, path: f.path
  })));

  // 1) Parseo + validación básica
  let { id_usuario, tipo, modalidad, inicio, fin, hInicio, hFin, goce, motivo } = req.body;

  id_usuario = parseInt(id_usuario, 10);
  tipo = (tipo || '').trim();               // 'personal' | 'médico' | 'estudios' | 'luto' | 'otro'
  modalidad = (modalidad || '').trim();     // 'dia-completo' | 'por-horas'
  inicio = (inicio || '').trim();           // 'YYYY-MM-DD'
  fin = (fin || '').trim();                 // 'YYYY-MM-DD' (opcional)
  hInicio = (hInicio || '').trim();         // 'HH:mm' (solo para por-horas)
  hFin = (hFin || '').trim();               // 'HH:mm' (solo para por-horas)
  motivo = (motivo || '').trim();           // UI máx 300 (DB es TEXT)
  const goce_sueldo = goce === 'con-goce' ? 1 : 0;

  if (!id_usuario || !tipo || !modalidad || !inicio || !motivo) {
    borrarArchivos(req.files);
    return res.status(400).json({ ok: false, msg: 'Faltan datos requeridos.' });
  }
  if (!['personal', 'médico', 'estudios', 'luto', 'otro'].includes(tipo)) {
    borrarArchivos(req.files);
    return res.status(400).json({ ok: false, msg: 'Tipo no válido.' });
  }
  if (!['dia-completo', 'por-horas'].includes(modalidad)) {
    borrarArchivos(req.files);
    return res.status(400).json({ ok: false, msg: 'Modalidad no válida.' });
  }
  if (motivo.length > 300) {
    borrarArchivos(req.files);
    return res.status(400).json({ ok: false, msg: 'Motivo supera 300 caracteres.' });
  }

  // Normalizar fechas/horas según modalidad
  if (modalidad === 'dia-completo') {
    if (!fin) fin = inicio;
    hInicio = null;
    hFin = null;
  } else {
    if (!hInicio || !hFin) {
      borrarArchivos(req.files);
      return res.status(400).json({ ok: false, msg: 'Indica hora inicio y fin para modalidad por horas.' });
    }
  }

  // 2) Transacción sobre la conexión simple
  connections.beginTransaction(errTx => {
    if (errTx) {
      borrarArchivos(req.files);
      console.error('beginTransaction error:', errTx);
      return res.status(500).json({ ok: false, msg: 'No se pudo iniciar la transacción.' });
    }

    // 2.1) Insert en permisos
    const sqlPerm = `
      INSERT INTO permisos
        (id_usuario, tipo, modalidad, estatus, id_aprobador, comentario_resolucion,
         hora_inicio, hora_fin, goce_sueldo, motivo, observaciones,
         fecha_inicio, fecha_fin)
      VALUES
        (?, ?, ?, 'Pendiente', NULL, NULL,
         ?, ?, ?, ?, NULL,
         ?, ?)
    `;
    const paramsPerm = [
      id_usuario, tipo, modalidad,
      hInicio || null, hFin || null, goce_sueldo, motivo || null,
      inicio, fin || null
    ];

    connections.query(sqlPerm, paramsPerm, (errPerm, resultPerm) => {
      if (errPerm) {
        console.error('Error insertando permiso:', errPerm);
        return connections.rollback(() => {
          borrarArchivos(req.files);
          // Posibles causas: ENUM inválido, FK id_usuario inexistente, etc.
          return res.status(500).json({ ok: false, msg: 'Error al crear permiso.' });
        });
      }

      const id_permiso = resultPerm.insertId;
      const files = req.files || [];

      // 2.2) Si no hay adjuntos, commit directo
      if (!files.length) {
        return connections.commit(commitErr => {
          if (commitErr) {
            console.error('commit error sin adjuntos:', commitErr);
            return res.status(500).json({ ok: false, msg: 'Error al confirmar transacción.' });
          }
          return res.json({ ok: true, id_permiso, estatus: 'Pendiente', saved_files: 0 });
        });
      }

      // 2.3) Insert batch en permiso_adjuntos
      const sqlAdj = `
        INSERT INTO permiso_adjuntos
          (id_permiso, nombre_original, ruta, mime, tamano)
        VALUES ?
      `;
      const values = files.map(f => [
        id_permiso,
        f.originalname,
        path.join('uploads', path.basename(f.path)).replace(/\\/g, '/'),
        f.mimetype || null,
        f.size || null
      ]);

      connections.query(sqlAdj, [values], (errAdj, resultAdj) => {
        if (errAdj) {
          console.error('Error insertando adjuntos:', errAdj);
          return connections.rollback(() => {
            borrarArchivos(files);
            return res.status(500).json({
              ok: false,
              msg: 'No se pudo registrar adjuntos; operación revertida.'
            });
          });
        }

        // 2.4) Commit final
        connections.commit(commitErr => {
          if (commitErr) {
            console.error('commit error con adjuntos:', commitErr);
            borrarArchivos(files);
            return res.status(500).json({ ok: false, msg: 'Error al confirmar transacción.' });
          }
          return res.json({
            ok: true,
            id_permiso,
            estatus: 'Pendiente',
            saved_files: resultAdj.affectedRows
          });
        });
      });
    });
  });
});

module.exports = pendientes_controller;
