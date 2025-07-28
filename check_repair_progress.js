import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function checkProgress() {
  try {
    const client = await pool.connect();
    
    const query = `
      SELECT COUNT(*) as total
      FROM sequential_queue sq
      LEFT JOIN location_custom_fields lcf ON sq.location_id = lcf.location_id
      WHERE EXTRACT(hour FROM sq.run_at AT TIME ZONE COALESCE(lcf.timezone, 'America/New_York')) < 8 
         OR EXTRACT(hour FROM sq.run_at AT TIME ZONE COALESCE(lcf.timezone, 'America/New_York')) >= 20
    `;
    
    const result = await client.query(query);
    const remaining = parseInt(result.rows[0].total);
    
    console.log(`📊 VIOLATIONS RESTANTES: ${remaining}`);
    console.log(`📈 ESTIMADO PROGRESO: ${((27545 - remaining) / 27545 * 100).toFixed(1)}%`);
    console.log(`⏳ ESTIMADO REPARADAS: ${27545 - remaining}`);
    
    if (remaining === 0) {
      console.log('🎉 ¡REPARACIÓN COMPLETADA!');
    } else {
      console.log(`📦 LOTES RESTANTES: ~${Math.ceil(remaining / 500)}`);
    }
    
    client.release();
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await pool.end();
  }
}

checkProgress(); 