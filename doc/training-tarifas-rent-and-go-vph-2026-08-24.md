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
| `Test` | *(sin nombre)* | ❌ No | Desactivada el 24-ago-2026 (era una tarifa de prueba con $0) |
| `__LOANER_PROGRAM__` | Loaner Program Rates | ❌ No | Programa de loaners del dealer (automática) |

### Precios actuales por clase

| Clase de vehículo | Precio diario (web y mostrador) |
|---|---|
| Economy | $45.00 |
| Standard SUV | $45.00 |
| Luxury SUV | $59.95 |
| Full Size SUV | $69.95 |
| Cargo Van | $79.95 |
| Jeep Wrangler | $79.95 |
| Minivan | $79.95 |
| Pick UP | $89.95 |
| Sedan | $99.00 |
| Passenger Van | $99.95 |
| Box Truck | $250.00 |

- **Los precios de la web y el mostrador ahora son idénticos** (sincronizados el 24-ago-2026).
- **Semanal y mensual están en $0.00** en ambas tarifas, así que **todo se cobra diario × días**. Cuando definan sus precios de semana y mes, se cargan en esos campos.
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

## 6. Cambios aplicados el 24 de agosto de 2026

Se corrigieron tres cosas en la configuración:

1. **Sedan estaba en $0.00** en la tarifa del mostrador → corregido a **$99.00**.
2. **La tarifa `Test`** estaba activa y publicada en la web con $0.00 en casi todas las clases → **desactivada**.
3. **Los precios diarios del mostrador se sincronizaron con los de la web**, así que ahora cobran igual por los dos canales.
4. **Semanal y mensual quedaron en $0.00** — todo se cobra por día hasta que ustedes definan esos precios.

### Pendiente para ustedes
Definir los **precios semanales y mensuales** por clase y cargarlos (sección 4). Mientras estén en $0.00, una renta de 7 días se cobra como 7 días sueltos.

### Recomendaciones abiertas
- **Ponerle nombre** a la tarifa `SJU` (el campo está vacío).
- `SJU` **no está asignada a la sede de San Juan** a pesar del nombre; aplica a todas las sedes. Si la idea era limitarla a esa sede, hay que asignarle la location.

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
