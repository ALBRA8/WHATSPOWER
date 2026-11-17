# DECISIÓN TÉCNICA — `node:sqlite` y `--experimental-strip-types` (Node 22)

**Fecha:** 2026-11-17
**Repositorio:** WHATSPOWER (aplica también a WHATSPOWER-ULTRA; CRM usa Prisma/better-sqlite3 en su daemon)
**Estado:** ADOPTADA con mitigaciones documentadas

---

## 1. Contexto

ULTRA (y WP) ejecutan TypeScript **directamente sobre Node.js 22** con:

```bash
node --experimental-strip-types src/server.ts
node --experimental-strip-types src/worker-main.ts
```

y persisten con la API **nativa `node:sqlite`** (`DatabaseSync`) — sin dependencias nativas compiladas (sin `node-gyp`), lo que hace el paquete portable entre Windows y Linux sin toolchain de C++.

## 2. Riesgos conocidos y mitigaciones

| Riesgo | Impacto | Mitigación aplicada en este repositorio |
|---|---|---|
| `node:sqlite` es marcado "experimental" | La API puede cambiar entre versiones menores de Node | Uso restringido a un patrón único (`createBroadcastDatabase` / `src/db.ts`); el resto del código solo importa tipos. Esquema creado con `CREATE TABLE IF NOT EXISTS` idempotente y migraciones aditivas |
| `--experimental-strip-types` solo DESPRENDE tipos (no compila) | Sintaxis TS "erasable only" (sin `enum`, sin namespaces, sin decorators) | El código fuente solo usa sintaxis borrible; la verificación dura de tipos la hace `tsc --noEmit` en cada build (`npm run build:all`) y es puerta obligatoria |
| Bandera experimental reporta advertencias al arrancar | Ruido en logs | Comportamiento ESPERADO y documentado; no se silencia el aviso (honestidad sobre el runtime) |
| `--test-isolation` del runner `node --test` cuelga en Node >= 22.23 (Windows) | Suite colgada en el PC del dueño | `scripts/run-tests.mjs` ejecuta las pruebas SIN `--test-isolation=process` (verificado en los 3 repositorios) |
| Diferencias de comportamiento entre 22.12 / 22.14 / 22.23 | Runtime distinto entre PC del dueño y CI | `engines: { "node": ">=22.12.0" }` + `.nvmrc` 22.14.0 alineados en los 3 repositorios; CI fija Node 22 |

## 3. Comportamiento esperado

- `npm start` / `npm run worker` arrancan con una **advertencia de experimental** en la primera línea de stderr: es NORMAL y NO indica fallo.
- `node:sqlite` abre la BD y las escrituras son serializadas por SQLite single-writer; el worker conserva exactly-once con claims atómicos + leases renovables.
- `tsc --noEmit` es la PUERTA de tipos: si `tsc` falla, el despliegue NO procede aunque el runtime strip-types pudiera ejecutar el código.

## 4. Plan de migración si el runtime cambiara

1. **Si `node:sqlite` estabiliza con cambios incompatibles:** actualizar SOLO `src/db.ts` (capa única de acceso al esquema); el resto del código usa tipos (`DatabaseSync`) sin llamar la API directamente.
2. **Si `--experimental-strip-types` cambia de nombre o se estabiliza (Node >= 24):** conmutar la bandera en `package.json` (`start`, `worker`, `test`) y en la documentación de despliegue; el código no requiere reescritura (solo sintaxis erasable).
3. **Si el proyecto migrara a un compilador** (tsx/esbuild): el comando sería `node --import tsx src/server.ts`; la suite de pruebas no cambia (ruta ya probada: `node --import tsx --test`).
4. **Si el proyecto migrara de SQLite** (p. ej. PostgreSQL multi-servidor): el esquema es SQL estándar portable; las decisiones de transacción única (`BEGIN/COMMIT`) y claims atómicos (`UPDATE ... WHERE status='DISPATCHING' AND claimed_by=?`) se conservan.

## 5. Qué NO hacer

- No introducir `enum`, `namespace`, decorators ni parámetros con propiedades (no-erasable) mientras se ejecute con strip-types.
- No agregar dependencias nativas compiladas para SQLite (rompe la portabilidad Windows/Linux sin toolchain).
- No fijar `NODE_OPTIONS` globales con banderas experimentales: cada script declara SOLO las banderas que necesita.
