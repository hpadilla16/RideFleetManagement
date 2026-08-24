# Guía de Tarifas — Rent & Go by VPH Motors

**Para:** equipo de Rent & Go by VPH Motors · **Fecha:** 24 de agosto de 2026
**Dónde se configuran:** **Settings → Rates** (Configuración → Tarifas)

---

## 1. Cómo funcionan las tarifas en Ride

El sistema tiene **tres niveles**. Es importante entenderlos porque cada uno hace algo distinto:

| Nivel | Qué es | Ejemplo |
|---|---|---|
| **1. Tarifa (Rate)** | El "plan de precios". Tiene un código, y define reglas generales: si sale en la web, desde/hasta cuándo aplica, mínimos, período de gracia | `RETAIL-ONLINE` |
| **2. Precio por clase (Rate Item)** | Dentro de cada tarifa, el precio de **cada tipo de vehículo**: diario, semanal, mensual, por hora | Economy = $45.00/día |
| **3. Precio por fecha (opcional)** | Un precio especial para **días específicos** (feriados, eventos). Sobrescribe el precio normal solo esos días | 24-dic Economy = $80.00 |

> **Regla de oro:** el precio que ve el cliente sale del **nivel 2** (precio por clase), salvo que exista un **nivel 3** (precio por fecha) para ese día.

---

## 2. Cuál tarifa se usa (¡importante!)

Ustedes tienen varias tarifas activas al mismo tiempo. El sistema escoge automáticamente, y **no siempre es la misma**:

| Canal | Tarifa que se usa hoy |
|---|---|
| **Reservas por la web** (cliente en línea) | Solo se consideran tarifas con **"Display Online" activado** |
| **Reservas en el mostrador** (staff) | Se consideran **todas** las tarifas activas |

Cuando hay varias candidatas, el sistema prefiere en este orden:
1. La que esté **asignada a esa sede** (location) por encima de las generales
2. La de **fecha de vigencia más reciente**
3. La **creada más recientemente**

👉 **Por eso conviene tener pocas tarifas activas y bien nombradas.** Mientras más tarifas activas haya, más difícil es predecir cuál gana.

---

## 3. Cómo está configurado hoy (estado actual)

| Código | Nombre | ¿Sale en web? | Uso actual |
|---|---|---|---|
| `RETAIL-ONLINE` | Retail (Online) | ✅ Sí | **La que usan las reservas web** |
| `SJU` | *(sin nombre)* | ❌ No | **La que usan las reservas del mostrador** |
| `Test` | *(sin nombre)* | ✅ Sí | ⚠️ Tarifa de prueba — **ver sección 6** |
| `__LOANER_PROGRAM__` | Loaner Program Rates | ❌ No | Programa de loaners del dealer (automática) |

### Precios actuales por clase

| Clase de vehículo | Web (`RETAIL-ONLINE`) | Mostrador (`SJU`) |
|---|---|---|
| Economy | $45.00 | $35.00 |
| Standard SUV | $45.00 | $45.00 |
| Luxury SUV | $59.95 | $60.00 |
| Full Size SUV | $69.95 | $65.00 |
| Cargo Van | $79.95 | $90.00 |
| Jeep Wrangler | $79.95 | $65.00 |
| Minivan | $79.95 | $65.00 |
| Pick UP | $89.95 | $50.00 |
| **Sedan** | $99.00 | **$0.00** ⚠️ |
| Passenger Van | $99.95 | $140.00 |
| Box Truck | $250.00 | $90.00 |

- Solo `SJU` tiene precios **semanales y mensuales** configurados. `RETAIL-ONLINE` solo tiene diario, así que una renta larga por web se cobra **diario × días**.
- No hay **precios por fecha** (feriados/temporada) configurados en ninguna tarifa.

---

## 4. Cómo actualizar un precio (lo más común)

1. Entra a **Settings → Rates**.
2. Selecciona la tarifa que quieres cambiar (ej. `RETAIL-ONLINE` para la web).
3. Busca la **clase de vehículo** en la lista de precios.
4. Cambia el valor que necesites:
   - **Daily** — precio por día *(el más usado)*
   - **Weekly** — precio total por semana (7 días)
   - **Monthly** — precio total por mes
   - **Hourly** — por hora (solo si la tarifa usa cobro por hora)
   - **Extra Daily** — precio de cada día adicional después del período base
5. **Guarda.**

> ⚠️ **Recuerda:** si cambias el precio de la web, cambia `RETAIL-ONLINE`. Si cambias el del mostrador, cambia `SJU`. **Cambiar una NO cambia la otra.**

### Mínimos (opcional)
- **Min Daily / Min Weekly / Min Monthly** — cantidad mínima de días/semanas/meses para que ese precio aplique.

---

## 5. Cómo poner un precio especial para fechas (feriados, eventos)

Si quieren cobrar distinto en Navidad, Semana Santa o un evento:

1. Entra a la tarifa.
2. Busca la sección de **precios por fecha** (daily prices).
3. Añade la **fecha**, la **clase de vehículo** y el **precio** de ese día.
4. Guarda.

Ese precio **manda solo ese día**; los demás días siguen con el precio normal. Puedes cargarlos en bloque subiendo un archivo.

---

## 6. ⚠️ Dos cosas que hay que atender

### 🔴 A. El Sedan está en $0.00 en el mostrador
En la tarifa `SJU` (la que usa el mostrador), el **Sedan tiene precio $0.00**. Si un agente crea una reserva de Sedan en el mostrador, **cobrará $0**.
**Acción:** poner el precio correcto del Sedan en `SJU`.

### 🔴 B. Existe una tarifa llamada "Test" publicada en la web
La tarifa `Test` está **activa, marcada para salir en la web**, y vigente hasta junio 2027. Tiene **$0.00 en casi todas las clases** (solo Economy tiene $30).

Hoy **no** se está usando porque `RETAIL-ONLINE` le gana en el orden de selección — pero eso es **frágil**: si alguien le cambia una fecha a cualquiera de las dos, `Test` podría empezar a ganar y **cotizar $0 en la web**.
**Acción recomendada:** desactivarla o quitarle el "Display Online".

### 🟡 Otras recomendaciones
- **Ponerle nombre** a `SJU` y `Test` (están vacíos) — así se identifican rápido.
- La tarifa `SJU` **no está asignada a la sede de San Juan** a pesar del nombre; aplica a todas. Si la idea era que fuera solo de esa sede, hay que asignarle la location.
- **Revisar las diferencias web vs mostrador.** Algunas son grandes (Pick UP: $89.95 web vs $50 mostrador; Box Truck: $250 vs $90). Si es intencional, perfecto; si no, hay dinero en juego.

---

## 7. Buenas prácticas

✅ **Menos tarifas activas = más predecible.** Desactiva las que no uses en vez de dejarlas.
✅ **Nombra todo** con nombres claros ("Retail Web", "Mostrador SJU").
✅ **Nunca dejes precios en $0.00** salvo que sea intencional (ej. cortesía).
✅ **Verifica después de cambiar:** haz una cotización de prueba y confirma que sale el precio esperado.
✅ **Un cambio a la vez**, y avisa al equipo cuando cambien precios.

---

## 8. ¿Dudas?

Si algo no cuadra — un precio que no aparece, una clase que no se puede reservar, o una cotización rara — anota **la clase de vehículo, la sede, la fecha y el precio que esperaban** y escríbenos. Con esos datos lo revisamos rápido.
