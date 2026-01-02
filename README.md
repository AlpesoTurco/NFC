# 🔐 NFC – Sistema de Control de Acceso con Torniquete

## 📌 Descripción del proyecto
**NFC** es un sistema de **control de acceso mediante torniquete** que utiliza tecnología **NFC** para registrar y gestionar las **entradas y salidas de empleados**. El sistema almacena la información en una base de datos, permitiendo un control de asistencia más eficiente y seguro dentro de una organización.

Este proyecto está orientado al aprendizaje y aplicación de tecnologías de control de acceso, así como al apoyo del área de **Recursos Humanos**.

---

## 🎯 Objetivos
- Controlar el acceso físico a las instalaciones mediante un torniquete.
- Registrar entradas y salidas de empleados en tiempo real.
- Identificar usuarios mediante tarjetas o dispositivos NFC.
- Optimizar el control de asistencia.
- Reducir errores de registros manuales.

---

## ⚙️ Funcionalidades principales
- Lectura de tarjetas NFC.
- Validación de empleados registrados.
- Registro automático de fecha y hora.
- Identificación de tipo de evento (entrada / salida).
- Almacenamiento de registros en base de datos.
- Consulta de historial de accesos.

---

## 🛠️ Tecnologías utilizadas
- **Hardware**:
  - Lector NFC
  - Torniquete electrónico
- **Software**:
  - Node.js / Java (según implementación)
  - Base de datos (MySQL / PostgreSQL / MongoDB)
- **Otros**:
  - API REST
  - Git y GitHub

---

## 🧩 Arquitectura general
1. El usuario acerca su tarjeta NFC al lector.
2. El sistema valida la identidad del empleado.
3. El torniquete permite o niega el acceso.
4. Se registra el evento en la base de datos.
5. La información queda disponible para consultas y reportes.
