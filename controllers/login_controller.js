const express = require('express');
const login_controller = express();
const connections = require ('../database/db');
const requireAuthView = require('../middlewares/requireAuthView');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

login_controller.post('/auth', (req, res) => {
  const Usuario = req.body.user;
  const Contra = req.body.pass; // aquí usaremos 'sexo' solo para pruebas

  if (!Usuario || !Contra) {
    return res.status(400).render('login', {
      alert: true,
      alertTitle: 'Error',
      alertMessage: 'Falta usuario o contraseña',
      alertIcon: 'error',
      showConfirmButton: false,
      timer: 1500,
      ruta: 'login'
    });
  }

  const sql = `
    SELECT id_usuario, tipo_usuario, nombre, apellido_paterno, apellido_materno, correo, sexo
    FROM usuarios
    WHERE correo = ? AND password = ?
    LIMIT 1
  `;

  connections.query(sql, [Usuario, Contra], (error, results) => {
    if (error) {
      console.error('Error en consulta:', error);
      return res.status(500).render('login', {
        alert: true,
        alertTitle: 'Error',
        alertMessage: 'Error del servidor',
        alertIcon: 'error',
        showConfirmButton: true,
        timer: 1500,
        ruta: 'login'
      });
    }

    if (!results || results.length === 0) {
      return res.status(401).render('login', {
        alert: true,
        alertTitle: 'Error',
        alertMessage: 'Usuario o contraseña incorrectos',
        alertIcon: 'error',
        showConfirmButton: false,
        timer: 1500,
        ruta: 'login'
      });
    }

    const user = results[0];

    // Generar JWT por 24h
    const token = jwt.sign(
      {
        id_usuario: user.id_usuario,
        correo: user.correo,
        nombre: user.nombre,
        apellido_paterno: user.apellido_paterno,
        apellido_materno: user.apellido_materno,
        tipo_usuario: user.tipo_usuario
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Guardar token en cookie httpOnly
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000
    });

    // Respuesta con tu mismo patrón de alerts
    return res.render('login', {
      alert: true,
      alertTitle: 'Conexión Exitosa',
      alertMessage: '¡LOGIN CORRECTO!',
      alertIcon: 'success',
      showConfirmButton: false,
      timer: 1500,
      ruta: 'home' // redirige a home
    });
  });
});

// (Opcional) Logout: borra la cookie
login_controller.post('/logout', (req, res) => {
  res.clearCookie('token');
  return res.render('login', {
    alert: true,
    alertTitle: 'Sesión cerrada',
    alertMessage: 'Has cerrado sesión correctamente',
    alertIcon: 'success',
    showConfirmButton: false,
    timer: 1200,
    ruta: 'login'
  });
});


module.exports = login_controller;    