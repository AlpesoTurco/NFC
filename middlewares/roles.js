// middlewares/roles.js
module.exports = function requireRoles(...rolesPermitidos) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');

    const rol = req.user?.tipo_usuario;
    if (!rolesPermitidos.includes(rol)) {
      // Para APIs devuelve 403; para vistas puedes renderizar 403.ejs si quieres.
      if (req.path.startsWith('/api/')) {
        return res.status(403).json({ ok: false, error: 'Acceso denegado' });
      }
      return res.status(403).send('Acceso denegado');
    }
    next();
  };
};