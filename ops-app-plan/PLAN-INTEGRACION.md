# Plan de integración — medido 2026-08-18

Inventario hecho por **evidencia** (genealogía de git), no por reporte de las sesiones.
Ninguna de las 14 sesiones sigue viva; todas pararon entre las 03:59 y las 06:22.

## El hallazgo que ordena todo

`claude/nervous-mestorf-a05e2c` (25 commits, idéntica a `claude/goofy-kilby-2101b6`)
**ya contiene** cuatro ramas que veníamos tratando por separado:

- `feat/checkout-multisurface-p123` (el PR-tren P1+P2+P3)
- `feat/checkout-cas-transition` (M2-H8)
- `fix/checkout-finalize-truth`
- `fix/closed-screen-tells-the-truth`

Las sesiones construyeron **una encima de otra** en vez de en paralelo. O sea que el tren
de fusión de backend no son cuatro merges con sus conflictos de `package.json` y
`beta-ci.yml`: es **uno**.

## Lo que hay que fusionar, en orden

| # | Rama | Qué trae | Estado |
|---|---|---|---|
| 1 | `claude/nervous-mestorf-a05e2c` | P1-P3 + H8 + cierre honesto + pantalla de cierre | **sin revisar, LOCAL** |
| 2 | `claude/clever-burnell-2c0148` | scope de inquilino en checkout (1 commit) | sin revisar, LOCAL |
| 3 | `claude/vigilant-haslett-bf4131` | límite de peticiones en rutas públicas | sin revisar, LOCAL |
| 4 | `claude/silly-bohr-44e772` | un segundo finalize deja de reescribir | sin revisar, LOCAL |
| 5 | `claude/bold-swirles-5f59e8` | suites de embedded-postgres en CI | sin revisar, LOCAL |
| 6 | `claude/elastic-mclean-cd0805` | K10 deja de prometer una entrega | sin revisar, LOCAL |
| 7 | `fix/precheckin-insurance-base-rental-only` | seguro por % sobre la base correcta | sin revisar |
| 8 | `fix/precheckin-ota-tax-snapshot` | tasa 0 significa 0, no "sin definir" | sin revisar |
| 9 | `claude/angry-euclid-aaa03a` | nota al cliente, con prueba | sin revisar, LOCAL |
| 10 | `claude/quirky-saha-bec5f5` | la consola deja de afirmar un envío | sin revisar, LOCAL |
| 11 | `fix/insurance-flag-and-terms-url` | **bug vivo**: anexos borrados | **QA SHIP** |
| 12 | `fix/sign-page-tenant-identity` | fuga de marca en la firma | **QA SHIP** |
| 13 | `feat/rideops-m1` | M1 completo + plan + mockups | **QA SHIP** |
| 14 | `feat/rideops-m2-h1-wizard` | tronco M2 (H1+H7+H2) | **QA SHIP** |
| 15 | `feat/rideops-m2-h4-inspection` | H4 con sus correcciones | revisado, falta QA |

## Lo que falta construir

- **M2-H5** (firma y cierre) — en curso.
- **M2-H6** (reconciliación) — necesita P1-P3 desplegado.
- **M2-H3** (pago) — bloqueado por el copy legal de la tarjeta, y hay que replantear su
  segunda pantalla: el depósito **no** pide tarjeta física en el camino normal.
- Los dos estados diferidos de H2 (D1/D2) y los cuatro MUST diferidos de la página de firma.

## Riesgo principal

Diez de las quince ramas **no han pasado revisión ni QA**, y varias tocan dinero, un
documento legal o el aislamiento entre inquilinos. Fusionar por volumen sería tirar por la
borda la disciplina que esta semana atrapó tres bloqueantes.
