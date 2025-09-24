const express = require('express');
const app = express();
const path = require('path'); // Agrega esta línea para utilizar el módulo 'path'
const multer = require('multer');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

//JWT Middleware 
app.use(cookieParser());


app.use(express.urlencoded({extended:false}));
app.use(express.json());

const dotenv = require('dotenv');
dotenv.config({path:'./env/.env'});

app.use('/resources', express.static('public'));
app.use('/resources', express.static(__dirname + 'public'));

app.set("view engine", "ejs");
app.set('views', path.join(__dirname, 'views'));

// Servir archivos subidos
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

const bcryptjs = require ('bcryptjs');
const { Session } = require('express-session');

const session = require ('express-session');
app.use(session({
    secret: 'secret',   
    resave: true,
    saveUninitialized: true
}))

const connections = require ('./database/db');

console.log(__dirname)


//Rutas
app.use('/', require('./router'));

//Acciones
app.use('/', require('./controllers/controller'));


//Servidor funcionando en el puerto 3000 
app.listen(3000, (req, res) => {
    console.log('SERVER RUNNING IN http://localhost:3000');
});
