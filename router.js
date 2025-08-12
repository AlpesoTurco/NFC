const express = require('express');
const router = express();

const connections = require ('./database/db');

router.get('/login', (req, res) => {
    res.render('login');
});
router.get('/index', (req, res) => {
    res.render('index');
});
router.get('/usuarios', (req, res) => {
    res.render('usuarios');
});
router.get('/dispositivos', (req, res) => {
    res.render('dispositivos');
});
router.get('/actividad', (req, res) => {
    res.render('actividad');
});
router.get('/configuracion', (req, res) => {
    res.render('configuracion');
});



router.get('/edit/:PersonaID', (req, res)=>{
    const PersonaID = req.params.PersonaID;
    connections.query('SELECT PersonaID, Nombre, Apellidos, CorreoElectronico, AreaEstudio FROM personas p INNER JOIN estudiante e ON p.PersonaID = e.PersonaFK WHERE PersonaID = ?;', [PersonaID], (error, results)=>{
        if(error){
            throw error;
        } else {
            res.render('edit', {user:results[0]});
        }
    })  
})




router.get('/delete/:PersonaID', (req, res)=>{
    const id = req.params.PersonaID;
    connections.query('UPDATE estudiante SET Estatus = 0 WHERE PersonaFK = ?', [id], (error, results)=>{
        if(error){
            throw error;
        } else {
            res.redirect('/users');
        }
    })
})


//Elimina y redirige a /file
router.get('/defile/:PublicacionID', (req, res)=>{
    const id = req.params.PublicacionID;
    connections.query('UPDATE publicaciones SET status = 4 WHERE PublicacionID = ?', [id], (error, results)=>{
        if(error){
            throw error;
        } else {
            res.redirect('/file');
        }
    })
})
//Elimina y redirige a /file
router.get('/defileRechazados/:PublicacionID', (req, res)=>{
    const id = req.params.PublicacionID;
    connections.query('UPDATE publicaciones SET status = 4 WHERE PublicacionID = ?', [id], (error, results)=>{
        if(error){
            throw error;
        } else {
            res.redirect('/AceptadosUser');
        }
    })
})
//Elimina y redirige a /file
router.get('/defileAceptar/:PublicacionID', (req, res)=>{
    const id = req.params.PublicacionID;
    connections.query('UPDATE publicaciones SET status = 4 WHERE PublicacionID = ?', [id], (error, results)=>{
        if(error){
            throw error;
        } else {
            res.redirect('/RechazadosUser');
        }
    })
})

//Procedimientos
//Login Pages (file)
router.post('files', (req, res) => {
    if (req.session.loggedin) {
        connections.query('CALL ObtenerPublicacionesOrdenadasPorFecha()', (error, results) => {
            if (error) {
                throw error;
            } else {
                res.render('file', {
                    login: true,
                    name: req.session.name,
                    photo: req.session.photo,
                    results: results
                });
            }
        });
    } else {
        res.render('file', {
            login: false,
            name: 'Ingresa a EduShare',
            photo: 'resources/img/Usuario 2.svg'
        });
    }
});

module.exports = router;