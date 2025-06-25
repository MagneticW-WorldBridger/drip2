import { redisClient, publishToStream, getStreamName } from './api/queue.js';
import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

// Conexión a PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/**
 * ARREGLO CORRECTO: Reschedules expired jobs usando TimeFrame REAL (60-300 min)
 * NO el delay_seconds que es muy corto
 */
async function rescheduleExpiredJobsCorrectly() {
  const client = await pool.connect();
  try {
    // Find all expired jobs grouped by location+workflow
    const expiredJobsQuery = `
      SELECT location_id, workflow_id, COUNT(*) as expired_count,
             MIN(run_at) as earliest_expired,
             MAX(run_at) as latest_expired
      FROM sequential_queue 
      WHERE run_at <= NOW() - INTERVAL '1 minute'  -- Only truly expired jobs
      GROUP BY location_id, workflow_id
      HAVING COUNT(*) > 1  -- Only reschedule if there are multiple expired jobs (backlog scenario)
      ORDER BY location_id, workflow_id
    `;
    
    const expiredGroups = await client.query(expiredJobsQuery);
    
    if (expiredGroups.rows.length === 0) {
      return; // No expired backlogs to reschedule
    }
    
    console.log(`🔄 Found ${expiredGroups.rows.length} location+workflow groups with expired job backlogs`);
    
    for (const group of expiredGroups.rows) {
      const { location_id, workflow_id, expired_count } = group;
      
      console.log(`⏰ Rescheduling ${expired_count} expired jobs for ${location_id}+${workflow_id}`);
      
      // Get all expired jobs for this location+workflow, ordered by original run_at
      const jobsToReschedule = await client.query(
        `SELECT id, contact_id, delay_seconds, run_at
         FROM sequential_queue 
         WHERE location_id = $1 AND workflow_id = $2 AND run_at <= NOW() - INTERVAL '1 minute'
         ORDER BY run_at ASC`,
        [location_id, workflow_id]
      );
      
      // Calculate new run_at times with PROPER SPACING (TimeFrame equivalent)
      const now = new Date();
      let currentRunAt = now;
      
      for (let i = 0; i < jobsToReschedule.rows.length; i++) {
        const job = jobsToReschedule.rows[i];
        
        if (i === 0) {
          // First job starts in 5 minutes (buffer)
          currentRunAt = new Date(now.getTime() + 5 * 60 * 1000);
        } else {
          // Subsequent jobs: ADD REAL TIMEFRAME DELAY (60-300 minutos)
          // Generar delay aleatorio entre 60-300 minutos (como TimeFrame original)
          const delayMinutes = Math.floor(Math.random() * (300 - 60 + 1)) + 60;
          currentRunAt = new Date(currentRunAt.getTime() + delayMinutes * 60 * 1000);
        }
        
        // Update the job's run_at time
        await client.query(
          'UPDATE sequential_queue SET run_at = $1 WHERE id = $2',
          [currentRunAt, job.id]
        );
        
        console.log(`  📅 Job ${job.contact_id}: ${job.run_at.toISOString()} → ${currentRunAt.toISOString()}`);
      }
      
      console.log(`✅ Rescheduled ${expired_count} jobs for ${location_id}+${workflow_id} with PROPER delays`);
    }
    
  } catch (error) {
    console.error('❌ Error rescheduling expired jobs:', error);
  } finally {
    client.release();
  }
}

/**
 * Busca contactos en PostgreSQL cuyo tiempo de ejecución ya ha llegado
 * y los publica en el stream correspondiente
 */
async function processReadyContacts() {
  const client = await pool.connect();
  try {
    // Buscar contactos cuyo run_at ya ha pasado
    const result = await client.query(
      `SELECT id, contact_id, location_id, workflow_id, custom_field_id, run_at, api_key
       FROM sequential_queue
       WHERE run_at <= NOW()
       LIMIT 50`  // Procesar en lotes para evitar sobrecarga
    );
    
    if (result.rows.length > 0) {
      console.log(`🔄 Procesando ${result.rows.length} contactos listos desde PostgreSQL`);
      
      for (const row of result.rows) {
        try {
          // Obtener nombre del stream para este contacto
          const streamName = getStreamName(row.location_id, row.workflow_id);
          
          // Datos a publicar en el stream
          const messageData = {
            contactId: row.contact_id,
            locationId: row.location_id,
            workflowId: row.workflow_id || 'noworkflow',
            customFieldId: row.custom_field_id,
            apiKey: row.api_key,  // Incluir API key
            runAt: row.run_at.toISOString(),
            enqueuedAt: new Date().toISOString()
          };
          
          // Publicar en el stream
          const messageId = await publishToStream(streamName, messageData);
          console.log(`🚀 Contacto ${row.contact_id} publicado en stream ${streamName} con ID ${messageId}`);
          
          // Eliminar contacto de PostgreSQL
          await client.query('DELETE FROM sequential_queue WHERE id = $1', [row.id]);
          console.log(`🗑️ Contacto ${row.contact_id} eliminado de sequential_queue`);
        } catch (error) {
          console.error(`❌ Error procesando contacto ${row.contact_id}:`, error);
          // Continuar con el siguiente contacto
        }
      }
    }
  } catch (error) {
    console.error('❌ Error buscando contactos listos:', error);
  } finally {
    client.release();
  }
}

// Main scheduler loop: process ready contacts from Postgres based on run_at
async function runSchedulerLoop() {
  console.log('⏱️ Scheduler loop started with CORRECT expired job handling...');
  
  // Run expired job rescheduling once on startup with CORRECT logic
  console.log('🔄 Checking for expired jobs to reschedule with PROPER TimeFrame delays...');
  await rescheduleExpiredJobsCorrectly();
  
  while (true) {
    try {
      // First, handle any new expired job backlogs (in case system was down again)
      await rescheduleExpiredJobsCorrectly();
      
      // Then process normally ready contacts
      await processReadyContacts();
    } catch (error) {
      console.error('❌ Error in scheduler loop:', error);
    }
    // Wait 5 seconds before next iteration
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

// Start the scheduler loop
runSchedulerLoop().catch(error => {
  console.error('❌ Fatal error in scheduler:', error);
  process.exit(1);
});

// Manejar señales para una limpieza adecuada
process.on('SIGINT', () => {
  console.log('👋 Cerrando scheduler...');
  redisClient.disconnect();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('👋 Cerrando scheduler...');
  redisClient.disconnect();
  process.exit(0);
}); 