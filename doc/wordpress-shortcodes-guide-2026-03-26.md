# Ride Fleet WordPress Shortcodes

## Plugin Path

- `wordpress/ridefleet-shortcodes/ridefleet-shortcodes.php`

## Shortcodes

### 1. Booking Module

```text
[ridefleet_booking tenant_slug="demo" search_mode="RENTAL" height="1900"]
```

Notas:

- usa un iframe al booking público de Ride Fleet
- `tenant_slug` es opcional
- `search_mode` puede ser `RENTAL` o `CAR_SHARING`
- `height` controla la altura del iframe

### 2. Vehicle Classes

```text
[ridefleet_vehicle_classes tenant_slug="demo" limit="6" cta_label="Rent Now"]
```

Notas:

- renderiza cards de clases de vehículos
- enseña precio diario
- enseña unidades disponibles
- el botón `Rent Now` abre el booking flow con el vehicle class preseleccionado

Opcionales:

- `pickup_location_id`
- `pickup_at`
- `return_at`

## Instalación

1. Copia la carpeta `wordpress/ridefleet-shortcodes` a `wp-content/plugins/`
2. Activa `Ride Fleet Shortcodes`
3. Inserta los shortcodes en la página de WordPress donde quieras mostrar booking o classes

## Dependencias

Este plugin espera que el backend/frontend público estén sirviendo desde:

- `https://ridefleetmanager.com`

Si luego cambia el dominio, actualiza:

- `api_base`
- `booking_base`

dentro del plugin.
