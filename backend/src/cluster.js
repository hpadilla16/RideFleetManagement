import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';

const MAX_WORKERS = parseInt(process.env.CLUSTER_WORKERS || '0', 10) || Math.min(availableParallelism(), 4);

if (cluster.isPrimary) {
  console.log(`Primary ${process.pid} starting ${MAX_WORKERS} workers`);

  for (let i = 0; i < MAX_WORKERS; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.error(`Worker ${worker.process.pid} exited (code=${code}, signal=${signal}). Restarting...`);
    cluster.fork();
  });
} else {
  await import('./main.js');
  console.log(`Worker ${process.pid} started`);
}
