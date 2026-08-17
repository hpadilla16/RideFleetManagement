// H6 integration pass — embedded Postgres para el backend real sin Docker.
// Se ejecuta con cwd = backend/ (resuelve embedded-postgres de sus node_modules).
import EmbeddedPostgres from 'embedded-postgres';

const dataDir = process.env.PG_DATA_DIR;
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port: 5455,
  persistent: true,
});

await pg.initialise();
await pg.start();
try {
  await pg.createDatabase('fleet_management');
} catch (e) {
  console.log('createDatabase:', e.message);
}
console.log('PG_READY on 5455');
setInterval(() => {}, 1 << 30); // mantener vivo
