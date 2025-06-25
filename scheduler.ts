import { redisClient, publishToStream, getStreamName } from './api/queue.js';
import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

// SCHEDULER PAUSADO - NO PROCESA JOBS
console.log('🛑 SCHEDULER PAUSADO - No procesará jobs hasta nuevo aviso');
console.log('🔧 Para reactivar, usar el scheduler.ts original');

// Conexión a PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Main scheduler loop: PAUSADO
async function runPausedScheduler() {
  console.log('🛑 Scheduler en modo PAUSA - no procesando jobs...');
  while (true) {
    // Solo imprimir estado cada 30 segundos
    try {
      const client = await pool.connect();
      const ready = await client.query('SELECT COUNT(*) FROM sequential_queue WHERE run_at <= NOW()');
      console.log(`⏸️ PAUSADO - ${ready.rows[0].count} jobs listos (no procesando)`);
      client.release();
    } catch (error) {
      console.error('Error checking status:', error);
    }
    
    // Esperar 30 segundos
    await new Promise(resolve => setTimeout(resolve, 30000));
  }
}

// Start the PAUSED scheduler
runPausedScheduler().catch(error => {
  console.error('❌ Fatal error in paused scheduler:', error);
  process.exit(1);
});

// Manejar señales para una limpieza adecuada
process.on('SIGINT', () => {
  console.log('👋 Cerrando scheduler pausado...');
  redisClient.disconnect();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('👋 Cerrando scheduler pausado...');
  redisClient.disconnect();
  process.exit(0);
}); 