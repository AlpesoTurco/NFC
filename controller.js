const express = require('express');
const controller = express();
const connections = require ('./database/db');

//Acciones


//Generador de ID
function generateUniqueId() {
    const timestamp = Date.now().toString(36); 
    const random = Math.random().toString(36).substr(2, 5); 
    return timestamp + random; 
}
//Me da la fecha del dia en curso
function obtenerFechaActual() {
    const fecha = new Date();
    const dia = String(fecha.getDate()).padStart(2, '0');
    const mes = String(fecha.getMonth() + 1).padStart(2, '0'); 
    const anio = fecha.getFullYear();
    return `${anio}-${mes}-${dia}`;
}
//Funcion para obtener la hora en curso
function obtenerHoraActual() {
    const ahora = new Date();
    const hora = ahora.getHours();
    const minutos = ahora.getMinutes();
    const segundos = ahora.getSeconds();
    
    const minutosFormateados = minutos < 10 ? '0' + minutos : minutos;
    const segundosFormateados = segundos < 10 ? '0' + segundos : segundos;
    
    return `${hora}:${minutosFormateados}:${segundosFormateados}`;
}
//Otro generador de ID pero numeros
function IDgenerator() {
    const ahora = new Date();
    const hora = ahora.getHours();
    const minutos = ahora.getMinutes();
    const segundos = ahora.getSeconds();
    
    const minutosFormateados = minutos < 10 ? '0' + minutos : minutos;
    const segundosFormateados = segundos < 10 ? '0' + segundos : segundos;
    
    const horaNumeros = parseInt(`${hora}${minutosFormateados}${segundosFormateados}`);
    
    return horaNumeros;
}
module.exports = controller;    